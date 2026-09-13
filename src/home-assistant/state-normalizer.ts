import type {DiscoveredEntity} from './discovery.js';
import {getSupportedActions, type CanonicalAction} from './capabilities.js';

export type NormalizedEntityState = {
	entityId: string;
	domain: string;
	state: string;
	name: string | undefined;
	area: string | undefined;
	supportedActions: CanonicalAction[];
};

const getStringAttribute = (
	attributes: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = attributes[key];

	return typeof value === 'string' ? value : undefined;
};

export const normalizeState = (entity: DiscoveredEntity): NormalizedEntityState => {
	const {homeAssistantState} = entity;

	return {
		entityId: entity.entityId,
		domain: entity.domain,
		state: homeAssistantState.state,
		name: getStringAttribute(homeAssistantState.attributes, 'friendly_name'),
		area: getStringAttribute(homeAssistantState.attributes, 'area_name'),
		supportedActions: getSupportedActions(entity.domain),
	};
};

export const normalizeStates = (entities: DiscoveredEntity[]): NormalizedEntityState[] =>
	entities.map((entity) => normalizeState(entity));
