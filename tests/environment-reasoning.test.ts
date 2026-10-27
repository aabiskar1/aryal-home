import {Buffer} from 'node:buffer';
import {describe, expect, it, vi} from 'vitest';
import type {OllamaChatRequest} from '../src/ollama/client.js';
import {assessContext} from '../src/assessment/pipeline.js';
import {assessmentRequestBytes} from '../src/assessment/reasoning.js';
import {createEnvironmentRequest} from '../src/assessment/environment-reasoning.js';
import {environmentProposalJsonSchema} from '../src/assessment/environment-schemas.js';
import {
	environmentData,
	selectedEnvironment,
	environmentProposal,
	stateFor,
	weatherId,
	temperatureId,
	humidityId,
} from './environment-fixture.js';
import {addEntity, now, presenceId} from './assessment-fixture.js';
import {historical} from './lighting-learning-fixture.js';

const run = async (
	raw: unknown = environmentProposal(),
	selection = selectedEnvironment(),
	extra: Partial<Parameters<typeof assessContext>[0]> = {},
) => {
	const chat = vi.fn(async (_request: OllamaChatRequest) =>
		typeof raw === 'string' ? raw : JSON.stringify(raw),
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

describe('multi-source environmental reasoning and independent facts', () => {
	it('calls the existing model once with selected facts, a fixed goal and strict environmental schema', async () => {
		const {result, chat} = await run();
		expect(chat).toHaveBeenCalledTimes(1);
		const request = chat.mock.calls[0]![0];
		expect(request.format).toBe(environmentProposalJsonSchema);
		expect(JSON.parse(request.messages[1]!.content)).toEqual(selectedEnvironment().context);
		expect(request.messages[0]!.content).toContain('environment_comfort');
		expect(result).toMatchObject({
			outcome: 'insight',
			model: 'structured_response',
			validation: 'accepted',
			executionAuthority: 'none',
			recommendations: [],
			insights: [
				{
					kind: 'environment_insight',
					category: 'temperature_comparison',
					temperatureRelation: 'indoor_warmer',
					weatherCondition: 'rainy',
				},
			],
		});
	});
	it.each([
		{condition: 'rainy', category: 'weather_caution', outcome: 'insight'},
		{condition: 'pouring', category: 'weather_caution', outcome: 'insight'},
		{condition: 'sunny', category: 'ventilation_review', outcome: 'recommend_review'},
		{condition: 'clear-night', category: 'ventilation_review', outcome: 'recommend_review'},
	])(
		'grounds $category in $condition with otherwise identical indoor conditions',
		async ({condition, category, outcome}) => {
			const data = environmentData();
			stateFor(data, weatherId).state = condition;
			const {result, chat} = await run(
				environmentProposal({category, outcome, weatherCondition: condition}),
				selectedEnvironment(data),
			);
			expect(chat).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				outcome,
				validation: 'accepted',
				recommendations: [],
				insights: [{category, weatherCondition: condition}],
			});
			if (category === 'ventilation_review') {
				expect(result).toMatchObject({
					insights: [
						{
							requiresAdditionalContext: [
								'window_safety',
								'outdoor_air_quality',
								'comfort_preferences',
								'user_intent',
							],
						},
					],
				});
			}
		},
	);
	it.each(['rainy', 'snowy', 'hail', 'fog', 'windy', 'exceptional'])(
		'rejects a ventilation review implying benign weather during %s',
		async (condition) => {
			const data = environmentData();
			stateFor(data, weatherId).state = condition;
			const {result} = await run(
				environmentProposal({
					outcome: 'recommend_review',
					category: 'ventilation_review',
					weatherCondition: condition,
				}),
				selectedEnvironment(data),
			);
			expect(result).toMatchObject({validation: 'rejected', insights: [], recommendations: []});
			expect(result.issues).toContain('weather_category_contradiction');
		},
	);
	it.each([
		{outdoor: 23, relation: 'similar'},
		{outdoor: 22.5, relation: 'similar'},
		{outdoor: 23.5, relation: 'similar'},
		{outdoor: 22.499999, relation: 'indoor_warmer'},
		{outdoor: 23.500001, relation: 'indoor_cooler'},
	])(
		'checks relative temperature against $outdoor C using the labelled comparison band',
		async ({outdoor, relation}) => {
			const data = environmentData();
			stateFor(data, weatherId).attributes.temperature = outdoor;
			const {result} = await run(
				environmentProposal({temperatureRelation: relation}),
				selectedEnvironment(data),
			);
			expect(result.validation).toBe('accepted');
		},
	);
	it('rejects ventilation cooling claims when indoor/outdoor temperatures are similar', async () => {
		const data = environmentData();
		stateFor(data, weatherId).state = 'sunny';
		stateFor(data, weatherId).attributes.temperature = 23;
		const {result} = await run(
			environmentProposal({
				outcome: 'recommend_review',
				category: 'ventilation_review',
				temperatureRelation: 'similar',
				weatherCondition: 'sunny',
			}),
			selectedEnvironment(data),
		);
		expect(result.issues).toContain('category_requires_warmer_indoors');
		expect(result).toMatchObject({insights: []});
	});
	it('compares normalized Fahrenheit and Celsius evidence rather than raw numbers', async () => {
		const data = environmentData();
		stateFor(data, temperatureId).state = '73.4';
		stateFor(data, temperatureId).attributes.unit_of_measurement = '°F';
		const {result} = await run(environmentProposal(), selectedEnvironment(data));
		expect(result.validation).toBe('accepted');
	});
	it.each([
		{value: '65', relation: 'indoor_higher'},
		{value: '45', relation: 'indoor_lower'},
		{value: '50.5', relation: 'similar'},
	])(
		'allows a supported relative humidity $relation insight without invented comfort preferences',
		async ({value, relation}) => {
			const data = environmentData();
			stateFor(data, humidityId).state = value;
			const {result} = await run(
				environmentProposal({
					category: 'humidity_comparison',
					temperatureRelation: 'not_compared',
					humidityRelation: relation,
					evidenceRefs: ['indoor_3', 'weather_1', 'outdoor_humidity'],
				}),
				selectedEnvironment(data),
			);
			expect(result).toMatchObject({
				validation: 'accepted',
				insights: [{humidityRelation: relation, requiresAdditionalContext: []}],
			});
			expect(JSON.stringify(result)).toContain('Relative humidity alone does not prove');
		},
	);
	it('distinguishes missing comfort preferences from missing measurements and requests review without a comfort threshold', async () => {
		const data = environmentData();
		delete stateFor(data, weatherId).attributes.temperature;
		delete stateFor(data, weatherId).attributes.humidity;
		const choice = selectedEnvironment(data);
		const {result, chat} = await run(
			environmentProposal({
				outcome: 'recommend_review',
				category: 'comfort_preferences_review',
				temperatureRelation: 'not_compared',
				evidenceRefs: ['indoor_3', 'weather_1'],
			}),
			choice,
		);
		expect(choice.context.preference.status).toBe('unknown');
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			validation: 'accepted',
			insights: [
				{
					category: 'comfort_preferences_review',
					requiresAdditionalContext: ['comfort_preferences', 'user_intent'],
				},
			],
		});
	});
	it('preserves unknown presence and never echoes invented occupancy, window, forecast or comfort prose', async () => {
		const data = environmentData();
		data.policy!.deny.push({entityId: presenceId});
		const {result} = await run(
			environmentProposal({
				presence: 'unknown',
				evidenceRefs: ['indoor_1', 'weather_1', 'outdoor_temperature'],
				rationale:
					'People are home, windows are open and rain will stop tomorrow; 23 C is universally uncomfortable.',
			}),
			selectedEnvironment(data),
		);
		expect(result.validation).toBe('accepted');
		expect(result).toMatchObject({presence: 'unknown'});
		for (const untrusted of [
			'People are home',
			'windows are open',
			'tomorrow',
			'universally uncomfortable',
		]) {
			expect(JSON.stringify(result)).not.toContain(untrusted);
		}
	});
	it.each(['indoor_cooler', 'similar'])(
		'rejects an unsupported model temperature comparison %s',
		async (relation) => {
			const {result} = await run(environmentProposal({temperatureRelation: relation}));
			expect(result.issues).toContain('unsupported_temperature_claim');
			expect(result).toMatchObject({validation: 'rejected', insights: []});
		},
	);
	it('rejects unsupported weather and humidity claims even when all their references exist', async () => {
		const {result} = await run(
			environmentProposal({
				weatherCondition: 'sunny',
				humidityRelation: 'indoor_lower',
				evidenceRefs: [
					'indoor_2',
					'indoor_3',
					'weather_1',
					'outdoor_temperature',
					'outdoor_humidity',
				],
			}),
		);
		expect(result.issues).toEqual(
			expect.arrayContaining(['weather_claim_mismatch', 'unsupported_humidity_claim']),
		);
		expect(result).toMatchObject({insights: []});
	});
	it.each([
		{
			refs: ['indoor_99', 'weather_1', 'outdoor_temperature'],
			issue: 'unsupported_evidence_reference',
		},
		{
			refs: ['indoor_2', 'indoor_2', 'weather_1', 'outdoor_temperature'],
			issue: 'duplicate_evidence_reference',
		},
		{refs: ['indoor_2', 'outdoor_temperature'], issue: 'missing_multi_source_support'},
		{refs: ['indoor_2', 'weather_1'], issue: 'missing_temperature_support'},
	])('requires actual complete supporting references: $issue', async ({refs, issue}) => {
		const {result} = await run(environmentProposal({evidenceRefs: refs}));
		expect(result.issues).toContain(issue);
		expect(result).toMatchObject({insights: []});
	});
	it('cannot arbitrarily cite one of several equal indoor sensors to imply complete support', async () => {
		const data = environmentData();
		addEntity(
			data,
			historical('sensor.example_second_temperature', '23', '2026-10-10T19:59:00Z', {
				device_class: 'temperature',
				unit_of_measurement: '°C',
			}),
		);
		const {result} = await run(environmentProposal(), selectedEnvironment(data));
		expect(result.issues).toContain('missing_temperature_support');
	});
	it.each(['conflicting', 'stale', 'unavailable'])(
		'can use humidity while temperature is %s, but cannot cite the unusable temperature profile',
		async (condition) => {
			const data = environmentData();
			const changes: Record<string, () => void> = {
				conflicting() {
					addEntity(
						data,
						historical('sensor.example_second_temperature', '24', '2026-10-10T19:59:00Z', {
							device_class: 'temperature',
							unit_of_measurement: '°C',
						}),
					);
				},
				stale() {
					stateFor(data, temperatureId).last_changed = '2026-10-10T19:00:00Z';
				},
				unavailable() {
					stateFor(data, temperatureId).state = 'unavailable';
				},
			};
			changes[condition]!();
			const choice = selectedEnvironment(data);
			const accepted = await run(
				environmentProposal({
					category: 'humidity_comparison',
					temperatureRelation: 'not_compared',
					humidityRelation: 'indoor_higher',
					evidenceRefs: ['indoor_3', 'weather_1', 'outdoor_humidity'],
				}),
				choice,
			);
			expect(accepted.chat).toHaveBeenCalledTimes(1);
			expect(accepted.result.validation).toBe('accepted');
			const rejected = await run(environmentProposal(), choice);
			expect(rejected.result.issues).toContain('unsupported_temperature_claim');
			expect(rejected.result).toMatchObject({insights: []});
		},
	);
	it.each(['no_action', 'insufficient_context'])(
		'accepts a structured model %s without forcing an insight',
		async (outcome) => {
			const {result, chat} = await run({
				outcome,
				rationale: 'No useful insight is established.',
				presence: 'detected',
			});
			expect(chat).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				outcome,
				validation: 'accepted',
				insights: [],
				recommendations: [],
			});
		},
	);
});

