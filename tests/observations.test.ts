import {Buffer} from 'node:buffer';
import {describe, expect, expectTypeOf, it, vi} from 'vitest';
import {ZodError} from 'zod';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {RegistrySnapshot} from '../src/home-assistant/registry-client.js';
import {homeAssistantStatesSchema, type HomeAssistantState} from '../src/home-assistant/schemas.js';
import {normalizeStates} from '../src/home-assistant/state-normalizer.js';
import {
	prepareExecutionReadyCommands,
	type ExecutionReadyCommand,
} from '../src/execution/readiness.js';
import type {DispatchAuthorizedCommand} from '../src/execution/revalidation.js';
import {createOllamaChatPayload} from '../src/ollama/request.js';
import type {OllamaChatTransport} from '../src/ollama/client.js';
import {runPlanningPipeline} from '../src/planning/pipeline.js';
import {createPlanningChatRequest, planningRequestBytes} from '../src/planning/planner.js';
import {outputHeadroomBytes} from '../src/planning/relevance.js';
import {toObservationState, type ObservationState} from '../src/planning/observations.js';
import {validatePlan, type PlanValidationResult} from '../src/planning/policy.js';
import type {Plan, ProposedAction} from '../src/planning/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';
import type {EntityPolicy} from '../src/policy/schemas.js';

const state = (
	entityId: string,
	value: string,
	deviceClass?: string,
	unit?: string,
): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {
		friendly_name: `Example ${entityId.split('.', 2)[1]}`,
		device_class: deviceClass,
		unit_of_measurement: unit,
		area_name: 'Untrusted Fallback Area',
		arbitrary_attribute: 'private_attribute_marker',
	},
	last_changed: '2026-10-07T00:00:00+00:00',
	last_updated: '2026-10-07T00:00:00+00:00',
});
const defaultStates = [
	state('light.example_living_first', 'on'),
	state('light.example_living_second', 'on'),
	state('light.example_living_satisfied', 'off'),
	state('light.example_bedroom_first', 'on'),
	state('light.example_bedroom_second', 'on'),
	state('switch.example_living_plug', 'on'),
	state('binary_sensor.example_living_occupancy', 'off', 'occupancy'),
	state('binary_sensor.example_living_presence', 'off', 'presence'),
	state('binary_sensor.example_bedroom_occupancy', 'on', 'occupancy'),
	state('sensor.example_living_temperature', '21.5', 'temperature', '°C'),
	state('sensor.example_living_humidity', '45', 'humidity', '%'),
	state('sensor.example_bedroom_temperature', '19', 'temperature', '°C'),
	state('binary_sensor.example_living_motion', 'off', 'motion'),
	state('sensor.example_living_energy', '10', 'energy', 'kWh'),
];
const allowedPolicy: EntityPolicy = {
	version: 1,
	allow: [{domain: 'light'}, {domain: 'switch'}, {domain: 'binary_sensor'}, {domain: 'sensor'}],
	deny: [],
};
type AvailableRegistry = Extract<RegistrySnapshot, {status: 'available'}>;
const fixture = (
	states = defaultStates,
	configuredPolicy = allowedPolicy,
	mutateRegistry?: (registry: AvailableRegistry) => void,
) => {
	const registry: AvailableRegistry = {
		status: 'available',
		entities: states.map(({entity_id: entityId}) => ({
			entity_id: entityId,
			device_id: null,
			area_id: entityId.includes('bedroom') ? 'fixture_bedroom' : 'fixture_living',
			labels: [],
			disabled_by: null,
		})),
		devices: [],
		areas: [
			{area_id: 'fixture_living', name: 'Living Room', aliases: ['Lounge'], labels: []},
			{area_id: 'fixture_bedroom', name: 'Bedroom', aliases: [], labels: []},
		],
		labels: [],
	};
	mutateRegistry?.(registry);
	const entities = discoverEntities(homeAssistantStatesSchema.parse(states), registry);
	return {entities, policy: resolveEntityPolicy(entities, configuredPolicy)};
};

