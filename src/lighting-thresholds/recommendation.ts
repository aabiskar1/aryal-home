import type {AuditData} from '../audit/collection.js';
import type {createHistoryClient} from '../home-assistant/history-client.js';
import {evaluateDarkness, type DarknessAssessment, PRACTICAL_DARKNESS_LUX} from './evaluation.js';
import {collectAmbientHistory, emptyAmbientEvidence, type AmbientEvidence} from './history.js';
import {roomMeasurement, type ThresholdRoom} from './room.js';

export type ThresholdReport = {
	area: string;
	mode: 'suggest' | 'show';
	configuredLux: number | undefined;
	suggestedLux: number | undefined;
	source: 'practical_starting_point_not_learned' | 'user_configured' | 'not_configured';
	sensorStatus: string;
	current: DarknessAssessment;
	currentLocalTime?: string;
	currentDaylight?: string;
	evidence?: AmbientEvidence;
	runtimeEffect: 'none';
};

export const buildThresholdReport = async (input: {
	room: ThresholdRoom;
	mode: 'suggest' | 'show';
	configuredLux: number | undefined;
	now: number;
	startingLux?: number;
	days?: number;
	client?: ReturnType<typeof createHistoryClient>;
}): Promise<ThresholdReport> => {
	const {room, mode, configuredLux, now} = input;
	const thresholdLux =
		mode === 'suggest' ? (input.startingLux ?? PRACTICAL_DARKNESS_LUX) : configuredLux;
	const current =
		thresholdLux === undefined
			? {assessment: 'insufficient_context' as const, reason: 'no_configured_threshold'}
			: evaluateDarkness({thresholdLux, measurement: roomMeasurement(room), now});
	const report: ThresholdReport = {
		area: room.area,
		mode,
		configuredLux,
		suggestedLux: mode === 'suggest' ? thresholdLux : undefined,
		source:
			mode === 'suggest'
				? 'practical_starting_point_not_learned'
				: configuredLux === undefined
					? 'not_configured'
					: 'user_configured',
		sensorStatus: room.sensorStatus,
		current,
		runtimeEffect: 'none',
	};
	if (mode === 'suggest') {
		const days = input.days ?? 3;
		if (input.client === undefined) {
			report.evidence = emptyAmbientEvidence(days, 'history_client_unavailable');
		} else {
			// History has its own eligibility checks and never supplies a current measurement.
			Object.assign(
				report,
				await collectAmbientHistory({
					room,
					client: input.client,
					days,
					now,
					thresholdLux: thresholdLux!,
				}),
			);
		}
	}

	return report;
};

export type ThresholdReadDependencies = {
	collect: () => Promise<AuditData>;
	now: () => number;
	client: () => ReturnType<typeof createHistoryClient>;
};
