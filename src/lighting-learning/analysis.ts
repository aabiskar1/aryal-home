/* eslint-disable no-await-in-loop -- Sequential daily requests bound Recorder load and response memory. */
import {z} from 'zod';
import {collectAuditData, type AuditData} from '../audit/collection.js';
import {createHistoryClient, HISTORY_LIMITS} from '../home-assistant/history-client.js';
import type {HistoricalLogEntry, LearningLocation} from '../home-assistant/history-schemas.js';
import {selectLightingScope, type LightingScope} from './scope.js';
import {identifyLightingEpisodes, type HistorySample} from './events.js';
import {estimateLightingPreference, type LearningEstimate} from './estimator.js';

export type LearningReport = {
	area: string;
	daysRequested: number;
	status: 'not_activated';
	assessment: LearningEstimate['assessment'] | 'unsupported_configuration';
	reason: string;
	sensors: number;
	lights: number;
	aggregateLights: number;
	history: {
		seriesWithData: number;
		missingSeries: number;
		samples: number;
		daysWithRecords: number;
		contextRows: number;
		logbookRows: number;
		logbookAccountAttributedRows: number;
		coverage: 'unverified_recorder_retention_and_exclusions';
		logbook: 'available' | 'unavailable';
	};
	events: {
		episodes: number;
		independent: number;
		withFreshLux: number;
		provenance: Record<string, number>;
		excluded: Record<string, number>;
	};
	context: {
		timezoneAvailable: boolean;
		solar: 'approximate_configured_location' | 'unavailable';
		weather: 'not_collected';
		daylightCounts: Record<string, number>;
		timeOfDayCounts: Record<string, number>;
	};
	estimate?: LearningEstimate;
	redactions?: readonly string[];
};
const configSchema = z.object({HA_URL: z.url(), HA_TOKEN: z.string().min(1)});
export type LearningOptions = {area: string; days: number};
export type LearningDependencies = {
	collect: () => Promise<AuditData>;
	client: ReturnType<typeof createHistoryClient>;
	now: () => Date;
};

const collectWindow = async (
	deps: LearningDependencies,
	scope: LightingScope,
	{location, start, end}: {location: LearningLocation; start: number; end: number},
	summary: LearningReport['history'],
) => {
	const entityIds = [scope.sensor.entityId, ...scope.lights.map((light) => light.entityId)];
	const samples = new Map<string, HistorySample[]>(entityIds.map((id) => [id, []]));
	const logbook: HistoricalLogEntry[] = [];
	const daysWithRecords = new Set<string>();
	let isLogbookFailed = false;
	for (let chunkStart = start; chunkStart < end; chunkStart += 86_400_000) {
		const request = {
			entityIds,
			start: new Date(chunkStart).toISOString(),
			end: new Date(Math.min(chunkStart + 86_400_000, end)).toISOString(),
		};
		const history = await deps.client.history(request);
		for (const series of history) {
			const earliest = Math.min(...series.map((row) => Date.parse(row.last_updated)));
			for (const row of series) {
				summary.samples++;
				if (summary.samples > HISTORY_LIMITS.maxTotalSamples) {
					throw new Error('Historical sample budget exceeded.');
				}

				const destination = samples.get(row.entity_id);
				if (destination === undefined) {
					throw new Error('Unexpected historical entity.');
				}

				const isInitialSnapshot = Date.parse(row.last_updated) === earliest;
				destination.push({...row, initialSnapshot: isInitialSnapshot});
				if (row.context !== undefined) {
					summary.contextRows++;
				}

				const updated = Date.parse(row.last_updated);
				if (!isInitialSnapshot && updated >= start && updated < end) {
					daysWithRecords.add(
						new Intl.DateTimeFormat('en-CA', {timeZone: location.time_zone}).format(updated),
					);
				}
			}
		}

		if (!isLogbookFailed) {
			try {
				logbook.push(
					...(await deps.client.logbook({
						...request,
						entityIds: scope.lights.map((light) => light.entityId),
					})),
				);
			} catch {
				isLogbookFailed = true;
				logbook.length = 0;
			}
		}

		if (logbook.length + summary.samples > HISTORY_LIMITS.maxTotalSamples) {
			throw new Error('Historical sample budget exceeded.');
		}
	}

	summary.logbook = isLogbookFailed ? 'unavailable' : 'available';
	summary.logbookRows = logbook.length;
	summary.logbookAccountAttributedRows = logbook.filter(
		(entry) => typeof entry.context_user_id === 'string',
	).length;
	for (const rows of samples.values()) {
		if (rows.length > 0) {
			summary.seriesWithData++;
		}
	}

	summary.missingSeries = entityIds.length - summary.seriesWithData;
	summary.daysWithRecords = daysWithRecords.size;
	return {samples, logbook: isLogbookFailed ? [] : logbook};
};

