import {z} from 'zod';
import {canonicalActions} from '../home-assistant/capabilities.js';

export const proposedActionSchema = z.strictObject({
	entityId: z.string().trim().min(1),
	action: z.enum(canonicalActions),
	reason: z.string().trim().min(1).max(500),
});

const summarySchema = z.string().trim().min(1).max(500).startsWith('Proposed plan:');

const proposeActionsPlanSchema = z.strictObject({
	outcome: z.literal('propose_actions'),
	summary: summarySchema,
	actions: z.array(proposedActionSchema).min(1),
});

const noActionPlanSchema = z.strictObject({
	outcome: z.literal('no_action'),
	summary: summarySchema,
	actions: z.array(proposedActionSchema).length(0),
});

const insufficientContextPlanSchema = z.strictObject({
	outcome: z.literal('insufficient_context'),
	summary: summarySchema,
	actions: z.array(proposedActionSchema).length(0),
});

export const planSchema = z.discriminatedUnion('outcome', [
	proposeActionsPlanSchema,
	noActionPlanSchema,
	insufficientContextPlanSchema,
]);

export const planJsonSchema = z.toJSONSchema(planSchema);

export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type Plan = z.infer<typeof planSchema>;
export type PlanOutcome = Plan['outcome'];
