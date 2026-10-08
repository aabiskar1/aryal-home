import {Buffer} from 'node:buffer';
import {describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {normalizeStates} from '../src/home-assistant/state-normalizer.js';
import {prepareExecutionReadyCommands} from '../src/execution/readiness.js';
import {createOllamaChatPayload} from '../src/ollama/request.js';
import type {OllamaChatTransport} from '../src/ollama/client.js';
import {runPlanningPipeline} from '../src/planning/pipeline.js';
import {
	createPlan,
	createPlanningChatRequest,
	planningRequestBytes,
} from '../src/planning/planner.js';
import {validatePlan} from '../src/planning/policy.js';
import {outputHeadroomBytes} from '../src/planning/relevance.js';
import {
	planningJsonSchemas,
	planningSchemas,
	type ObservationPlan,
	type Plan,
	type PlanningIntentMode,
} from '../src/planning/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';

const state = (
	entityId: string,
	value: string,
	deviceClass?: string,
	unit?: string,
): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {
		friendly_name: 'Example reading',
		device_class: deviceClass,
		unit_of_measurement: unit,
	},
	last_changed: '2026-10-08T00:00:00+00:00',
	last_updated: '2026-10-08T00:00:00+00:00',
});
const occupancy = state('binary_sensor.example_living_occupancy', 'off', 'occupancy');
const fixture = (evidence = occupancy) => {
	const states = [
		state('light.example_first', 'on'),
		state('light.example_second', 'on'),
		state('switch.example_first', 'on'),
		state('switch.example_second', 'on'),
		evidence,
	];
	const entities = discoverEntities(states, {
		status: 'available',
		entities: states.map(({entity_id: entityId}) => ({
			entity_id: entityId,
			device_id: null,
			area_id: entityId.includes('bedroom') ? 'example_bedroom' : 'example_living',
			labels: [],
			disabled_by: null,
		})),
		devices: [],
		areas: [
			{area_id: 'example_living', name: 'Living Room', aliases: [], labels: []},
			{area_id: 'example_bedroom', name: 'Bedroom', aliases: [], labels: []},
		],
		labels: [],
	});
	return {
		entities,
		policy: resolveEntityPolicy(entities, {
			version: 1,
			allow: [{domain: 'light'}, {domain: 'switch'}, {domain: 'sensor'}, {domain: 'binary_sensor'}],
			deny: [],
		}),
	};
};

const options = {model: 'example-model', maxRequestBytes: 100_000};
const noAction: ObservationPlan = {
	outcome: 'no_action',
	summary: 'Proposed plan: The room is clear.',
	actions: [],
};
const observationRequest = {
	instruction: 'Is anyone in the Living Room?',
	states: [],
	observations: [
		{
			entityId: occupancy.entity_id,
			name: 'Example occupancy',
			area: 'Living Room',
			state: 'off',
			deviceClass: 'occupancy' as const,
		},
	],
};
const entityAction = {
	entityId: 'light.example_first',
	action: 'turn_off',
	reason: 'Invented control.',
};
const scopedProposal = {
	type: 'set_action',
	action: 'turn_off',
	scope: {area: 'Living Room', domain: 'light'},
	reason: 'Invented automation.',
};

