import {createHash} from 'node:crypto';

const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((item: unknown) => canonical(item));
	}

	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}

	return value;
};

/** Private comparison digests, never raw snapshots in candidate presentation. */
export const fingerprint = (value: unknown): string =>
	createHash('sha256')
		.update(JSON.stringify(canonical(value)) ?? 'undefined')
		.digest('hex');
