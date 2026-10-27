import type {RegistrySnapshot} from './registry-client.js';

/** Exact registry names/aliases only; neither state hints nor entity names establish a room. */
export const resolveRegistryArea = (registries: RegistrySnapshot, name: string) => {
	if (registries.status !== 'available') {
		throw new Error('Room registries unavailable.');
	}

	const query = name.normalize('NFKC').trim().toLowerCase();
	const areas = registries.areas.filter((area) =>
		[area.name, ...area.aliases].some(
			(candidate) => candidate.normalize('NFKC').trim().toLowerCase() === query,
		),
	);
	if (areas.length !== 1) {
		throw new Error('Room name missing or ambiguous.');
	}

	return areas[0]!;
};
