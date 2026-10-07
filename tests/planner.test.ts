import {describe, expect, it} from 'vitest';
import {ZodError} from 'zod';
import type {CanonicalAction} from '../src/home-assistant/capabilities.js';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {RegistrySnapshot} from '../src/home-assistant/registry-client.js';
import {normalizeStates} from '../src/home-assistant/state-normalizer.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import type {OllamaChatRequest, OllamaChatTransport} from '../src/ollama/client.js';
import {createPlan} from '../src/planning/planner.js';
import {planJsonSchema} from '../src/planning/schemas.js';
import {resolveEntityPolicy, selectAllowedEntities} from '../src/policy/resolver.js';

const makeTransport =
	(content: string, requests: OllamaChatRequest[] = []): OllamaChatTransport =>
	async (request) => {
		requests.push(request);

		return content;
	};

describe('createPlan', () => {
	it('keeps registry identifiers and labels out of the Ollama payload', async () => {
		const requests: OllamaChatRequest[] = [];
		const state: HomeAssistantState = {
			entity_id: 'light.example_light',
			state: 'on',
			attributes: {friendly_name: 'Example Light'},
			last_changed: '2026-09-09T20:00:00+00:00',
			last_updated: '2026-09-09T20:00:00+00:00',
		};
		const registries: RegistrySnapshot = {
			status: 'available',
			entities: [
				{
					entity_id: state.entity_id,
					device_id: 'private_device_marker',
					area_id: 'private_area_marker',
					labels: ['private_label_marker'],
					disabled_by: null,
				},
			],
			devices: [
				{
					id: 'private_device_marker',
					area_id: null,
					labels: [],
					disabled_by: null,
					parent_device_id: null,
				},
			],
			areas: [{area_id: 'private_area_marker', name: 'Example Room', aliases: [], labels: []}],
			labels: [{label_id: 'private_label_marker'}],
		};
		const discovered = discoverEntities([state], registries);
		const policy = resolveEntityPolicy(discovered, {
			version: 2,
			allow: [{labelId: 'private_label_marker'}],
			deny: [],
		});
		const states = normalizeStates(selectAllowedEntities(discovered, policy));

		await createPlan(
			{instruction: 'Assess the example light.', states},
			makeTransport(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No action is needed.',
					actions: [],
				}),
				requests,
			),
		);

		const payload = JSON.stringify(requests);
		expect(states).toHaveLength(1);
		expect(payload).not.toContain('private_device_marker');
		expect(payload).not.toContain('private_area_marker');
		expect(payload).not.toContain('private_label_marker');
	});
	it('accepts propose_actions with at least one action', async () => {
		const requests: OllamaChatRequest[] = [];
		const plan = await createPlan(
			{
				instruction: 'Decide whether the example light should be turned off.',
				states: [
					{
						entityId: 'light.example_light',
						domain: 'light',
						state: 'on',
						name: 'Example Light',
						area: 'Example Room',
						supportedActions: ['turn_on', 'turn_off'],
					},
				],
			},
			makeTransport(
				JSON.stringify({
					outcome: 'propose_actions',
					summary: 'Proposed plan: The example light can be turned off.',
					actions: [
						{
							entityId: 'light.example_light',
							action: 'turn_off',
							reason: 'The instruction asks whether it should be turned off.',
						},
					],
				}),
				requests,
			),
		);

		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]).toMatchObject({entityId: 'light.example_light'});
		expect(requests[0]?.format).toBeDefined();

		const userMessage = requests[0]?.messages.find((message) => message.role === 'user');
		expect(JSON.parse(userMessage?.content ?? '')).toEqual({
			instruction: 'Decide whether the example light should be turned off.',
			states: [
				{
					entityId: 'light.example_light',
					domain: 'light',
					state: 'on',
					name: 'Example Light',
					area: 'Example Room',
					deviceClass: undefined,
					unit: undefined,
					supportedActions: ['turn_on', 'turn_off'],
				},
			],
		});
	});

	it('rejects malformed model output', async () => {
		await expect(
			createPlan(
				{instruction: 'Assess the example state.', states: []},
				makeTransport('not valid JSON'),
			),
		).rejects.toBeInstanceOf(SyntaxError);
	});

	it('rejects JSON that does not match the plan schema', async () => {
		const content = JSON.stringify({
			outcome: 'no_action',
			summary: 'Proposed plan: Missing actions.',
			actions: 'none',
		});

		await expect(
			createPlan({instruction: 'Assess the example state.', states: []}, makeTransport(content)),
		).rejects.toBeInstanceOf(ZodError);
	});

	it('accepts a valid no_action outcome', async () => {
		const plan = await createPlan(
			{instruction: 'Assess whether any action is needed.', states: []},
			makeTransport(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No action is needed.',
					actions: [],
				}),
			),
		);

		expect(plan).toEqual({
			outcome: 'no_action',
			summary: 'Proposed plan: No action is needed.',
			actions: [],
		});
	});

	it('accepts a valid insufficient_context outcome', async () => {
		const plan = await createPlan(
			{instruction: 'Decide whether a change is appropriate.', states: []},
			makeTransport(
				JSON.stringify({
					outcome: 'insufficient_context',
					summary:
						'Proposed plan: There is insufficient context to decide, so no actions are proposed.',
					actions: [],
				}),
			),
		);

		expect(plan.actions).toEqual([]);
		expect(plan.outcome).toBe('insufficient_context');
		expect(plan.summary).toContain('insufficient context');
	});

	it.each([
		{
			name: 'propose_actions with zero actions',
			plan: {
				outcome: 'propose_actions',
				summary: 'Proposed plan: Changes are proposed.',
				actions: [],
			},
		},
		{
			name: 'no_action with an action',
			plan: {
				outcome: 'no_action',
				summary: 'Proposed plan: No change is appropriate.',
				actions: [
					{
						entityId: 'light.example_light',
						action: 'turn_off',
						reason: 'The requested change is relevant.',
					},
				],
			},
		},
		{
			name: 'insufficient_context with an action',
			plan: {
				outcome: 'insufficient_context',
				summary: 'Proposed plan: More context is required.',
				actions: [
					{
						entityId: 'light.example_light',
						action: 'turn_off',
						reason: 'The requested change is relevant.',
					},
				],
			},
		},
	])('rejects $name', async ({plan}) => {
		const transport = makeTransport(JSON.stringify(plan));

		await expect(
			createPlan({instruction: 'Assess the example state.', states: []}, transport),
		).rejects.toBeInstanceOf(ZodError);
	});

	it('rejects a summary without the proposed-plan prefix', async () => {
		const content = JSON.stringify({
			outcome: 'no_action',
			summary: 'No action is needed.',
			actions: [],
		});

		await expect(
			createPlan({instruction: 'Assess the example state.', states: []}, makeTransport(content)),
		).rejects.toBeInstanceOf(ZodError);
	});

	it('includes the discriminated outcomes and action counts in the generated JSON Schema', () => {
		expect(planJsonSchema).toMatchObject({
			oneOf: [
				{
					properties: {
						outcome: {const: 'propose_actions'},
						summary: {pattern: '^Proposed plan:.*'},
						actions: {
							minItems: 1,
							items: {
								anyOf: [
									{
										properties: {
											type: {const: 'set_action'},
											action: {enum: ['turn_on', 'turn_off']},
											scope: {additionalProperties: false},
										},
									},
									{properties: {action: {enum: ['turn_on', 'turn_off']}}},
								],
							},
						},
					},
				},
				{
					properties: {
						outcome: {const: 'no_action'},
						actions: {minItems: 0, maxItems: 0},
					},
				},
				{
					properties: {
						outcome: {const: 'insufficient_context'},
						actions: {minItems: 0, maxItems: 0},
					},
				},
			],
		});
	});

	it('instructs the model to use prospective language and report insufficient context', async () => {
		const requests: OllamaChatRequest[] = [];

		await createPlan(
			{instruction: 'Assess the example state.', states: []},
			makeTransport(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No action is needed.',
					actions: [],
				}),
				requests,
			),
		);

		const systemMessage = requests[0]?.messages.find((message) => message.role === 'system');
		expect(systemMessage?.content).toContain('You propose actions; you never execute them.');
		expect(systemMessage?.content).toContain('use prospective language');
		expect(systemMessage?.content).toContain(
			'Never claim or imply that an action was executed, completed, or attempted.',
		);
		expect(systemMessage?.content).toContain('there is insufficient context');
		expect(systemMessage?.content).toContain(
			'Use current state to determine whether a proposed change is relevant and to avoid no-op proposals; do not infer intent from current state alone.',
		);
		expect(systemMessage?.content).toContain(
			'Choose the outcome before writing the summary and actions:',
		);
		expect(systemMessage?.content).toContain(
			'When the user explicitly states a target outcome and supplied entity states identify relevant non-no-op changes, use "propose_actions" and include those actions. Do not return only descriptive text.',
		);
		expect(systemMessage?.content).toContain(
			"Propose only an action listed in the target entity's supportedActions array and copy it exactly.",
		);
		expect(systemMessage?.content).toContain(
			'The only canonical actions are "turn_on" and "turn_off".',
		);
		expect(systemMessage?.content).toContain('Do not use state values such as "on" or "off"');
		expect(systemMessage?.content).toContain('domain-qualified services such as "light.turn_off"');
	});

	it('rejects a whitespace-only planning instruction without calling the model', async () => {
		let wasCalled = false;
		const transport: OllamaChatTransport = async () => {
			wasCalled = true;
			return JSON.stringify({
				outcome: 'no_action',
				summary: 'Proposed plan: No action is needed.',
				actions: [],
			});
		};

		await expect(createPlan({instruction: ' \n\t ', states: []}, transport)).rejects.toThrow(
			'A planning instruction is required.',
		);
		expect(wasCalled).toBe(false);
	});

	it.each([
		{
			name: 'plan objects',
			plan: {
				outcome: 'no_action',
				summary: 'Proposed plan: No action is needed.',
				actions: [],
				unexpected: true,
			},
		},
		{
			name: 'action objects',
			plan: {
				outcome: 'propose_actions',
				summary: 'Proposed plan: Turn off the example light.',
				actions: [
					{
						entityId: 'light.example_light',
						action: 'turn_off',
						reason: 'The example light is no longer needed.',
						unexpected: true,
					},
				],
			},
		},
	])('strictly rejects unknown fields in $name', async ({plan}) => {
		const transport = makeTransport(JSON.stringify(plan));

		await expect(
			createPlan({instruction: 'Assess the example state.', states: []}, transport),
		).rejects.toBeInstanceOf(ZodError);
	});

	it('sends only normalized state fields to the model', async () => {
		const requests: OllamaChatRequest[] = [];
		const stateWithUnexpectedProperty = {
			entityId: 'light.example_light',
			domain: 'light',
			state: 'on',
			name: 'Example Light',
			area: 'Example Room',
			supportedActions: ['turn_on', 'turn_off'] as CanonicalAction[],
			accessToken: 'must-not-be-sent',
		};

		await createPlan(
			{
				instruction: 'Assess the example light.',
				states: [stateWithUnexpectedProperty],
			},
			makeTransport(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No action is needed.',
					actions: [],
				}),
				requests,
			),
		);

		const userMessage = requests[0]?.messages.find((message) => message.role === 'user');
		expect(JSON.parse(userMessage?.content ?? '')).toEqual({
			instruction: 'Assess the example light.',
			states: [
				{
					entityId: 'light.example_light',
					domain: 'light',
					state: 'on',
					name: 'Example Light',
					area: 'Example Room',
					supportedActions: ['turn_on', 'turn_off'],
				},
			],
		});
	});

	it('sends only policy-resolved discovered entities to the model', async () => {
		const requests: OllamaChatRequest[] = [];
		const makeState = (entityId: string): HomeAssistantState => ({
			entity_id: entityId,
			state: 'on',
			attributes: {},
			last_changed: '2026-09-09T20:00:00+00:00',
			last_updated: '2026-09-09T20:00:00+00:00',
		});
		const discovered = discoverEntities([
			makeState('light.example_allowed'),
			makeState('light.example_denied'),
			makeState('switch.example_unlisted'),
		]);
		const policy = resolveEntityPolicy(discovered, {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [{entityId: 'light.example_denied'}],
		});
		const normalized = normalizeStates(selectAllowedEntities(discovered, policy));

		await createPlan(
			{instruction: 'Assess the allowed entities.', states: normalized},
			makeTransport(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No action is needed.',
					actions: [],
				}),
				requests,
			),
		);

		const userMessage = requests[0]?.messages.find((message) => message.role === 'user');
		const content = JSON.parse(userMessage?.content ?? '') as {states: Array<{entityId: string}>};
		expect(content.states.map((state) => state.entityId)).toEqual(['light.example_allowed']);
	});

	it('sends unknown-domain entities with no supported actions', async () => {
		const requests: OllamaChatRequest[] = [];

		await createPlan(
			{
				instruction: 'Assess the example sensor.',
				states: [
					{
						entityId: 'sensor.example_temperature',
						domain: 'sensor',
						state: '21',
						name: undefined,
						area: undefined,
						supportedActions: [],
					},
				],
			},
			makeTransport(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No supported control action is available.',
					actions: [],
				}),
				requests,
			),
		);

		const userMessage = requests[0]?.messages.find((message) => message.role === 'user');
		const content = JSON.parse(userMessage?.content ?? '') as {
			states: Array<{supportedActions: string[]}>;
		};
		expect(content.states[0]?.supportedActions).toEqual([]);
	});

	it.each(['off', 'on', 'light.turn_off', 'switch.turn_off', 'toggle'])(
		'rejects the noncanonical action value %s',
		async (action) => {
			const content = JSON.stringify({
				outcome: 'propose_actions',
				summary: 'Proposed plan: Change the example light.',
				actions: [
					{
						entityId: 'light.example_light',
						action,
						reason: 'The instruction requests a change.',
					},
				],
			});

			await expect(
				createPlan({instruction: 'Change the example light.', states: []}, makeTransport(content)),
			).rejects.toBeInstanceOf(ZodError);
		},
	);

	it.each([
		{name: 'domain', field: {domain: 'light'}},
		{name: 'service', field: {service: 'turn_off'}},
		{name: 'data', field: {data: {brightness: 100}}},
	])('rejects the legacy model-controlled $name field', async ({field}) => {
		const content = JSON.stringify({
			outcome: 'propose_actions',
			summary: 'Proposed plan: Turn off the example light.',
			actions: [
				{
					entityId: 'light.example_light',
					action: 'turn_off',
					reason: 'The instruction requests a change.',
					...field,
				},
			],
		});

		await expect(
			createPlan({instruction: 'Change the example light.', states: []}, makeTransport(content)),
		).rejects.toBeInstanceOf(ZodError);
	});
});
