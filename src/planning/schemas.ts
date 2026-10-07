import {z} from 'zod';
import {canonicalActions, supportedDomains} from '../home-assistant/capabilities.js';

const reasonSchema = z.string().trim().min(1).max(500);

export const proposedActionSchema = z.strictObject({
	entityId: z.string().trim().min(1),
	action: z.enum(canonicalActions),
	reason: reasonSchema,
});

export const scopedActionSchema = z.strictObject({
	type: z.literal('set_action'),
	action: z.enum(canonicalActions),
	scope: z.strictObject({
		area: z.string().trim().min(1),
		domain: z.enum(supportedDomains),
	}),
	reason: reasonSchema,
});

const intentSchema = z.union([scopedActionSchema, proposedActionSchema]);

const summarySchema = z.string().trim().min(1).max(500).startsWith('Proposed plan:');

const createPlanSchema = <T extends z.ZodType>(actionSchema: T) =>
	z.discriminatedUnion('outcome', [
		z.strictObject({
			outcome: z.literal('propose_actions'),
			summary: summarySchema,
			actions: z.array(actionSchema).min(1),
		}),
		z.strictObject({
			outcome: z.literal('no_action'),
			summary: summarySchema,
			actions: z.array(actionSchema).length(0),
		}),
		z.strictObject({
			outcome: z.literal('insufficient_context'),
			summary: summarySchema,
			actions: z.array(actionSchema).length(0),
		}),
	]);

export const planSchema = createPlanSchema(intentSchema);

export const planningSchemas = {
	mixed: planSchema,
	entity_only: createPlanSchema(proposedActionSchema),
	set_only: createPlanSchema(scopedActionSchema),
};

export type PlanningIntentMode = keyof typeof planningSchemas;

export const planJsonSchema = z.toJSONSchema(planSchema);
export const planningJsonSchemas = {
	mixed: planJsonSchema,
	entity_only: z.toJSONSchema(planningSchemas.entity_only),
	set_only: z.toJSONSchema(planningSchemas.set_only),
};

export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type SetAction = z.infer<typeof scopedActionSchema>;
export type Plan = z.infer<typeof planSchema>;
export type PlanOutcome = Plan['outcome'];

// Internal expansion output only: semantic scopes cannot enter concrete policy validation.
export type ConcretePlan = {outcome: PlanOutcome; summary: string; actions: ProposedAction[]};
