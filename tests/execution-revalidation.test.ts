import {afterEach, describe, expect, expectTypeOf, it, vi} from 'vitest';
import {loadEntityPolicy} from '../src/config/policy.js';
import {
	prepareExecutionReadyCommands,
	type ExecutionReadyCommand,
} from '../src/execution/readiness.js';
import {
	revalidateForDispatch,
	type DispatchAuthorizedCommand,
	type PreDispatchRevalidationResult,
} from '../src/execution/revalidation.js';
import * as capabilities from '../src/home-assistant/capabilities.js';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import {
	getHomeAssistantRegistries,
	type RegistrySnapshot,
} from '../src/home-assistant/registry-client.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {normalizeStates} from '../src/home-assistant/state-normalizer.js';
import {validatePlan} from '../src/planning/policy.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';
import type {EntityPolicy} from '../src/policy/schemas.js';

const http = vi.hoisted(() => {
	const get = vi.fn();
	const post = vi.fn();
	return {get, post, extend: vi.fn(() => ({get, post}))};
});
vi.mock('got', () => ({default: {extend: http.extend}}));
vi.mock('../src/config/env.js', () => ({
	env: {HA_URL: 'https://ha.example.test', HA_TOKEN: 'test-token', DRY_RUN: false},
}));
vi.mock('../src/config/policy.js', () => ({loadEntityPolicy: vi.fn()}));
vi.mock('../src/home-assistant/registry-client.js', () => ({getHomeAssistantRegistries: vi.fn()}));

const target = 'light.example_target';
const other = 'switch.example_other';
const allowPolicy: EntityPolicy = {
	version: 1,
	allow: [{domain: 'light'}, {domain: 'switch'}],
	deny: [],
};

const state = (entityId = target, value = 'off'): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {friendly_name: 'Example target'},
	last_changed: '2026-09-09T20:00:00+00:00',
	last_updated: '2026-09-09T20:00:00+00:00',
});

const registries = (entityIds = [target]): Extract<RegistrySnapshot, {status: 'available'}> => ({
	status: 'available',
	entities: entityIds.map((entityId) => ({
		entity_id: entityId,
		device_id: 'example_device',
		area_id: null,
		labels: ['example_label'],
		disabled_by: null,
	})),
	devices: [{id: 'example_device', area_id: 'example_area', labels: [], disabled_by: null}],
	areas: [{area_id: 'example_area', name: 'Example Room', aliases: [], labels: []}],
	labels: [{label_id: 'example_label'}],
});

const ready = (
	entityId = target,
	action: capabilities.CanonicalAction = 'turn_on',
	policy: EntityPolicy = allowPolicy,
): ExecutionReadyCommand => {
	const entities = discoverEntities(
		[state(entityId, action === 'turn_on' ? 'off' : 'on')],
		registries([entityId]),
	);
	const plan = validatePlan(
		{
			outcome: 'propose_actions',
			summary: 'Proposed plan: Change the example target.',
			actions: [{entityId, action, reason: 'The example instruction requests this change.'}],
		},
		resolveEntityPolicy(entities, policy),
		new Set([entityId]),
	);
	const result = prepareExecutionReadyCommands(plan, normalizeStates(entities));
	expect(result.outcome).toBe('ready');
	return result.commands[0]!;
};

const readers = (
	states = [state()],
	metadata: RegistrySnapshot = registries(states.map((item) => item.entity_id)),
	policy: EntityPolicy = allowPolicy,
) => ({
	getStates: vi.fn<() => Promise<HomeAssistantState[]>>().mockResolvedValue(states),
	getRegistries: vi.fn<() => Promise<RegistrySnapshot>>().mockResolvedValue(metadata),
	loadPolicy: vi.fn<() => Promise<EntityPolicy>>().mockResolvedValue(policy),
});

