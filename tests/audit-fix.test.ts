import {describe, expect, it, vi} from 'vitest';
import {
	deriveFixCandidates,
	type AuditFixCandidate,
	type FixSnapshot,
} from '../src/audit/fixes/planning.js';
import {applyAuditFix, type FixOutcome} from '../src/audit/fixes/execution.js';
import {presentFixCandidate} from '../src/audit/fixes/presentation.js';
import {runAuditFixSession} from '../src/cli/ha-audit-fix.js';
import {runHaAuditCli} from '../src/cli/ha-audit.js';
import {fixFixture, fixState, fixRegistries} from './audit-fix-fixture.js';

const firstCandidate = (snapshot: FixSnapshot): AuditFixCandidate => {
	const candidate = deriveFixCandidates(snapshot).candidates[0];
	if (candidate === undefined) {
		throw new Error('Fixture requires candidate.');
	}

	return candidate;
};

const suspicious = () =>
	fixFixture([fixState('light.example_status', 'on', 'Example Status Light')]);
const fakeDependencies = (snapshot: FixSnapshot) => ({
	collect: vi.fn(async () => structuredClone(snapshot)),
	disable: vi.fn(
		async (_candidate: unknown, beforeWrite: () => Promise<boolean>): Promise<FixOutcome> =>
			(await beforeWrite()) ? ('verified' as const) : ('changed' as const),
	),
	deny: vi.fn(
		async (_id: string, _text: string, beforeWrite: () => Promise<boolean>): Promise<FixOutcome> =>
			(await beforeWrite()) ? ('verified' as const) : ('changed' as const),
	),
});

