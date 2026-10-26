import {z} from 'zod';
import {historyTimestampSchema} from '../home-assistant/history-schemas.js';
import {normalizeObservationValue, observationRegistry} from '../observations/registry.js';

export const PRACTICAL_DARKNESS_LUX = 40;
export const MAX_MEASUREMENT_AGE_MS = 300_000;
export const thresholdLuxSchema = z.number().min(1).max(1000);
const measurementSchema = z.object({
	domain: z.literal('sensor'),
	deviceClass: z.literal('illuminance'),
	unit: z.literal('lx'),
	state: z.string(),
	measuredAt: historyTimestampSchema,
	updatedAt: historyTimestampSchema,
});

export type DarknessAssessment =
	| {assessment: 'dark' | 'not_dark'; lux: number; thresholdLux: number}
	| {assessment: 'insufficient_context'; reason: string};

/** Standalone advisory evaluation. No policy grants, persistence, model or execution access. */
export const evaluateDarkness = (input: {
	thresholdLux: unknown;
	measurement: unknown;
	now: number;
}): DarknessAssessment => {
	const threshold = thresholdLuxSchema.safeParse(input.thresholdLux);
	if (!threshold.success) {
		return {assessment: 'insufficient_context', reason: 'invalid_threshold'};
	}

	const measurement = measurementSchema.safeParse(input.measurement);
	if (!measurement.success || !Number.isFinite(input.now)) {
		return {assessment: 'insufficient_context', reason: 'invalid_or_missing_measurement'};
	}

	const value = measurement.data;
	const definition = observationRegistry.find('sensor', 'illuminance')!;
	if (normalizeObservationValue(definition, value.state) === undefined || Number(value.state) < 0) {
		return {assessment: 'insufficient_context', reason: 'invalid_illuminance'};
	}

	const measured = Date.parse(value.measuredAt);
	const updated = Date.parse(value.updatedAt);
	if (measured > updated || updated > input.now) {
		return {assessment: 'insufficient_context', reason: 'invalid_measurement_time'};
	}

	if (input.now - measured > MAX_MEASUREMENT_AGE_MS) {
		return {assessment: 'insufficient_context', reason: 'stale_measurement'};
	}

	const lux = Number(value.state);
	return {
		assessment: lux < threshold.data ? 'dark' : 'not_dark',
		lux,
		thresholdLux: threshold.data,
	};
};
