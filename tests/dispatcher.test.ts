import {setTimeout as delay} from 'node:timers/promises';
import {beforeEach, describe, expect, expectTypeOf, it, vi} from 'vitest';
import {loadEntityPolicy} from '../src/config/policy.js';
import {env} from '../src/config/env.js';
import * as dispatcher from '../src/execution/dispatcher.js';
import {executeReadyCommands} from '../src/execution/dispatcher.js';
import {
	prepareExecutionReadyCommands,
	type ExecutionReadyCommand,
} from '../src/execution/readiness.js';
import type {DispatchAuthorizedCommand} from '../src/execution/revalidation.js';
import type {CanonicalAction} from '../src/home-assistant/capabilities.js';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import {getHomeAssistantRegistries} from '../src/home-assistant/registry-client.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {normalizeStates} from '../src/home-assistant/state-normalizer.js';
import {validatePlan, type ValidatedAction} from '../src/planning/policy.js';
import {runPlanningPipeline} from '../src/planning/pipeline.js';
import type {ProposedAction} from '../src/planning/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';
import type {EntityPolicy} from '../src/policy/schemas.js';

const http = vi.hoisted(() => {
	const get = vi.fn();
	const post = vi.fn();
	const options: unknown[] = [];
	return {
		get,
		post,
		options,
		extend: vi.fn((configuration: unknown) => {
			options.push(configuration);
			return {get, post};
		}),
	};
});
vi.mock('got', () => ({default: {extend: http.extend}}));
vi.mock('node:timers/promises', () => ({setTimeout: vi.fn().mockResolvedValue(undefined)}));
vi.mock('../src/config/env.js', () => ({
	env: {HA_URL: 'https://ha.example.test', HA_TOKEN: 'test-token', DRY_RUN: true},
}));
vi.mock('../src/config/policy.js', () => ({loadEntityPolicy: vi.fn()}));
vi.mock('../src/home-assistant/registry-client.js', () => ({getHomeAssistantRegistries: vi.fn()}));

const target = 'light.example_target';
const other = 'switch.example_other';
const policy: EntityPolicy = {version: 1, allow: [{domain: 'light'}, {domain: 'switch'}], deny: []};
const state = (entityId = target, value = 'off'): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {},
	last_changed: '2026-10-07T00:00:00+00:00',
	last_updated: '2026-10-07T00:00:00+00:00',
});
const registries = (entityIds = [target, other]) => ({
	status: 'available' as const,
	entities: entityIds.map((entityId) => ({
		entity_id: entityId,
		device_id: null,
		area_id: null,
		labels: [],
		disabled_by: null,
	})),
	devices: [],
	areas: [],
	labels: [],
});

const ready = (entityId = target, action: CanonicalAction = 'turn_on'): ExecutionReadyCommand => {
	const inventory = discoverEntities(
		[state(entityId, action === 'turn_on' ? 'off' : 'on')],
		registries([entityId]),
	);
	const plan = validatePlan(
		{
			outcome: 'propose_actions',
			summary: 'Example power plan.',
			actions: [{entityId, action, reason: 'Example instruction.'}],
		},
		resolveEntityPolicy(inventory, policy),
		new Set([entityId]),
	);
	return prepareExecutionReadyCommands(plan, normalizeStates(inventory)).commands[0]!;
};

const freshStates = vi.fn<() => Promise<HomeAssistantState[]>>();
const confirmation = vi.fn<(entityId: string) => Promise<{statusCode: number; body: unknown}>>();
let events: string[];
beforeEach(() => {
	vi.clearAllMocks();
	env.DRY_RUN = false;
	freshStates.mockReset().mockResolvedValue([state(), state(other)]);
	confirmation.mockReset().mockImplementation(async (entityId) => ({
		statusCode: 200,
		body: state(entityId, 'on'),
	}));
	events = [];
	http.get
		.mockReset()
		.mockImplementation(
			(
				path: string,
			):
				| Promise<{statusCode: number; body: unknown}>
				| {json: () => Promise<HomeAssistantState[]>} => {
				if (path === 'states') {
					events.push('fresh_authorization');
					return {json: freshStates};
				}

				events.push(`confirm:${path}`);
				return confirmation(path.slice('states/'.length));
			},
		);
	http.post.mockReset().mockImplementation(async (path: string) => {
		events.push(`post:${path}`);
		return {statusCode: 200, body: []};
	});
	vi.mocked(getHomeAssistantRegistries).mockReset().mockResolvedValue(registries());
	vi.mocked(loadEntityPolicy).mockReset().mockResolvedValue(policy);
});