describe('conservative audit fix planning', () => {
	it.each(['unavailable', 'unknown'])(
		'offers exact stale duplicate disable for %s with one usable sibling',
		(state) => {
			const snapshot = fixFixture([
				fixState('light.example_stale', state),
				fixState('light.example_live'),
			]);
			expect(deriveFixCandidates(snapshot).candidates).toEqual([
				expect.objectContaining({
					type: 'disable_stale_entity',
					entityId: 'light.example_stale',
					siblingId: 'light.example_live',
				}),
			]);
		},
	);

	it('does not infer stale identity from entity ordering', () => {
		const snapshot = fixFixture();
		const original = deriveFixCandidates(snapshot).candidates;
		snapshot.data.states.reverse();
		fixRegistries(snapshot).entities.reverse();
		expect(deriveFixCandidates(snapshot).candidates).toEqual(original);
	});

	it.each([
		{case: 'both usable', states: [fixState('light.example_a'), fixState('light.example_b')]},
		{
			case: 'both unusable',
			states: [fixState('light.example_a', 'unknown'), fixState('light.example_b', 'unavailable')],
		},
		{
			case: 'three siblings',
			states: [
				fixState('light.example_a', 'unknown'),
				fixState('light.example_b'),
				fixState('light.example_c'),
			],
		},
		{
			case: 'mixed domains',
			states: [fixState('light.example_a', 'unknown'), fixState('switch.example_b')],
		},
		{
			case: 'invalid state',
			states: [fixState('light.example_a', 'invalid'), fixState('light.example_b')],
		},
		{
			case: 'normalized-only name',
			states: [
				fixState('light.example_a', 'unknown'),
				fixState('light.example_b', 'on', 'EXAMPLE LAMP'),
			],
		},
	])('refuses ambiguous/unsupported duplicates: $case', ({states}) => {
		expect(deriveFixCandidates(fixFixture(states)).candidates).toEqual([]);
	});

	it.each([
		'different device',
		'missing device',
		'disabled candidate',
		'disabled sibling',
		'incomplete metadata',
		'no capability',
		'registry changed',
	])('refuses disable when %s', (condition) => {
		const snapshot = fixFixture();
		const registry = fixRegistries(snapshot);
		switch (condition) {
			case 'different device': {
				registry.entities[1]!.device_id = 'other_device';
				break;
			}

			case 'missing device': {
				registry.entities[0]!.device_id = null;
				break;
			}

			case 'disabled candidate': {
				registry.entities[0]!.disabled_by = 'user';
				break;
			}

			case 'disabled sibling': {
				registry.entities[1]!.disabled_by = 'user';
				break;
			}

			case 'incomplete metadata': {
				registry.devices = [];
				break;
			}

			case 'no capability': {
				snapshot.registryEvidence = {};
				break;
			}

			case 'registry changed': {
				snapshot.registryEvidence['light.example_stale']!.entry.area_id = 'changed_area';
				break;
			}

			default: {
				throw new Error('Unexpected case.');
			}
		}

		expect(deriveFixCandidates(snapshot).candidates).toEqual([]);
		expect(deriveFixCandidates(snapshot).nonFixable.length).toBeGreaterThan(0);
	});

	it('never disables a policy-permitted duplicate', () => {
		const snapshot = fixFixture([fixState('light.example_a'), fixState('light.example_b')]);
		expect(deriveFixCandidates(snapshot).candidates).toEqual([]);
		expect(
			deriveFixCandidates(snapshot).nonFixable.some(({reason}) =>
				reason.includes('policy-permitted'),
			),
		).toBe(true);
	});

	it('does not infer duplicate names or staleness for registry-only entities', () => {
		const snapshot = fixFixture();
		snapshot.data.states.shift();
		expect(deriveFixCandidates(snapshot).candidates).toEqual([]);
	});

	it('proposes only an exact deny for a permitted suspicious entity', () => {
		expect(firstCandidate(suspicious())).toMatchObject({
			type: 'deny_policy_entity',
			entityId: 'light.example_status',
		});
	});

	it.each(['denied', 'not allowed', 'missing policy', 'unavailable'])(
		'does not offer suspicious entity deny when %s',
		(condition) => {
			const snapshot = suspicious();
			switch (condition) {
				case 'denied': {
					snapshot.data.policy!.deny = [{entityId: 'light.example_status'}];

					break;
				}

				case 'not allowed': {
					snapshot.data.policy!.allow = [];

					break;
				}

				case 'missing policy': {
					snapshot.data.policy = undefined;
					snapshot.policyText = undefined;

					break;
				}

				case 'unavailable': {
					snapshot.data.states[0]!.state = 'unavailable';

					break;
				}
				// No default
			}

			expect(deriveFixCandidates(snapshot).candidates).toEqual([]);
		},
	);

	it('unrelated inventory/readiness INFO never creates candidates', () => {
		const snapshot = fixFixture([fixState('light.example_lamp')]);
		expect(deriveFixCandidates(snapshot).candidates).toEqual([]);
	});

	it('omits unrelated informational duplicate diagnostics from the interactive display', () => {
		const snapshot = fixFixture([
			fixState('notify.example_first'),
			fixState('notify.example_second'),
		]);
		expect(deriveFixCandidates(snapshot)).toEqual({candidates: [], nonFixable: []});
	});

	it('preserves snapshot inputs and deterministic candidate/diagnostic order', () => {
		const snapshot = fixFixture();
		const before = structuredClone(snapshot);
		deriveFixCandidates(snapshot);
		expect(snapshot).toEqual(before);
	});
});

