import {getSupportedActions, type CanonicalAction} from '../home-assistant/capabilities.js';
import {discoverEntities, type DiscoveredEntity} from '../home-assistant/discovery.js';
import type {EntityRegistryEntry, DeviceRegistryEntry} from '../home-assistant/registry-schemas.js';
import type {HomeAssistantState} from '../home-assistant/schemas.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {isObservationCandidate, toObservationState} from '../planning/observations.js';
import {resolveEntityPolicy} from '../policy/resolver.js';
import type {EntityPolicy} from '../policy/schemas.js';
import type {AuditData} from './collection.js';

export type AuditEntity = {
	entityId: string;
	domain: string;
	name: string | undefined;
	state: string;
	hasCurrentState: boolean;
	deviceId: string | undefined;
	areaId: string | undefined;
	area: string | undefined;
	entityAreaId: string | undefined;
	entityArea: string | undefined;
	deviceAreaId: string | undefined;
	deviceArea: string | undefined;
	parentDeviceArea: string | undefined;
	areaSource: 'entity' | 'device' | 'parent_device' | 'none' | 'incomplete';
	metadataComplete: boolean;
	disabledSources: Array<{source: string; by: string}>;
	deviceClass: string | undefined;
	unit: string | undefined;
	supportedActions: CanonicalAction[];
	observationSupported: boolean;
	observationNormalizable: boolean;
	policyPermitted: boolean;
};

export type AuditInventory = {
	entities: AuditEntity[];
	stateEntityIds: ReadonlySet<string>;
	devicesScanned: number;
	areasScanned: number;
	policy: EntityPolicy | undefined;
};

export const compareText = (left: string, right: string): number =>
	left < right ? -1 : left > right ? 1 : 0;

// No arbitrary state strings, attributes, registry payloads, or timestamps enter the report.
const displayState = (entity: DiscoveredEntity, hasCurrentState: boolean): string => {
	if (!hasCurrentState) {
		return 'no_current_state';
	}

	const normalized = normalizeState(entity);
	if (['on', 'off', 'unavailable', 'unknown'].includes(normalized.state)) {
		return normalized.state;
	}

	const observation = toObservationState(normalized);
	return observation === undefined ? 'other' : String(Number(observation.state));
};

const disabledSources = (
	entry: EntityRegistryEntry | undefined,
	device: DeviceRegistryEntry | undefined,
	parent: DeviceRegistryEntry | undefined,
): AuditEntity['disabledSources'] =>
	[
		{source: 'entity', by: entry?.disabled_by},
		{source: 'device', by: device?.disabled_by},
		{source: 'parent_device', by: parent?.disabled_by},
	].flatMap(({source, by}) =>
		typeof by === 'string'
			? [{source, by: ['user', 'integration', 'config_entry'].includes(by) ? by : 'other'}]
			: [],
	);

const areaSource = (
	entity: DiscoveredEntity,
	entry: EntityRegistryEntry | undefined,
	device: DeviceRegistryEntry | undefined,
	parent: DeviceRegistryEntry | undefined,
): AuditEntity['areaSource'] => {
	if (entity.metadata.status !== 'available') {
		return 'incomplete';
	}

	if (typeof entry?.area_id === 'string') {
		return 'entity';
	}

	if (typeof device?.area_id === 'string') {
		return 'device';
	}

	return typeof parent?.area_id === 'string' ? 'parent_device' : 'none';
};

/** Registry-only rows use a sentinel solely to reuse metadata discovery; they have no live state. */
const registryOnlyState = (entityId: string): HomeAssistantState => ({
	entity_id: entityId,
	state: 'unknown',
	attributes: {},
	last_changed: '',
	last_updated: '',
});

export const buildAuditInventory = (data: AuditData): AuditInventory => {
	const {states, registries, policy} = data;
	if (registries.status !== 'available') {
		throw new Error('Audit requires complete registry access.');
	}

	const stateEntityIds = new Set(states.map(({entity_id: entityId}) => entityId));
	if (stateEntityIds.size !== states.length) {
		throw new Error('Duplicate state identifiers cannot be audited.');
	}

	const registryOnly = registries.entities
		.filter(({entity_id: entityId}) => !stateEntityIds.has(entityId))
		.map(({entity_id: entityId}) => registryOnlyState(entityId));
	const discovered = discoverEntities([...states, ...registryOnly], registries);
	const resolvedPolicy = resolveEntityPolicy(
		discovered,
		policy ?? {version: 1, allow: [], deny: []},
	);
	const entries = new Map(registries.entities.map((entry) => [entry.entity_id, entry]));
	const devices = new Map(registries.devices.map((entry) => [entry.id, entry]));
	const areas = new Map(registries.areas.map((entry) => [entry.area_id, entry.name]));
	const entities = discovered.map((entity): AuditEntity => {
		const entry = entries.get(entity.entityId);
		const device = devices.get(entry?.device_id ?? '');
		const parent = devices.get(device?.parent_device_id ?? '');
		const normalized = normalizeState(entity);
		const observation = toObservationState(normalized);
		const {metadata} = entity;
		return {
			entityId: entity.entityId,
			domain: entity.domain,
			name: normalized.name,
			state: displayState(entity, stateEntityIds.has(entity.entityId)),
			hasCurrentState: stateEntityIds.has(entity.entityId),
			deviceId: entry?.device_id ?? undefined,
			areaId: metadata.status === 'available' ? metadata.areaId : undefined,
			area: metadata.status === 'available' ? metadata.areaName : undefined,
			entityAreaId: entry?.area_id ?? undefined,
			entityArea: areas.get(entry?.area_id ?? ''),
			deviceAreaId: device?.area_id ?? undefined,
			deviceArea: areas.get(device?.area_id ?? ''),
			parentDeviceArea: areas.get(parent?.area_id ?? ''),
			areaSource: areaSource(entity, entry, device, parent),
			metadataComplete: metadata.status === 'available',
			disabledSources: disabledSources(entry, device, parent),
			deviceClass: normalized.deviceClass,
			unit: observation?.unit,
			supportedActions: getSupportedActions(entity.domain),
			observationSupported: isObservationCandidate(normalized),
			observationNormalizable: observation !== undefined,
			policyPermitted: resolvedPolicy.allowedEntityIds.has(entity.entityId),
		};
	});

	return {
		entities: entities.toSorted((left, right) => compareText(left.entityId, right.entityId)),
		stateEntityIds,
		devicesScanned: registries.devices.length,
		areasScanned: registries.areas.length,
		policy,
	};
};
