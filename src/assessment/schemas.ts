import {z} from 'zod';
import {historyTimestampSchema} from '../home-assistant/history-schemas.js';
import {thresholdLuxSchema} from '../lighting-thresholds/evaluation.js';

export const presenceSchema = z.enum(['detected', 'clear', 'unknown', 'conflicting']);
const lightRefSchema = z.string().regex(/^light_\d{1,2}$/v);
const observationValueSchema = z.union([z.number().nonnegative(), z.enum(['on', 'off']), z.null()]);
const rawObservationSchema = z.strictObject({
	ref: z.string().regex(/^observation_\d{1,2}$/v),
	source: z.literal('home_assistant_state'),
	deviceClass: z.enum(['illuminance', 'presence', 'occupancy']),
	status: z.enum(['available', 'stale', 'invalid']),
	value: observationValueSchema,
	unit: z.literal('lx').nullable(),
	measuredAt: historyTimestampSchema.nullable(),
	updatedAt: historyTimestampSchema.nullable(),
});
const observationSchema = rawObservationSchema.refine((item) => {
	if (item.status !== 'available') {
		return item.value === null;
	}

	return (
		item.measuredAt !== null &&
		item.updatedAt !== null &&
		(item.deviceClass === 'illuminance'
			? typeof item.value === 'number' && item.unit === 'lx'
			: (item.value === 'on' || item.value === 'off') && item.unit === null)
	);
});

const lightSchema = z.strictObject({
	ref: lightRefSchema,
	source: z.literal('home_assistant_state'),
	state: z.enum(['on', 'off']),
	observedAt: historyTimestampSchema,
	supportedActions: z.tuple([z.literal('turn_on')]),
});
const preferenceSchema = z.discriminatedUnion('status', [
	z.strictObject({
		status: z.literal('missing'),
		source: z.literal('local_threshold_preferences'),
	}),
	z.strictObject({
		status: z.literal('approved'),
		source: z.literal('local_threshold_preferences'),
		thresholdLux: thresholdLuxSchema,
	}),
]);
const availableClockSchema = z.strictObject({
	status: z.literal('available'),
	source: z.literal('ha_config_and_system_clock'),
	localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/v),
	localTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/v),
	utcOffset: z.string().max(16),
	timeOfDay: z.enum(['night', 'morning', 'afternoon', 'evening']),
	daylight: z.enum(['daylight', 'civil_twilight', 'night', 'boundary_uncertain']),
	reliability: z.literal('approximate_configured_location'),
});
export const clockSchema = z.discriminatedUnion('status', [
	z.strictObject({
		status: z.literal('unavailable'),
		source: z.literal('ha_config_and_system_clock'),
	}),
	availableClockSchema,
]);
export const assessmentContextSchema = z.strictObject({
	version: z.literal(1),
	goal: z.literal('lighting_comfort'),
	scope: z.literal('selected_area'),
	capturedAt: historyTimestampSchema,
	states: z.array(lightSchema).max(16),
	observations: z.array(observationSchema).max(16),
	preference: preferenceSchema,
	clock: clockSchema,
	presence: presenceSchema,
});
export type AssessmentContext = z.infer<typeof assessmentContextSchema>;
export type AssessmentObservation = AssessmentContext['observations'][number];

const responseFields = {
	rationale: z.string().trim().min(1).max(320),
	presence: presenceSchema,
};
const actionSchema = z.strictObject({lightRef: lightRefSchema, action: z.literal('turn_on')});
const actionsSchema = z.array(actionSchema).min(1).max(16);
const emptyActionsSchema = z.array(z.never()).max(0);
export const assessmentProposalSchema = z.discriminatedUnion('outcome', [
	z.strictObject({
		...responseFields,
		outcome: z.literal('suggest_action'),
		actions: actionsSchema,
	}),
	z.strictObject({
		...responseFields,
		outcome: z.literal('no_action'),
		actions: emptyActionsSchema,
	}),
	z.strictObject({
		...responseFields,
		outcome: z.literal('insufficient_context'),
		actions: emptyActionsSchema,
	}),
]);
export type AssessmentProposal = z.infer<typeof assessmentProposalSchema>;
export const assessmentProposalJsonSchema = z.toJSONSchema(assessmentProposalSchema);