describe('fresh remediation authorization', () => {
	it.each([
		'state',
		'timestamp',
		'name',
		'registry',
		'device',
		'policy',
		'policy bytes',
		'registry identity',
		'sibling',
	])('skips when %s changes after audit', async (change) => {
		const snapshot = fixFixture();
		const candidate = firstCandidate(snapshot);
		const dependencies = fakeDependencies(snapshot);
		switch (change) {
			case 'state': {
				snapshot.data.states[0]!.state = 'on';

				break;
			}

			case 'timestamp': {
				snapshot.data.states[0]!.last_updated = 'changed';

				break;
			}

			case 'name': {
				snapshot.data.states[0]!.attributes.friendly_name = 'Changed';

				break;
			}

			case 'registry': {
				fixRegistries(snapshot).entities[0]!.area_id = 'example_room';

				break;
			}

			case 'device': {
				fixRegistries(snapshot).devices[0]!.disabled_by = 'user';

				break;
			}

			case 'policy': {
				snapshot.data.policy!.deny = [{entityId: 'light.example_live'}];

				break;
			}

			case 'policy bytes': {
				snapshot.policyText += '\n';

				break;
			}

			case 'registry identity': {
				snapshot.registryEvidence['light.example_stale']!.digest = 'changed';

				break;
			}

			case 'sibling': {
				snapshot.data.states[1]!.state = 'off';

				break;
			}
			// No default
		}

		expect(await applyAuditFix(candidate, dependencies, new AbortController().signal)).toBe(
			'changed',
		);
		expect(dependencies.disable).not.toHaveBeenCalled();
		expect(dependencies.deny).not.toHaveBeenCalled();
	});

	it('revalidates again inside the final write boundary', async () => {
		const snapshot = fixFixture();
		const candidate = firstCandidate(snapshot);
		const dependencies = fakeDependencies(snapshot);
		dependencies.disable.mockImplementation(async (_candidate, beforeWrite) => {
			snapshot.data.states[0]!.state = 'on';
			return (await beforeWrite()) ? 'verified' : 'changed';
		});
		expect(await applyAuditFix(candidate, dependencies, new AbortController().signal)).toBe(
			'changed',
		);
		expect(dependencies.collect).toHaveBeenCalledTimes(2);
	});

	it('skips policy denial on any policy edit before applying', async () => {
		const snapshot = suspicious();
		const candidate = firstCandidate(snapshot);
		const dependencies = fakeDependencies(snapshot);
		snapshot.policyText += ' ';
		expect(await applyAuditFix(candidate, dependencies, new AbortController().signal)).toBe(
			'changed',
		);
		expect(dependencies.deny).not.toHaveBeenCalled();
	});

	it('rejects fabricated candidates without calling a mutator', async () => {
		const snapshot = fixFixture();
		const dependencies = fakeDependencies(snapshot);
		const candidate = {...firstCandidate(snapshot), entityId: 'light.example_other'};
		expect(await applyAuditFix(candidate, dependencies, new AbortController().signal)).toBe(
			'changed',
		);
		expect(dependencies.disable).not.toHaveBeenCalled();
	});

	it('does not claim policy success until fresh resolver output confirms an effective exact deny', async () => {
		const snapshot = suspicious();
		const dependencies = fakeDependencies(snapshot);
		expect(
			await applyAuditFix(firstCandidate(snapshot), dependencies, new AbortController().signal),
		).toBe('failed');
		expect(dependencies.deny).toHaveBeenCalledOnce();
	});

	it('fails closed on fresh-read failures', async () => {
		const snapshot = fixFixture();
		const dependencies = fakeDependencies(snapshot);
		dependencies.collect.mockRejectedValue(new Error('private failure'));
		expect(
			await applyAuditFix(firstCandidate(snapshot), dependencies, new AbortController().signal),
		).toBe('failed');
		expect(dependencies.disable).not.toHaveBeenCalled();
	});

	it('aborts before dispatch without reads or writes', async () => {
		const snapshot = fixFixture();
		const dependencies = fakeDependencies(snapshot);
		const controller = new AbortController();
		controller.abort();
		expect(await applyAuditFix(firstCandidate(snapshot), dependencies, controller.signal)).toBe(
			'changed',
		);
		expect(dependencies.collect).not.toHaveBeenCalled();
		expect(dependencies.disable).not.toHaveBeenCalled();
	});
});

