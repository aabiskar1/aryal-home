import {describe, expect, it} from 'vitest';
import {ZodError} from 'zod';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {RegistrySnapshot} from '../src/home-assistant/registry-client.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import type {OllamaChatRequest, OllamaChatTransport} from '../src/ollama/client.js';
import {runPlanningPipeline} from '../src/planning/pipeline.js';
import {selectionDiagnostic} from '../src/planning/relevance.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';

const state = (entityId: string, name: string): HomeAssistantState => ({
	entity_id: entityId,
	state: 'off',
	attributes: {friendly_name: name},
	last_changed: '2026-09-09T20:00:00+00:00',
	last_updated: '2026-09-09T20:00:00+00:00',
});

const states = [
	state('light.example_kitchen_ceiling', 'Ceiling Light'),
	state('light.example_kitchen_counter', 'Counter Light'),
	state('light.example_hall', 'Hall Light'),
];

const registries: RegistrySnapshot = {
	status: 'available',
	entities: [
		{
			entity_id: states[0]!.entity_id,
			device_id: 'private_denied_device',
			area_id: null,
			labels: [],
			disabled_by: null,
		},
		{
			entity_id: states[1]!.entity_id,
			device_id: 'private_allowed_device',
			area_id: null,
			labels: ['private_allowed_label'],
			disabled_by: null,
		},
		{
			entity_id: states[2]!.entity_id,
			device_id: null,
			area_id: 'private_hall_area',
			labels: [],
			disabled_by: null,
		},
	],
	devices: [
		{id: 'private_denied_device', area_id: 'private_kitchen_area', labels: [], disabled_by: null},
		{id: 'private_allowed_device', area_id: 'private_kitchen_area', labels: [], disabled_by: null},
	],
	areas: [
		{area_id: 'private_kitchen_area', name: 'Kitchen', aliases: ['Galley'], labels: []},
		{area_id: 'private_hall_area', name: 'Hall', aliases: [], labels: []},
	],
	labels: [{label_id: 'private_allowed_label'}],
};

const entities = discoverEntities(states, registries);
const policy = resolveEntityPolicy(entities, {
	version: 2,
	allow: [{domain: 'light'}, {labelId: 'private_allowed_label'}],
	deny: [{deviceId: 'private_denied_device'}],
});
const options = {model: 'example-model', maxRequestBytes: 100_000};

const plan = (entityId: string) =>
	JSON.stringify({
		outcome: 'propose_actions',
		summary: 'Proposed plan: Turn on the example light.',
		actions: [{entityId, action: 'turn_on', reason: 'The request asks for it.'}],
	});

