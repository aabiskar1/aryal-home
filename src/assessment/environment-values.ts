import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {historyTimestampSchema} from '../home-assistant/history-schemas.js';
import {toObservationState} from '../planning/observations.js';
import {areStateTimestampsValid} from '../home-assistant/state-timestamps.js';
import {evidenceStatus, presenceFrom} from './context.js';
import {
	indoorReportingFreshness,
	type EnvironmentReportingPolicy,
} from './environment-freshness.js';
import type {IndoorEnvironmentObservation, WeatherValue} from './environment-schemas.js';

export const environmentTimestamps = (entity: DiscoveredEntity, now: number) => {
	const changed = historyTimestampSchema.safeParse(entity.homeAssistantState.last_changed);
	const updated = historyTimestampSchema.safeParse(entity.homeAssistantState.last_updated);
	const reported = historyTimestampSchema.safeParse(entity.homeAssistantState.last_reported);
	return {
		timestamps: {
			lastChangedAt: changed.success ? changed.data : null,
			updatedAt: updated.success ? updated.data : null,
			...(reported.success && {lastReportedAt: reported.data}),
		},
		valid: areStateTimestampsValid(entity.homeAssistantState, now),
	};
};

const numericFreshnessBasis = (
	timestamps: ReturnType<typeof environmentTimestamps>['timestamps'],
) => (timestamps.lastReportedAt === undefined ? 'last_updated' : 'last_reported');

/** Canonical units, not comfort limits. Weather attributes must be numeric, never coerced strings. */
export const environmentalValue = (
	ref: WeatherValue['ref'],
	value: unknown,
	unit: unknown,
): WeatherValue => {
	const result: WeatherValue = {
		ref,
		status: value === undefined || value === null ? 'missing' : 'invalid',
		value: null,
		unit: null,
		originalUnit: null,
	};
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return result;
	}

	if (ref === 'outdoor_humidity') {
		return unit === '%' && value >= 0 && value <= 100
			? {...result, status: 'available', value, unit: '%', originalUnit: '%'}
			: result;
	}

	if (unit !== '°C' && unit !== '°F' && unit !== 'K') {
		return result;
	}

	const minimum = {'°C': -273.15, '°F': -459.67, K: 0}[unit];
	if (value < minimum) {
		return result;
	}

	const celsius = unit === '°F' ? ((value - 32) * 5) / 9 : unit === 'K' ? value - 273.15 : value;
	const rounded = Number(celsius.toFixed(6));
	if (!Number.isFinite(rounded) || rounded < -273.15) {
		return result;
	}

	return {
		...result,
		status: 'available',
		value: rounded,
		unit: '°C',
		originalUnit: unit,
	};
};

export const indoorEnvironmentFor = (
	entity: DiscoveredEntity,
	index: number,
	now: number,
	policy: EnvironmentReportingPolicy,
): IndoorEnvironmentObservation => {
	const normalized = normalizeState(entity);
	const projected = toObservationState(normalized);
	const {timestamps, valid: areTimestampsValid} = environmentTimestamps(entity, now);
	const deviceClass = normalized.deviceClass as IndoorEnvironmentObservation['deviceClass'];
	const isNumeric = deviceClass === 'temperature' || deviceClass === 'humidity';
	const numeric = environmentalValue(
		deviceClass === 'temperature' ? 'outdoor_temperature' : 'outdoor_humidity',
		projected === undefined ? undefined : Number(projected.state),
		projected?.unit,
	);
	let status: IndoorEnvironmentObservation['status'] = 'invalid';
	if (
		entity.homeAssistantState.state === 'unavailable' ||
		entity.homeAssistantState.state === 'unknown'
	) {
		status = 'unavailable';
	} else if (
		areTimestampsValid &&
		projected !== undefined &&
		entity.homeAssistantState.attributes.restored !== true &&
		(!isNumeric || numeric.status === 'available')
	) {
		status = isNumeric
			? 'available'
			: evidenceStatus(timestamps.lastChangedAt, timestamps.updatedAt, now);
	}

	return {
		ref: `indoor_${index + 1}`,
		source: 'home_assistant_state',
		scope: 'selected_area',
		deviceClass,
		status,
		value:
			status === 'available'
				? isNumeric
					? numeric.value
					: (projected!.state as 'on' | 'off')
				: null,
		unit: isNumeric ? numeric.unit : null,
		originalUnit: isNumeric ? numeric.originalUnit : null,
		freshnessBasis: isNumeric ? numericFreshnessBasis(timestamps) : 'last_changed',
		freshness: isNumeric
			? status === 'available'
				? indoorReportingFreshness(timestamps, policy, now)
				: 'unavailable_or_invalid'
			: null,
		measurementTime: 'physical_measurement_time_unknown',
		...timestamps,
	};
};

/** Presence retains its existing change-age rule; numeric reports cannot imply occupancy. */
export const environmentPresenceFrom = (
	observations: IndoorEnvironmentObservation[],
	now: number,
) =>
	presenceFrom(
		observations.map((item) => ({...item, measuredAt: item.lastChangedAt})),
		now,
	);