const session = async (
	snapshot: FixSnapshot,
	answers: string[],
	customize?: (
		dependencies: ReturnType<typeof fakeDependencies>,
		controller: AbortController,
	) => void,
) => {
	const dependencies = fakeDependencies(snapshot);
	const controller = new AbortController();
	const output: string[] = [];
	const confirm = vi.fn(async () => answers.shift() ?? '');
	dependencies.disable.mockImplementation(async (candidate, beforeWrite) => {
		if (!(await beforeWrite())) {
			return 'changed';
		}

		const id = (candidate as AuditFixCandidate).entityId;
		fixRegistries(snapshot).entities.find((entry) => entry.entity_id === id)!.disabled_by = 'user';
		return 'verified';
	});
	dependencies.deny.mockImplementation(async (id, _text, beforeWrite) => {
		if (!(await beforeWrite())) {
			return 'changed';
		}

		snapshot.data.policy!.deny.push({entityId: id});
		snapshot.policyText = JSON.stringify(snapshot.data.policy);
		return 'verified';
	});
	customize?.(dependencies, controller);
	const result = await runAuditFixSession(
		dependencies,
		{
			interactive: true,
			write(text) {
				output.push(text);
			},
			confirm,
		},
		controller.signal,
	);
	return {result, output: output.join('\n'), dependencies, confirm};
};