// Test-only fixture wiring; every call still enters the production function and its real readers.
const revalidateWithMockedReaders = async (
	commands: readonly ExecutionReadyCommand[],
	source = readers(),
) => {
	http.get.mockReturnValue({json: source.getStates});
	vi.mocked(getHomeAssistantRegistries).mockImplementation(source.getRegistries);
	vi.mocked(loadEntityPolicy).mockImplementation(source.loadPolicy);
	return revalidateForDispatch(commands);
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('fresh pre-dispatch revalidation', () => {
	it('does not accept caller-supplied readers even when passed as an extra runtime argument', async () => {
		expectTypeOf<typeof revalidateForDispatch>().parameters.toEqualTypeOf<
			[commands: readonly ExecutionReadyCommand[]]
		>();
		const staleReaders = readers();
		http.get.mockReturnValue({json: async () => [state(target, 'on')]});
		vi.mocked(getHomeAssistantRegistries).mockResolvedValue(registries());
		vi.mocked(loadEntityPolicy).mockResolvedValue(allowPolicy);
		const result = (await Reflect.apply(revalidateForDispatch, undefined, [
			[ready()],
			staleReaders,
		])) as PreDispatchRevalidationResult;

		expect(result.outcome).toBe('rejected');
		expect(result.decisions[0]).toMatchObject({reason: 'fresh_no_op'});
		expect(staleReaders.getStates).not.toHaveBeenCalled();
		expect(staleReaders.getRegistries).not.toHaveBeenCalled();
		expect(staleReaders.loadPolicy).not.toHaveBeenCalled();
		expect(http.get).toHaveBeenCalledExactlyOnceWith('states');
		expect(getHomeAssistantRegistries).toHaveBeenCalledTimes(1);
		expect(loadEntityPolicy).toHaveBeenCalledTimes(1);
		expect(http.post).not.toHaveBeenCalled();
	});

	it.each([
		{entityId: target, action: 'turn_on' as const, currentState: 'off'},
		{entityId: target, action: 'turn_off' as const, currentState: 'on'},
		{entityId: other, action: 'turn_on' as const, currentState: 'off'},
		{entityId: other, action: 'turn_off' as const, currentState: 'on'},
	])(
		'authorizes $entityId $action from fresh $currentState',
		async ({entityId, action, currentState}) => {
			const command = ready(entityId, action);
			const result = await revalidateWithMockedReaders(
				[command],
				readers([state(entityId, currentState)]),
			);

			expect(result.outcome).toBe('authorized');
			expect(result.commands).toEqual([command]);
			expect(result.commands[0]).not.toBe(command);
			expect(result.decisions).toEqual([
				{index: 0, status: 'authorized', command: result.commands[0]},
			]);
			expect(Object.isFrozen(result.commands[0])).toBe(true);
			expect(Object.isFrozen(result.commands[0]?.target)).toBe(true);
			expectTypeOf<ExecutionReadyCommand>().not.toMatchObjectType<DispatchAuthorizedCommand>();
		},
	);

	it.each([
		{action: 'turn_on' as const, currentState: 'on'},
		{action: 'turn_off' as const, currentState: 'off'},
	])(
		'rejects $action when fresh state is already $currentState',
		async ({action, currentState}) => {
			const result = await revalidateWithMockedReaders(
				[ready(target, action)],
				readers([state(target, currentState)]),
			);

			expect(result.outcome).toBe('rejected');
			expect(result.commands).toEqual([]);
			expect(result.decisions).toEqual([
				{index: 0, status: 'rejected', entityId: target, reason: 'fresh_no_op'},
			]);
		},
	);

	it('rejects a target removed from fresh states even if it remains in the registry', async () => {
		const result = await revalidateWithMockedReaders([ready()], readers([], registries()));

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'target_missing'});
	});

	it.each(['unavailable', 'unknown', 'unexpected'])(
		'rejects fresh state %s as ineligible',
		async (value) => {
			const result = await revalidateWithMockedReaders([ready()], readers([state(target, value)]));

			expect(result.outcome).toBe('rejected');
			expect(result.commands).toEqual([]);
			expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'ineligible_state'});
		},
	);

	it.each(['entity', 'device', 'parent'])('rejects fresh %s disablement', async (source) => {
		const metadata = registries();
		if (source === 'entity') {
			metadata.entities[0]!.disabled_by = 'user';
		} else if (source === 'device') {
			metadata.devices[0]!.disabled_by = 'user';
		} else {
			metadata.devices[0]!.parent_device_id = 'example_parent';
			metadata.devices.push({id: 'example_parent', area_id: null, labels: [], disabled_by: 'user'});
		}

		const result = await revalidateWithMockedReaders([ready()], readers([state()], metadata));

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'ineligible_state'});
	});

	it.each(['device', 'area', 'label'])('rejects incomplete fresh %s metadata', async (source) => {
		const metadata = registries();
		if (source === 'device') {
			metadata.devices = [];
		} else if (source === 'area') {
			metadata.areas = [];
		} else {
			metadata.labels = [];
		}

		const result = await revalidateWithMockedReaders([ready()], readers([state()], metadata));

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'ineligible_state'});
	});

	it('rejects a removed allow rule using the newly loaded policy', async () => {
		const command = ready();
		const result = await revalidateWithMockedReaders(
			[command],
			readers([state()], registries(), {
				version: 1,
				allow: [],
				deny: [],
			}),
		);

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'not_allowed'});
	});

	it('preserves deny-overrides-allow when a deny is added after planning', async () => {
		const command = ready();
		const result = await revalidateWithMockedReaders(
			[command],
			readers([state()], registries(), {
				...allowPolicy,
				deny: [{entityId: target}],
			}),
		);

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'denied'});
	});

	it.each(['area', 'device', 'label'] as const)(
		're-resolves a %s allow against changed registry metadata',
		async (field) => {
			const selector = {
				area: {areaId: 'example_area'},
				device: {deviceId: 'example_device'},
				label: {labelId: 'example_label'},
			}[field];
			const policy: EntityPolicy = {version: 2, allow: [selector], deny: []};
			const command = ready(target, 'turn_on', policy);
			const metadata = registries();
			if (field === 'area') {
				metadata.devices[0]!.area_id = 'example_other_area';
				metadata.areas.push({
					area_id: 'example_other_area',
					name: 'Other Room',
					aliases: [],
					labels: [],
				});
			} else if (field === 'device') {
				metadata.entities[0]!.device_id = 'example_other_device';
				metadata.devices.push({
					id: 'example_other_device',
					area_id: null,
					labels: [],
					disabled_by: null,
				});
			} else {
				metadata.entities[0]!.labels = [];
			}

			const result = await revalidateWithMockedReaders(
				[command],
				readers([state()], metadata, policy),
			);

			expect(result.commands).toEqual([]);
			expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'not_allowed'});
		},
	);

	it('rejects when a fresh label assignment now matches a deny selector', async () => {
		const policy: EntityPolicy = {
			version: 2,
			allow: [{domain: 'light'}],
			deny: [{labelId: 'example_denied'}],
		};
		const command = ready(target, 'turn_on', policy);
		const metadata = registries();
		metadata.entities[0]!.labels.push('example_denied');
		metadata.labels.push({label_id: 'example_denied'});
		const result = await revalidateWithMockedReaders(
			[command],
			readers([state()], metadata, policy),
		);

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'denied'});
	});

	it.each([{domain: 'switch'}, {service: 'light.turn_on'}])(
		'rejects supplied routing mismatch %j',
		async (change) => {
			const untrusted = {...ready(), ...change};
			const command = untrusted as ExecutionReadyCommand;
			const result = await revalidateWithMockedReaders([command], readers());

			expect(result.commands).toEqual([]);
			expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'routing_mismatch'});
		},
	);

	it.each(['getSupportedActions', 'resolveAction'] as const)(
		'fails closed when %s no longer supports the action',
		async (method) => {
			const command = ready();
			if (method === 'getSupportedActions') {
				vi.spyOn(capabilities, method).mockReturnValue([]);
			} else {
				vi.spyOn(capabilities, method).mockReturnValue(undefined);
			}

			const result = await revalidateWithMockedReaders([command], readers());

			expect(result.commands).toEqual([]);
			expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'unsupported_action'});
		},
	);

	it.each([
		{domain: 'light' as const, service: 'turn_off' as const},
		{domain: 'switch' as const, service: 'turn_on' as const},
	])('compares against freshly resolved routing %j', async (resolved) => {
		const command = ready();
		vi.spyOn(capabilities, 'resolveAction').mockReturnValue(resolved);
		const result = await revalidateWithMockedReaders([command], readers());

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({status: 'rejected', reason: 'routing_mismatch'});
	});

	it.each([
		{domain: 'binary_sensor', deviceClass: 'occupancy', value: 'off', reason: 'unsupported_action'},
		{domain: 'binary_sensor', deviceClass: 'presence', value: 'off', reason: 'unsupported_action'},
		{domain: 'sensor', deviceClass: 'temperature', value: '21', reason: 'ineligible_state'},
		{domain: 'sensor', deviceClass: 'humidity', value: '45', reason: 'ineligible_state'},
	])(
		'never authorizes a forged command targeting a $deviceClass observation',
		async ({domain, deviceClass, value, reason}) => {
			const entityId = `${domain}.example_observation`;
			const command = {
				domain,
				service: 'turn_on',
				target: {entity_id: entityId},
			} as unknown as ExecutionReadyCommand;
			const result = await revalidateWithMockedReaders(
				[command],
				readers(
					[{...state(entityId, value), attributes: {device_class: deviceClass}}],
					registries([entityId]),
					{
						version: 1,
						allow: [{domain}],
						deny: [],
					},
				),
			);

			expect(result.commands).toEqual([]);
			expect(result.decisions[0]).toMatchObject({status: 'rejected', reason});
		},
	);

	it('uses one fresh snapshot and policy resolution for multiple commands in input order', async () => {
		const commands = [ready(other), ready()];
		const source = readers([state(), state(other)]);
		const result = await revalidateWithMockedReaders(commands, source);

		expect(result.outcome).toBe('authorized');
		expect(result.commands).toEqual(commands);
		expect(result.decisions.map((item) => item.index)).toEqual([0, 1]);
		expect(source.getStates).toHaveBeenCalledTimes(1);
		expect(source.getRegistries).toHaveBeenCalledTimes(1);
		expect(source.loadPolicy).toHaveBeenCalledTimes(1);
	});

	it('preserves ordered decisions in a mixed batch without replacing rejected commands', async () => {
		const commands = [ready(), ready(other), ready('light.example_missing')];
		const result = await revalidateWithMockedReaders(
			commands,
			readers([state(target, 'on'), state(other)]),
		);

		expect(result.outcome).toBe('authorized');
		expect(result.commands).toEqual([commands[1]]);
		expect(result.decisions).toEqual([
			{index: 0, status: 'rejected', entityId: target, reason: 'fresh_no_op'},
			{index: 1, status: 'authorized', command: result.commands[0]},
			{index: 2, status: 'rejected', entityId: 'light.example_missing', reason: 'target_missing'},
		]);
	});

	it('distinguishes an entirely rejected batch from empty input', async () => {
		const result = await revalidateWithMockedReaders(
			[ready(), ready(other)],
			readers([state(target, 'on')]),
		);

		expect(result.outcome).toBe('rejected');
		expect(result.commands).toEqual([]);
		expect(result.decisions).toHaveLength(2);
	});

	it('returns no_commands without reading any state, registries, or policy', async () => {
		const source = readers();
		expect(await revalidateWithMockedReaders([], source)).toEqual({
			outcome: 'no_commands',
			commands: [],
			decisions: [],
		});
		expect(await revalidateForDispatch([])).toEqual({
			outcome: 'no_commands',
			commands: [],
			decisions: [],
		});
		expect(source.getStates).not.toHaveBeenCalled();
		expect(source.getRegistries).not.toHaveBeenCalled();
		expect(source.loadPolicy).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
	});

	it('reads a new snapshot and policy on every invocation instead of caching planning inputs', async () => {
		const command = ready();
		const source = readers();
		const initial = await revalidateWithMockedReaders([command], source);
		expect(initial.outcome).toBe('authorized');
		source.getStates.mockResolvedValue([state(target, 'on')]);
		const changedState = await revalidateWithMockedReaders([command], source);
		expect(changedState.decisions[0]).toMatchObject({
			reason: 'fresh_no_op',
		});
		source.getStates.mockResolvedValue([state()]);
		source.loadPolicy.mockResolvedValue({version: 1, allow: [], deny: []});
		const changedPolicy = await revalidateWithMockedReaders([command], source);
		expect(changedPolicy.decisions[0]).toMatchObject({
			reason: 'not_allowed',
		});
		expect(source.getStates).toHaveBeenCalledTimes(3);
		expect(source.getRegistries).toHaveBeenCalledTimes(3);
		expect(source.loadPolicy).toHaveBeenCalledTimes(3);
	});

	it('captures command input before awaiting fresh reads', async () => {
		const original = ready();
		const commands = [original];
		const source = readers();
		source.getStates.mockImplementation(async () => {
			commands[0] = ready(other);
			return [state(), state(other)];
		});
		const result = await revalidateWithMockedReaders(commands, source);

		expect(commands[0]?.target.entity_id).toBe(other);
		expect(result.commands).toEqual([original]);
	});

	it.each(['getStates', 'getRegistries', 'loadPolicy'] as const)(
		'fails closed when %s fails without returning error details',
		async (method) => {
			const source = readers([state(), state(other)]);
			source[method].mockRejectedValue(new Error('Example sensitive transport details.'));
			const result = await revalidateWithMockedReaders([ready(), ready(other)], source);

			expect(result.outcome).toBe('rejected');
			expect(result.commands).toEqual([]);
			expect(result.decisions.map((item) => item.status === 'rejected' && item.reason)).toEqual([
				'snapshot_unavailable',
				'snapshot_unavailable',
			]);
			expect(JSON.stringify(result)).not.toContain('sensitive transport');
		},
	);

	it('rejects registry failure even for conclusive legacy policy', async () => {
		const result = await revalidateWithMockedReaders(
			[ready()],
			readers([state()], {status: 'unavailable'}),
		);

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({reason: 'snapshot_unavailable'});
	});

	it('rejects malformed fresh policy instead of using planning permission', async () => {
		const source = readers();
		source.loadPolicy.mockResolvedValue({
			version: 99,
			allow: [],
			deny: [],
		} as unknown as EntityPolicy);
		const result = await revalidateWithMockedReaders([ready()], source);

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({reason: 'snapshot_unavailable'});
	});

	it('rejects malformed fresh states', async () => {
		const source = readers();
		source.getStates.mockResolvedValue([{}] as HomeAssistantState[]);
		const result = await revalidateWithMockedReaders([ready()], source);

		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({reason: 'snapshot_unavailable'});
	});

	it('rejects duplicate registry identifiers across the batch', async () => {
		const metadata = registries([target, other]);
		metadata.entities.push(metadata.entities[0]!);
		const result = await revalidateWithMockedReaders(
			[ready(), ready(other)],
			readers([state(), state(other)], metadata),
		);

		expect(result.outcome).toBe('rejected');
		expect(result.commands).toEqual([]);
		expect(result.decisions[0]).toMatchObject({reason: 'snapshot_unavailable'});
	});

	it('rejects ambiguous fresh target state while allowing an unrelated target', async () => {
		const result = await revalidateWithMockedReaders(
			[ready(), ready(other)],
			readers([state(), state(target, 'on'), state(other)], registries([target, other])),
		);

		expect(result.commands).toEqual([ready(other)]);
		expect(result.decisions[0]).toMatchObject({reason: 'ambiguous_target'});
	});

	it.each(['duplicate', 'conflict'])(
		'rejects repeated batch targets with %s commands',
		async (kind) => {
			const result = await revalidateWithMockedReaders(
				[ready(), ready(target, kind === 'duplicate' ? 'turn_on' : 'turn_off')],
				readers(),
			);

			expect(result.outcome).toBe('rejected');
			expect(result.commands).toEqual([]);
			expect(result.decisions).toEqual([
				{index: 0, status: 'rejected', entityId: target, reason: 'ambiguous_target'},
				{index: 1, status: 'rejected', entityId: target, reason: 'ambiguous_target'},
			]);
		},
	);

	it.each([
		{data: {unexpected: true}},
		{target: {entity_id: target, device_id: 'example_arbitrary_device'}},
		{target: {entity_id: [target]}},
		{target: {entity_id: 'light.example/invalid'}},
		{reason: 'Example model descriptive text.'},
	])('rejects arbitrary input fields or targets %j without echoing payloads', async (change) => {
		const command = {...ready(), ...change} as unknown as ExecutionReadyCommand;
		const result = await revalidateWithMockedReaders([command], readers());

		expect(result.commands).toEqual([]);
		expect(result.decisions).toEqual([{index: 0, status: 'rejected', reason: 'invalid_command'}]);
	});

	it('returns only command fields and reason codes without fresh registry metadata', async () => {
		const metadata = registries();
		metadata.areas[0]!.name = 'Example Sensitive Room';
		const result = await revalidateWithMockedReaders([ready()], readers([state()], metadata));
		const serialized = JSON.stringify(result);

		expect(result.commands).toEqual([
			{domain: 'light', service: 'turn_on', target: {entity_id: target}},
		]);
		expect(serialized).not.toContain('example_device');
		expect(serialized).not.toContain('example_area');
		expect(serialized).not.toContain('example_label');
		expect(serialized).not.toContain('Sensitive Room');
	});

	it('uses the existing read-only REST and registry readers once per batch even with DRY_RUN=false', async () => {
		const commands = [ready(), ready(other)];
		http.get.mockReturnValue({json: async () => [state(), state(other)]});
		vi.mocked(getHomeAssistantRegistries).mockResolvedValue(registries([target, other]));
		vi.mocked(loadEntityPolicy).mockResolvedValue(allowPolicy);
		const result = await revalidateForDispatch(commands);

		expect(result.outcome).toBe('authorized');
		expect(result.commands).toEqual(commands);
		expect(http.get).toHaveBeenCalledExactlyOnceWith('states');
		expect(http.post).not.toHaveBeenCalled();
		expect(getHomeAssistantRegistries).toHaveBeenCalledExactlyOnceWith(
			'https://ha.example.test',
			'test-token',
		);
		expect(loadEntityPolicy).toHaveBeenCalledTimes(1);
	});
});