describe('observation-only planning mode', () => {
	it.each([
		{
			instruction: 'What is the Living Room temperature?',
			evidence: state('sensor.example_living_temperature', '21.5', 'temperature', '°C'),
			summary: 'Proposed plan: Living Room temperature is 21.5 °C.',
		},
		{
			instruction: 'What is the Bedroom humidity?',
			evidence: state('sensor.example_bedroom_humidity', '45', 'humidity', '%'),
			summary: 'Proposed plan: Bedroom humidity is 45%.',
		},
		{
			instruction: 'Is anyone in the Living Room?',
			evidence: state('binary_sensor.example_living_presence', 'off', 'presence'),
			summary: 'Proposed plan: The Living Room presence sensor reports clear.',
		},
	])(
		'answers $instruction with no_action and no actionable scope',
		async ({instruction, evidence, summary}) => {
			const input = fixture(evidence);
			const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify({...noAction, summary}));
			const result = await runPlanningPipeline(instruction, input.entities, input.policy, {
				...options,
				chat,
			});
			expect(result.selection).toMatchObject({
				kind: 'ready',
				intentMode: 'observation_only',
				states: [],
				setScopes: [],
				requiresSetIntent: false,
			});
			if (result.selection.kind === 'ready') {
				expect(result.selection.contextEntityIds.size).toBe(0);
				expect(result.selection.observations).toHaveLength(1);
			}

			expect(result.validatedPlan).toMatchObject({outcome: 'no_action', summary, actions: []});
			expect(result.executionReadiness.commands).toEqual([]);
			expect(result.intentExpansion.sets).toEqual([]);
			const request = chat.mock.calls[0]![0];
			expect(request.format).toEqual(planningJsonSchemas.observation_only);
			const context = JSON.parse(request.messages[1]!.content) as {
				states: unknown[];
				observations: unknown[];
				intentMode: string;
				setScopes?: unknown[];
			};
			expect(context.intentMode).toBe('observation_only');
			expect(context.states).toEqual([]);
			expect(context.observations).toHaveLength(1);
			expect(context.setScopes).toBeUndefined();
			expect(request.messages[0]?.content).toContain(
				'Observation-only questions are informational',
			);
			expect(request.messages[0]?.content).toContain('answer via summary with no_action');
			expect(request.messages[0]?.content).toContain(
				'Do not invent automation/control intent from temperature, humidity, occupancy, or presence facts',
			);
		},
	);

	it('accepts insufficient_context with structurally empty actions', async () => {
		const result = await createPlan(observationRequest, async () =>
			JSON.stringify({
				...noAction,
				outcome: 'insufficient_context',
				summary: 'Proposed plan: Presence alone does not answer how many people are there.',
			}),
		);
		expect(result.outcome).toBe('insufficient_context');
		expect(result.actions).toEqual([]);
	});

	it.each([
		{outcome: 'propose_actions', actions: [entityAction]},
		{outcome: 'propose_actions', actions: [scopedProposal]},
		{outcome: 'propose_actions', actions: []},
		{outcome: 'no_action', actions: [entityAction]},
		{outcome: 'no_action', actions: [scopedProposal]},
		{outcome: 'insufficient_context', actions: [entityAction]},
		{outcome: 'insufficient_context', actions: [scopedProposal]},
	])('rejects model control output before expansion: %j', async (proposal) => {
		const response = {...noAction, ...proposal};
		expect(planningSchemas.observation_only.safeParse(response).success).toBe(false);
		const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(response));
		const input = fixture();
		await expect(
			runPlanningPipeline(observationRequest.instruction, input.entities, input.policy, {
				...options,
				chat,
			}),
		).rejects.toBeInstanceOf(ZodError);
		expect(chat.mock.calls[0]?.[0].format).toEqual(planningJsonSchemas.observation_only);
	});

	it('advertises only empty action arrays and informational outcomes in JSON Schema', () => {
		const format = JSON.stringify(planningJsonSchemas.observation_only);
		for (const field of [
			'propose_actions',
			'entityId',
			'set_action',
			'turn_on',
			'turn_off',
			'scope',
			'service',
		]) {
			expect(format).not.toContain(field);
		}

		expect(format).toContain('"maxItems":0');
	});

	it.each([undefined, 'mixed', 'entity_only', 'set_only'] as const)(
		'derives observation-only generation and parsing even with requested mode %s',
		async (intentMode: PlanningIntentMode | undefined) => {
			const request = {...observationRequest, intentMode};
			expect(createPlanningChatRequest(request).format).toEqual(
				planningJsonSchemas.observation_only,
			);
			await expect(
				createPlan(request, async () =>
					JSON.stringify({...noAction, outcome: 'propose_actions', actions: [entityAction]}),
				),
			).rejects.toBeInstanceOf(ZodError);
		},
	);

	it.each(['states', 'setScopes', 'missing_observations'])(
		'rejects inconsistent explicit observation-only context containing %s',
		(field) => {
			const request = {
				...observationRequest,
				intentMode: 'observation_only' as const,
				...(field === 'states' && {
					states: normalizeStates(fixture().entities).filter(({domain}) => domain === 'light'),
				}),
				...(field === 'setScopes' && {
					setScopes: [{area: 'Living Room', aliases: [], domain: 'light' as const}],
				}),
				...(field === 'missing_observations' && {observations: []}),
			};
			expect(() => createPlanningChatRequest(request)).toThrow(
				'Observation-only planning requires observations and no actionable context',
			);
		},
	);

	it.each([
		{
			instruction: 'Turn off Living Room lights if the room is unoccupied',
			domain: 'light',
			mode: 'mixed',
		},
		{
			instruction: 'Turn off Living Room switches if the room is unoccupied',
			domain: 'switch',
			mode: 'mixed',
		},
		{
			instruction: 'Turn off all Living Room lights if the room is unoccupied',
			domain: 'light',
			mode: 'set_only',
		},
	])('retains actionable set planning for $instruction', async ({instruction, domain, mode}) => {
		const input = fixture();
		const chat = vi.fn<OllamaChatTransport>(async () =>
			JSON.stringify({
				outcome: 'propose_actions',
				summary: 'Proposed plan: Turn off the requested complete room set.',
				actions: [{...scopedProposal, scope: {area: 'Living Room', domain}}],
			}),
		);
		const result = await runPlanningPipeline(instruction, input.entities, input.policy, {
			...options,
			chat,
		});
		expect(result.selection).toMatchObject({kind: 'ready', intentMode: mode});
		expect(result.intentExpansion.sets[0]?.matchedCount).toBe(2);
		expect(result.executionReadiness.commands.map(({target}) => target.entity_id)).toEqual([
			`${domain}.example_first`,
			`${domain}.example_second`,
		]);
		expect(JSON.stringify(chat.mock.calls[0]?.[0].format)).toContain('set_action');
	});

	it('retains post-model policy/context validation if schema rejection is bypassed', () => {
		const input = fixture();
		const forged: Plan = {
			outcome: 'propose_actions',
			summary: noAction.summary,
			actions: [
				{
					entityId: 'light.example_first',
					action: 'turn_off',
					reason: 'Invented change from an observation question.',
				},
			],
		};
		const validated = validatePlan(forged, input.policy, new Set());
		expect(validated.actions).toEqual([]);
		expect(validated.rejectedActions[0]?.reason).toBe('not_in_context');
		expect(prepareExecutionReadyCommands(validated, []).commands).toEqual([]);
	});

	it('accounts for the exact informational prompt, schema, context, and output headroom', async () => {
		const input = fixture();
		const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(noAction));
		const result = await runPlanningPipeline(
			observationRequest.instruction,
			input.entities,
			input.policy,
			{...options, chat},
		);
		expect(result.selection.kind).toBe('ready');
		if (result.selection.kind !== 'ready') {
			return;
		}

		const bytes = Buffer.byteLength(
			JSON.stringify(createOllamaChatPayload(chat.mock.calls[0]![0], options.model)),
		);
		expect(result.selection.requestBytes).toBe(bytes);
		expect(
			planningRequestBytes(
				{
					instruction: observationRequest.instruction,
					states: result.selection.states,
					observations: result.selection.observations,
				},
				options.model,
			),
		).toBe(bytes);
		const fits = await runPlanningPipeline(
			observationRequest.instruction,
			input.entities,
			input.policy,
			{...options, maxRequestBytes: bytes + outputHeadroomBytes, chat},
		);
		expect(fits.selection.kind).toBe('ready');
		const blockedChat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(noAction));
		const overflow = await runPlanningPipeline(
			observationRequest.instruction,
			input.entities,
			input.policy,
			{...options, maxRequestBytes: bytes + outputHeadroomBytes - 1, chat: blockedChat},
		);
		expect(overflow.selection).toEqual({kind: 'insufficient_context', reason: 'over_budget'});
		expect(blockedChat).not.toHaveBeenCalled();
	});
});