describe('environment preflight, output and resource boundaries', () => {
	it('accepts a complete, consistent indoor profile after cross-unit normalization', async () => {
		const data = environmentData();
		addEntity(
			data,
			historical('sensor.example_second_temperature', '73.4', '2026-10-10T19:59:00Z', {
				device_class: 'temperature',
				unit_of_measurement: '°F',
			}),
		);
		const {result, chat} = await run(
			environmentProposal({
				evidenceRefs: ['indoor_2', 'indoor_4', 'weather_1', 'outdoor_temperature'],
			}),
			selectedEnvironment(data),
		);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.validation).toBe('accepted');
	});
	it('accepts current weather attributes when the condition itself has not changed recently', async () => {
		const data = environmentData();
		stateFor(data, weatherId).last_changed = '2026-10-01T00:00:00Z';
		const {result, chat} = await run(environmentProposal(), selectedEnvironment(data));
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.validation).toBe('accepted');
	});
	it.each([
		'weather_unapproved',
		'weather_missing',
		'weather_stale',
		'weather_invalid',
		'weather_unavailable',
		'weather_multiple',
		'indoor_missing',
		'indoor_stale',
		'indoor_invalid',
		'indoor_conflicting',
		'indoor_unavailable',
	])('skips Ollama for %s and retains trusted context diagnostics', async (condition) => {
		const data = environmentData();
		const changes: Record<string, () => void> = {
			weather_unapproved() {
				data.policy!.deny.push({entityId: weatherId});
			},
			weather_missing() {
				data.states = data.states.filter((item) => item.entity_id !== weatherId);
			},
			weather_stale() {
				stateFor(data, weatherId).last_changed = '2026-10-10T19:00:00Z';
				stateFor(data, weatherId).last_updated = '2026-10-10T19:00:00Z';
			},
			weather_invalid() {
				stateFor(data, weatherId).state = 'made-up-weather';
			},
			weather_unavailable() {
				stateFor(data, weatherId).state = 'unavailable';
			},
			weather_multiple() {
				addEntity(data, historical('weather.example_second', 'sunny'));
			},
			indoor_missing() {
				data.states = data.states.filter(
					(item) => ![temperatureId, humidityId].includes(item.entity_id),
				);
			},
			indoor_stale() {
				for (const id of [temperatureId, humidityId]) {
					stateFor(data, id).last_changed = '2026-10-10T19:00:00Z';
				}
			},
			indoor_invalid() {
				for (const id of [temperatureId, humidityId]) {
					stateFor(data, id).state = 'NaN';
				}
			},
			indoor_conflicting() {
				for (const [id, device_class, unit, state] of [
					['sensor.example_second_temperature', 'temperature', '°C', '26'],
					['sensor.example_second_humidity', 'humidity', '%', '30'],
				]) {
					addEntity(
						data,
						historical(id!, state!, '2026-10-10T19:59:00Z', {
							device_class,
							unit_of_measurement: unit,
						}),
					);
				}
			},
			indoor_unavailable() {
				for (const id of [temperatureId, humidityId]) {
					stateFor(data, id).state = 'unavailable';
				}
			},
		};
		changes[condition]!();
		const choice = selectedEnvironment(data);
		const snapshot = structuredClone(choice.context);
		const {result, chat} = await run(environmentProposal(), choice);
		expect(chat).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			outcome: 'insufficient_context',
			model: 'not_called',
			executionAuthority: 'none',
			recommendations: [],
		});
		expect(result.issues.length).toBeGreaterThan(0);
		expect(choice.context).toEqual(snapshot);
	});
	it('rechecks current evidence after generation without retrying the model', async () => {
		const clock = vi
			.fn<() => number>()
			.mockReturnValueOnce(now)
			.mockReturnValue(now + 240_001);
		const {result, chat} = await run(undefined, selectedEnvironment(), {now: clock});
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.issues).toContain('weather_stale');
		expect(result).toMatchObject({validation: 'rejected', insights: []});
	});
	it('allows unavailable time and optional unknown presence while assessing measurements', async () => {
		const data = environmentData();
		data.policy!.deny.push({entityId: presenceId});
		const {result, chat} = await run(
			environmentProposal({
				presence: 'unknown',
				evidenceRefs: ['indoor_1', 'weather_1', 'outdoor_temperature'],
			}),
			selectedEnvironment(data, {location: undefined}),
		);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.validation).toBe('accepted');
	});
	it.each([
		'not JSON',
		'null',
		'[]',
		{...environmentProposal(), forecast: 'sunny tomorrow'},
		{...environmentProposal(), windowState: 'open'},
		{...environmentProposal(), comfortThreshold: 21},
		{...environmentProposal(), actions: [{action: 'open_cover'}]},
		{...environmentProposal(), evidenceRefs: ['sensor.private_identifier', 'weather_1']},
		{...environmentProposal(), rationale: 'x'.repeat(321)},
		{...environmentProposal(), category: 'turn_on_heating'},
		{...environmentProposal(), confidence: 1},
		{...environmentProposal(), weatherCondition: 'dry'},
	])('rejects malformed, invented or executable output %#', async (raw) => {
		const {result} = await run(raw);
		expect(result).toMatchObject({
			model: 'invalid_output',
			validation: 'rejected',
			recommendations: [],
		});
	});
	it('rejects unsupported presence facts independent of model prose', async () => {
		const data = environmentData();
		data.policy!.deny.push({entityId: presenceId});
		const {result} = await run(
			environmentProposal({evidenceRefs: ['indoor_1', 'weather_1', 'outdoor_temperature']}),
			selectedEnvironment(data),
		);
		expect(result.issues).toEqual(['presence_mismatch']);
	});
	it('reports an unavailable model without leaking errors or making a second call', async () => {
		const chat = vi.fn(async () => {
			throw new Error('private-test-token https://ha.example.test');
		});
		const {result} = await run(undefined, selectedEnvironment(), {chat});
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({model: 'unavailable', recommendations: []});
		expect(JSON.stringify(result)).not.toContain('private-test-token');
	});
	it('counts the entire request/schema/model/output headroom and never trims it to fit', async () => {
		const choice = selectedEnvironment();
		const request = createEnvironmentRequest(choice.context);
		const bytes = assessmentRequestBytes(request, 'example-model');
		expect(bytes).toBeGreaterThan(Buffer.byteLength(request.messages[1]!.content) + 4096);
		const rejected = await run(undefined, choice, {maxRequestBytes: bytes - 1});
		expect(rejected.chat).not.toHaveBeenCalled();
		expect(rejected.result.issues).toContain('context_over_budget');
		const accepted = await run(undefined, choice, {maxRequestBytes: bytes});
		expect(accepted.chat).toHaveBeenCalledTimes(1);
	});
	it('retains the hard resource ceiling even when a caller requests a larger budget', async () => {
		const {result, chat} = await run(undefined, selectedEnvironment(), {
			model: 'x'.repeat(25_000),
			maxRequestBytes: 1_000_000,
		});
		expect(chat).not.toHaveBeenCalled();
		expect(result.issues).toContain('context_over_budget');
	});
	it('rejects oversized model responses', async () => {
		const {result} = await run(' '.repeat(4097));
		expect(result.model).toBe('invalid_output');
	});
});