const options = {model: 'example-model', maxRequestBytes: 100_000};
const plan = (actions: Plan['actions'] = []): Plan => ({
	outcome: actions.length > 0 ? 'propose_actions' : 'no_action',
	summary: 'Proposed plan: Consider the requested change.',
	actions,
});
const lightSetIntent: Plan['actions'][number] = {
	type: 'set_action',
	action: 'turn_off',
	scope: {area: 'Living Room', domain: 'light'},
	reason: 'The user requested switching off the complete light set in unoccupied rooms.',
};
const conditionalGoal =
	'Save energy by turning off lights in rooms that are unoccupied, but leave occupied rooms unchanged.';
type ModelContext = {
	states: Array<Record<string, unknown>>;
	observations: Array<Record<string, unknown>>;
	setScopes?: unknown[];
};
const run = async (instruction: string, input = fixture(), actions: Plan['actions'] = []) => {
	const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(plan(actions)));
	const result = await runPlanningPipeline(instruction, input.entities, input.policy, {
		...options,
		chat,
	});
	const request = chat.mock.calls[0]?.[0];
	const context =
		request === undefined ? undefined : (JSON.parse(request.messages[1]!.content) as ModelContext);
	return {result, chat, request, context};
};

const unassignedLightId = 'light.example_unassigned_helper';
const unassignedLightName = 'Example Unassigned Helper';
const fixtureWithUnassignedLight = (
	states = defaultStates.filter(({entity_id: entityId}) => !entityId.includes('bedroom')),
) =>
	fixture(
		[
			...states,
			{
				...state(unassignedLightId, 'on'),
				attributes: {friendly_name: unassignedLightName},
			},
		],
		allowedPolicy,
		(registry) => {
			registry.entities.find(({entity_id: entityId}) => entityId === unassignedLightId)!.area_id =
				null;
		},
	);

describe('presence-language normalization in planning', () => {
	it.each(['No one', 'No-one', 'Noone', 'Nobody'])(
		'supplies evidence for %s without inventing a control proposal',
		async (variant) => {
			const instruction = `${variant} is at home. The lights are on.`;
			const {result, context, request} = await run(instruction);
			expect(result.selection).toMatchObject({kind: 'ready', intentMode: 'mixed'});
			expect(context?.observations.map(({deviceClass}) => deviceClass)).toEqual([
				'occupancy',
				'presence',
				'occupancy',
			]);
			expect(
				context?.observations.every((observation) => !('supportedActions' in observation)),
			).toBe(true);
			expect(request?.messages[1]?.content).toContain(JSON.stringify(instruction));
			expect(result.validatedPlan).toMatchObject({outcome: 'no_action', actions: []});
			expect(result.executionReadiness.commands).toEqual([]);
		},
	);

	it.each(['no one', 'no-one', 'noone', 'nobody'])(
		'preserves complete conditional set expansion for %s',
		async (variant) => {
			const {result, context} = await run(
				`Turn off Living Room lights if ${variant} is there`,
				fixture(),
				[lightSetIntent],
			);
			expect(result.selection).toMatchObject({kind: 'ready', intentMode: 'mixed'});
			expect(context?.observations.map(({entityId}) => entityId)).toEqual([
				'binary_sensor.example_living_occupancy',
				'binary_sensor.example_living_presence',
			]);
			expect(result.intentExpansion.sets[0]?.matchedCount).toBe(3);
			expect(result.intentExpansion.outcome).toBe('complete');
			expect(result.executionReadiness.commands.map(({target}) => target.entity_id)).toEqual([
				'light.example_living_first',
				'light.example_living_second',
			]);
		},
	);

	it('fails closed when a noone condition has no permitted presence evidence', async () => {
		const {result, chat} = await run(
			'Turn off Living Room lights if noone is there',
			fixture(
				defaultStates.filter(
					({attributes}) => !['occupancy', 'presence'].includes(String(attributes.device_class)),
				),
			),
			[lightSetIntent],
		);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(chat).not.toHaveBeenCalled();
		expect(result.executionReadiness.commands).toEqual([]);
	});
});

