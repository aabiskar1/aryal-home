import type {HomeAssistantState} from './schemas.js';
import type {RegistrySnapshot} from './registry-client.js';
import type {
	AreaRegistryEntry,
	DeviceRegistryEntry,
	EntityRegistryEntry,
} from './registry-schemas.js';

export type RegistryMetadata =
	| {status: 'unavailable'; reason: 'registry_failure' | 'incomplete'}
	| {
			status: 'available';
			deviceId: string | undefined;
			areaId: string | undefined;
			labels: {entity: string[]; device: string[]; area: string[]};
			disabled: boolean;
	  };

export type DiscoveredEntity = {
	entityId: string;
	domain: string;
	homeAssistantState: HomeAssistantState;
	metadata: RegistryMetadata;
};

export const getDomainFromEntityId = (entityId: string): string => entityId.split('.', 1)[0] ?? '';

type RegistryLookup = {
	entities: Map<string, EntityRegistryEntry>;
	devices: Map<string, DeviceRegistryEntry>;
	areas: Map<string, AreaRegistryEntry>;
	labels: Set<string>;
};

const hasId = (id: unknown): id is string => typeof id === 'string';

type ResolvedRelationships = {
	entry: EntityRegistryEntry | undefined;
	device: DeviceRegistryEntry | undefined;
	parent: DeviceRegistryEntry | undefined;
	areaId: string | undefined;
	area: AreaRegistryEntry | undefined;
};

const hasIncompleteReferences = ({
	entry,
	device,
	parent,
	areaId,
	area,
}: ResolvedRelationships): boolean =>
	(hasId(entry?.device_id) && device === undefined) ||
	(hasId(device?.parent_device_id) && (parent === undefined || hasId(parent.parent_device_id))) ||
	(hasId(areaId) && area === undefined);

const resolveRelationships = (entityId: string, lookup: RegistryLookup): ResolvedRelationships => {
	const entry = lookup.entities.get(entityId);
	const device = hasId(entry?.device_id) ? lookup.devices.get(entry.device_id) : undefined;
	const parent = hasId(device?.parent_device_id)
		? lookup.devices.get(device.parent_device_id)
		: undefined;
	const areaId = entry?.area_id ?? device?.area_id ?? parent?.area_id;
	const area = hasId(areaId) ? lookup.areas.get(areaId) : undefined;

	return {entry, device, parent, areaId: areaId ?? undefined, area};
};

const resolveMetadata = (entityId: string, lookup: RegistryLookup): RegistryMetadata => {
	const relationships = resolveRelationships(entityId, lookup);
	const {entry, device, parent, areaId, area} = relationships;
	const labels = {
		entity: entry?.labels ?? [],
		device: device?.labels ?? [],
		area: area?.labels ?? [],
	};

	if (
		hasIncompleteReferences(relationships) ||
		Object.values(labels).some((source) => source.some((id) => !lookup.labels.has(id)))
	) {
		return {status: 'unavailable', reason: 'incomplete'};
	}

	return {
		status: 'available',
		deviceId: entry?.device_id ?? undefined,
		areaId: areaId ?? undefined,
		labels,
		disabled: [entry?.disabled_by, device?.disabled_by, parent?.disabled_by].some(
			(value) => typeof value === 'string',
		),
	};
};

export const discoverEntities = (
	states: HomeAssistantState[],
	registries?: RegistrySnapshot,
): DiscoveredEntity[] => {
	if (registries === undefined || registries.status === 'unavailable') {
		return states.map((state) => ({
			entityId: state.entity_id,
			domain: getDomainFromEntityId(state.entity_id),
			homeAssistantState: state,
			metadata: {status: 'unavailable', reason: 'registry_failure'},
		}));
	}

	const lookup: RegistryLookup = {
		entities: new Map(registries.entities.map((entry) => [entry.entity_id, entry])),
		devices: new Map(registries.devices.map((entry) => [entry.id, entry])),
		areas: new Map(registries.areas.map((entry) => [entry.area_id, entry])),
		labels: new Set(registries.labels.map((entry) => entry.label_id)),
	};

	return states.map((state) => ({
		entityId: state.entity_id,
		domain: getDomainFromEntityId(state.entity_id),
		homeAssistantState: state,
		metadata: resolveMetadata(state.entity_id, lookup),
	}));
};
