import {historyTimestampSchema} from './history-schemas.js';

export type StateTimestamps = {
	last_changed: string;
	last_updated: string;
	last_reported?: string | undefined;
};

/** HA activity timestamps are not physical measurement times. Missing reports stay missing. */
export const areStateTimestampsValid = (state: StateTimestamps, now: number): boolean => {
	const timestamps = [
		state.last_changed,
		state.last_updated,
		...(state.last_reported === undefined ? [] : [state.last_reported]),
	];
	if (
		!Number.isFinite(now) ||
		timestamps.some((value) => !historyTimestampSchema.safeParse(value).success)
	) {
		return false;
	}

	const times = timestamps.map((value) => Date.parse(value));
	return times.every((time, index) => time <= now && (index === 0 || time >= times[index - 1]!));
};
