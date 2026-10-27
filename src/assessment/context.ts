import type {AuditData} from '../audit/collection.js';
import {discoverEntities, type DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {
	historyTimestampSchema,
	learningConfigSchema,
	type LearningLocation,
} from '../home-assistant/history-schemas.js';
import {enrichEpisode} from '../lighting-learning/context.js';
import {MAX_MEASUREMENT_AGE_MS} from '../lighting-thresholds/evaluation.js';
import {
	thresholdPreferencesSchema,
	type PreferenceSnapshot,
} from '../lighting-thresholds/preferences.js';
import {resolveThresholdRoom} from '../lighting-thresholds/room.js';
import {toObservationState} from '../planning/observations.js';
import {resolveEntityPolicy} from '../policy/resolver.js';
import {
	assessmentContextSchema,
	type AssessmentContext,
	type AssessmentObservation,
} from './schemas.js';

export type SelectedAssessment = {
	context: AssessmentContext;
	// Private mapping, never included in the model request. Rebuilt for each invocation.
	targets: ReadonlyMap<string, string>;
};

export const evidenceStatus = (
	measuredAt: AssessmentObservation['measuredAt'],
	updatedAt: AssessmentObservation['updatedAt'],
	now: number,
): AssessmentObservation['status'] => {
	if (measuredAt === null || updatedAt === null || !Number.isFinite(now)) {
		return 'invalid';
	}

	const measured = Date.parse(measuredAt);
	const updated = Date.parse(updatedAt);
	if (
		!Number.isFinite(measured) ||
		!Number.isFinite(updated) ||
		measured > updated ||
		updated > now
	) {
		return 'invalid';
	}

	return now - measured > MAX_MEASUREMENT_AGE_MS ? 'stale' : 'available';
};

const observationFor = (
	entity: DiscoveredEntity,
	index: number,
	now: number,
): AssessmentObservation => {
	const normalized = normalizeState(entity);
	const projected = toObservationState(normalized);
	const state = entity.homeAssistantState;
	const measured = historyTimestampSchema.safeParse(state.last_changed);
	const updated = historyTimestampSchema.safeParse(state.last_updated);
	const measuredAt = measured.success ? measured.data : null;
	const updatedAt = updated.success ? updated.data : null;
	const deviceClass = normalized.deviceClass as AssessmentObservation['deviceClass'];
	const isLux = deviceClass === 'illuminance';
	const isValid =
		projected !== undefined &&
		state.attributes.restored !== true &&
		(!isLux || (projected.unit === 'lx' && Number(projected.state) >= 0));
	const status = isValid ? evidenceStatus(measuredAt, updatedAt, now) : 'invalid';
	return {
		ref: `observation_${index + 1}`,
		source: 'home_assistant_state',
		deviceClass,
		status,
		value:
			status === 'available'
				? isLux
					? Number(projected!.state)
					: (projected!.state as 'on' | 'off')
				: null,
		unit: isLux && projected?.unit === 'lx' ? 'lx' : null,
		measuredAt,
		updatedAt,
	};
};

export const presenceFrom = (
	observations: Array<
		Pick<AssessmentObservation, 'value' | 'measuredAt' | 'updatedAt'> & {
			deviceClass: string;
			status: string;
		}
	>,
	now: number,
): AssessmentContext['presence'] => {
	const presence = observations.filter(
		(item) => item.deviceClass === 'presence' || item.deviceClass === 'occupancy',
	);
	const fresh = presence.filter(
		(item) =>
			item.status === 'available' &&
			evidenceStatus(item.measuredAt, item.updatedAt, now) === 'available',
	);
	const values = new Set(fresh.map((item) => item.value));
	if (values.size > 1) {
		return 'conflicting';
	}

	if (fresh.length === 0 || fresh.length !== presence.length) {
		return 'unknown';
	}

	return values.has('on') ? 'detected' : 'clear';
};

export const clockFor = (
	now: number,
	location: LearningLocation | undefined,
): AssessmentContext['clock'] => {
	if (location === undefined) {
		return {status: 'unavailable', source: 'ha_config_and_system_clock'};
	}

	const value = enrichEpisode(now, learningConfigSchema.parse(location));
	return {
		status: 'available',
		source: 'ha_config_and_system_clock',
		localDate: value.localDate,
		localTime: value.localTime,
		utcOffset: value.utcOffset,
		timeOfDay: value.timeOfDay,
		daylight: value.daylight,
		reliability: value.solarReliability,
	};
};

/** Policy first, exact registry area membership, then a small name-free projection. */
export const selectAssessmentContext = (input: {
	data: AuditData;
	area: string;
	preferences: PreferenceSnapshot['preferences'];
	location: LearningLocation | undefined;
	now: number;
}): SelectedAssessment => {
	const {data, now} = input;
	if (new Set(data.states.map((state) => state.entity_id)).size !== data.states.length) {
		throw new Error('Duplicate state identity.');
	}

	const room = resolveThresholdRoom(data, input.area);
	const discovered = discoverEntities(data.states, data.registries);
	const policy = resolveEntityPolicy(discovered, data.policy ?? {version: 1, allow: [], deny: []});
	const permitted = discovered.filter(
		(entity) =>
			entity.metadata.status === 'available' &&
			entity.metadata.areaId === room.areaId &&
			policy.allowedEntityIds.has(entity.entityId) &&
			!policy.deniedEntityIds.has(entity.entityId),
	);
	const lights = permitted.filter(
		(entity) =>
			entity.domain === 'light' && ['on', 'off'].includes(entity.homeAssistantState.state),
	);
	const candidates = permitted.filter((entity) => {
		const normalized = normalizeState(entity);
		return (
			(entity.domain === 'sensor' && normalized.deviceClass === 'illuminance') ||
			(entity.domain === 'binary_sensor' &&
				['presence', 'occupancy'].includes(normalized.deviceClass ?? ''))
		);
	});
	if (lights.length > 16 || candidates.length > 16) {
		throw new Error('Complete assessment selection exceeds item limits.');
	}

	const observations = candidates.map((entity, index) => observationFor(entity, index, now));
	const preferences = thresholdPreferencesSchema.parse(input.preferences);
	const threshold = preferences.rooms.find((item) => item.areaId === room.areaId)?.thresholdLux;
	const capturedAt = new Date(now).toISOString();
	const context = assessmentContextSchema.parse({
		version: 1,
		goal: 'lighting_comfort',
		scope: 'selected_area',
		capturedAt,
		states: lights.map((entity, index) => ({
			ref: `light_${index + 1}`,
			source: 'home_assistant_state',
			state: entity.homeAssistantState.state,
			observedAt: capturedAt,
			supportedActions: ['turn_on'],
		})),
		observations,
		preference:
			threshold === undefined
				? {status: 'missing', source: 'local_threshold_preferences'}
				: {status: 'approved', source: 'local_threshold_preferences', thresholdLux: threshold},
		clock: clockFor(now, input.location),
		presence: presenceFrom(observations, now),
	});
	return {
		context,
		targets: new Map(lights.map((entity, index) => [`light_${index + 1}`, entity.entityId])),
	};
};
