/* eslint-disable unicorn/no-break-in-nested-loop -- Ordered scans retain explicit transition and exclusion accounting. */
import type {
	HistoricalState,
	HistoricalLogEntry,
	LearningLocation,
} from '../home-assistant/history-schemas.js';
import {observationRegistry, normalizeObservationValue} from '../observations/registry.js';
import {enrichEpisode, type EpisodeContext} from './context.js';

export const EVENT_LIMITS = Object.freeze({
	maxLuxAgeMs: 300_000,
	simultaneousMs: 5000,
	independenceMs: 1_800_000,
});
export type HistorySample = HistoricalState & {initialSnapshot?: boolean};
export type EventProvenance =
	| 'interaction_supported'
	| 'user_attributed_origin_unverified'
	| 'automation_or_script_attributed'
	| 'external_context_attributed'
	| 'unknown_origin';
export type LightingEpisode = {
	timestamp: number;
	entityIds: string[];
	provenance: EventProvenance;
	independent: boolean;
	lux: number | undefined;
	luxAgeMs: number | undefined;
	luxIssue: 'missing_pre_event_lux' | 'stale_pre_event_lux' | 'invalid_pre_event_lux' | undefined;
	context: EpisodeContext;
};
export type EventAnalysis = {
	episodes: LightingEpisode[];
	excluded: Record<string, number>;
};

/** Account attribution is not evidence of physical/UI interaction: API tokens can automate. */
export const classifyEventOrigin = (
	state: HistoricalState,
	logbook: HistoricalLogEntry[],
): EventProvenance => {
	const matches = logbook.filter(
		(entry) =>
			entry.entity_id === state.entity_id &&
			entry.state === state.state &&
			Date.parse(entry.when) === Date.parse(state.last_changed),
	);
	if (
		matches.some(
			(entry) =>
				['automation', 'script'].includes(entry.context_domain ?? '') ||
				/^(?:automation|script)\./v.test(entry.context_entity_id ?? ''),
		)
	) {
		return 'automation_or_script_attributed';
	}

	if (
		matches.some(
			(entry) => entry.context_domain !== undefined || entry.context_entity_id !== undefined,
		) ||
		typeof state.context?.parent_id === 'string'
	) {
		return 'external_context_attributed';
	}

	if (
		typeof state.context?.user_id === 'string' ||
		matches.some((entry) => typeof entry.context_user_id === 'string')
	) {
		return 'user_attributed_origin_unverified';
	}

	return 'unknown_origin';
};

/** Sort and deduplicate; conflicting records at one timestamp become unusable barriers. */
export const canonicalSamples = (rows: HistorySample[]): HistorySample[] => {
	const byTime = new Map<number, HistorySample[]>();
	for (const row of rows) {
		const time = Date.parse(row.last_updated);
		const group = byTime.get(time) ?? [];
		group.push(row);
		byTime.set(time, group);
	}

	return [...byTime]
		.toSorted(([a], [b]) => a - b)
		.map(([, group]) => {
			const first = group[0]!;
			const signature = (row: HistorySample) =>
				JSON.stringify([
					row.state,
					Date.parse(row.last_changed),
					row.attributes.unit_of_measurement,
					row.attributes.device_class,
					row.attributes.restored,
					row.context,
				]);
			const isConflict = group.some((row) => signature(row) !== signature(first));
			return {
				...first,
				state: isConflict ? 'unknown' : first.state,
				initialSnapshot: group.every((row) => row.initialSnapshot === true),
			};
		});
};

const preEventLux = (
	rows: HistorySample[],
	timestamp: number,
): Pick<LightingEpisode, 'lux' | 'luxAgeMs' | 'luxIssue'> => {
	// A malformed latest reading is a barrier; never search past it to manufacture coverage.
	let lower = 0;
	let upper = rows.length;
	while (lower < upper) {
		const middle = Math.floor((lower + upper) / 2);
		if (Date.parse(rows[middle]!.last_updated) < timestamp) {
			lower = middle + 1;
		} else {
			upper = middle;
		}
	}

	const sample = rows[lower - 1];
	if (sample === undefined || sample.initialSnapshot === true) {
		return {lux: undefined, luxAgeMs: undefined, luxIssue: 'missing_pre_event_lux'};
	}

	// Attribute-only updates cannot prove a new measurement of an unchanged value.
	const age = timestamp - Date.parse(sample.last_changed);
	const definition = observationRegistry.find('sensor', 'illuminance')!;
	if (
		sample.attributes.device_class !== 'illuminance' ||
		sample.attributes.unit_of_measurement !== 'lx' ||
		normalizeObservationValue(definition, sample.state) === undefined ||
		Number(sample.state) < 0
	) {
		return {lux: undefined, luxAgeMs: age, luxIssue: 'invalid_pre_event_lux'};
	}

	if (age > EVENT_LIMITS.maxLuxAgeMs) {
		return {lux: undefined, luxAgeMs: age, luxIssue: 'stale_pre_event_lux'};
	}

	return {lux: Number(sample.state), luxAgeMs: age, luxIssue: undefined};
};

