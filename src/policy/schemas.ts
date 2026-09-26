import {z} from 'zod';

const domainSchema = z
	.string()
	.trim()
	.min(1)
	.regex(/^[0-9_a-z]+$/v);
const entityIdSchema = z
	.string()
	.trim()
	.min(1)
	.regex(/^[0-9_a-z]+\.[0-9_a-z]+$/v);

export const entitySelectorSchema = z
	.strictObject({
		entityId: entityIdSchema.optional(),
		domain: domainSchema.optional(),
	})
	.refine((selector) => selector.entityId !== undefined || selector.domain !== undefined, {
		message: 'A selector must contain at least one supported field.',
	});

export const entitySelectorV2Schema = z
	.strictObject({
		entityId: entityIdSchema.optional(),
		domain: domainSchema.optional(),
		deviceId: z.string().min(1).optional(),
		areaId: z.string().min(1).optional(),
		labelId: z.string().min(1).optional(),
	})
	.refine((selector) => Object.values(selector).some((value) => value !== undefined), {
		message: 'A selector must contain at least one supported field.',
	});

export const entityPolicyV1Schema = z.strictObject({
	version: z.literal(1),
	allow: z.array(entitySelectorSchema),
	deny: z.array(entitySelectorSchema),
});

export const entityPolicyV2Schema = z.strictObject({
	version: z.literal(2),
	allow: z.array(entitySelectorV2Schema),
	deny: z.array(entitySelectorV2Schema),
});

export const entityPolicySchema = z.discriminatedUnion('version', [
	entityPolicyV1Schema,
	entityPolicyV2Schema,
]);

export type EntitySelector = z.infer<typeof entitySelectorV2Schema>;
export type EntityPolicy = z.infer<typeof entityPolicySchema>;
