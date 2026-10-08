import {z} from 'zod';
import type {DiscoveredEntity} from './discovery.js';
import {getSupportedActions, type CanonicalAction} from './capabilities.js';

export type NormalizedEntityState = {
	entityId: string;
	domain: string;
	state: string;
	name: string | undefined;
	area: string | undefined;
	deviceClass?: string | undefined;
	unit?: string | undefined;
	supportedActions: CanonicalAction[];
};

export const observationDeviceClassSchema = z.enum([
	'presence',
	'occupancy',
	'temperature',
	'humidity',
]);
export type ObservationDeviceClass = z.infer<typeof observationDeviceClassSchema>;
const unitSchema = z.string().trim().min(1).max(16);

const getStringAttribute = (
	attributes: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = attributes[key];

	return typeof value === 'string' ? value : undefined;
};

export const normalizeState = (entity: DiscoveredEntity): NormalizedEntityState => {
	const {homeAssistantState} = entity;
	const deviceClass = observationDeviceClassSchema.safeParse(
		homeAssistantState.attributes.device_class,
	);
	const unit = unitSchema.safeParse(homeAssistantState.attributes.unit_of_measurement);

	return {
		entityId: entity.entityId,
		domain: entity.domain,
		state: homeAssistantState.state,
		name: getStringAttribute(homeAssistantState.attributes, 'friendly_name'),
		area:
			entity.metadata.status === 'available'
				? (entity.metadata.areaName ??
					getStringAttribute(homeAssistantState.attributes, 'area_name'))
				: getStringAttribute(homeAssistantState.attributes, 'area_name'),
		deviceClass: deviceClass.success ? deviceClass.data : undefined,
		unit: unit.success ? unit.data : undefined,
		supportedActions:
			homeAssistantState.state === 'unavailable' ||
			homeAssistantState.state === 'unknown' ||
			(entity.metadata.status === 'unavailable' && entity.metadata.reason === 'incomplete') ||
			(entity.metadata.status === 'available' && entity.metadata.disabled)
				? []
				: getSupportedActions(entity.domain),
	};
};

export const normalizeStates = (entities: DiscoveredEntity[]): NormalizedEntityState[] =>
	entities.map((entity) => normalizeState(entity));