type EventCandidate = {state: HistorySample; episode: LightingEpisode};

const groupCandidates = (
	candidates: EventCandidate[],
	exclude: (reason: string) => void,
): LightingEpisode[] => {
	candidates.sort((a, b) =>
		a.episode.timestamp === b.episode.timestamp
			? a.state.entity_id.localeCompare(b.state.entity_id)
			: a.episode.timestamp - b.episode.timestamp,
	);
	const episodes: LightingEpisode[] = [];
	const grouped = new Set<number>();
	for (let index = 0; index < candidates.length; index++) {
		if (grouped.has(index)) {
			continue;
		}

		const candidate = candidates[index]!;
		const {episode} = candidate;
		for (let next = index + 1; next < candidates.length; next++) {
			const other = candidates[next]!;
			if (other.episode.timestamp - episode.timestamp > EVENT_LIMITS.simultaneousMs) {
				break;
			}

			if (grouped.has(next)) {
				continue;
			}

			const contextId = candidate.state.context?.id;
			if (typeof contextId === 'string' && contextId === other.state.context?.id) {
				episode.entityIds.push(...other.episode.entityIds);
				grouped.add(next);
				exclude('shared_context_collapsed');
				if (other.episode.provenance !== episode.provenance) {
					episode.provenance = 'unknown_origin';
				}
			} else {
				// Timing alone cannot establish one action or independent decisions. Keep both descriptive.
				episode.independent = false;
				other.episode.independent = false;
			}
		}

		episodes.push(episode);
	}

	let previousIndependent = -Infinity;
	for (const episode of episodes) {
		if (episode.timestamp - previousIndependent < EVENT_LIMITS.independenceMs) {
			episode.independent = false;
		}

		if (episode.independent) {
			previousIndependent = episode.timestamp;
		} else {
			exclude('independence_unestablished');
		}

		if (episode.luxIssue !== undefined) {
			exclude(episode.luxIssue);
		}
	}

	return episodes;
};

export const identifyLightingEpisodes = (input: {
	lights: Map<string, HistorySample[]>;
	sensor: HistorySample[];
	aggregateIds: ReadonlySet<string>;
	logbook: HistoricalLogEntry[];
	start: number;
	end: number;
	location: LearningLocation;
}): EventAnalysis => {
	const excluded: Record<string, number> = {};
	const exclude = (reason: string) => {
		excluded[reason] = (excluded[reason] ?? 0) + 1;
	};

	const sensor = canonicalSamples(input.sensor);
	const logbookByEvent = new Map<string, HistoricalLogEntry[]>();
	for (const entry of input.logbook) {
		const key = `${entry.entity_id ?? ''}:${Date.parse(entry.when)}`;
		const matches = logbookByEvent.get(key) ?? [];
		matches.push(entry);
		logbookByEvent.set(key, matches);
	}

	const candidates: EventCandidate[] = [];
	for (const [id, history] of input.lights) {
		const rows = canonicalSamples(history);
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index]!;
			const previous = rows[index - 1];
			if (row.state !== 'on' || previous?.state === 'on') {
				continue;
			}

			const timestamp = Date.parse(row.last_changed);
			if (
				row.initialSnapshot === true ||
				previous === undefined ||
				timestamp <= input.start ||
				timestamp >= input.end ||
				timestamp !== Date.parse(row.last_updated)
			) {
				exclude('initial_or_non_transition');
				continue;
			}

			if (
				previous.state !== 'off' ||
				row.attributes.restored === true ||
				previous.attributes.restored === true
			) {
				exclude('unusable_or_restored_transition');
				continue;
			}

			if (input.aggregateIds.has(id)) {
				exclude('aggregate_entity_transition');
				continue;
			}

			candidates.push({
				state: row,
				episode: {
					timestamp,
					entityIds: [id],
					provenance: classifyEventOrigin(
						row,
						logbookByEvent.get(`${row.entity_id}:${timestamp}`) ?? [],
					),
					independent: true,
					...preEventLux(sensor, timestamp),
					context: enrichEpisode(timestamp, input.location),
				},
			});
		}
	}

	return {episodes: groupCandidates(candidates, exclude), excluded};
};
