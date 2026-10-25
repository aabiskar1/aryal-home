import type {NormalizedEntityState} from '../home-assistant/state-normalizer.js';
import {
	observationRegistry,
	normalizeObservationValue,
	normalizeObservationUnit,
	type ObservationDeviceClass,
} from '../observations/registry.js';

// Evidence has no domain, supported actions, service, or execution target fields.
export type ObservationState = {
	entityId: string;
	name: string | undefined;
	area: string | undefined;
	state: string;
	deviceClass: ObservationDeviceClass;
	unit?: string | undefined;
};

export const isObservationCandidate = (state: NormalizedEntityState): boolean =>
	observationRegistry.find(state.domain, state.deviceClass) !== undefined;

/** Project only meaningful, narrowly normalized evidence from already policy-permitted states. */
export const toObservationState = (state: NormalizedEntityState): ObservationState | undefined => {
	const definition = observationRegistry.find(state.domain, state.deviceClass);
	if (
		definition === undefined ||
		normalizeObservationValue(definition, state.state) === undefined
	) {
		return undefined;
	}

	const unit = definition.kind === 'numeric' ? normalizeObservationUnit(state.unit) : undefined;
	return {
		entityId: state.entityId,
		name: state.name,
		area: state.area,
		state: state.state,
		deviceClass: definition.deviceClass,
		...(unit !== undefined && {unit}),
	};
};
