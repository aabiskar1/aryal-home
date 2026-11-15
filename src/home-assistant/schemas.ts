import {z} from 'zod';
import {historyTimestampSchema} from './history-schemas.js';
import {areStateTimestampsValid} from './state-timestamps.js';

export const homeAssistantStateSchema = z
	.object({
		entity_id: z.string(),
		state: z.string(),
		attributes: z.record(z.string(), z.unknown()),
		last_changed: historyTimestampSchema,
		last_updated: historyTimestampSchema,
		last_reported: historyTimestampSchema.optional(),
	})
	.refine(
		(state) => areStateTimestampsValid(state, Date.now()),
		'Invalid Home Assistant timestamp ordering or future timestamp.',
	);

export const homeAssistantStatesSchema = z.array(homeAssistantStateSchema);

export type HomeAssistantState = z.infer<typeof homeAssistantStateSchema>;