describe('area-conditioned planning with permitted no-area lights', () => {
	it.each(['Turn off lights in rooms that are unoccupied', conditionalGoal])(
		'keeps complete room reasoning available for %s without including no-area targets',
		async (instruction) => {
			const input = fixtureWithUnassignedLight();
			expect(input.policy.allowedEntityIds.has(unassignedLightId)).toBe(true);
			expect(
				normalizeStates(input.entities).find(({entityId}) => entityId === unassignedLightId),
			).toMatchObject({area: undefined, supportedActions: ['turn_on', 'turn_off']});
			const {result, context} = await run(instruction, input, [lightSetIntent]);
			expect(result.selection.kind).toBe('ready');
			expect(context?.states).toHaveLength(3);
			expect(JSON.stringify(context)).not.toContain(unassignedLightId);
			expect(context?.observations).toContainEqual(
				expect.objectContaining({area: 'Living Room', deviceClass: 'occupancy', state: 'off'}),
			);
			if (result.selection.kind === 'ready') {
				expect(result.selection.contextEntityIds.has(unassignedLightId)).toBe(false);
				expect(result.selection.setScopes).toEqual([
					{area: 'Living Room', aliases: ['Lounge'], domain: 'light'},
				]);
			}

			expect(result.intentExpansion.sets[0]?.matchedCount).toBe(3);
			expect(result.intentExpansion.sets[0]?.expandedActions.map(({entityId}) => entityId)).toEqual(
				[
					'light.example_living_first',
					'light.example_living_satisfied',
					'light.example_living_second',
				],
			);
			expect(result.executionReadiness.commands.map(({target}) => target.entity_id)).toEqual([
				'light.example_living_first',
				'light.example_living_second',
			]);
			expect(result.intentExpansion.outcome).toBe('complete');
		},
	);

	it.each([
		`Turn off ${unassignedLightId} if unoccupied`,
		`Turn off ${unassignedLightName} if unoccupied`,
		`Turn off ${unassignedLightId} if the Living Room is unoccupied`,
		`Turn off all lights in rooms that are unoccupied, including ${unassignedLightName}`,
		`Turn off light.example_living_first and ${unassignedLightId} if unoccupied`,
	])(
		'fails closed for an explicitly requested no-area conditional target in %s',
		async (instruction) => {
			const {result, chat} = await run(instruction, fixtureWithUnassignedLight(), [lightSetIntent]);
			expect(result.selection).toEqual({
				kind: 'insufficient_context',
				reason: 'missing_observations',
			});
			expect(chat).not.toHaveBeenCalled();
			expect(result.executionReadiness.commands).toEqual([]);
		},
	);

	it.each([
		'Turn off Bedroom lights if unoccupied',
		'Turn off lights in rooms that are unoccupied',
	])('still requires occupancy for every included area in %s', async (instruction) => {
		const input = fixtureWithUnassignedLight(
			defaultStates.filter(
				({entity_id: entityId}) => entityId !== 'binary_sensor.example_bedroom_occupancy',
			),
		);
		const {result, chat} = await run(instruction, input, [lightSetIntent]);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(chat).not.toHaveBeenCalled();
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('rejects a model-invented no-area target while retaining valid area set expansion', async () => {
		const {result} = await run(conditionalGoal, fixtureWithUnassignedLight(), [
			lightSetIntent,
			{entityId: unassignedLightId, action: 'turn_off', reason: 'Model guessed room membership.'},
		]);
		const rejected = result.validatedPlan.rejectedActions.find(
			({action}) => action.entityId === unassignedLightId,
		);
		expect(rejected?.reason).toBe('not_in_context');
		expect(result.executionReadiness.commands).toHaveLength(2);
		expect(result.intentExpansion.outcome).toBe('partial');
	});

	it('preserves contextual subset protection with a no-area light in the inventory', async () => {
		const {result} = await run(conditionalGoal, fixtureWithUnassignedLight(), [
			{entityId: 'light.example_living_first', action: 'turn_off', reason: 'Model chose a subset.'},
		]);
		expect(result.intentExpansion.rejectedIntents[0]?.reason).toBe(
			'contextual_subset_requires_set_intent',
		);
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('keeps occupancy evidence read-only when no-area lights are excluded', async () => {
		const entityId = 'binary_sensor.example_living_occupancy';
		const {result, context} = await run(conditionalGoal, fixtureWithUnassignedLight(), [
			lightSetIntent,
			{entityId, action: 'turn_off', reason: 'Model tried to act on evidence.'},
		]);
		expect(context?.observations).toContainEqual(expect.objectContaining({entityId}));
		expect(context?.observations.every((observation) => !('supportedActions' in observation))).toBe(
			true,
		);
		expect(result.validatedPlan.rejectedActions[0]?.reason).toBe('not_in_context');
		expect(result.executionReadiness.commands.map(({target}) => target.entity_id)).toEqual([
			'light.example_living_first',
			'light.example_living_second',
		]);
	});

	it('retains explicit no-area light control for requests without an area condition', async () => {
		const {result} = await run(`Turn off ${unassignedLightId}`, fixtureWithUnassignedLight(), [
			{entityId: unassignedLightId, action: 'turn_off', reason: 'Explicit unconditional request.'},
		]);
		expect(result.executionReadiness.commands).toEqual([
			{domain: 'light', service: 'turn_off', target: {entity_id: unassignedLightId}},
		]);
	});

	it('budgets the complete participating action and observation context after excluding no-area lights', async () => {
		const input = fixtureWithUnassignedLight();
		const {result, request} = await run(conditionalGoal, input, [lightSetIntent]);
		expect(result.selection.kind).toBe('ready');
		if (result.selection.kind !== 'ready') {
			return;
		}

		const bytes = Buffer.byteLength(
			JSON.stringify(createOllamaChatPayload(request!, options.model)),
		);
		expect(result.selection.requestBytes).toBe(bytes);
		const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(plan([lightSetIntent])));
		const overflow = await runPlanningPipeline(conditionalGoal, input.entities, input.policy, {
			...options,
			maxRequestBytes: bytes + outputHeadroomBytes - 1,
			chat,
		});
		expect(overflow.selection).toEqual({kind: 'insufficient_context', reason: 'over_budget'});
		expect(chat).not.toHaveBeenCalled();
		expect(overflow.executionReadiness.commands).toEqual([]);
	});
});

describe('read-only observation context from real HA state and registries', () => {
	it.each([
		{
			deviceClass: 'occupancy',
			entityId: 'binary_sensor.example_living_occupancy',
			instruction: 'Is the Living Room occupied?',
		},
		{
			deviceClass: 'presence',
			entityId: 'binary_sensor.example_living_presence',
			instruction: 'Is anyone in the Living Room?',
		},
		{
			deviceClass: 'temperature',
			entityId: 'sensor.example_living_temperature',
			instruction: 'What is the Living Room temperature?',
		},
		{
			deviceClass: 'humidity',
			entityId: 'sensor.example_living_humidity',
			instruction: 'What is the Living Room humidity?',
		},
	])(
		'selects $deviceClass facts separately from actionable entities',
		async ({deviceClass, entityId, instruction}) => {
			const {result, context} = await run(instruction);
			expect(result.selection.kind).toBe('ready');
			expect(context?.states).toEqual([]);
			expect(context?.observations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({entityId, deviceClass, area: 'Living Room'}),
				]),
			);
			expect(result.executionReadiness.commands).toEqual([]);
			if (result.selection.kind === 'ready') {
				expect(result.selection.contextEntityIds.size).toBe(0);
				expect(result.selection.setScopes).toEqual([]);
			}
		},
	);

	it.each(['Living Room', 'Lounge'])(
		'pairs %s lights only with relevant local occupancy/presence evidence',
		async (area) => {
			const {result, context} = await run(
				`Turn off ${area} lights when nobody is there`,
				fixture(),
				[lightSetIntent],
			);
			expect(context?.states).toHaveLength(3);
			expect(context?.observations.map(({entityId}) => entityId)).toEqual([
				'binary_sensor.example_living_occupancy',
				'binary_sensor.example_living_presence',
			]);
			expect(JSON.stringify(context)).not.toContain('example_bedroom');
			expect(JSON.stringify(context)).not.toContain('example_living_temperature');
			expect(result.executionReadiness.commands).toHaveLength(2);
		},
	);

	it('includes both requested numeric profiles with units and no unrelated observation classes', async () => {
		const {context} = await run('Compare Living Room temperature and humidity');
		expect(context?.observations).toEqual([
			expect.objectContaining({deviceClass: 'temperature', state: '21.5', unit: '°C'}),
			expect.objectContaining({deviceClass: 'humidity', state: '45', unit: '%'}),
		]);
		expect(context?.states).toEqual([]);
	});

	it.each(['Turn off Living Room lights', 'Please assess the home'])(
		'does not include irrelevant observations for %s',
		async (instruction) => {
			const {context} = await run(instruction);
			expect(context?.observations).toEqual([]);
			expect(context?.states.length).toBeGreaterThan(0);
			expect(JSON.stringify(context)).not.toContain('example_living_motion');
			expect(JSON.stringify(context)).not.toContain('example_living_energy');
		},
	);

	it('uses an explicit observation ID as evidence without making it an action targeting signal', async () => {
		const {result, context} = await run('Check binary_sensor.example_living_occupancy');
		expect(context?.observations.map(({entityId}) => entityId)).toEqual([
			'binary_sensor.example_living_occupancy',
		]);
		expect(context?.states).toEqual([]);
		if (result.selection.kind === 'ready') {
			expect(result.selection.intentMode).toBe('observation_only');
			expect(result.selection.reasons).toEqual(['observation']);
		}
	});

	it('does not treat action words or quantifiers embedded in an observation ID as user intent', async () => {
		const entityId = 'binary_sensor.example_all_living_room_lights_presence';
		const input = fixture([...defaultStates, state(entityId, 'off', 'presence')]);
		const {result, context} = await run(`Check ${entityId}`, input);
		expect(context?.states).toEqual([]);
		expect(context?.observations.map((observation) => observation.entityId)).toEqual([entityId]);
		if (result.selection.kind === 'ready') {
			expect(result.selection.intentMode).toBe('observation_only');
			expect(result.selection.requiresSetIntent).toBe(false);
			expect(result.selection.setScopes).toEqual([]);
		}
	});

	it('keeps explicit light targeting single-target while adding its area evidence', async () => {
		const {result, context} = await run(
			'Turn off light.example_living_first if unoccupied',
			fixture(),
			[
				{
					entityId: 'light.example_living_first',
					action: 'turn_off',
					reason: 'Explicit target and requested condition.',
				},
			],
		);
		expect(context?.states).toHaveLength(1);
		expect(context?.observations).toHaveLength(2);
		expect(result.executionReadiness.commands).toHaveLength(1);
		if (result.selection.kind === 'ready') {
			expect(result.selection.intentMode).toBe('entity_only');
		}
	});

	it('requires an explicit allow for model exposure and preserves deny precedence', async () => {
		const input = fixture(defaultStates, {version: 1, allow: [{domain: 'light'}], deny: []});
		const {result, chat} = await run(conditionalGoal, input, [lightSetIntent]);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(chat).not.toHaveBeenCalled();
		const denied = fixture(defaultStates, {...allowedPolicy, deny: [{domain: 'binary_sensor'}]});
		const outcome = await run(conditionalGoal, denied, [lightSetIntent]);
		expect(outcome.chat).not.toHaveBeenCalled();
		expect(outcome.result.executionReadiness.commands).toEqual([]);
	});

	it.each(['unknown', 'unavailable', 'disabled', 'incomplete'])(
		'withholds %s observation evidence and makes no model call',
		async (condition) => {
			const input = fixture(
				[
					state(
						'binary_sensor.example_living_occupancy',
						condition === 'disabled' || condition === 'incomplete' ? 'off' : condition,
						'occupancy',
					),
				],
				allowedPolicy,
				(registry) => {
					if (condition === 'disabled') {
						registry.entities[0]!.disabled_by = 'user';
					} else if (condition === 'incomplete') {
						registry.entities[0]!.device_id = 'fixture_missing_device';
					}
				},
			);
			const {result, chat} = await run('Is the Living Room occupied?', input);
			expect(result.selection).toEqual({
				kind: 'insufficient_context',
				reason: 'missing_observations',
			});
			expect(result.executionReadiness.commands).toEqual([]);
			expect(chat).not.toHaveBeenCalled();
		},
	);

	it.each(['occupied', 'clear', 'unexpected'])(
		'does not treat invalid binary HA value %s as evidence',
		async (value) => {
			const input = fixture([state('binary_sensor.example_living_occupancy', value, 'occupancy')]);
			const {result, chat} = await run('Is the Living Room occupied?', input);
			expect(result.selection).toEqual({
				kind: 'insufficient_context',
				reason: 'missing_observations',
			});
			expect(chat).not.toHaveBeenCalled();
		},
	);

	it.each(['', 'NaN', 'Infinity', '21 °C', '0xFF', 'on'])(
		'withholds non-numeric temperature evidence %j',
		async (value) => {
			const {result, chat} = await run(
				'What is the Living Room temperature?',
				fixture([state('sensor.example_living_temperature', value, 'temperature', '°C')]),
			);
			expect(result.selection).toEqual({
				kind: 'insufficient_context',
				reason: 'missing_observations',
			});
			expect(chat).not.toHaveBeenCalled();
		},
	);

	it('does not infer an observation class from a sensor name or allow an unrelated domain', async () => {
		const input = fixture(
			[
				state('sensor.example_living_temperature', '21'),
				state('person.example_living_presence', 'on', 'presence'),
			],
			{...allowedPolicy, allow: [...allowedPolicy.allow, {domain: 'person'}]},
		);
		const {chat} = await run('What is the Living Room temperature and presence?', input);
		expect(chat).not.toHaveBeenCalled();
	});

	it('fails closed when an actionable room lacks required evidence instead of sending a misleading subset', async () => {
		const input = fixture(
			defaultStates.filter(
				({entity_id: entityId}) => entityId !== 'binary_sensor.example_bedroom_occupancy',
			),
		);
		const {result, chat} = await run(conditionalGoal, input, [lightSetIntent]);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(result.executionReadiness.commands).toEqual([]);
		expect(chat).not.toHaveBeenCalled();
	});

	it.each([
		{
			instruction: 'Is anyone in the Living Room or Bedroom?',
			missingId: 'binary_sensor.example_bedroom_occupancy',
		},
		{
			instruction: 'Compare Living Room and Bedroom temperature',
			missingId: 'sensor.example_bedroom_temperature',
		},
	])('requires evidence for every named room in $instruction', async ({instruction, missingId}) => {
		const input = fixture(defaultStates.filter(({entity_id: entityId}) => entityId !== missingId));
		const {result, chat} = await run(instruction, input);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(chat).not.toHaveBeenCalled();
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('includes complete evidence for a question about two rooms without action authority', async () => {
		const {result, context} = await run('Is anyone in the Living Room or Bedroom?');
		expect(context?.states).toEqual([]);
		expect(context?.observations.map(({entityId}) => entityId)).toEqual([
			'binary_sensor.example_living_occupancy',
			'binary_sensor.example_living_presence',
			'binary_sensor.example_bedroom_occupancy',
		]);
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('does not drop an invalid selected observation just because another valid observation remains', async () => {
		const input = fixture([
			state('binary_sensor.example_living_occupancy', 'unexpected', 'occupancy'),
			state('binary_sensor.example_living_presence', 'off', 'presence'),
		]);
		const {chat} = await run('Is anyone in the Living Room?', input);
		expect(chat).not.toHaveBeenCalled();
	});

	it('does not silently omit an explicitly required unavailable observation', async () => {
		const input = fixture(
			defaultStates.map((value) =>
				value.entity_id === 'sensor.example_living_temperature'
					? {...value, state: 'unavailable'}
					: value,
			),
		);
		const {result, chat} = await run(
			'Turn off Living Room lights if sensor.example_living_temperature is below 18',
			input,
			[lightSetIntent],
		);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(chat).not.toHaveBeenCalled();
	});

	it('retains conclusive REST-only exposure while uncertain registry selectors remain denied', async () => {
		const entities = discoverEntities(
			[state('binary_sensor.example_living_occupancy', 'off', 'occupancy')],
			{status: 'unavailable'},
		);
		const conclusive = {entities, policy: resolveEntityPolicy(entities, allowedPolicy)};
		const permitted = await run('Is anyone home?', conclusive);
		expect(permitted.context?.observations).toHaveLength(1);
		const uncertain = {
			entities,
			policy: resolveEntityPolicy(entities, {
				version: 2,
				allow: [{areaId: 'fixture_living'}],
				deny: [],
			}),
		};
		const blocked = await run('Is anyone home?', uncertain);
		expect(blocked.chat).not.toHaveBeenCalled();
	});
});

describe('observation evidence and existing deterministic execution boundaries', () => {
	it('does not give an observation-only question permission to control lights', async () => {
		await expect(
			run('Is anyone in the Living Room?', fixture(), [
				{
					entityId: 'light.example_living_first',
					action: 'turn_off',
					reason: 'The model invented a change from occupancy alone.',
				},
			]),
		).rejects.toBeInstanceOf(ZodError);
	});
	it('allows a semantic area light set alongside actual HA evidence, expands every permitted member, and leaves another occupied area unchanged', async () => {
		const input = fixture();
		const {result, context} = await run(conditionalGoal, input, [lightSetIntent]);
		expect(context?.observations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({area: 'Living Room', deviceClass: 'occupancy', state: 'off'}),
				expect.objectContaining({area: 'Bedroom', deviceClass: 'occupancy', state: 'on'}),
			]),
		);
		expect(result.intentExpansion.sets[0]?.matchedCount).toBe(3);
		expect(result.intentExpansion.outcome).toBe('complete');
		expect(result.executionReadiness.commands).toEqual([
			{domain: 'light', service: 'turn_off', target: {entity_id: 'light.example_living_first'}},
			{domain: 'light', service: 'turn_off', target: {entity_id: 'light.example_living_second'}},
		]);
		expect(result.intentExpansion.sets[0]?.members).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					entityId: 'light.example_living_satisfied',
					status: 'already_satisfied',
				}),
			]),
		);
		const repeated = await run(conditionalGoal, input, [lightSetIntent]);
		expect(repeated.result.executionReadiness.commands).toEqual(result.executionReadiness.commands);
	});

	it('does not let an explicit observation ID bypass contextual subset protection for light proposals', async () => {
		const {result} = await run(
			'Turn off lights in rooms that are unoccupied; consider binary_sensor.example_living_occupancy',
			fixture(),
			[
				{
					entityId: 'light.example_living_first',
					action: 'turn_off',
					reason: 'Model chose an arbitrary member.',
				},
			],
		);
		expect(result.intentExpansion.rejectedIntents[0]?.reason).toBe(
			'contextual_subset_requires_set_intent',
		);
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it.each(['binary_sensor.example_living_occupancy', 'sensor.example_living_temperature'])(
		'rejects a malformed actionable proposal for %s before command construction',
		async (entityId) => {
			const instruction = entityId.startsWith('sensor')
				? 'Turn off Living Room lights if the temperature is below 18'
				: 'Turn off Living Room lights if unoccupied';
			const {result} = await run(instruction, fixture(), [
				{entityId, action: 'turn_off', reason: 'Untrusted model proposal.'},
			]);
			expect(result.validatedPlan.actions).toEqual([]);
			expect(result.validatedPlan.rejectedActions[0]?.reason).toBe('not_in_context');
			expect(result.executionReadiness.commands).toEqual([]);
			const forgedContext = validatePlan(
				{
					outcome: 'propose_actions',
					summary: plan().summary,
					actions: [{entityId, action: 'turn_off', reason: 'Forged context membership.'}],
				},
				fixture().policy,
				new Set([entityId]),
			);
			expect(forgedContext.rejectedActions[0]?.reason).toBe('unsupported_action');
		},
	);

	it('readiness independently rejects forged validated actions for an observation domain', () => {
		const [normalized] = normalizeStates(
			fixture([state('binary_sensor.example_living_occupancy', 'on', 'occupancy')]).entities,
		);
		const forged: PlanValidationResult = {
			outcome: 'propose_actions',
			summary: plan().summary,
			rejectedActions: [],
			actions: [
				{
					entityId: normalized!.entityId,
					action: 'turn_off',
					reason: 'Forged validated action.',
					domain: 'light',
					service: 'turn_off',
				},
			],
		};
		const readiness = prepareExecutionReadyCommands(forged, [normalized!]);
		expect(readiness.commands).toEqual([]);
		expect(readiness.rejectedActions[0]?.reason).toBe('ineligible_state');
		expectTypeOf<ObservationState>().not.toMatchObjectType<ExecutionReadyCommand>();
		expectTypeOf<ObservationState>().not.toMatchObjectType<DispatchAuthorizedCommand>();
	});

	it('preserves switch power actions alongside observation evidence', async () => {
		const action: ProposedAction = {
			entityId: 'switch.example_living_plug',
			action: 'turn_off',
			reason: 'Explicit user target.',
		};
		const {result} = await run(
			'Turn off switch.example_living_plug if nobody is there',
			fixture(),
			[action],
		);
		expect(result.executionReadiness.commands).toEqual([
			{domain: 'switch', service: 'turn_off', target: {entity_id: action.entityId}},
		]);
	});
});