/** Explicit invocation only. No planner, model, policy writer, or execution dependency. */
export const analyseLightingHistory = async (
	options: LearningOptions,
	dependencies?: LearningDependencies,
): Promise<LearningReport> => {
	if (
		!Number.isSafeInteger(options.days) ||
		options.days < 1 ||
		options.days > HISTORY_LIMITS.maxDays ||
		options.area.trim().length === 0 ||
		options.area.length > 120
	) {
		throw new Error('Invalid learning options.');
	}

	const config = dependencies === undefined ? configSchema.parse(process.env) : undefined;
	const deps = dependencies ?? {
		collect: collectAuditData,
		client: createHistoryClient(config!.HA_URL, config!.HA_TOKEN),
		now: () => new Date(),
	};
	const data = await deps.collect();
	const selected = selectLightingScope(data, options.area);
	const report: LearningReport = {
		area: options.area,
		daysRequested: options.days,
		status: 'not_activated',
		assessment: 'unsupported_configuration',
		reason: 'scope_unavailable',
		sensors: 0,
		lights: 0,
		aggregateLights: 0,
		history: {
			seriesWithData: 0,
			missingSeries: 0,
			samples: 0,
			daysWithRecords: 0,
			contextRows: 0,
			logbookRows: 0,
			logbookAccountAttributedRows: 0,
			coverage: 'unverified_recorder_retention_and_exclusions',
			logbook: 'unavailable',
		},
		events: {episodes: 0, independent: 0, withFreshLux: 0, provenance: {}, excluded: {}},
		context: {
			timezoneAvailable: false,
			solar: 'unavailable',
			weather: 'not_collected',
			daylightCounts: {},
			timeOfDayCounts: {},
		},
		redactions: data.redactions,
	};
	if (selected.kind !== 'available') {
		return {
			...report,
			reason: selected.reason,
			sensors: selected.sensorCount,
			lights: selected.lightCount,
		};
	}

	const {scope} = selected;
	report.area = scope.area;
	report.sensors = 1;
	report.lights = scope.lights.length;
	report.aggregateLights = scope.aggregateIds.size;
	const location = await deps.client.config();
	report.context.timezoneAvailable = true;
	report.context.solar = 'approximate_configured_location';
	const end = deps.now().getTime();
	const lookbackMs = options.days * 86_400_000;
	const start = end - lookbackMs;
	const {samples, logbook} = await collectWindow(
		deps,
		scope,
		{location, start, end},
		report.history,
	);
	const analysis = identifyLightingEpisodes({
		lights: new Map(scope.lights.map((light) => [light.entityId, samples.get(light.entityId)!])),
		sensor: samples.get(scope.sensor.entityId)!,
		aggregateIds: scope.aggregateIds,
		logbook,
		start,
		end,
		location,
	});
	for (const episode of analysis.episodes) {
		const counts = report.events.provenance;
		counts[episode.provenance] = (counts[episode.provenance] ?? 0) + 1;
		for (const [target, category] of [
			[report.context.daylightCounts, episode.context.daylight],
			[report.context.timeOfDayCounts, episode.context.timeOfDay],
		] as const) {
			target[category] = (target[category] ?? 0) + 1;
		}
	}

	report.events.episodes = analysis.episodes.length;
	report.events.independent = analysis.episodes.filter((episode) => episode.independent).length;
	report.events.withFreshLux = analysis.episodes.filter(
		(episode) => episode.lux !== undefined,
	).length;
	report.events.excluded = analysis.excluded;
	const estimate = estimateLightingPreference(analysis.episodes);
	report.estimate = estimate;
	report.assessment = estimate.assessment;
	report.reason = estimate.reason;
	if (report.history.missingSeries > 0) {
		report.assessment = 'insufficient_history';
		report.reason = 'missing_history_possible_recorder_exclusion_or_retention';
	}

	return report;
};
