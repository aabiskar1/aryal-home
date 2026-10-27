import type {AuditData} from '../audit/collection.js';
import {discoverEntities, type DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import type {LearningLocation} from '../home-assistant/history-schemas.js';
import {resolveEntityPolicy} from '../policy/resolver.js';
import {resolveRegistryArea} from '../home-assistant/area.js';
import {clockFor} from './context.js';
import {
	environmentReportingPolicySchema,
	weatherUpdateFreshness,
	type EnvironmentReportingPolicy,
} from './environment-freshness.js';
import {
	environmentContextSchema,
	weatherConditionSchema,
	type EnvironmentContext,
	type OutdoorWeather,
} from './environment-schemas.js';
import {
	environmentTimestamps,
	environmentalValue,
	indoorEnvironmentFor,
	environmentPresenceFrom,
} from './environment-values.js';

export type SelectedEnvironmentAssessment = {
	context: EnvironmentContext;
	targets: ReadonlyMap<string, string>;
};

const emptyWeather = (status: OutdoorWeather['status']): OutdoorWeather => ({
	ref: 'weather_1',
	source: 'home_assistant_weather_state',
	scope: 'installation',
	status,
	condition: null,
	freshnessBasis: 'last_updated_snapshot',
	measurementTime: 'provider_measurement_time_unknown',
	lastChangedAt: null,
	updatedAt: null,
	temperature: {
		ref: 'outdoor_temperature',
		status: 'missing',
		value: null,
		unit: null,
		originalUnit: null,
	},
	humidity: {
		ref: 'outdoor_humidity',
		status: 'missing',
		value: null,
		unit: null,
		originalUnit: null,
	},
});

const weatherFor = (
	entities: DiscoveredEntity[],
	now: number,
	policy: EnvironmentReportingPolicy,
): OutdoorWeather => {
	if (entities.length !== 1) {
		return emptyWeather(entities.length === 0 ? 'missing_or_not_permitted' : 'multiple_sources');
	}

	const entity = entities[0]!;
	const state = entity.homeAssistantState;
	const {timestamps, valid: areTimestampsValid} = environmentTimestamps(entity, now);
	const condition = weatherConditionSchema.safeParse(state.state);
	if (state.state === 'unknown' || state.state === 'unavailable') {
		return {...emptyWeather('unavailable'), ...timestamps};
	}

	if (!condition.success || state.attributes.restored === true) {
		return {...emptyWeather('invalid'), ...timestamps};
	}

	// A condition can stay unchanged while current attributes update. Validate ordering first.
	const status = areTimestampsValid ? weatherUpdateFreshness(timestamps, policy, now) : 'invalid';
	if (status !== 'available') {
		return {...emptyWeather(status), ...timestamps};
	}

	return {
		...emptyWeather('available'),
		...timestamps,
		condition: condition.data,
		temperature: environmentalValue(
			'outdoor_temperature',
			state.attributes.temperature,
			state.attributes.temperature_unit,
		),
		humidity: environmentalValue('outdoor_humidity', state.attributes.humidity, '%'),
	};
};

/**
 Static selector permission for read-only evidence, with unavailable values redacted entirely.
 The projection only allows availability diagnostics for explicitly selected unknown/unavailable
 observations. Disabled/incomplete metadata and every deny rule still use the shared resolver.
 It is never used for actionable states, and grants no control permission.
 */
const observationExposure = (entities: DiscoveredEntity[], policy: AuditData['policy']) =>
	resolveEntityPolicy(
		entities.map((entity) => ({
			...entity,
			homeAssistantState: {...entity.homeAssistantState, state: 'read_only_availability'},
		})),
		policy ?? {version: 1, allow: [], deny: []},
	);

export const selectEnvironmentContext = (input: {
	data: AuditData;
	area: string;
	location: LearningLocation | undefined;
	now: number;
	reportingPolicy?: EnvironmentReportingPolicy | undefined;
}): SelectedEnvironmentAssessment => {
	const {data, now} = input;
	if (new Set(data.states.map((state) => state.entity_id)).size !== data.states.length) {
		throw new Error('Duplicate state identity.');
	}

	const reportingPolicy = environmentReportingPolicySchema.parse(input.reportingPolicy ?? {});
	const room = resolveRegistryArea(data.registries, input.area);
	const discovered = discoverEntities(data.states, data.registries);
	const candidates = discovered.filter((entity) => {
		if (entity.domain === 'weather') {
			return true;
		}

		const {deviceClass} = normalizeState(entity);
		return (
			(entity.domain === 'sensor' &&
				(deviceClass === 'temperature' || deviceClass === 'humidity')) ||
			(entity.domain === 'binary_sensor' &&
				(deviceClass === 'occupancy' || deviceClass === 'presence'))
		);
	});
	const exposure = observationExposure(candidates, data.policy);
	const permitted = candidates.filter(
		(entity) =>
			entity.metadata.status === 'available' &&
			exposure.allowedEntityIds.has(entity.entityId) &&
			!exposure.deniedEntityIds.has(entity.entityId),
	);
	const indoor = permitted.filter(
		(entity) =>
			entity.domain !== 'weather' &&
			entity.metadata.status === 'available' &&
			entity.metadata.areaId === room.area_id,
	);
	if (indoor.length > 16) {
		throw new Error('Complete environmental selection exceeds item limits.');
	}

	const observations = indoor.map((entity, index) =>
		indoorEnvironmentFor(entity, index, now, reportingPolicy),
	);
	const context = environmentContextSchema.parse({
		version: 1,
		goal: 'environment_comfort',
		scope: 'selected_area',
		capturedAt: new Date(now).toISOString(),
		states: [],
		observations,
		outdoorWeather: weatherFor(
			permitted.filter((entity) => entity.domain === 'weather'),
			now,
			reportingPolicy,
		),
		preference: {status: 'unknown', source: 'environment_preferences_not_configured'},
		clock: clockFor(now, input.location),
		presence: environmentPresenceFrom(observations, now),
		reportingPolicy,
		comparisonPolicy: {
			source: 'advisory_comparison_tolerance_not_comfort_preference',
			temperatureDeltaC: 0.5,
			humidityDeltaPercent: 1,
		},
	});
	return {context, targets: new Map()};
};
