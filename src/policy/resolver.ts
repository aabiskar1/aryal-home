import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import type {EntityPolicy, EntitySelector} from './schemas.js';

export type ResolvedEntityPolicy = {
	allowedEntityIds: ReadonlySet<string>;
	deniedEntityIds: ReadonlySet<string>;
};

type Match = 'match' | 'no_match' | 'unknown';

const selectorMatch = (entity: DiscoveredEntity, selector: EntitySelector): Match => {
	const {entityId, domain, deviceId, areaId, labelId} = selector;
	if (
		(entityId !== undefined && entityId !== entity.entityId) ||
		(domain !== undefined && domain !== entity.domain)
	) {
		return 'no_match';
	}

	if (deviceId === undefined && areaId === undefined && labelId === undefined) {
		return 'match';
	}

	if (entity.metadata.status === 'unavailable') {
		return 'unknown';
	}

	if (
		(deviceId !== undefined && deviceId !== entity.metadata.deviceId) ||
		(areaId !== undefined && areaId !== entity.metadata.areaId) ||
		(labelId !== undefined &&
			Object.values(entity.metadata.labels).every((labels) => !labels.includes(labelId)))
	) {
		return 'no_match';
	}

	return 'match';
};

export const resolveEntityPolicy = (
	entities: DiscoveredEntity[],
	policy: EntityPolicy,
): ResolvedEntityPolicy => {
	const allowedEntityIds = new Set<string>();
	const deniedEntityIds = new Set<string>();

	for (const entity of entities) {
		const isAllowed = policy.allow.some((selector) => selectorMatch(entity, selector) === 'match');
		const isDenied = policy.deny.some((selector) => selectorMatch(entity, selector) !== 'no_match');
		const isIneligible =
			entity.homeAssistantState.state === 'unavailable' ||
			entity.homeAssistantState.state === 'unknown' ||
			(entity.metadata.status === 'unavailable' && entity.metadata.reason === 'incomplete') ||
			(entity.metadata.status === 'available' && entity.metadata.disabled);

		if (isDenied || isIneligible) {
			deniedEntityIds.add(entity.entityId);
		}

		if (isAllowed && !isDenied && !isIneligible) {
			allowedEntityIds.add(entity.entityId);
		}
	}

	return {allowedEntityIds, deniedEntityIds};
};

export const selectAllowedEntities = (
	entities: DiscoveredEntity[],
	policy: ResolvedEntityPolicy,
): DiscoveredEntity[] => entities.filter((entity) => policy.allowedEntityIds.has(entity.entityId));