describe('production dispatch and confirmation', () => {
	it.each(['nonempty', 'empty'])(
		'blocks %s execution with DRY_RUN=true before any reads',
		async (kind) => {
			env.DRY_RUN = true;
			const commands = kind === 'nonempty' ? [ready(), ready(other)] : [];
			const result = await executeReadyCommands(commands);

			expect(result).toEqual({
				outcome: 'execution_disabled',
				results: commands.map((_, index) => ({
					index,
					outcome: 'execution_disabled',
					reason: 'dry_run',
				})),
			});
			expect(http.post).not.toHaveBeenCalled();
			expect(http.get).not.toHaveBeenCalled();
			expect(confirmation).not.toHaveBeenCalled();
			expect(delay).not.toHaveBeenCalled();
			expect(freshStates).not.toHaveBeenCalled();
			expect(getHomeAssistantRegistries).not.toHaveBeenCalled();
			expect(loadEntityPolicy).not.toHaveBeenCalled();
		},
	);

	it('exports only the production execution entry point', () => {
		expect(Object.keys(dispatcher)).toEqual(['executeReadyCommands']);
	});

	it.each([true, false])('preserves read-only planning with DRY_RUN=%s', async (dryRun) => {
		env.DRY_RUN = dryRun;
		const inventory = discoverEntities([state()], registries([target]));
		const result = await runPlanningPipeline(
			`Turn on ${target}`,
			inventory,
			resolveEntityPolicy(inventory, policy),
			{
				model: 'example-model',
				maxRequestBytes: 100_000,
				chat: async () =>
					JSON.stringify({
						outcome: 'propose_actions',
						summary: 'Proposed plan: Turn on the example light.',
						actions: [{entityId: target, action: 'turn_on', reason: 'Example instruction.'}],
					}),
			},
		);

		expect(result.executionReadiness.outcome).toBe('ready');
		expect(result.executionReadiness.commands).toEqual([ready()]);
		expect(http.post).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
		expect(confirmation).not.toHaveBeenCalled();
	});

	it.each([
		{entityId: target, domain: 'light', action: 'turn_on' as const, before: 'off', after: 'on'},
		{entityId: target, domain: 'light', action: 'turn_off' as const, before: 'on', after: 'off'},
		{entityId: other, domain: 'switch', action: 'turn_on' as const, before: 'off', after: 'on'},
		{entityId: other, domain: 'switch', action: 'turn_off' as const, before: 'on', after: 'off'},
	])(
		'confirms $domain $action with DRY_RUN=false using an exact service POST and fresh GET',
		async (example) => {
			expect(env.DRY_RUN).toBe(false);
			freshStates.mockResolvedValue([state(example.entityId, example.before)]);
			confirmation.mockResolvedValue({
				statusCode: 200,
				body: state(example.entityId, example.after),
			});
			const result = await executeReadyCommands([ready(example.entityId, example.action)]);

			expect(result.outcome).toBe('all_confirmed');
			expect(result.results[0]).toMatchObject({index: 0, outcome: 'confirmed'});
			expect(http.post).toHaveBeenCalledExactlyOnceWith(
				`services/${example.domain}/${example.action}`,
				{
					json: {entity_id: example.entityId},
					responseType: 'json',
				},
			);
			expect(http.get).toHaveBeenLastCalledWith(`states/${example.entityId}`, {
				responseType: 'json',
				timeout: {request: 2000},
			});
			expect(events).toEqual([
				'fresh_authorization',
				`post:services/${example.domain}/${example.action}`,
				`confirm:states/${example.entityId}`,
			]);
			expect(freshStates).toHaveBeenCalledTimes(1);
			expect(confirmation).toHaveBeenCalledTimes(1);
			expect(delay).not.toHaveBeenCalled();
		},
	);

	it('keeps proposal, readiness, and authorization types separate', () => {
		expectTypeOf<ExecutionReadyCommand>().not.toMatchObjectType<DispatchAuthorizedCommand>();
		expectTypeOf<ValidatedAction>().not.toMatchObjectType<DispatchAuthorizedCommand>();
		expectTypeOf<ProposedAction>().not.toMatchObjectType<DispatchAuthorizedCommand>();
		expectTypeOf<typeof executeReadyCommands>().parameters.toEqualTypeOf<
			[commands: readonly ExecutionReadyCommand[]]
		>();
	});

	it('disables service redirects and automatic retries with a bounded request timeout', () => {
		expect(http.options).toContainEqual({
			prefixUrl: 'https://ha.example.test/api',
			headers: {authorization: 'Bearer test-token'},
			timeout: {request: 5000},
			retry: {limit: 0},
			followRedirect: false,
			throwHttpErrors: false,
		});
	});

	it.each([301, 400, 401, 404, 500])(
		'fails closed for service response %s without confirmation',
		async (statusCode) => {
			http.post.mockResolvedValue({statusCode, body: []});
			const result = await executeReadyCommands([ready()]);
			expect(result).toMatchObject({
				outcome: 'all_failed',
				results: [{outcome: 'dispatch_failed', reason: 'service_request_failed'}],
			});
			expect(http.post).toHaveBeenCalledTimes(1);
			expect(confirmation).not.toHaveBeenCalled();
		},
	);

	it('sanitizes transport errors without retrying the POST', async () => {
		http.post.mockRejectedValue(new Error('Example sensitive response and test-token.'));
		const result = await executeReadyCommands([ready()]);
		expect(result.results[0]).toMatchObject({
			outcome: 'dispatch_failed',
			reason: 'service_request_failed',
		});
		expect(JSON.stringify(result)).not.toContain('sensitive');
		expect(JSON.stringify(result)).not.toContain('test-token');
		expect(http.post).toHaveBeenCalledTimes(1);
		expect(confirmation).not.toHaveBeenCalled();
	});

	it.each([{}, [{}], null, 'invalid JSON'])(
		'rejects malformed service response %j',
		async (body) => {
			http.post.mockResolvedValue({statusCode: 200, body});
			const result = await executeReadyCommands([ready()]);
			expect(result.results[0]).toMatchObject({outcome: 'dispatch_failed'});
			expect(confirmation).not.toHaveBeenCalled();
		},
	);

	it('fails after five mismatches without using POST changed states as confirmation', async () => {
		http.post.mockResolvedValue({statusCode: 200, body: [state(target, 'on')]});
		confirmation.mockResolvedValue({statusCode: 200, body: state()});
		const result = await executeReadyCommands([ready()]);
		expect(result.results[0]).toMatchObject({
			outcome: 'confirmation_failed',
			reason: 'state_mismatch',
		});
		expect(confirmation).toHaveBeenCalledTimes(5);
		expect(http.post).toHaveBeenCalledTimes(1);
		expect(delay).toHaveBeenCalledTimes(4);
		for (let index = 1; index <= 4; index++) {
			expect(delay).toHaveBeenNthCalledWith(index, 500);
		}
	});

	it.each([2, 3, 5])(
		'confirms on read %s and stops polling without retrying the POST',
		async (expectedRead) => {
			for (let index = 1; index < expectedRead; index++) {
				confirmation.mockResolvedValueOnce({statusCode: 200, body: state()});
			}

			const result = await executeReadyCommands([ready()]);
			expect(result.outcome).toBe('all_confirmed');
			expect(result.results[0]).toMatchObject({outcome: 'confirmed'});
			expect(confirmation).toHaveBeenCalledTimes(expectedRead);
			expect(http.post).toHaveBeenCalledTimes(1);
			expect(delay).toHaveBeenCalledTimes(expectedRead - 1);
			for (let index = 1; index < expectedRead; index++) {
				expect(delay).toHaveBeenNthCalledWith(index, 500);
				const delayOrder = vi.mocked(delay).mock.invocationCallOrder[index - 1]!;
				expect(delayOrder).toBeGreaterThan(confirmation.mock.invocationCallOrder[index - 1]!);
				expect(delayOrder).toBeLessThan(confirmation.mock.invocationCallOrder[index]!);
			}
		},
	);

	it.each(['unknown', 'unavailable', 'unexpected'])(
		'rejects confirmation state %s without polling',
		async (value) => {
			confirmation.mockResolvedValue({statusCode: 200, body: state(target, value)});
			const result = await executeReadyCommands([ready()]);
			expect(result.results[0]).toMatchObject({
				outcome: 'confirmation_failed',
				reason: 'ineligible_state',
			});
			expect(confirmation).toHaveBeenCalledTimes(1);
			expect(delay).not.toHaveBeenCalled();
			expect(http.post).toHaveBeenCalledTimes(1);
		},
	);

	it('rejects a target disappearing after POST', async () => {
		confirmation.mockResolvedValue({statusCode: 404, body: {message: 'Example missing target'}});
		const result = await executeReadyCommands([ready()]);
		expect(result.results[0]).toMatchObject({
			outcome: 'confirmation_failed',
			reason: 'target_missing',
		});
		expect(confirmation).toHaveBeenCalledTimes(1);
		expect(delay).not.toHaveBeenCalled();
		expect(http.post).toHaveBeenCalledTimes(1);
	});

	it.each([
		{statusCode: 500, body: []},
		{statusCode: 200, body: {}},
		{statusCode: 200, body: state(other, 'on')},
	])('rejects invalid confirmation response %j', async (response) => {
		confirmation.mockResolvedValue(response);
		const result = await executeReadyCommands([ready()]);
		expect(result.results[0]).toMatchObject({
			outcome: 'confirmation_failed',
			reason: 'confirmation_read_failed',
		});
		expect(confirmation).toHaveBeenCalledTimes(1);
		expect(delay).not.toHaveBeenCalled();
		expect(http.post).toHaveBeenCalledTimes(1);
	});

	it.each(['Error', 'TimeoutError'])(
		'sanitizes failed confirmation reads (%s) immediately',
		async (name) => {
			const message = 'Example private error and test-token.';
			const error = name === 'TimeoutError' ? new DOMException(message, name) : new Error(message);
			confirmation.mockRejectedValue(error);
			const result = await executeReadyCommands([ready()]);
			expect(result.results[0]).toMatchObject({
				outcome: 'confirmation_failed',
				reason: 'confirmation_read_failed',
			});
			expect(JSON.stringify(result)).not.toContain('private');
			expect(JSON.stringify(result)).not.toContain('test-token');
			expect(confirmation).toHaveBeenCalledTimes(1);
			expect(delay).not.toHaveBeenCalled();
			expect(http.post).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		{statusCode: 200, body: state(target, 'unavailable'), reason: 'ineligible_state'},
		{statusCode: 200, body: state(target, 'unknown'), reason: 'ineligible_state'},
		{statusCode: 200, body: state(target, 'unexpected'), reason: 'ineligible_state'},
		{statusCode: 404, body: {}, reason: 'target_missing'},
		{statusCode: 200, body: {}, reason: 'confirmation_read_failed'},
		{statusCode: 200, body: state(other, 'on'), reason: 'confirmation_read_failed'},
		{statusCode: 500, body: {}, reason: 'confirmation_read_failed'},
	])(
		'stops polling after a mismatch followed by terminal response %j',
		async ({statusCode, body, reason}) => {
			confirmation
				.mockResolvedValueOnce({statusCode: 200, body: state()})
				.mockResolvedValueOnce({statusCode, body});
			const result = await executeReadyCommands([ready()]);
			expect(result.results[0]).toMatchObject({outcome: 'confirmation_failed', reason});
			expect(confirmation).toHaveBeenCalledTimes(2);
			expect(delay).toHaveBeenCalledExactlyOnceWith(500);
			expect(http.post).toHaveBeenCalledTimes(1);
		},
	);

	it('executes sequentially and reauthorizes later targets after confirmation', async () => {
		const result = await executeReadyCommands([ready(), ready(other)]);
		expect(result.outcome).toBe('all_confirmed');
		expect(result.results.map((item) => item.index)).toEqual([0, 1]);
		expect(events).toEqual([
			'fresh_authorization',
			'post:services/light/turn_on',
			`confirm:states/${target}`,
			'fresh_authorization',
			'post:services/switch/turn_on',
			`confirm:states/${other}`,
		]);
		expect(loadEntityPolicy).toHaveBeenCalledTimes(2);
		expect(getHomeAssistantRegistries).toHaveBeenCalledTimes(2);
	});

	it('reports partial success and continues without rollback', async () => {
		http.post.mockResolvedValueOnce({statusCode: 500, body: []});
		const result = await executeReadyCommands([ready(), ready(other)]);
		expect(result.outcome).toBe('partial_success');
		expect(result.results.map((item) => item.outcome)).toEqual(['dispatch_failed', 'confirmed']);
		expect(http.post).toHaveBeenCalledTimes(2);
	});

	it('reports all failed when every POST fails', async () => {
		http.post.mockRejectedValue(new Error('Example transport failure'));
		const result = await executeReadyCommands([ready(), ready(other)]);
		expect(result.outcome).toBe('all_failed');
		expect(result.results.map((item) => item.outcome)).toEqual([
			'dispatch_failed',
			'dispatch_failed',
		]);
		expect(confirmation).not.toHaveBeenCalled();
	});

	it('never dispatches fresh-policy-rejected commands and preserves input indices', async () => {
		vi.mocked(loadEntityPolicy).mockResolvedValue({...policy, deny: [{entityId: target}]});
		const result = await executeReadyCommands([ready(), ready(other)]);
		expect(result.outcome).toBe('partial_success');
		expect(result.results).toMatchObject([
			{index: 0, outcome: 'skipped_not_authorized', reason: 'denied'},
			{index: 1, outcome: 'confirmed'},
		]);
		expect(http.post).toHaveBeenCalledTimes(1);
		expect(http.post).toHaveBeenCalledWith('services/switch/turn_on', expect.anything());
	});

	it('discards later authorization if policy changes during earlier confirmation', async () => {
		confirmation.mockImplementation(async (entityId) => {
			vi.mocked(loadEntityPolicy).mockResolvedValue({...policy, deny: [{entityId: other}]});
			return {statusCode: 200, body: state(entityId, 'on')};
		});
		const result = await executeReadyCommands([ready(), ready(other)]);
		expect(result.outcome).toBe('partial_success');
		expect(result.results[1]).toMatchObject({
			index: 1,
			outcome: 'skipped_not_authorized',
			reason: 'denied',
		});
		expect(http.post).toHaveBeenCalledTimes(1);
	});

	it('discards later authorization when state becomes a no-op', async () => {
		freshStates
			.mockResolvedValueOnce([state(), state(other)])
			.mockResolvedValue([state(target, 'on'), state(other, 'on')]);
		const result = await executeReadyCommands([ready(), ready(other)]);
		expect(result.results[1]).toMatchObject({
			outcome: 'skipped_not_authorized',
			reason: 'fresh_no_op',
		});
		expect(http.post).toHaveBeenCalledTimes(1);
	});

	it('does not dispatch when revalidation authorizes none', async () => {
		vi.mocked(loadEntityPolicy).mockResolvedValue({version: 1, allow: [], deny: []});
		const result = await executeReadyCommands([ready()]);
		expect(result.outcome).toBe('no_authorized_commands');
		expect(result.results[0]).toMatchObject({
			outcome: 'skipped_not_authorized',
			reason: 'not_allowed',
		});
		expect(http.post).not.toHaveBeenCalled();
		expect(confirmation).not.toHaveBeenCalled();
	});

	it('does not dispatch when fresh registry metadata is unavailable', async () => {
		vi.mocked(getHomeAssistantRegistries).mockResolvedValue({status: 'unavailable'});
		const result = await executeReadyCommands([ready()]);
		expect(result.outcome).toBe('no_authorized_commands');
		expect(result.results[0]).toMatchObject({reason: 'snapshot_unavailable'});
		expect(http.post).not.toHaveBeenCalled();
	});

	it('rejects duplicate and conflicting batch targets before any service call', async () => {
		const result = await executeReadyCommands([ready(), ready(target, 'turn_off')]);
		expect(result.outcome).toBe('no_authorized_commands');
		expect(result.results.map((item) => item.outcome)).toEqual([
			'skipped_not_authorized',
			'skipped_not_authorized',
		]);
		expect(http.post).not.toHaveBeenCalled();
	});

	it('returns empty results without reads or POSTs for empty input', async () => {
		expect(await executeReadyCommands([])).toEqual({
			outcome: 'no_authorized_commands',
			results: [],
		});
		expect(http.get).not.toHaveBeenCalled();
		expect(http.post).not.toHaveBeenCalled();
		expect(loadEntityPolicy).not.toHaveBeenCalled();
	});

	it.each([
		{domain: 'lock'},
		{service: 'unlock'},
		{data: {brightness: 100}},
		{reason: 'Model says use a different service'},
		{target: {entity_id: target, area_id: 'example_area'}},
	])('rejects forged service input %j before private transport dispatch', async (change) => {
		const untrusted = {...ready(), ...change};
		const command = untrusted as ExecutionReadyCommand;
		const result = await executeReadyCommands([command]);
		expect(result.outcome).toBe('no_authorized_commands');
		expect(result.results[0]).toMatchObject({outcome: 'skipped_not_authorized'});
		expect(http.post).not.toHaveBeenCalled();
	});
});
