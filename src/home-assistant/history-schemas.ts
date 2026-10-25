import {z} from 'zod';

export const historyTimestampSchema = z.iso
	.datetime({offset: true})
	.refine((value) => Number.isFinite(Date.parse(value)));

const contextSchema = z.object({
	id: z.string().min(1).nullable(),
	parent_id: z.string().min(1).nullable(),
	user_id: z.string().min(1).nullable(),
});

// Full responses are deliberate: minimal_response drops metadata needed to assess evidence.
export const historicalStateSchema = z.object({
	entity_id: z.string().regex(/^(?:light|sensor)\.[0-9_a-z]+$/v),
	state: z.string().max(255),
	attributes: z.object({
		device_class: z.string().max(64).optional(),
		unit_of_measurement: z.string().max(32).optional(),
		restored: z.boolean().optional(),
	}),
	last_changed: historyTimestampSchema,
	last_updated: historyTimestampSchema,
	context: contextSchema.optional(),
});

export const historyResponseSchema = z.array(z.array(historicalStateSchema).max(50_000)).max(17);
export type HistoricalState = z.infer<typeof historicalStateSchema>;

// Only attribution fields are retained; names, messages and service data are discarded.
export const logbookResponseSchema = z
	.array(
		z.object({
			entity_id: z.string().optional(),
			state: z.string().optional(),
			when: historyTimestampSchema,
			context_user_id: z.string().nullable().optional(),
			context_entity_id: z.string().optional(),
			context_domain: z.string().optional(),
			context_event_type: z.string().optional(),
			context_id: z.string().optional(),
		}),
	)
	.max(50_000);
export type HistoricalLogEntry = z.infer<typeof logbookResponseSchema>[number];

export const learningConfigSchema = z.object({
	time_zone: z.string().refine((value) => {
		try {
			new Intl.DateTimeFormat('en', {timeZone: value}).format();
			return true;
		} catch {
			return false;
		}
	}),
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
});
export type LearningLocation = z.infer<typeof learningConfigSchema>;
