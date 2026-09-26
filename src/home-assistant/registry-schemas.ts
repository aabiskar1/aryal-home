import {z} from 'zod';

const identifier = z.string().min(1);
const labelIds = z.array(identifier);

export const entityRegistryEntrySchema = z.object({
	entity_id: identifier,
	device_id: identifier.nullable(),
	area_id: identifier.nullable(),
	labels: labelIds,
	disabled_by: identifier.nullable(),
});

export const deviceRegistryEntrySchema = z.object({
	id: identifier,
	area_id: identifier.nullable(),
	labels: labelIds,
	disabled_by: identifier.nullable(),
	parent_device_id: identifier.nullable().optional(),
});

export const areaRegistryEntrySchema = z.object({
	area_id: identifier,
	labels: labelIds,
});

export const labelRegistryEntrySchema = z.object({
	label_id: identifier,
});

const uniqueEntries = <T>(entries: T[], getId: (entry: T) => string): T[] => {
	const identifiers = new Set<string>();

	for (const entry of entries) {
		const id = getId(entry);

		if (identifiers.has(id)) {
			throw new Error('Duplicate Home Assistant registry identifier.');
		}

		identifiers.add(id);
	}

	return entries;
};

export const registrySchemas = {
	'config/entity_registry/list': z
		.array(entityRegistryEntrySchema)
		.transform((entries) => uniqueEntries(entries, (entry) => entry.entity_id)),
	'config/device_registry/list': z
		.array(deviceRegistryEntrySchema)
		.transform((entries) => uniqueEntries(entries, (entry) => entry.id)),
	'config/area_registry/list': z
		.array(areaRegistryEntrySchema)
		.transform((entries) => uniqueEntries(entries, (entry) => entry.area_id)),
	'config/label_registry/list': z
		.array(labelRegistryEntrySchema)
		.transform((entries) => uniqueEntries(entries, (entry) => entry.label_id)),
};

export type EntityRegistryEntry = z.infer<typeof entityRegistryEntrySchema>;
export type DeviceRegistryEntry = z.infer<typeof deviceRegistryEntrySchema>;
export type AreaRegistryEntry = z.infer<typeof areaRegistryEntrySchema>;
export type LabelRegistryEntry = z.infer<typeof labelRegistryEntrySchema>;