describe('planning pipeline with relevance selection', () => {
	it('never gives denied entities to the selector or Ollama and preserves device/label policy', async () => {
		let request: OllamaChatRequest | undefined;
		const chat: OllamaChatTransport = async (value) => {
			request = value;

			return plan(states[1]!.entity_id);
		};

		const result = await runPlanningPipeline('Turn on kitchen lights', entities, policy, {
			...options,
			chat,
		});

		expect(result.selection.kind).toBe('ready');
		if (result.selection.kind !== 'ready') {
			return;
		}

		expect(result.selection.states.map((item) => item.entityId)).toEqual([states[1]!.entity_id]);
		expect(result.validatedPlan.actions).toHaveLength(1);
		expect(result.executionReadiness.outcome).toBe('ready');
		expect(result.executionReadiness.commands).toEqual([
			{domain: 'light', service: 'turn_on', target: {entity_id: states[1]!.entity_id}},
		]);
		expect(JSON.stringify(result.executionReadiness)).not.toContain('private_');
		expect(JSON.stringify(request)).not.toContain(states[0]!.entity_id);
		expect(JSON.stringify(request)).not.toContain('private_denied_device');
		expect(JSON.stringify(request)).not.toContain('private_allowed_device');
		expect(JSON.stringify(request)).not.toContain('private_allowed_label');
		expect(JSON.stringify(request)).not.toContain('private_kitchen_area');
	});

	it('rejects a policy-allowed entity outside the exact model context', async () => {
		const result = await runPlanningPipeline('Turn on kitchen lights', entities, policy, {
			...options,
			chat: async () => plan(states[2]!.entity_id),
		});

		expect(result.validatedPlan.actions).toEqual([]);
		expect(result.executionReadiness.outcome).toBe('no_action');
		expect(result.executionReadiness.commands).toEqual([]);
		expect(result.validatedPlan.rejectedActions).toEqual([
			{
				action: {
					entityId: states[2]!.entity_id,
					action: 'turn_on',
					reason: 'The request asks for it.',
				},
				reason: 'not_in_context',
			},
		]);
	});

	it('retains full-policy denial precedence even if the model invents a denied target', async () => {
		const result = await runPlanningPipeline('Turn on kitchen lights', entities, policy, {
			...options,
			chat: async () => plan(states[0]!.entity_id),
		});

		expect(result.validatedPlan.rejectedActions[0]?.reason).toBe('denied');
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('skips Ollama when there is no permitted targeted match', async () => {
		let wasCalled = false;
		const result = await runPlanningPipeline('Turn on office lights', entities, policy, {
			...options,
			async chat() {
				wasCalled = true;
				return plan(states[1]!.entity_id);
			},
		});

		expect(wasCalled).toBe(false);
		expect(result.selection).toEqual({kind: 'insufficient_context', reason: 'no_permitted_match'});
		expect(result.validatedPlan.outcome).toBe('insufficient_context');
		expect(result.executionReadiness.outcome).toBe('insufficient_context');
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('skips Ollama rather than truncating a complete over-budget selection', async () => {
		let wasCalled = false;
		const result = await runPlanningPipeline('Turn off all lights', entities, policy, {
			...options,
			maxRequestBytes: 1,
			async chat() {
				wasCalled = true;
				return plan(states[1]!.entity_id);
			},
		});

		expect(wasCalled).toBe(false);
		expect(result.selection).toEqual({kind: 'insufficient_context', reason: 'over_budget'});
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('emits only aggregate, non-identifying selection diagnostics', async () => {
		const result = await runPlanningPipeline('Turn on kitchen lights', entities, policy, {
			...options,
			chat: async () => plan(states[1]!.entity_id),
		});
		const diagnostics = JSON.stringify(
			selectionDiagnostic(result.selection, result.permittedCount),
		);

		expect(diagnostics).toContain('selectedCount');
		expect(diagnostics).not.toContain('private_');
		expect(diagnostics).not.toContain('light.example');
		expect(diagnostics).not.toContain('Turn on kitchen lights');
	});

	it('keeps incomplete registry relationships out of selection and skips Ollama', async () => {
		const incomplete = discoverEntities([state('light.example_incomplete', 'Example Light')], {
			status: 'available',
			entities: [
				{
					entity_id: 'light.example_incomplete',
					device_id: 'missing_device',
					area_id: null,
					labels: [],
					disabled_by: null,
				},
			],
			devices: [],
			areas: [],
			labels: [],
		});
		const fullPolicy = resolveEntityPolicy(incomplete, {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [],
		});
		let wasCalled = false;
		const result = await runPlanningPipeline('Turn on all lights', incomplete, fullPolicy, {
			...options,
			async chat() {
				wasCalled = true;
				return plan('light.example_incomplete');
			},
		});

		expect(wasCalled).toBe(false);
		expect(result.permittedCount).toBe(0);
		expect(result.validatedPlan.outcome).toBe('insufficient_context');
	});

	it('rejects a selected observation action at the observation-only schema boundary', async () => {
		const observation = state('binary_sensor.example_occupancy', 'Example Occupancy');
		observation.attributes.device_class = 'occupancy';
		const discovered = discoverEntities([observation], {
			status: 'available',
			entities: [],
			devices: [],
			areas: [],
			labels: [],
		});
		const fullPolicy = resolveEntityPolicy(discovered, {
			version: 1,
			allow: [{domain: 'binary_sensor'}],
			deny: [],
		});
		await expect(
			runPlanningPipeline('Is anyone home?', discovered, fullPolicy, {
				...options,
				chat: async () => plan(observation.entity_id),
			}),
		).rejects.toBeInstanceOf(ZodError);
	});

	it.each([
		{actions: ['turn_on', 'turn_on'], reason: 'duplicate_action'},
		{actions: ['turn_on', 'turn_off'], reason: 'conflicting_actions'},
		{actions: ['turn_off'], reason: 'no_op'},
	])('stops after rejecting $reason at readiness', async ({actions, reason}) => {
		const entityId = states[1]!.entity_id;
		const result = await runPlanningPipeline('Turn on kitchen lights', entities, policy, {
			...options,
			chat: async () =>
				JSON.stringify({
					outcome: 'propose_actions',
					summary: 'Proposed plan: Change the example light.',
					actions: actions.map((action) => ({
						entityId,
						action,
						reason: 'The request asks for it.',
					})),
				}),
		});

		expect(result.validatedPlan.outcome).toBe('propose_actions');
		expect(result.validatedPlan.actions).toHaveLength(actions.length);
		expect(result.executionReadiness.outcome).toBe('rejected');
		expect(result.executionReadiness.commands).toEqual([]);
		expect(result.executionReadiness.rejectedActions.map((item) => item.reason)).toEqual(
			actions.map(() => reason),
		);
	});

	it('preserves both validation stages in a mixed plan', async () => {
		const ready = state('light.example_ready', 'Ready Light');
		const noOp = {...state('light.example_no_op', 'No-op Light'), state: 'on'};
		const denied = state('light.example_denied', 'Denied Light');
		const unsupported = state('sensor.example_temperature', 'Temperature');
		const discovered = discoverEntities([ready, noOp, denied, unsupported]);
		const fullPolicy = resolveEntityPolicy(discovered, {
			version: 1,
			allow: [{domain: 'light'}, {domain: 'sensor'}],
			deny: [{entityId: denied.entity_id}],
		});
		const result = await runPlanningPipeline('Review permitted entities', discovered, fullPolicy, {
			...options,
			chat: async () =>
				JSON.stringify({
					outcome: 'propose_actions',
					summary: 'Proposed plan: Turn on the example entities.',
					actions: [ready, noOp, denied, unsupported].map((item) => ({
						entityId: item.entity_id,
						action: 'turn_on',
						reason: 'The request asks for it.',
					})),
				}),
		});

		expect(result.validatedPlan.actions.map((action) => action.entityId)).toEqual([
			ready.entity_id,
			noOp.entity_id,
		]);
		expect(result.validatedPlan.rejectedActions.map((item) => item.reason)).toEqual([
			'denied',
			'not_in_context',
		]);
		expect(result.executionReadiness.outcome).toBe('ready');
		expect(result.executionReadiness.commands).toEqual([
			{domain: 'light', service: 'turn_on', target: {entity_id: ready.entity_id}},
		]);
		expect(result.executionReadiness.rejectedActions[0]?.reason).toBe('no_op');
	});

	it.each(['unknown', 'unavailable', 'disabled'])(
		'keeps %s entities ineligible',
		async (condition) => {
			const unavailable = {
				...state('light.example_ineligible', 'Ineligible Light'),
				state: condition === 'disabled' ? 'off' : condition,
			};
			const discovered = discoverEntities([unavailable], {
				status: 'available',
				entities: [
					{
						entity_id: unavailable.entity_id,
						device_id: null,
						area_id: null,
						labels: [],
						disabled_by: condition === 'disabled' ? 'user' : null,
					},
				],
				devices: [],
				areas: [],
				labels: [],
			});
			const fullPolicy = resolveEntityPolicy(discovered, {
				version: 1,
				allow: [{domain: 'light'}],
				deny: [],
			});
			let wasCalled = false;
			const result = await runPlanningPipeline('Turn on all lights', discovered, fullPolicy, {
				...options,
				async chat() {
					wasCalled = true;
					return plan(unavailable.entity_id);
				},
			});

			expect(wasCalled).toBe(false);
			expect(result.executionReadiness.outcome).toBe('insufficient_context');
			expect(result.executionReadiness.commands).toEqual([]);
		},
	);

	it('rejects model-owned service fields at the structured schema before readiness', async () => {
		await expect(
			runPlanningPipeline('Turn on kitchen lights', entities, policy, {
				...options,
				chat: async () =>
					JSON.stringify({
						outcome: 'propose_actions',
						summary: 'Proposed plan: Turn on the example light.',
						actions: [
							{
								entityId: states[1]!.entity_id,
								action: 'turn_on',
								reason: 'The request asks for it.',
								domain: 'light',
								service: 'turn_on',
								target: {entity_id: 'switch.example_other'},
								data: {unexpected: true},
							},
						],
					}),
			}),
		).rejects.toThrow();
	});
});
