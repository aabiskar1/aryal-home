import type {AuditData} from '../audit/collection.js';
import {discoverEntities} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {observationRegistry} from '../observations/registry.js';
import {resolveEntityPolicy} from '../policy/resolver.js';

export const resolveThresholdRoom = (data: AuditData, name: string) => {
	if (data.registries.status !== 'available') {
		throw new Error('Room registries unavailable.');
	}

	const query = name.normalize('NFKC').trim().toLowerCase();
	const areas = data.registries.areas.filter((area) =>
		[area.name, ...area.aliases].some(
			(candidate) => candidate.normalize('NFKC').trim().toLowerCase() === query,
		),
	);
	if (areas.length !== 1) {
		throw new Error('Room name missing or ambiguous.');
	}

	const area = areas[0]!;
	const stateIds = new Set(data.states.map((state) => state.entity_id));
	// Registry-only lights must count against coverage, never become history query targets.
	const missingLights = data.registries.entities
		.filter((entry) => entry.entity_id.startsWith('light.') && !stateIds.has(entry.entity_id))
		.map((entry) => ({
			entity_id: entry.entity_id,
			state: 'unknown',
			attributes: {},
			last_changed: '1970-01-01T00:00:00Z',
			last_updated: '1970-01-01T00:00:00Z',
		}));
	const discovered = discoverEntities([...data.states, ...missingLights], data.registries);
	const policy = resolveEntityPolicy(discovered, data.policy ?? {version: 1, allow: [], deny: []});
	const members = discovered.filter(
		(entity) => entity.metadata.status === 'available' && entity.metadata.areaId === area.area_id,
	);
	const permitted = members.filter(
		(entity) =>
			policy.allowedEntityIds.has(entity.entityId) && !policy.deniedEntityIds.has(entity.entityId),
	);
	const sensors = permitted.filter(
		(entity) =>
			observationRegistry.find(entity.domain, normalizeState(entity).deviceClass)?.deviceClass ===
			'illuminance',
	);
	const lights = permitted.filter((entity) => entity.domain === 'light');
	const allLights = members.filter((entity) => entity.domain === 'light');
	const hasUnresolvedLights = discovered.some(
		(entity) => entity.domain === 'light' && entity.metadata.status !== 'available',
	);
	const sensor = sensors.length === 1 ? sensors[0] : undefined;
	return {
		areaId: area.area_id,
		area: area.name,
		sensor,
		lights,
		sensorStatus:
			sensors.length === 1
				? 'available'
				: sensors.length > 1
					? 'multiple_permitted_sensors'
					: 'no_eligible_sensor',
		lightCoverageComplete:
			!hasUnresolvedLights &&
			lights.length > 0 &&
			lights.length <= 16 &&
			lights.length === allLights.length,
	};
};

export type ThresholdRoom = ReturnType<typeof resolveThresholdRoom>;

export const roomMeasurement = (room: ThresholdRoom): unknown => {
	if (room.sensor === undefined) {
		return undefined;
	}

	const state = room.sensor.homeAssistantState;
	return {
		domain: room.sensor.domain,
		deviceClass: state.attributes.device_class,
		unit: state.attributes.unit_of_measurement,
		state: state.state,
		measuredAt: state.last_changed,
		updatedAt: state.last_updated,
	};
};
