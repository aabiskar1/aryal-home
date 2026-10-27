import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {historyTimestampSchema} from '../home-assistant/history-schemas.js';
import {toObservationState} from '../planning/observations.js';
import {evidenceStatus} from './context.js';
import type {IndoorEnvironmentObservation, WeatherValue} from './environment-schemas.js';

export const environmentTimestamps = (entity: DiscoveredEntity) => {
	const changed = historyTimestampSchema.safeParse(entity.homeAssistantState.last_changed);
	const updated = historyTimestampSchema.safeParse(entity.homeAssistantState.last_updated);
	return {
		measuredAt: changed.success ? changed.data : null,
		updatedAt: updated.success ? updated.data : null,
	};
};

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
): IndoorEnvironmentObservation => {
	const normalized = normalizeState(entity);
	const projected = toObservationState(normalized);
	const timestamps = environmentTimestamps(entity);
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
		projected !== undefined &&
		entity.homeAssistantState.attributes.restored !== true &&
		(!isNumeric || numeric.status === 'available')
	) {
		status = evidenceStatus(timestamps.measuredAt, timestamps.updatedAt, now);
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
		freshnessBasis: 'last_changed',
		...timestamps,
	};
};
