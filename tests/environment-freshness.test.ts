import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OllamaChatRequest} from '../src/ollama/client.js';
import {assessContext} from '../src/assessment/pipeline.js';
import {
	environmentReportingPolicySchema,
	environmentReportingPolicyFromEnv,
} from '../src/assessment/environment-freshness.js';
import {
	environmentData,
	selectedEnvironment,
	environmentProposal,
	stateFor,
	temperatureId,
	humidityId,
	weatherId,
} from './environment-fixture.js';
import {addEntity, now} from './assessment-fixture.js';
import {historical} from './lighting-learning-fixture.js';

afterEach(() => vi.unstubAllEnvs());
const old = '2026-10-09T15:00:00Z';
const recent = '2026-10-10T19:59:00Z';
const run = async (
	selection = selectedEnvironment(),
	raw: unknown = environmentProposal(),
	clock = () => now,
) => {
	const chat = vi.fn(async (_request: OllamaChatRequest) => JSON.stringify(raw));
	return {
		result: await assessContext({selected: selection, chat, model: 'example-model', now: clock}),
		chat,
	};
};

describe('environment reporting activity versus physical measurement uncertainty', () => {
	it.each(['temperature', 'humidity'] as const)(
		'assesses recently reported %s with the other profile unavailable',
		async (profile) => {
			const data = environmentData();
			const usableId = profile === 'temperature' ? temperatureId : humidityId;
			const unavailableId = profile === 'temperature' ? humidityId : temperatureId;
			const state = stateFor(data, usableId);
			state.last_changed = old;
			state.last_updated = old;
			state.last_reported = recent;
			stateFor(data, unavailableId).state = 'unavailable';
			const proposal =
				profile === 'temperature'
					? environmentProposal()
					: environmentProposal({
							category: 'humidity_comparison',
							temperatureRelation: 'not_compared',
							humidityRelation: 'indoor_higher',
							evidenceRefs: ['indoor_3', 'weather_1', 'outdoor_humidity'],
						});
			const {result, chat} = await run(selectedEnvironment(data), proposal);
			expect(chat).toHaveBeenCalledTimes(1);
			expect(result.validation).toBe('accepted');
		},
	);
	it('uses recent explicit reporting despite a value unchanged for more than 24 hours', async () => {
		const data = environmentData();
		const raw = stateFor(data, temperatureId);
		raw.last_changed = old;
		raw.last_updated = old;
		raw.last_reported = recent;
		const choice = selectedEnvironment(data);
		expect(choice.context.observations[1]).toMatchObject({
			status: 'available',
			value: 23,
			freshness: 'recently_reported',
			freshnessBasis: 'last_reported',
			lastChangedAt: old,
			updatedAt: old,
			lastReportedAt: recent,
			measurementTime: 'physical_measurement_time_unknown',
		});
		const {result, chat} = await run(choice);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			validation: 'accepted',
			evidenceSemantics: 'recent_home_assistant_activity_not_verified_physical_measurements',
		});
		expect(JSON.stringify(result)).toContain('physical measurement ages remain unknown');
	});
	it('supports recently reported humidity unchanged for several hours independently of temperature', async () => {
		const data = environmentData();
		for (const id of [temperatureId, humidityId]) {
			stateFor(data, id).last_changed = old;
			stateFor(data, id).last_updated = old;
		}

		stateFor(data, humidityId).last_reported = recent;
		const choice = selectedEnvironment(data);
		expect(choice.context.observations[1]).toMatchObject({
			status: 'available',
			freshness: 'last_known_unverified',
			value: 23,
		});
		const {result, chat} = await run(
			choice,
			environmentProposal({
				category: 'humidity_comparison',
				temperatureRelation: 'not_compared',
				humidityRelation: 'indoor_higher',
				evidenceRefs: ['indoor_3', 'weather_1', 'outdoor_humidity'],
			}),
		);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.validation).toBe('accepted');
	});
	it('preserves last-known numeric values and limitations without recent reporting, and skips inference', async () => {
		const data = environmentData();
		for (const id of [temperatureId, humidityId]) {
			const state = stateFor(data, id);
			state.last_changed = old;
			state.last_updated = old;
		}

		const choice = selectedEnvironment(data);
		expect(choice.context.observations[1]).toMatchObject({
			status: 'available',
			value: 23,
			freshness: 'last_known_unverified',
			measurementTime: 'physical_measurement_time_unknown',
		});
		expect(Object.hasOwn(choice.context.observations[1]!, 'lastReportedAt')).toBe(false);
		const snapshot = structuredClone(choice.context);
		const {result, chat} = await run(choice);
		expect(chat).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			outcome: 'insufficient_context',
			model: 'not_called',
			executionAuthority: 'none',
		});
		expect('limitations' in result && result.limitations).toEqual(
			expect.arrayContaining([
				'indoor_temperature_last_known_unverified',
				'indoor_humidity_last_known_unverified',
			]),
		);
		expect(choice.context).toEqual(snapshot);
	});
	it('uses an explicitly labelled state-update fallback when last_reported is absent, never collection time', () => {
		const data = environmentData();
		stateFor(data, temperatureId).last_changed = old;
		const observation = selectedEnvironment(data).context.observations[1]!;
		expect(observation).toMatchObject({
			freshness: 'recently_reported',
			freshnessBasis: 'last_updated',
			measurementTime: 'physical_measurement_time_unknown',
		});
		expect(Object.hasOwn(observation, 'lastReportedAt')).toBe(false);
		stateFor(data, temperatureId).last_updated = old;
		expect(selectedEnvironment(data).context.observations[1]?.freshness).toBe(
			'last_known_unverified',
		);
	});
	it('does not promote last-known values because online/battery metadata looks healthy', () => {
		const data = environmentData();
		const state = stateFor(data, temperatureId);
		state.last_changed = old;
		state.last_updated = old;
		state.attributes.online = true;
		state.attributes.battery = 100;
		expect(selectedEnvironment(data).context.observations[1]).toMatchObject({
			freshness: 'last_known_unverified',
			value: 23,
		});
	});
	it.each([
		{age: 900_000, expected: 'recently_reported'},
		{age: 900_001, expected: 'last_known_unverified'},
	])('enforces the default indoor reporting policy at $age milliseconds', ({age, expected}) => {
		const data = environmentData();
		const state = stateFor(data, temperatureId);
		state.last_changed = old;
		state.last_updated = old;
		state.last_reported = new Date(now - age).toISOString();
		expect(selectedEnvironment(data).context.observations[1]?.freshness).toBe(expected);
	});
	it('honours a configured reporting policy without claiming a device validity guarantee', () => {
		const data = environmentData();
		const state = stateFor(data, temperatureId);
		state.last_changed = old;
		state.last_updated = old;
		state.last_reported = new Date(now - 600_000).toISOString();
		const strict = environmentReportingPolicySchema.parse({indoorMaxReportAgeSeconds: 300});
		expect(
			selectedEnvironment(data, {reportingPolicy: strict}).context.observations[1]?.freshness,
		).toBe('last_known_unverified');
		expect(selectedEnvironment(data).context.reportingPolicy.source).toBe(
			'application_advisory_policy_not_measurement_guarantee',
		);
	});
	it.each(['bad', '2026-10-10T19:59:00', '2026-10-10T19:58:00Z', '2026-10-10T20:00:01Z'])(
		'excludes malformed, out-of-order or future report timestamps %s',
		(reported) => {
			const data = environmentData();
			stateFor(data, temperatureId).last_reported = reported;
			expect(selectedEnvironment(data).context.observations[1]).toMatchObject({
				status: 'invalid',
				freshness: 'unavailable_or_invalid',
				value: null,
			});
		},
	);
	it.each(['unavailable', 'restored', 'unit_invalid'])(
		'cannot make %s evidence usable merely with a recent report',
		(condition) => {
			const data = environmentData();
			const state = stateFor(data, temperatureId);
			state.last_reported = recent;
			const changes: Record<string, () => void> = {
				unavailable() {
					state.state = 'unavailable';
				},
				restored() {
					state.attributes.restored = true;
				},
				unit_invalid() {
					state.attributes.unit_of_measurement = 'bogus';
				},
			};
			changes[condition]!();
			expect(selectedEnvironment(data).context.observations[1]).toMatchObject({
				freshness: 'unavailable_or_invalid',
				value: null,
			});
		},
	);
	it('rejects model attempts to cite last-known evidence while another profile is usable', async () => {
		const data = environmentData();
		stateFor(data, temperatureId).last_changed = old;
		stateFor(data, temperatureId).last_updated = old;
		const {result, chat} = await run(selectedEnvironment(data));
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.issues).toEqual(
			expect.arrayContaining(['unsupported_temperature_claim', 'unsupported_evidence_reference']),
		);
		expect(result).toMatchObject({
			validation: 'rejected',
			insights: [],
			executionAuthority: 'none',
		});
	});
	it('does not echo model claims of verified physical freshness, and rejects invented verification fields', async () => {
		const choice = selectedEnvironment();
		const claimed = await run(
			choice,
			environmentProposal({
				rationale: 'Verified physical measurements taken right now prove the room is warm.',
			}),
		);
		expect(claimed.result.validation).toBe('accepted');
		expect(JSON.stringify(claimed.result)).not.toContain('Verified physical measurements taken');
		const invalid = await run(choice, {...environmentProposal(), verifiedCurrentMeasurement: true});
		expect(invalid.result.model).toBe('invalid_output');
	});
	it('does not average conflicting usable sensors with recent reports', async () => {
		const data = environmentData();
		stateFor(data, humidityId).state = 'unavailable';
		addEntity(data, {
			...historical('sensor.example_other_temperature', '25', old, {
				device_class: 'temperature',
				unit_of_measurement: '°C',
			}),
			last_reported: recent,
		});
		const {result, chat} = await run(selectedEnvironment(data));
		expect(chat).not.toHaveBeenCalled();
		expect('limitations' in result && result.limitations).toContain(
			'indoor_temperature_conflicting',
		);
	});
	it('revalidates report age after generation, rather than trusting a cached classification', async () => {
		const data = environmentData();
		for (const id of [temperatureId, humidityId]) {
			const state = stateFor(data, id);
			state.last_changed = old;
			state.last_updated = old;
			state.last_reported = new Date(now - 899_999).toISOString();
		}

		const clock = vi
			.fn<() => number>()
			.mockReturnValueOnce(now)
			.mockReturnValue(now + 2);
		const {result, chat} = await run(selectedEnvironment(data), environmentProposal(), clock);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(result.validation).toBe('rejected');
		expect(result.issues).toContain('missing_or_unusable_indoor_environment');
	});
});

