import type {LightingEpisode} from './events.js';

export const LEARNING_REQUIREMENTS = Object.freeze({
	minEpisodes: 8,
	minDays: 4,
	minGroupEpisodes: 4,
	minGroupDays: 2,
});
export type LearningAssessment =
	| 'suggestion_available'
	| 'insufficient_history'
	| 'insufficient_reliable_events'
	| 'ambiguous_event_provenance'
	| 'insufficient_sensor_coverage'
	| 'unstable_preference';
export type ContextGroup = {
	dimension: 'daylight' | 'timeOfDay';
	category: string;
	episodes: number;
	days: number;
	medianLux: number;
};
export type LearningEstimate = {
	assessment: LearningAssessment;
	reason: string;
	reliableEpisodes: number;
	independentDays: number;
	supportingSamples: number;
	outlierSamples: number;
	contextGroups: ContextGroup[];
	contextGrouping: 'sufficient' | 'insufficient_samples';
	estimatedLux?: number;
	interquartileRangeLux?: number;
};

export const quantile = (values: readonly number[], fraction: number): number => {
	const sorted = values.toSorted((a, b) => a - b);
	const position = (sorted.length - 1) * fraction;
	const lower = Math.floor(position);
	const interpolation = (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
	return sorted[lower]! + interpolation;
};

const days = (episodes: LightingEpisode[]) =>
	new Set(episodes.map((episode) => episode.context.localDate)).size;

const assessContext = (usable: LightingEpisode[], estimate: number) => {
	const contextGroups: ContextGroup[] = [];
	let hasConflict = false;
	// Assess context on ALL usable evidence, before outlier removal can hide a minority pattern.
	for (const dimension of ['daylight', 'timeOfDay'] as const) {
		const categories = new Map<string, LightingEpisode[]>();
		for (const episode of usable) {
			const category = episode.context[dimension];
			const group = categories.get(category) ?? [];
			group.push(episode);
			categories.set(category, group);
		}

		for (const [category, group] of categories) {
			contextGroups.push({
				dimension,
				category,
				episodes: group.length,
				days: days(group),
				medianLux: quantile(
					group.map((episode) => episode.lux!),
					0.5,
				),
			});
		}
	}

	const supportedGroups = contextGroups.filter(
		(group) =>
			group.episodes >= LEARNING_REQUIREMENTS.minGroupEpisodes &&
			group.days >= LEARNING_REQUIREMENTS.minGroupDays,
	);
	const contextGrouping: LearningEstimate['contextGrouping'] =
		supportedGroups.length > 0 && supportedGroups.length === contextGroups.length
			? 'sufficient'
			: 'insufficient_samples';
	for (const dimension of ['daylight', 'timeOfDay'] as const) {
		const groups = supportedGroups.filter((group) => group.dimension === dimension);
		if (
			groups.length >= 2 &&
			Math.max(...groups.map((group) => group.medianLux)) -
				Math.min(...groups.map((group) => group.medianLux)) >
				Math.max(10, estimate * 0.5)
		) {
			hasConflict = true;
		}
	}

	return {contextGroups, contextGrouping, hasConflict};
};

/**
 Pure advisory estimator. interaction_supported requires independent interaction evidence.
 The REST collector cannot attest this and never constructs that provenance value.
 */
export const estimateLightingPreference = (episodes: LightingEpisode[]): LearningEstimate => {
	const reliable = episodes.filter(
		(episode) => episode.independent && episode.provenance === 'interaction_supported',
	);
	const usable = reliable.filter(
		(episode) => episode.lux !== undefined && Number.isFinite(episode.lux) && episode.lux >= 0,
	);
	const result: LearningEstimate = {
		assessment: 'insufficient_reliable_events',
		reason: 'minimum_independent_evidence_not_met',
		reliableEpisodes: reliable.length,
		independentDays: days(usable),
		supportingSamples: usable.length,
		outlierSamples: 0,
		contextGroups: [],
		contextGrouping: 'insufficient_samples',
	};
	if (episodes.length === 0) {
		return {...result, assessment: 'insufficient_history', reason: 'no_usable_off_to_on_episodes'};
	}

	if (reliable.length < LEARNING_REQUIREMENTS.minEpisodes) {
		const isAmbiguous = episodes.some((episode) =>
			[
				'unknown_origin',
				'user_attributed_origin_unverified',
				'external_context_attributed',
			].includes(episode.provenance),
		);
		return {
			...result,
			assessment: isAmbiguous ? 'ambiguous_event_provenance' : 'insufficient_reliable_events',
			reason: isAmbiguous ? 'direct_user_interaction_not_established' : result.reason,
		};
	}

	if (
		usable.length < LEARNING_REQUIREMENTS.minEpisodes ||
		days(usable) < LEARNING_REQUIREMENTS.minDays
	) {
		return {
			...result,
			assessment:
				usable.length < reliable.length
					? 'insufficient_sensor_coverage'
					: 'insufficient_reliable_events',
			reason:
				usable.length < reliable.length
					? 'fresh_pre_event_lux_insufficient'
					: 'minimum_independent_days_not_met',
		};
	}

	const values = usable.map((episode) => episode.lux!);
	const q1 = quantile(values, 0.25);
	const q3 = quantile(values, 0.75);
	const iqr = q3 - q1;
	const fenceWidth = 1.5 * iqr;
	const lowerFence = q1 - fenceWidth;
	const upperFence = q3 + fenceWidth;
	const filtered = usable.filter(
		(episode) => episode.lux! >= lowerFence && episode.lux! <= upperFence,
	);
	result.outlierSamples = usable.length - filtered.length;
	result.supportingSamples = filtered.length;
	result.independentDays = days(filtered);
	if (
		result.outlierSamples > usable.length / 5 ||
		filtered.length < LEARNING_REQUIREMENTS.minEpisodes ||
		days(filtered) < LEARNING_REQUIREMENTS.minDays
	) {
		return {
			...result,
			assessment: 'unstable_preference',
			reason: 'outliers_or_remaining_evidence_insufficient',
		};
	}

	const daily = new Map<string, number[]>();
	for (const episode of filtered) {
		const readings = daily.get(episode.context.localDate) ?? [];
		readings.push(episode.lux!);
		daily.set(episode.context.localDate, readings);
	}

	const dailyMedians = Array.from(daily.values(), (readings) => quantile(readings, 0.5));
	const estimate = quantile(dailyMedians, 0.5);
	const contextual = assessContext(usable, estimate);
	result.contextGroups = contextual.contextGroups;
	result.contextGrouping = contextual.contextGrouping;
	if (contextual.hasConflict) {
		return {...result, assessment: 'unstable_preference', reason: 'contextual_patterns_differ'};
	}

	if (
		iqr > Math.max(10, estimate * 0.5) ||
		Math.max(...dailyMedians) - Math.min(...dailyMedians) > Math.max(15, estimate * 0.75)
	) {
		return {
			...result,
			assessment: 'unstable_preference',
			reason: 'wide_or_day_dependent_distribution',
		};
	}

	return {
		...result,
		assessment: 'suggestion_available',
		reason: 'stable_historical_estimate_not_an_active_threshold',
		estimatedLux: Math.round(estimate * 10) / 10,
		interquartileRangeLux: iqr,
	};
};