describe('interactive audit remediation', () => {
	it('renders a single candidate exactly once immediately before its confirmation prompt', async () => {
		const snapshot = suspicious();
		const dependencies = fakeDependencies(snapshot);
		const proposal = presentFixCandidate(firstCandidate(snapshot), snapshot.data.redactions);
		const events: string[] = [];
		const confirm = vi.fn(async (prompt: string) => {
			events.push(prompt);
			return 'n';
		});
		const result = await runAuditFixSession(
			dependencies,
			{
				interactive: true,
				write(text) {
					events.push(text);
				},
				confirm,
			},
			new AbortController().signal,
		);
		expect(events.filter((event) => event === proposal)).toHaveLength(1);
		expect(events.indexOf(proposal)).toBe(events.indexOf('Apply? [y/N] ') - 1);
		expect(confirm).toHaveBeenCalledOnce();
		expect(result.exitCode).toBe(0);
		expect(dependencies.disable).not.toHaveBeenCalled();
		expect(dependencies.deny).not.toHaveBeenCalled();
	});

	it.each(['', 'n', 'no', 'YES please', 'true', '1', 'maybe', 'yeſ'])(
		'declines %j without writes and runs a final fresh audit',
		async (answer) => {
			const {result, output, dependencies, confirm} = await session(fixFixture(), [answer]);
			expect(result.exitCode).toBe(0);
			expect(dependencies.disable).not.toHaveBeenCalled();
			expect(dependencies.deny).not.toHaveBeenCalled();
			expect(confirm).toHaveBeenCalledWith('Apply? [y/N] ', expect.any(AbortSignal));
			expect(dependencies.collect).toHaveBeenCalledTimes(2);
			expect(output).toContain('Declined 1.');
		},
	);

	it.each(['y', 'yes', 'Y', 'YES'])(
		'applies only explicit confirmation %j, verifies and re-audits',
		async (answer) => {
			const {result, output, dependencies} = await session(fixFixture(), [answer]);
			expect(result.exitCode).toBe(0);
			expect(dependencies.disable).toHaveBeenCalledOnce();
			expect(output).toContain('Applied and verified.');
			expect(output).toContain('Applied 1 fixes.');
			expect(output).toContain('Re-running audit...');
			expect(dependencies.collect.mock.calls.length).toBeGreaterThanOrEqual(5);
		},
	);

	it('confirms each fix independently, with no blanket yes', async () => {
		const snapshot = fixFixture([
			fixState('light.example_stale', 'unavailable'),
			fixState('light.example_live'),
			fixState('light.example_status', 'on', 'Example Status Light'),
		]);
		const {confirm, dependencies, output} = await session(snapshot, ['y', 'n']);
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(dependencies.disable).toHaveBeenCalledOnce();
		expect(dependencies.deny).not.toHaveBeenCalled();
		expect(output).toContain('Declined 1.');
	});

	it('shows exact changes and final fresh warnings after a verified policy deny', async () => {
		const {result, output, dependencies} = await session(suspicious(), ['yes']);
		expect(result.exitCode).toBe(0);
		expect(dependencies.deny).toHaveBeenCalledOnce();
		expect(output).toContain('deny += {"entityId":"light.example_status"}');
		expect(output).toContain('Current policy effect: allowed');
		expect(output).toContain('New policy effect: denied');
		expect(output).toContain('Findings: 0 ERROR, 0 WARN, 2 INFO.');
		expect(output).toContain('No actionable warnings remain.');
		expect(output.slice(output.lastIndexOf('Re-running audit...'))).not.toContain(
			'No changes were made.',
		);
	});

	it('displays a changed-precondition skip and performs no write', async () => {
		const snapshot = fixFixture();
		const {result, output} = await session(snapshot, ['yes'], (dependencies) => {
			dependencies.disable.mockResolvedValue('changed');
		});
		expect(result.exitCode).toBe(1);
		expect(output).toContain('Skipped: underlying state changed since audit. Re-run audit.');
	});

	it('stops after uncertain mutation/verification instead of applying later candidates', async () => {
		const snapshot = fixFixture([
			fixState('light.example_stale', 'unavailable'),
			fixState('light.example_live'),
			fixState('light.example_status', 'on', 'Example Status Light'),
		]);
		const {result, output, dependencies, confirm} = await session(
			snapshot,
			['yes', 'yes'],
			(dependencies) => {
				dependencies.disable.mockResolvedValue('failed');
			},
		);
		expect(result.exitCode).toBe(1);
		expect(output).not.toContain('Applied and verified.');
		expect(dependencies.deny).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledOnce();
	});

	it('Ctrl+C at confirmation aborts without applying the current fix', async () => {
		const snapshot = fixFixture();
		const dependencies = fakeDependencies(snapshot);
		const controller = new AbortController();
		const result = await runAuditFixSession(
			dependencies,
			{
				interactive: true,
				write: vi.fn<(text: string) => void>(),
				async confirm() {
					controller.abort();
					throw new Error('Abort');
				},
			},
			controller.signal,
		);
		expect(result.exitCode).toBe(1);
		expect(dependencies.disable).not.toHaveBeenCalled();
		expect(dependencies.deny).not.toHaveBeenCalled();
	});

	it('rejects non-terminal fix mode before collecting or writing', async () => {
		const dependencies = fakeDependencies(fixFixture());
		const result = await runAuditFixSession(
			dependencies,
			{
				interactive: false,
				write: vi.fn<(text: string) => void>(),
				async confirm() {
					return 'yes';
				},
			},
			new AbortController().signal,
		);
		expect(result.exitCode).toBe(2);
		expect(dependencies.collect).not.toHaveBeenCalled();
	});

	it('sanitizes failures and reports final audit failure', async () => {
		const dependencies = fakeDependencies(fixFixture());
		dependencies.collect.mockRejectedValue(new Error('secret-token https://ha.example.test'));
		const output: string[] = [];
		const result = await runAuditFixSession(
			dependencies,
			{
				interactive: true,
				write(text) {
					output.push(text);
				},
				async confirm() {
					return 'yes';
				},
			},
			new AbortController().signal,
		);
		expect(result.exitCode).toBe(1);
		expect(output.join('\n')).not.toContain('secret-token');
		expect(output.join('\n')).toContain('Final audit failed');
	});

	it('redacts installation secrets and terminal controls in candidate presentation', () => {
		const candidate = {...firstCandidate(fixFixture()), entityId: 'light.example_secret\n\u{1B}'};
		const text = presentFixCandidate(candidate, ['example_secret']);
		expect(text).not.toContain('example_secret');
		expect(text).not.toContain('\u{1B}');
	});
});

describe('fix CLI modes', () => {
	it.each([
		['--fix', '--json'],
		['--fix', '--verbose'],
		['--fix', '--fix'],
		['--fix', '--help'],
		['--unknown'],
	])('rejects combined/repeated/unknown modes %j before HA access', async (...args) => {
		const collect = vi.fn();
		const result = await runHaAuditCli(args, collect);
		expect(result.exitCode).toBe(2);
		expect(collect).not.toHaveBeenCalled();
	});

	it('documents --fix, default NO and isolated modes', async () => {
		const result = await runHaAuditCli(['--help']);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('--fix: interactive');
		expect(result.output).toContain('[y/N]');
	});
});
