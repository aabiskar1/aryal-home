import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runAssessmentCli, type AssessmentDependencies} from '../src/cli/assess-home.js';
import {
	environmentData,
	environmentProposal,
	weatherId,
	temperatureId,
	humidityId,
	stateFor,
} from './environment-fixture.js';
import {now, proposal, preferences} from './assessment-fixture.js';
import {location} from './lighting-learning-fixture.js';

let deps: AssessmentDependencies;
const args = ['--area', 'Example Room', '--goal', 'environment_comfort'];
beforeEach(() => {
	deps = {
		collect: vi.fn(async () => environmentData()),
		read: vi.fn(async () => {
			throw new Error('lighting preference read must not run');
		}),
		location: vi.fn(async () => location),
		chat: vi.fn(async () => JSON.stringify(environmentProposal())),
		config: () => ({model: 'example-model', maxRequestBytes: 24_576}),
		now: () => now,
	};
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('explicit environmental goal CLI and unchanged lighting default', () => {
	it.each(['true', 'false'])(
		'is read-only with DRY_RUN=%s, never reads lighting preferences and exposes no execution shortcut',
		async (dryRun) => {
			vi.stubEnv('DRY_RUN', dryRun);
			const data = environmentData();
			const policy = structuredClone(data.policy);
			const states = structuredClone(data.states);
			vi.mocked(deps.collect).mockResolvedValue(data);
			const result = await runAssessmentCli(args, deps);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				context: {goal: 'environment_comfort', states: [], preference: {status: 'unknown'}},
				decision: {
					outcome: 'insight',
					validation: 'accepted',
					executionAuthority: 'none',
					recommendations: [],
				},
			});
			expect(deps.read).not.toHaveBeenCalled();
			expect(deps.chat).toHaveBeenCalledTimes(1);
			expect(data.policy).toEqual(policy);
			expect(data.states).toEqual(states);
		},
	);
	it('accepts goal-before-area order without a natural-language input', async () => {
		const result = await runAssessmentCli(
			['--goal', 'environment_comfort', '--area', 'Example Room'],
			deps,
		);
		expect(result.exitCode).toBe(0);
		expect(deps.chat).toHaveBeenCalledTimes(1);
	});
	it.each(
		[
			['--goal', 'unknown', '--area', 'Example Room'],
			['--area', 'Example Room', '--area', 'Other'],
			['--area', 'Example Room', '--goal'],
			['--area', 'Example Room', '--forecast', 'true'],
		].map((input) => ({input})),
	)('rejects unknown/duplicate/incomplete flags %# before reads', async ({input}) => {
		const result = await runAssessmentCli(input, deps);
		expect(result.exitCode).toBe(2);
		expect(deps.collect).not.toHaveBeenCalled();
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it.each(['default', 'explicit'])(
		'preserves %s lighting selection and approved threshold validation',
		async (mode) => {
			vi.mocked(deps.read).mockResolvedValue({text: JSON.stringify(preferences), preferences});
			vi.mocked(deps.chat).mockResolvedValue(JSON.stringify(proposal()));
			const result = await runAssessmentCli(
				mode === 'default'
					? ['--area', 'Example Room']
					: ['--area', 'Example Room', '--goal', 'lighting_comfort'],
				deps,
			);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				context: {goal: 'lighting_comfort', preference: {status: 'approved', thresholdLux: 40}},
				decision: {outcome: 'suggest_action', validation: 'accepted'},
			});
			expect(deps.read).toHaveBeenCalledTimes(1);
			expect(deps.chat).toHaveBeenCalledTimes(1);
		},
	);
	it('keeps missing lighting thresholds a hard preflight failure even though environment measurements exist', async () => {
		vi.mocked(deps.read).mockResolvedValue({text: undefined, preferences: {version: 1, rooms: []}});
		const result = await runAssessmentCli(['--area', 'Example Room'], deps);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			decision: {model: 'not_called', issues: ['missing_threshold']},
		});
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it('reports unapproved weather and retains available indoor observations without modifying policy or calling Ollama', async () => {
		const data = environmentData();
		data.policy!.deny.push({entityId: weatherId});
		const policy = structuredClone(data.policy);
		vi.mocked(deps.collect).mockResolvedValue(data);
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			context: {outdoorWeather: {status: 'missing_or_not_permitted'}},
			decision: {
				model: 'not_called',
				issues: ['weather_missing_or_not_permitted'],
				executionAuthority: 'none',
			},
		});
		expect(result.output).toContain('temperature');
		expect(result.output).toContain('humidity');
		expect(deps.chat).not.toHaveBeenCalled();
		expect(data.policy).toEqual(policy);
	});
	it('marks missing/stale indoor evidence explicitly rather than substituting weather or time', async () => {
		const data = environmentData();
		for (const id of [temperatureId, humidityId]) {
			stateFor(data, id).last_changed = '2026-10-10T19:00:00Z';
			stateFor(data, id).last_updated = '2026-10-10T19:00:00Z';
		}

		vi.mocked(deps.collect).mockResolvedValue(data);
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			decision: {model: 'not_called', issues: ['missing_or_unusable_indoor_environment']},
		});
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it('permits missing optional configured local-time/solar context and labels it unavailable', async () => {
		vi.mocked(deps.location).mockRejectedValue(new Error('private-test-token'));
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({context: {clock: {status: 'unavailable'}}});
		expect(result.output).not.toContain('private-test-token');
	});
	it('never emits names, installation identifiers, private configuration or untrusted model rationale', async () => {
		vi.mocked(deps.chat).mockResolvedValue(
			JSON.stringify(environmentProposal({rationale: 'private-test-token; turn on heating now'})),
		);
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(0);
		for (const forbidden of [
			weatherId,
			temperatureId,
			humidityId,
			'example_area',
			'example_device',
			'private-test-token',
			'turn on heating now',
		]) {
			expect(result.output).not.toContain(forbidden);
		}
	});
	it('keeps preflight diagnostics while optional collection latency makes the snapshot expire', async () => {
		let time = now;
		deps.now = () => time;
		vi.mocked(deps.location).mockImplementation(async () => {
			time += 300_001;
			return location;
		});
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('stale_snapshot');
		expect(deps.chat).not.toHaveBeenCalled();
	});
});
