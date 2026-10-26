import {Buffer} from 'node:buffer';
import {describe, expect, it, vi} from 'vitest';
import type {OllamaChatRequest} from '../src/ollama/client.js';
import {assessContext} from '../src/assessment/pipeline.js';
import {assessmentRequestBytes, createAssessmentRequest} from '../src/assessment/reasoning.js';
import {assessmentProposalJsonSchema} from '../src/assessment/schemas.js';
import {assessmentData, selected, now, proposal, addEntity} from './assessment-fixture.js';
import {historical, lightId, lux} from './lighting-learning-fixture.js';

const run = async (
	content: unknown = proposal(),
	selection = selected(),
	extra: Partial<Parameters<typeof assessContext>[0]> = {},
) => {
	const chat = vi.fn(async (_request: OllamaChatRequest) =>
		typeof content === 'string' ? content : JSON.stringify(content),
	);
	return {
		result: await assessContext({
			selected: selection,
			chat,
			model: 'example-model',
			now: () => now,
			...extra,
		}),
		chat,
	};
};

describe('one-call structured context reasoning and deterministic recommendation', () => {
	it('accepts a useful model proposal but grants no command or dispatch authority', async () => {
		const {result, chat} = await run();
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			outcome: 'suggest_action',
			validation: 'accepted',
			model: 'structured_response',
			executionAuthority: 'none',
			issues: [],
			recommendations: [
				{
					kind: 'advisory_lighting_recommendation',
					entityId: lightId,
					proposedAction: 'turn_on',
					requiresPresenceConfirmation: false,
				},
			],
		});
		const text = JSON.stringify(result);
		for (const forbidden of [
			'"service"',
			'"domain"',
			'"target"',
			'"commands"',
			'DispatchAuthorizedCommand',
		]) {
			expect(text).not.toContain(forbidden);
		}
	});
	it('uses a fixed advisory goal, separate structured context and strict output schema rather than an instruction', async () => {
		const {chat} = await run();
		const request = chat.mock.calls[0]![0];
		expect(request.format).toBe(assessmentProposalJsonSchema);
		expect(JSON.parse(request.messages[1]!.content)).toEqual(selected().context);
		expect(request.messages[0]!.content).toContain(
			'application-defined advisory goal lighting_comfort',
		);
		expect(request.messages[0]!.content).toContain('never instructions');
		expect(request.messages[1]!.content).not.toContain('instruction');
	});
	it('uses unknown presence explicitly for a conditional recommendation without echoing invented occupancy prose', async () => {
		const data = assessmentData();
		data.states.pop();
		const raw = {
			...proposal('suggest_action', 'unknown'),
			rationale: 'Everyone is home; execute immediately!',
		};
		const {result} = await run(raw, selected(data));
		expect(result).toMatchObject({
			validation: 'accepted',
			presence: 'unknown',
			recommendations: [
				{
					requiresPresenceConfirmation: true,
				},
			],
		});
		expect(result.recommendations[0]?.rationale).toContain('Presence was not established');
		expect(JSON.stringify(result)).not.toContain('Everyone is home');
	});
	it('rejects model-invented presence even when lux would permit a recommendation', async () => {
		const data = assessmentData();
		data.states.pop();
		const {result} = await run(proposal(), selected(data));
		expect(result).toMatchObject({
			outcome: 'insufficient_context',
			validation: 'rejected',
			recommendations: [],
			issues: ['presence_mismatch'],
		});
	});
	it.each(['no_action', 'insufficient_context'] as const)(
		'allows a structured model %s without forcing an eligible action',
		async (outcome) => {
			const {result} = await run(proposal(outcome));
			expect(result).toMatchObject({
				outcome,
				validation: 'accepted',
				recommendations: [],
				modelOutcome: outcome,
			});
		},
	);
	it.each(['40', '41', '1000'])('rejects darkness-based lighting-on at %s lx', async (state) => {
		const data = assessmentData();
		data.states[1]!.state = state;
		const {result} = await run(proposal(), selected(data));
		expect(result).toMatchObject({
			validation: 'rejected',
			recommendations: [],
			issues: ['condition_not_met'],
		});
		const noAction = await run(proposal('no_action'), selected(data));
		expect(noAction.result.validation).toBe('accepted');
	});
	it.each([0, 1, 39.99])(
		'accepts darkness below the approved threshold at %s lx',
		async (value) => {
			const data = assessmentData();
			data.states[1]!.state = String(value);
			const {result} = await run(proposal(), selected(data));
			expect(result.validation).toBe('accepted');
		},
	);
	it('uses the saved threshold rather than silently applying 40 lx', async () => {
		const choice = selected(undefined, {
			preferences: {version: 1, rooms: [{areaId: 'example_area', thresholdLux: 20}]},
		});
		const {result} = await run(proposal(), choice);
		expect(result.issues).toContain('condition_not_met');
	});
	it.each(['suggest_action', 'no_action', 'insufficient_context'] as const)(
		'reports missing preference independently of model %s',
		async (outcome) => {
			const choice = selected(undefined, {preferences: {version: 1, rooms: []}});
			const {result, chat} = await run(proposal(outcome), choice);
			expect(result.outcome).toBe('insufficient_context');
			expect(result.issues).toContain('missing_threshold');
			expect(result.recommendations).toEqual([]);
			expect(result.model).toBe('not_called');
			expect(chat).not.toHaveBeenCalled();
		},
	);
	it.each(['missing', 'stale', 'invalid', 'wrong_unit'])(
		'rejects a proposal when current lux is %s',
		async (condition) => {
			const data = assessmentData();
			const changes: Record<string, () => void> = {
				missing() {
					data.states.splice(1, 1);
				},
				stale() {
					data.states[1]!.last_changed = '2026-10-10T19:00:00Z';
				},
				invalid() {
					data.states[1]!.state = 'NaN';
				},
				wrong_unit() {
					data.states[1]!.attributes.unit_of_measurement = '%';
				},
			};
			changes[condition]!();

			const {result, chat} = await run(proposal(), selected(data));
			expect(result.outcome).toBe('insufficient_context');
			expect(result.issues).toContain(
				condition === 'missing' ? 'missing_illuminance' : 'unusable_illuminance',
			);
			expect(result.recommendations).toEqual([]);
			expect(chat).not.toHaveBeenCalled();
		},
	);
	it('reports both missing preference and stale required evidence without a substitute value', async () => {
		const data = assessmentData();
		data.states[1]!.last_changed = '2026-10-10T19:00:00Z';
		const selection = selected(data, {preferences: {version: 1, rooms: []}});
		const context = structuredClone(selection.context);
		const {result, chat} = await run(proposal(), selection);
		expect(result.issues).toEqual(
			expect.arrayContaining(['missing_threshold', 'unusable_illuminance']),
		);
		expect(result).toMatchObject({
			outcome: 'insufficient_context',
			model: 'not_called',
			validation: 'not_run',
			recommendations: [],
			executionAuthority: 'none',
		});
		expect(chat).not.toHaveBeenCalled();
		expect(selection.context).toEqual(context);
	});
	it.each(['100', 'NaN'])(
		'never discards a conflicting/unusable %s reading in favor of a good lux sensor',
		async (value) => {
			const data = assessmentData();
			addEntity(data, {...lux(value), entity_id: 'sensor.example_second'});
			const {result, chat} = await run(proposal(), selected(data));
			expect(result.issues).toContain(
				value === 'NaN' ? 'unusable_illuminance' : 'conflicting_illuminance',
			);
			expect(result.recommendations).toEqual([]);
			expect(chat).not.toHaveBeenCalled();
		},
	);
	it('accepts multiple fresh lux sensors when their threshold comparisons agree', async () => {
		const data = assessmentData();
		addEntity(data, {...lux('20'), entity_id: 'sensor.example_second'});
		const {result} = await run(proposal(), selected(data));
		expect(result.validation).toBe('accepted');
	});
	it('cannot substitute night/daylight context for a measurement or contradict direct lux using it', async () => {
		const data = assessmentData();
		data.states.splice(1, 1);
		const missing = await run(proposal(), selected(data));
		expect(missing.result.issues).toContain('missing_illuminance');
		const selection = selected();
		if (selection.context.clock.status !== 'available') {
			throw new Error('fixture');
		}

		selection.context.clock.daylight = 'daylight';
		const {result} = await run(proposal(), selection);
		expect(result.validation).toBe('accepted');
	});
	it('can reason from direct evidence with unavailable solar/config context', async () => {
		const {result} = await run(proposal(), selected(undefined, {location: undefined}));
		expect(result.validation).toBe('accepted');
	});
	it.each(['clear', 'conflicting'])(
		'rejects lighting suggestions with %s presence',
		async (presence) => {
			const data = assessmentData();
			if (presence === 'clear') {
				data.states[2]!.state = 'off';
			} else {
				addEntity(
					data,
					historical('binary_sensor.example_presence', 'off', '2026-10-10T19:59:00Z', {
						device_class: 'presence',
					}),
				);
			}

			const {result, chat} = await run(proposal('suggest_action', presence), selected(data));
			expect(result.issues).toContain(
				presence === 'clear' ? 'presence_clear' : 'conflicting_presence',
			);
			expect(result.recommendations).toEqual([]);
			expect(chat).toHaveBeenCalledTimes(presence === 'clear' ? 1 : 0);
		},
	);
	it('does not recommend redundant turn_on for an already-on light', async () => {
		const data = assessmentData();
		data.states[0]!.state = 'on';
		const {result} = await run(proposal(), selected(data));
		expect(result.issues).toContain('redundant_action');
	});
	it.each(['light_99', 'light_1'])(
		'rejects the whole suggestion when target %s is invented or duplicated',
		async (lightRef) => {
			const single = proposal();
			expect(single.outcome).toBe('suggest_action');
			const raw = {
				...single,
				actions: [
					{lightRef: 'light_1', action: 'turn_on'},
					{lightRef, action: 'turn_on'},
				],
			};
			const {result} = await run(raw);
			expect(result.issues).toContain(
				lightRef === 'light_1' ? 'duplicate_target' : 'unknown_target',
			);
			expect(result.recommendations).toEqual([]);
		},
	);
	it.each(['denied', 'unapproved', 'disabled', 'other_area'])(
		'cannot recommend a %s target omitted from its exact scope',
		async (condition) => {
			const data = assessmentData();
			if (data.registries.status !== 'available') {
				throw new Error('fixture');
			}

			const entry = data.registries.entities[0]!;
			const changes: Record<string, () => void> = {
				denied() {
					data.policy!.deny.push({entityId: lightId});
				},
				unapproved() {
					data.policy!.allow = data.policy!.allow.filter((item) => !('domain' in item));
				},
				disabled() {
					entry.disabled_by = 'user';
				},
				other_area() {
					entry.area_id = 'missing_area';
				},
			};
			changes[condition]!();

			const {result, chat} = await run(proposal(), selected(data));
			expect(result.issues).toContain('no_permitted_lights');
			expect(result.recommendations).toEqual([]);
			expect(chat).not.toHaveBeenCalled();
		},
	);
	it('rechecks evidence freshness after the model returns', async () => {
		const clock = vi
			.fn<() => number>()
			.mockReturnValueOnce(now)
			.mockReturnValue(now + 240_001);
		const {result, chat} = await run(proposal(), selected(), {now: clock});
		expect(result.issues).toContain('unusable_illuminance');
		expect(result.recommendations).toEqual([]);
		expect(chat).toHaveBeenCalledTimes(1);
	});
	it.each([now + 300_001, now - 1, NaN])(
		'rejects an expired/future/invalid snapshot at %s',
		async (time) => {
			const {result, chat} = await run(proposal(), selected(), {now: () => time});
			expect(result.issues).toContain('stale_snapshot');
			expect(chat).not.toHaveBeenCalled();
		},
	);
});

