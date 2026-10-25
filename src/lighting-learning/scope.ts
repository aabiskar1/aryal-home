import {z} from 'zod';
import type {AuditData} from '../audit/collection.js';
import {discoverEntities, type DiscoveredEntity} from '../home-assistant/discovery.js';
import {HISTORY_LIMITS} from '../home-assistant/history-client.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {observationRegistry, normalizeObservationValue} from '../observations/registry.js';
import {resolveEntityPolicy} from '../policy/resolver.js';

export type LightingScope = {
	area: string;
	sensor: DiscoveredEntity;
	lights: DiscoveredEntity[];
	aggregateIds: ReadonlySet<string>;
};
export type ScopeResult =
	| {kind: 'available'; scope: LightingScope}
	| {kind: 'unsupported_configuration'; reason: string; sensorCount: number; lightCount: number};

/** Registry-backed associations only; friendly names and state area hints have no authority. */
export const selectLightingScope = (data: AuditData, areaName: string): ScopeResult => {
	const fail = (reason: string, sensorCount = 0, lightCount = 0): ScopeResult => ({
		kind: 'unsupported_configuration',
		reason,
		sensorCount,
		lightCount,
	});
	if (data.registries.status !== 'available') {
		return fail('registry_metadata_unavailable');
	}

	const query = areaName.normalize('NFKC').trim().toLowerCase();
	const areas = data.registries.areas.filter((area) =>
		[area.name, ...area.aliases].some(
			(name) => name.normalize('NFKC').trim().toLowerCase() === query,
		),
	);
	if (areas.length !== 1) {
		return fail('area_missing_or_ambiguous');
	}

	const area = areas[0]!;
	const entities = discoverEntities(data.states, data.registries);
	const policy = resolveEntityPolicy(entities, data.policy ?? {version: 1, allow: [], deny: []});
	const eligible = entities.filter(
		(entity) =>
			policy.allowedEntityIds.has(entity.entityId) &&
			!policy.deniedEntityIds.has(entity.entityId) &&
			entity.metadata.status === 'available' &&
			!entity.metadata.disabled &&
			entity.metadata.areaId === area.area_id,
	);
	const sensors = eligible.filter((entity) => {
		const state = normalizeState(entity);
		return (
			observationRegistry.find(entity.domain, state.deviceClass)?.deviceClass === 'illuminance'
		);
	});
	const lights = eligible.filter((entity) => entity.domain === 'light');
	if (sensors.length !== 1 || lights.length === 0 || lights.length > HISTORY_LIMITS.maxLights) {
		return fail(
			sensors.length > 1 ? 'multiple_illuminance_sensors' : 'require_one_sensor_and_bounded_lights',
			sensors.length,
			lights.length,
		);
	}

	const sensor = sensors[0]!;
	const normalized = normalizeState(sensor);
	const definition = observationRegistry.find('sensor', 'illuminance')!;
	if (
		normalized.unit !== 'lx' ||
		normalizeObservationValue(definition, normalized.state) === undefined ||
		Number(normalized.state) < 0
	) {
		return fail('current_illuminance_invalid_or_wrong_units', 1, lights.length);
	}

	const aggregateIds = new Set<string>();
	for (const light of lights) {
		const members: unknown = light.homeAssistantState.attributes.entity_id;
		if (members !== undefined) {
			if (
				!z
					.array(z.string().regex(/^light\.[0-9_a-z]+$/v))
					.min(1)
					.safeParse(members).success
			) {
				return fail('invalid_group_membership', 1, lights.length);
			}

			aggregateIds.add(light.entityId);
		}
	}

	return {kind: 'available', scope: {area: area.name, sensor, lights, aggregateIds}};
};
