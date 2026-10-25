import {Buffer} from 'node:buffer';
import got from 'got';
import {z} from 'zod';
import {
	historyResponseSchema,
	historyTimestampSchema,
	learningConfigSchema,
	logbookResponseSchema,
} from './history-schemas.js';

export const HISTORY_LIMITS = Object.freeze({
	maxDays: 30,
	maxLights: 16,
	maxResponseBytes: 8 * 1024 * 1024,
	maxTotalSamples: 200_000,
	requestTimeoutMs: 15_000,
});

const requestSchema = z
	.object({
		entityIds: z
			.array(z.string().regex(/^(?:light|sensor)\.[0-9_a-z]+$/v))
			.min(1)
			.max(17),
		start: historyTimestampSchema,
		end: historyTimestampSchema,
	})
	.refine(
		({entityIds, start, end}) =>
			new Set(entityIds).size === entityIds.length &&
			Date.parse(end) > Date.parse(start) &&
			Date.parse(end) - Date.parse(start) <= HISTORY_LIMITS.maxDays * 86_400_000,
	);

/** Streaming byte limit applies before JSON parsing, including decompressed bodies. GET only. */
export const createHistoryClient = (homeAssistantUrl: string, token: string) => {
	const client = got.extend({
		prefixUrl: `${homeAssistantUrl}/api`,
		headers: {authorization: `Bearer ${token}`},
		timeout: {request: HISTORY_LIMITS.requestTimeoutMs},
		retry: {limit: 0},
		followRedirect: false,
	});
	const readJson = async (
		path: string,
		searchParameters: Record<string, string> = {},
	): Promise<unknown> => {
		const request = client.stream.get(path, {searchParams: searchParameters});
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for await (const chunk of request) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
				size += bytes.length;
				if (size > HISTORY_LIMITS.maxResponseBytes) {
					throw new Error('Historical response exceeded the byte budget.');
				}

				chunks.push(bytes);
			}

			return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
		} finally {
			request.destroy();
		}
	};

	return {
		async config() {
			return learningConfigSchema.parse(await readJson('config'));
		},
		async history(input: z.input<typeof requestSchema>) {
			const {entityIds, start, end} = requestSchema.parse(input);
			const result = historyResponseSchema.parse(
				await readJson(`history/period/${encodeURIComponent(start)}`, {
					filter_entity_id: entityIds.join(','),
					end_time: end,
					significant_changes_only: '0',
				}),
			);
			const seen = new Set<string>();
			for (const series of result) {
				const id = series[0]?.entity_id;
				if (id === undefined) {
					continue;
				}

				if (!entityIds.includes(id) || seen.has(id) || series.some((row) => row.entity_id !== id)) {
					throw new Error('Unexpected historical entity series.');
				}

				seen.add(id);
				if (
					series.some(
						(row) =>
							Date.parse(row.last_updated) > Date.parse(end) ||
							Date.parse(row.last_changed) > Date.parse(row.last_updated),
					)
				) {
					throw new Error('Invalid historical sample interval.');
				}
			}

			return result;
		},
		async logbook(input: z.input<typeof requestSchema>) {
			const {entityIds, start, end} = requestSchema.parse(input);
			if (entityIds.some((id) => !id.startsWith('light.'))) {
				throw new Error('Logbook queries require explicit light targets.');
			}

			const rows = logbookResponseSchema.parse(
				await readJson(`logbook/${encodeURIComponent(start)}`, {
					entity: entityIds.join(','),
					end_time: end,
				}),
			);
			return rows.filter(
				(row) =>
					row.entity_id !== undefined &&
					entityIds.includes(row.entity_id) &&
					Date.parse(row.when) >= Date.parse(start) &&
					Date.parse(row.when) < Date.parse(end),
			);
		},
	};
};
