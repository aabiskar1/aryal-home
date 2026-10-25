import {describe, expect, it, vi} from 'vitest';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {OllamaChatTransport} from '../src/ollama/client.js';
import {runPlanningPipeline} from '../src/planning/pipeline.js';
import type {Plan} from '../src/planning/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';

const lightIds = Array.from({length: 6}, (_, index) => `light.example_living_${index + 1}`);
const sensorId = 'sensor.example_living_illuminance';
const state = (entityId: string, value: string, deviceClass?: string): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {
		friendly_name: `Example ${entityId}`,
		device_class: deviceClass,
		...(deviceClass === 'illuminance' && {unit_of_measurement: 'lx'}),
	},
	last_changed: '',
	last_updated: '',
});
const fixture = (value: string | undefined = '48', isDenied = false) => {
	const states = [
		...lightIds.map((entityId) => state(entityId, 'off')),
		state('binary_sensor.example_presence', 'on', 'presence'),
		...(value === undefined ? [] : [state(sensorId, value, 'illuminance')]),
	];
	const entities = discoverEntities(states, {
		status: 'available',
		entities: states.map(({entity_id: entityId}) => ({
			entity_id: entityId,
			device_id: null,
			area_id: 'example_living',
			disabled_by: null,
			labels: [],
		})),
		devices: [],
		areas: [{area_id: 'example_living', name: 'Living Room', aliases: ['Lounge'], labels: []}],
		labels: [],
	});
	const policy = resolveEntityPolicy(entities, {
		version: 1,
		allow: [{domain: 'light'}, {domain: 'sensor'}, {domain: 'binary_sensor'}],
		deny: isDenied ? [{entityId: sensorId}] : [],
	});
	return {entities, policy};
};

const turnOnSet: Plan['actions'][number] = {
	type: 'set_action',
	action: 'turn_on',
	scope: {area: 'Living Room', domain: 'light'},
	reason: 'The model considers 48 lx dark enough to turn on the lights.',
};
const proposal = (actions: Plan['actions'] = [turnOnSet]): Plan => ({
	outcome: 'propose_actions',
	summary: 'Proposed plan: Turn on the lights because 48 lx means dark.',
	actions,
});
const run = async (instruction: string, input = fixture(), response = proposal()) => {
	const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(response));
	const result = await runPlanningPipeline(instruction, input.entities, input.policy, {
		model: 'example-model',
		maxRequestBytes: 100_000,
		chat,
	});
	return {result, chat};
};