describe('independent weather update policy', () => {
	it.each([
		{age: 300_001, status: 'available'},
		{age: 1_800_000, status: 'available'},
		{age: 1_800_001, status: 'stale'},
	])(
		'evaluates weather at $age milliseconds independently of indoor reporting',
		({age, status}) => {
			const data = environmentData();
			const weather = stateFor(data, weatherId);
			weather.last_changed = old;
			weather.last_updated = new Date(now - age).toISOString();
			expect(selectedEnvironment(data).context.outdoorWeather.status).toBe(status);
		},
	);
	it('does not refresh weather attributes using a recent unchanged report', async () => {
		const data = environmentData();
		const weather = stateFor(data, weatherId);
		weather.last_changed = old;
		weather.last_updated = old;
		weather.last_reported = recent;
		const choice = selectedEnvironment(data);
		const {result, chat} = await run(choice);
		expect(choice.context.outdoorWeather).toMatchObject({
			status: 'stale',
			lastReportedAt: recent,
			measurementTime: 'provider_measurement_time_unknown',
		});
		expect(chat).not.toHaveBeenCalled();
		expect(result.issues).toContain('weather_stale');
	});
	it('honours a weather-specific window and never invents a provider measurement timestamp', () => {
		const data = environmentData();
		const weather = stateFor(data, weatherId);
		weather.last_changed = old;
		weather.last_updated = new Date(now - 600_000).toISOString();
		const reportingPolicy = environmentReportingPolicySchema.parse({
			weatherMaxUpdateAgeSeconds: 300,
		});
		expect(selectedEnvironment(data, {reportingPolicy}).context.outdoorWeather.status).toBe(
			'stale',
		);
		expect(selectedEnvironment(data).context.outdoorWeather.measurementTime).toBe(
			'provider_measurement_time_unknown',
		);
	});
	it('validates independent local configuration without writing preferences', () => {
		vi.stubEnv('ENVIRONMENT_INDOOR_REPORT_MAX_AGE_SECONDS', '1200');
		vi.stubEnv('ENVIRONMENT_WEATHER_UPDATE_MAX_AGE_SECONDS', '2400');
		expect(environmentReportingPolicyFromEnv()).toMatchObject({
			indoorMaxReportAgeSeconds: 1200,
			weatherMaxUpdateAgeSeconds: 2400,
		});
		vi.stubEnv('ENVIRONMENT_WEATHER_UPDATE_MAX_AGE_SECONDS', 'NaN');
		expect(() => environmentReportingPolicyFromEnv()).toThrow();
	});
});