describe('model-facing projection and byte budget', () => {
	it('instructs the model to combine facts with intent and exposes only narrow evidence without routing or credentials', async () => {
		const {request, context} = await run(conditionalGoal);
		const system = request?.messages[0]?.content ?? '';
		for (const phrase of [
			'observations array contains read-only facts/evidence, not commands',
			"Combine observations with the user's requested goal or intent",
			'Presence/occupancy alone does not automatically imply a light action',
			'Do not invent automations or actions merely because an observation exists',
			'Never attempt to act on an observation entity',
			'Only produce actions permitted by the supplied actionable entity/set schema',
			'Missing observations are not evidence that an area is unoccupied',
		]) {
			expect(system).toContain(phrase);
		}

		for (const observation of context?.observations ?? []) {
			expect(new Set(Object.keys(observation))).toEqual(
				new Set(['area', 'deviceClass', 'entityId', 'name', 'state']),
			);
		}

		for (const item of context?.states ?? []) {
			expect(item.supportedActions).toEqual(['turn_on', 'turn_off']);
		}

		for (const marker of [
			'private_attribute_marker',
			'fixture_living',
			'fixture_bedroom',
			'Untrusted Fallback Area',
			'HA_TOKEN',
			'authorization',
			'arbitrary_attribute',
		]) {
			expect(JSON.stringify(request)).not.toContain(marker);
		}

		expect(JSON.stringify(request?.format)).not.toContain('sensor');
		expect(JSON.stringify(request?.format)).not.toContain('service');
	});

	it('projects observation fields explicitly even if runtime input carries extra control data', () => {
		const [normalized] = normalizeStates(
			fixture([state('sensor.example_living_temperature', '21', 'temperature', '°C')]).entities,
		);
		const observation = toObservationState(normalized!)!;
		const unexpectedObservation = {
			...observation,
			supportedActions: ['turn_off'],
			domain: 'sensor',
			service: 'turn_off',
			target: {entity_id: observation.entityId},
			accessToken: 'private_token_marker',
		};
		const request = createPlanningChatRequest({
			instruction: 'What is the temperature?',
			states: [],
			observations: [unexpectedObservation],
		});
		const context = JSON.parse(request.messages[1]!.content) as {observations: ObservationState[]};
		expect(context.observations).toEqual([observation]);
		expect(JSON.stringify(request.messages[1])).not.toContain('private_token_marker');
	});

	it('includes all observations in exact serialized byte accounting and never trims them to fit', async () => {
		const input = fixture();
		const first = await run(conditionalGoal, input, [lightSetIntent]);
		expect(first.result.selection.kind).toBe('ready');
		if (first.result.selection.kind !== 'ready') {
			return;
		}

		const {selection} = first.result;
		const bytes = Buffer.byteLength(
			JSON.stringify(createOllamaChatPayload(first.request!, options.model)),
		);
		expect(selection.requestBytes).toBe(bytes);
		const withoutEvidence = planningRequestBytes(
			{
				instruction: conditionalGoal,
				states: selection.states,
				setScopes: selection.setScopes,
				intentMode: selection.intentMode,
			},
			options.model,
		);
		expect(bytes).toBeGreaterThan(withoutEvidence);
		const fits = await runPlanningPipeline(conditionalGoal, input.entities, input.policy, {
			...options,
			maxRequestBytes: bytes + outputHeadroomBytes,
			chat: first.chat,
		});
		expect(fits.selection.kind).toBe('ready');
		if (fits.selection.kind === 'ready') {
			expect(fits.selection.observations).toEqual(selection.observations);
		}

		const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(plan([lightSetIntent])));
		const overflow = await runPlanningPipeline(conditionalGoal, input.entities, input.policy, {
			...options,
			maxRequestBytes: bytes + outputHeadroomBytes - 1,
			chat,
		});
		expect(overflow.selection).toEqual({kind: 'insufficient_context', reason: 'over_budget'});
		expect(chat).not.toHaveBeenCalled();
		expect(overflow.executionReadiness.commands).toEqual([]);
	});
});