describe('application-owned illuminance condition safety', () => {
	it.each(['if dark', 'if too dark', 'when dim', 'when bright', 'if the light level is low'])(
		'rejects otherwise executable six-light model proposals for %s',
		async (condition) => {
			const input = fixture();
			const unconditional = await run('Turn on all Living Room lights', input);
			expect(unconditional.result.executionReadiness.commands).toHaveLength(6);
			const {result, chat} = await run(`Turn on all Living Room lights ${condition}`, input);
			expect(chat).toHaveBeenCalledOnce();
			expect(result.selection).toMatchObject({
				kind: 'ready',
				intentMode: 'set_only',
				states: lightIds.map((entityId) => ({entityId, state: 'off'})),
				observations: [expect.objectContaining({entityId: sensorId, state: '48', unit: 'lx'})],
			});
			expect(result.validatedPlan).toMatchObject({outcome: 'insufficient_context', actions: []});
			expect(result.validatedPlan.summary).toContain('Illuminance is available');
			expect(result.validatedPlan.summary).toContain('no reliable darkness/brightness threshold');
			expect(result.executionReadiness.commands).toEqual([]);
			expect(result.intentExpansion.sets).toEqual([]);
			expect(result.conditionIssue?.reason).toBe('unresolved_illuminance_threshold');
		},
	);

	it.each([
		'if illuminance is below 50 lux',
		'if below 50 lx',
		'if below 50lx',
		'if below 50lux',
		'when the light level is less than 100 lx',
		`if ${sensorId} is below 50`,
		'if Example sensor.example_living_illuminance is below 50',
	])('does not delegate numeric comparison authority to the model: %s', async (condition) => {
		const {result} = await run(`Turn on Living Room lights ${condition}`);
		expect(result.selection.kind).toBe('ready');
		expect(result.validatedPlan.outcome).toBe('insufficient_context');
		expect(result.conditionIssue?.reason).toBe('unresolved_illuminance_threshold');
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('rejects individual proposals too, before single-target readiness', async () => {
		const {result} = await run(
			`Turn on ${lightIds[0]} if dark`,
			fixture(),
			proposal([
				{entityId: lightIds[0]!, action: 'turn_on', reason: 'The model guessed darkness.'},
			]),
		);
		expect(result.selection).toMatchObject({kind: 'ready', intentMode: 'entity_only'});
		expect(result.validatedPlan).toMatchObject({outcome: 'insufficient_context', actions: []});
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it.each(['on', 'off'])('does not depend on no-op rejection (all lights %s)', async (value) => {
		const input = fixture();
		for (const entity of input.entities) {
			if (entity.domain === 'light') {
				entity.homeAssistantState.state = value;
			}
		}

		const {result} = await run('Turn on Living Room lights if dark', input);
		expect(result.conditionIssue?.reason).toBe('unresolved_illuminance_threshold');
		expect(result.validatedPlan).toMatchObject({outcome: 'insufficient_context', actions: []});
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it.each(['no_action', 'insufficient_context'] as const)(
		'supplies the trusted explanation even if the model returns %s',
		async (outcome) => {
			const {result} = await run('Turn on Living Room lights if dark', fixture(), {
				outcome,
				summary: 'Proposed plan: Untrusted model wording.',
				actions: [],
			});
			expect(result.validatedPlan.outcome).toBe('insufficient_context');
			expect(result.validatedPlan.summary).not.toContain('Untrusted');
			expect(result.conditionIssue?.reason).toBe('unresolved_illuminance_threshold');
		},
	);

	it.each(['unknown', 'unavailable', 'NaN', 'invalid', ''])(
		'retains missing_observations for unusable evidence %j',
		async (value) => {
			const {result, chat} = await run('Turn on Living Room lights if dark', fixture(value));
			expect(result.selection).toEqual({
				kind: 'insufficient_context',
				reason: 'missing_observations',
			});
			expect(chat).not.toHaveBeenCalled();
			expect(result.conditionIssue).toBeUndefined();
			expect(result.executionReadiness.commands).toEqual([]);
		},
	);
	it.each(['absent', 'denied'])('retains missing_observations for %s evidence', async (reason) => {
		const input = fixture('48', reason === 'denied');
		if (reason === 'absent') {
			input.entities = input.entities.filter((entity) => entity.entityId !== sensorId);
		}

		const {result, chat} = await run('Turn on Living Room lights if dark', input);
		expect(result.selection).toEqual({
			kind: 'insufficient_context',
			reason: 'missing_observations',
		});
		expect(chat).not.toHaveBeenCalled();
		expect(result.conditionIssue).toBeUndefined();
	});
	it.each([
		'Turn on all Living Room lights',
		'Turn on all Living Room lights if someone is there',
		'Turn on all Lounge lights if occupied',
	])('preserves complete permitted-set expansion for %s', async (instruction) => {
		const {result} = await run(instruction);
		expect(result.conditionIssue).toBeUndefined();
		expect(result.intentExpansion.sets[0]?.matchedCount).toBe(6);
		expect(result.executionReadiness.commands).toHaveLength(6);
	});
	it('preserves explicit unconditional entity control', async () => {
		const {result} = await run(
			`Turn on ${lightIds[0]}`,
			fixture(),
			proposal([
				{entityId: lightIds[0]!, action: 'turn_on', reason: 'Explicit unconditional target.'},
			]),
		);
		expect(result.conditionIssue).toBeUndefined();
		expect(result.executionReadiness.commands).toHaveLength(1);
	});
	it('conservatively rejects combined illuminance evidence and control without interpreting independent clauses', async () => {
		const {result} = await run('Turn on Living Room lights and report the light level');
		expect(result.validatedPlan).toMatchObject({outcome: 'insufficient_context', actions: []});
		expect(result.conditionIssue?.reason).toBe('unresolved_illuminance_threshold');
	});
});

it('does not reinterpret a numeric lux spelling inside an explicitly targeted friendly name', async () => {
	const input = fixture();
	input.entities[0]!.homeAssistantState.attributes.friendly_name = '50lx Lamp';
	const {result} = await run(
		'Turn on 50lx Lamp',
		input,
		proposal([{entityId: lightIds[0]!, action: 'turn_on', reason: 'Explicit named lamp.'}]),
	);
	expect(result.selection).toMatchObject({
		kind: 'ready',
		intentMode: 'entity_only',
		observations: [],
	});
	expect(result.conditionIssue).toBeUndefined();
	expect(result.executionReadiness.commands).toHaveLength(1);
});
