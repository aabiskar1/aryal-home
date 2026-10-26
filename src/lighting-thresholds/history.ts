/* eslint-disable no-await-in-loop -- Sequential daily slices bound Recorder load and memory. */
import {HISTORY_LIMITS, type createHistoryClient} from '../home-assistant/history-client.js';
import type {LearningLocation} from '../home-assistant/history-schemas.js';
import {canonicalSamples, type HistorySample} from '../lighting-learning/events.js';
import {enrichEpisode} from '../lighting-learning/context.js';
import {quantile} from '../lighting-learning/estimator.js';
import {evaluateDarkness} from './evaluation.js';
import type {ThresholdRoom} from './room.js';

export type AmbientEvidence = {
	status: string;
	daysRequested: number;
	alignedOffReadings: number;
	halfHourBins: number;
	localDays: number;
	contextCoverage: 'unavailable' | 'limited_daylight_conditions' | 'daylight_and_night_observed';
	excludedReadings: number;
	daylightCounts: Record<string, number>;
	timeOfDayCounts: Record<string, number>;
	observedLux?: {lower: number; median: number; upper: number};
};
export const emptyAmbientEvidence = (days: number, status: string): AmbientEvidence => ({
	status,
	daysRequested: days,
	alignedOffReadings: 0,
	halfHourBins: 0,
	localDays: 0,
	contextCoverage: 'unavailable',
	excludedReadings: 0,
	daylightCounts: {},
	timeOfDayCounts: {},
});

const contextCoverage = (evidence: AmbientEvidence): AmbientEvidence['contextCoverage'] => {
	if (evidence.halfHourBins === 0) {
		return 'unavailable';
	}

	return (evidence.daylightCounts.daylight ?? 0) > 0 && (evidence.daylightCounts.night ?? 0) > 0
		? 'daylight_and_night_observed'
		: 'limited_daylight_conditions';
};

const wasLightOff = (rows: HistorySample[], timestamp: number): boolean => {
	let lower = 0;
	let upper = rows.length;
	while (lower < upper) {
		const middle = Math.floor((lower + upper) / 2);
		if (Date.parse(rows[middle]!.last_updated) <= timestamp) {
			lower = middle + 1;
		} else {
			upper = middle;
		}
	}

	const sample = rows[lower - 1];
	return (
		sample?.state === 'off' &&
		sample.attributes.restored !== true &&
		timestamp - Date.parse(sample.last_changed) >= 60_000
	);
};

/** These are ambient observations, not lighting decisions or evidence of human preferences. */
export const summariseAmbientHistory = (input: {
	sensor: HistorySample[];
	lights: HistorySample[][];
	start: number;
	end: number;
	location: LearningLocation;
	thresholdLux: number;
	days: number;
}): AmbientEvidence => {
	const result = emptyAmbientEvidence(input.days, 'insufficient_off_light_history');
	const lights = input.lights.map((rows) => canonicalSamples(rows));
	const days = new Set<string>();
	const bins = new Set<number>();
	const values: number[] = [];
	for (const sample of canonicalSamples(input.sensor)) {
		const timestamp = Date.parse(sample.last_updated);
		const reading = evaluateDarkness({
			thresholdLux: input.thresholdLux,
			now: timestamp,
			measurement: {
				domain: 'sensor',
				deviceClass: sample.attributes.device_class,
				unit: sample.attributes.unit_of_measurement,
				state: sample.state,
				measuredAt: sample.last_changed,
				updatedAt: sample.last_updated,
			},
		});
		if (
			sample.initialSnapshot === true ||
			timestamp < input.start ||
			timestamp >= input.end ||
			Date.parse(sample.last_changed) !== timestamp ||
			reading.assessment === 'insufficient_context' ||
			lights.length === 0 ||
			lights.some((rows) => !wasLightOff(rows, timestamp))
		) {
			result.excludedReadings++;
			continue;
		}

		result.alignedOffReadings++;
		const bin = Math.floor(timestamp / 1_800_000);
		if (bins.has(bin)) {
			continue;
		}

		bins.add(bin);
		values.push(reading.lux);
		const context = enrichEpisode(timestamp, input.location);
		days.add(context.localDate);
		result.daylightCounts[context.daylight] = (result.daylightCounts[context.daylight] ?? 0) + 1;
		result.timeOfDayCounts[context.timeOfDay] =
			(result.timeOfDayCounts[context.timeOfDay] ?? 0) + 1;
	}

	result.halfHourBins = bins.size;
	result.localDays = days.size;
	result.contextCoverage = contextCoverage(result);
	if (values.length > 0) {
		result.observedLux = {
			lower: quantile(values, 0.1),
			median: quantile(values, 0.5),
			upper: quantile(values, 0.9),
		};
	}

	if (bins.size >= 12 && days.size >= 2 && result.observedLux !== undefined) {
		result.status =
			input.thresholdLux < result.observedLux.lower
				? 'starting_point_below_observed_range'
				: input.thresholdLux > result.observedLux.upper
					? 'starting_point_above_observed_range'
					: 'starting_point_within_observed_range';
	}

	return result;
};

export const collectAmbientHistory = async (input: {
	room: ThresholdRoom;
	client: ReturnType<typeof createHistoryClient>;
	days: number;
	now: number;
	thresholdLux: number;
}): Promise<{evidence: AmbientEvidence; currentLocalTime?: string; currentDaylight?: string}> => {
	const {room, client, days, now, thresholdLux} = input;
	if (room.sensor === undefined || !room.lightCoverageComplete) {
		return {evidence: emptyAmbientEvidence(days, 'incomplete_sensor_or_light_coverage')};
	}

	try {
		const location = await client.config();
		const current = enrichEpisode(now, location);
		const lookbackMs = days * 86_400_000;
		const start = now - lookbackMs;
		const entityIds = [room.sensor.entityId, ...room.lights.map((light) => light.entityId)];
		const histories = new Map<string, HistorySample[]>(entityIds.map((id) => [id, []]));
		let count = 0;
		for (let date = start; date < now; date += 86_400_000) {
			const result = await client.history({
				entityIds,
				start: new Date(date).toISOString(),
				end: new Date(Math.min(now, date + 86_400_000)).toISOString(),
			});
			if (entityIds.some((id) => result.every((series) => series[0]?.entity_id !== id))) {
				throw new Error('Ambient history is missing a requested daily series.');
			}

			count += result.reduce((total, series) => total + series.length, 0);
			if (count > HISTORY_LIMITS.maxTotalSamples) {
				throw new Error('Ambient history budget exceeded.');
			}

			for (const series of result) {
				const earliest = Math.min(...series.map((row) => Date.parse(row.last_updated)));
				for (const row of series) {
					histories
						.get(row.entity_id)!
						.push({...row, initialSnapshot: Date.parse(row.last_updated) === earliest});
				}
			}
		}

		return {
			evidence: summariseAmbientHistory({
				sensor: histories.get(room.sensor.entityId)!,
				lights: room.lights.map((light) => histories.get(light.entityId)!),
				start,
				end: now,
				location,
				thresholdLux,
				days,
			}),
			currentLocalTime: `${current.localDate} ${current.localTime} ${current.utcOffset}`,
			currentDaylight: current.daylight,
		};
	} catch {
		return {evidence: emptyAmbientEvidence(days, 'history_or_solar_context_unavailable')};
	}
};