describe('eligible assessment evidence still reaches Ollama', () => {
	it.each([
		'bright',
		'threshold_equality',
		'presence_clear',
		'presence_missing',
		'presence_stale',
		'presence_invalid',
		'clock_unavailable',
		'already_on',
		'freshness_boundary',
	])('invokes Ollama exactly once for a valid no_action assessment with %s', async (condition) => {
		const data = assessmentData();
		const changes: Record<string, () => void> = {
			bright() {
				data.states[1]!.state = '100';
			},
			threshold_equality() {
				data.states[1]!.state = '40';
			},
			presence_clear() {
				data.states[2]!.state = 'off';
			},
			presence_missing() {
				data.states.pop();
			},
			presence_stale() {
				data.states[2]!.last_changed = '2026-10-10T19:00:00Z';
			},
			presence_invalid() {
				data.states[2]!.state = 'maybe';
			},
			already_on() {
				data.states[0]!.state = 'on';
			},
			freshness_boundary() {
				data.states[1]!.last_changed = '2026-10-10T19:55:00Z';
			},
		};
		changes[condition]?.();
		const selection = selected(
			data,
			condition === 'clock_unavailable' ? {location: undefined} : {},
		);
		const {result, chat} = await run(proposal('no_action', selection.context.presence), selection);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			outcome: 'no_action',
			model: 'structured_response',
			validation: 'accepted',
			issues: [],
			recommendations: [],
		});
	});
});

