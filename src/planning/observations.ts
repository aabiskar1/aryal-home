import {
	observationDeviceClassSchema,
	type NormalizedEntityState,
	type ObservationDeviceClass,
} from '../home-assistant/state-normalizer.js';

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
	(state.domain === 'binary_sensor' &&
		(state.deviceClass === 'occupancy' || state.deviceClass === 'presence')) ||
	(state.domain === 'sensor' &&
		(state.deviceClass === 'temperature' || state.deviceClass === 'humidity'));

/** Project only meaningful, narrowly normalized evidence from already policy-permitted states. */
export const toObservationState = (state: NormalizedEntityState): ObservationState | undefined => {
	const deviceClass = observationDeviceClassSchema.safeParse(state.deviceClass);
	if (!deviceClass.success || !isObservationCandidate(state)) {
		return undefined;
	}

	const isBinary = deviceClass.data === 'occupancy' || deviceClass.data === 'presence';
	const isNumeric =
		/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/iv.test(state.state.trim()) &&
		Number.isFinite(Number(state.state));
	if (isBinary ? state.state !== 'on' && state.state !== 'off' : !isNumeric) {
		return undefined;
	}

	return {
		entityId: state.entityId,
		name: state.name,
		area: state.area,
		state: state.state,
		deviceClass: deviceClass.data,
		...(!isBinary && state.unit !== undefined && {unit: state.unit}),
	};
};