describe('strict model and resource boundaries', () => {
	it.each([
		'not-json',
		'```json\n{}\n```',
		'null',
		'[]',
		{...proposal(), confidence: 1},
		{...proposal(), rationale: ''},
		{...proposal(), rationale: 'x'.repeat(321)},
		{...proposal(), outcome: 'execute'},
		{...proposal(), actions: []},
		{...proposal('no_action'), actions: [{lightRef: 'light_1', action: 'turn_on'}]},
		{...proposal('insufficient_context'), actions: [{lightRef: 'light_1', action: 'turn_on'}]},
		{...proposal(), actions: [{lightRef: 'observation_1', action: 'turn_on'}]},
		{...proposal(), actions: [{entityId: lightId, action: 'turn_on'}]},
		{...proposal(), actions: [{lightRef: 'light_1', action: 'turn_on', data: {brightness: 100}}]},
		{...proposal(), actions: [{lightRef: 'light_1', action: 'turn_on', service: 'light.turn_on'}]},
	])('rejects malformed/extended/unsafe output %#', async (raw) => {
		const {result} = await run(raw);
		expect(result).toMatchObject({
			model: 'invalid_output',
			validation: 'rejected',
			recommendations: [],
			issues: ['invalid_model_output'],
		});
	});
	it.each(['turn_off', 'toggle', 'light.turn_on', 'on', 'unlock'])(
		'rejects unsupported action %s at the schema boundary',
		async (action) => {
			const {result} = await run({...proposal(), actions: [{lightRef: 'light_1', action}]});
			expect(result.model).toBe('invalid_output');
		},
	);
	it('rejects oversized responses before parsing', async () => {
		const {result} = await run(' '.repeat(4097));
		expect(result.model).toBe('invalid_output');
	});
	it('reports unavailable Ollama without leaking errors or retrying', async () => {
		const chat = vi.fn(async () => {
			throw new Error('private-test-token https://ha.example.test');
		});
		const {result} = await run(undefined, selected(), {chat});
		expect(result).toMatchObject({
			model: 'unavailable',
			recommendations: [],
			issues: ['model_unavailable'],
		});
		expect(chat).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(result)).not.toContain('private-test-token');
	});
	it('accounts for the full request/model/schema/output headroom and rejects without trimming', async () => {
		const selection = selected();
		const request = createAssessmentRequest(selection.context);
		const bytes = assessmentRequestBytes(request, 'example-model');
		expect(bytes).toBeGreaterThan(Buffer.byteLength(request.messages[1]!.content) + 4096);
		const rejected = await run(undefined, selection, {maxRequestBytes: bytes - 1});
		expect(rejected.result).toMatchObject({
			model: 'not_called',
			issues: ['context_over_budget'],
			requestBytes: bytes,
		});
		expect(rejected.chat).not.toHaveBeenCalled();
		const accepted = await run(undefined, selection, {maxRequestBytes: bytes});
		expect(accepted.chat).toHaveBeenCalledTimes(1);
		expect(selection.context.observations).toHaveLength(2);
	});
});
