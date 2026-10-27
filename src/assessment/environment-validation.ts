import {MAX_MEASUREMENT_AGE_MS} from '../lighting-thresholds/evaluation.js';
import {evidenceStatus} from './context.js';
import {environmentPresenceFrom} from './environment-values.js';
import {indoorReportingFreshness, weatherUpdateFreshness} from './environment-freshness.js';
import type {EnvironmentContext, EnvironmentProposal} from './environment-schemas.js';

const indoorProfile = (
	context: EnvironmentContext,
	deviceClass: 'temperature' | 'humidity',
	now: number,
) => {
	const items = context.observations.filter((item) => item.deviceClass === deviceClass);
	const refs = items.map((item) => item.ref);
	if (items.length === 0) {
		return {status: 'missing' as const, value: undefined, refs};
	}

	const recency = new Set(
		items.map((item) =>
			item.status === 'available'
				? indoorReportingFreshness(item, context.reportingPolicy, now)
				: 'unavailable_or_invalid',
		),
	);
	if (recency.has('unavailable_or_invalid')) {
		return {status: 'unusable' as const, value: undefined, refs};
	}

	if (
		recency.has('last_known_unverified') ||
		items.some((item) => item.freshness !== 'recently_reported')
	) {
		return {status: 'last_known_unverified' as const, value: undefined, refs};
	}

	const values = new Set(items.map((item) => item.value));
	if (values.size !== 1) {
		return {status: 'conflicting' as const, value: undefined, refs};
	}

	return {status: 'available' as const, value: items[0]!.value as number, refs};
};

/** Shared preflight/post-model facts: comparisons are not comfort preferences. */
export const evaluateEnvironmentEvidence = (context: EnvironmentContext, now: number) => {
	const issues: string[] = [];
	const age = now - Date.parse(context.capturedAt);
	if (!Number.isFinite(age) || age < 0 || age > MAX_MEASUREMENT_AGE_MS) {
		issues.push('stale_snapshot');
	}

	const weather = context.outdoorWeather;
	const weatherRecency = weatherUpdateFreshness(weather, context.reportingPolicy, now);
	const isWeatherFresh = weather.status === 'available' && weatherRecency === 'available';
	if (!isWeatherFresh) {
		issues.push(
			weather.status === 'available' ? `weather_${weatherRecency}` : `weather_${weather.status}`,
		);
	}

	const temperature = indoorProfile(context, 'temperature', now);
	const humidity = indoorProfile(context, 'humidity', now);
	if (temperature.status !== 'available' && humidity.status !== 'available') {
		issues.push('missing_or_unusable_indoor_environment');
	}

	const limitations = [
		temperature.status === 'available' ? undefined : `indoor_temperature_${temperature.status}`,
		humidity.status === 'available' ? undefined : `indoor_humidity_${humidity.status}`,
		weather.temperature.status === 'available'
			? undefined
			: `outdoor_temperature_${weather.temperature.status}`,
		weather.humidity.status === 'available'
			? undefined
			: `outdoor_humidity_${weather.humidity.status}`,
	].filter((value): value is string => value !== undefined);
	return {
		issues,
		limitations,
		temperature,
		humidity,
		isWeatherFresh,
		presence: environmentPresenceFrom(context.observations, now),
	};
};

const temperatureComparison = (
	context: EnvironmentContext,
	evidence: ReturnType<typeof evaluateEnvironmentEvidence>,
) => {
	const outdoor = context.outdoorWeather.temperature;
	if (
		!evidence.isWeatherFresh ||
		evidence.temperature.value === undefined ||
		outdoor.status !== 'available' ||
		outdoor.value === null
	) {
		return 'not_compared';
	}

	const delta = Number((evidence.temperature.value - outdoor.value).toFixed(6));
	return Math.abs(delta) <= context.comparisonPolicy.temperatureDeltaC
		? 'similar'
		: delta > 0
			? 'indoor_warmer'
			: 'indoor_cooler';
};

const humidityComparison = (
	context: EnvironmentContext,
	evidence: ReturnType<typeof evaluateEnvironmentEvidence>,
) => {
	const outdoor = context.outdoorWeather.humidity;
	if (
		!evidence.isWeatherFresh ||
		evidence.humidity.value === undefined ||
		outdoor.status !== 'available' ||
		outdoor.value === null
	) {
		return 'not_compared';
	}

	const delta = Number((evidence.humidity.value - outdoor.value).toFixed(6));
	return Math.abs(delta) <= context.comparisonPolicy.humidityDeltaPercent
		? 'similar'
		: delta > 0
			? 'indoor_higher'
			: 'indoor_lower';
};

type InsightProposal = Extract<EnvironmentProposal, {evidenceRefs: string[]}>;
const availableReferences = (
	context: EnvironmentContext,
	evidence: ReturnType<typeof evaluateEnvironmentEvidence>,
	now: number,
) => {
	const allowed = new Set<string>();
	for (const profile of [evidence.temperature, evidence.humidity]) {
		if (profile.status === 'available') {
			for (const ref of profile.refs) {
				allowed.add(ref);
			}
		}
	}

	for (const item of context.observations) {
		if (
			(item.deviceClass === 'occupancy' || item.deviceClass === 'presence') &&
			item.status === 'available' &&
			evidenceStatus(item.lastChangedAt, item.updatedAt, now) === 'available'
		) {
			allowed.add(item.ref);
		}
	}

	if (evidence.isWeatherFresh) {
		allowed.add('weather_1');
		for (const item of [context.outdoorWeather.temperature, context.outdoorWeather.humidity]) {
			if (item.status === 'available') {
				allowed.add(item.ref);
			}
		}
	}

	return allowed;
};

const validateReferences = (
	context: EnvironmentContext,
	evidence: ReturnType<typeof evaluateEnvironmentEvidence>,
	proposal: InsightProposal,
	now: number,
): string[] => {
	const allowed = availableReferences(context, evidence, now);
	const refs = new Set(proposal.evidenceRefs);
	const issues: string[] = [];
	if (refs.size !== proposal.evidenceRefs.length) {
		issues.push('duplicate_evidence_reference');
	}

	if (proposal.evidenceRefs.some((ref) => !allowed.has(ref))) {
		issues.push('unsupported_evidence_reference');
	}

	const hasIndoor = [evidence.temperature, evidence.humidity].some(
		(profile) => profile.status === 'available' && profile.refs.every((ref) => refs.has(ref)),
	);
	if (!refs.has('weather_1') || !hasIndoor) {
		issues.push('missing_multi_source_support');
	}

	if (
		proposal.temperatureRelation !== 'not_compared' &&
		(!refs.has('outdoor_temperature') ||
			evidence.temperature.refs.length === 0 ||
			evidence.temperature.refs.some((ref) => !refs.has(ref)))
	) {
		issues.push('missing_temperature_support');
	}

	if (
		proposal.humidityRelation !== 'not_compared' &&
		(!refs.has('outdoor_humidity') ||
			evidence.humidity.refs.length === 0 ||
			evidence.humidity.refs.some((ref) => !refs.has(ref)))
	) {
		issues.push('missing_humidity_support');
	}

	return issues;
};

const checkInsight = (
	context: EnvironmentContext,
	evidence: ReturnType<typeof evaluateEnvironmentEvidence>,
	proposal: InsightProposal,
	now: number,
) => {
	const issues = validateReferences(context, evidence, proposal, now);
	if (proposal.weatherCondition !== context.outdoorWeather.condition) {
		issues.push('weather_claim_mismatch');
	}

	if (
		proposal.temperatureRelation !== 'not_compared' &&
		proposal.temperatureRelation !== temperatureComparison(context, evidence)
	) {
		issues.push('unsupported_temperature_claim');
	}

	if (
		proposal.humidityRelation !== 'not_compared' &&
		proposal.humidityRelation !== humidityComparison(context, evidence)
	) {
		issues.push('unsupported_humidity_claim');
	}

	if (
		proposal.category === 'temperature_comparison' &&
		proposal.temperatureRelation === 'not_compared'
	) {
		issues.push('category_requires_temperature_comparison');
	}

	if (proposal.category === 'humidity_comparison' && proposal.humidityRelation === 'not_compared') {
		issues.push('category_requires_humidity_comparison');
	}

	const isBenignWeather = ['sunny', 'clear-night', 'cloudy', 'partlycloudy'].includes(
		proposal.weatherCondition,
	);
	if (proposal.category === 'ventilation_review' || proposal.category === 'weather_caution') {
		if (proposal.temperatureRelation !== 'indoor_warmer') {
			issues.push('category_requires_warmer_indoors');
		}

		if ((proposal.category === 'ventilation_review') !== isBenignWeather) {
			issues.push('weather_category_contradiction');
		}
	}

	return issues;
};

const summaryFor = (proposal: InsightProposal) => {
	const temperatureWords = {
		indoor_warmer:
			'The recently reported indoor temperature is higher than the reported outdoor temperature',
		indoor_cooler:
			'The recently reported indoor temperature is lower than the reported outdoor temperature',
		similar: 'Recently reported indoor and outdoor temperature values are similar',
		not_compared: 'Temperature was not compared',
	};
	const humidityWords = {
		indoor_higher:
			'The recently reported indoor relative humidity value is higher than the reported outdoor value',
		indoor_lower:
			'The recently reported indoor relative humidity value is lower than the reported outdoor value',
		similar: 'Recently reported indoor and outdoor relative humidity values are similar',
		not_compared: 'Relative humidity was not compared',
	};
	const summaries = {
		temperature_comparison: `${temperatureWords[proposal.temperatureRelation]}. The similar band is an advisory comparison tolerance, not a comfort preference.`,
		humidity_comparison: `${humidityWords[proposal.humidityRelation]}. Relative humidity alone does not prove whether ventilation would reduce moisture.`,
		weather_caution:
			'Reported indoor temperature is higher than reported outdoors, but weather reports warrant checking outdoor and window safety before considering ventilation.',
		ventilation_review:
			'Reported indoor temperature is higher than reported outdoors. Review whether outdoor air could help cooling; actual measurement ages, window safety, outdoor air quality, preferences and intent are not established.',
		comfort_preferences_review:
			'Recently reported indoor values and weather are available, but comfort preferences are unknown. Review preferences before judging conditions as comfortable or uncomfortable.',
	};
	return `Recent Home Assistant activity supports this advisory assessment; physical measurement ages remain unknown. ${summaries[proposal.category]} Reported weather: ${proposal.weatherCondition}. Presence: ${proposal.presence}; presence does not establish user intent.`;
};

export const validateEnvironmentAssessment = (
	context: EnvironmentContext,
	proposal: EnvironmentProposal,
	now: number,
) => {
	const evidence = evaluateEnvironmentEvidence(context, now);
	const issues = [...evidence.issues];
	if (proposal.presence !== evidence.presence) {
		issues.push('presence_mismatch');
	}

	const isInsight = proposal.outcome === 'insight' || proposal.outcome === 'recommend_review';
	if (isInsight) {
		issues.push(...checkInsight(context, evidence, proposal, now));
	}

	return {
		outcome: issues.length > 0 ? ('insufficient_context' as const) : proposal.outcome,
		validation: issues.length === 0 ? ('accepted' as const) : ('rejected' as const),
		issues: [...new Set(issues)],
		limitations: evidence.limitations,
		presence: evidence.presence,
		executionAuthority: 'none' as const,
		evidenceSemantics: 'recent_home_assistant_activity_not_verified_physical_measurements' as const,
		recommendations: [],
		insights:
			!isInsight || issues.length > 0
				? []
				: [
						{
							kind: proposal.outcome === 'insight' ? 'environment_insight' : 'environment_review',
							category: proposal.category,
							evidenceRefs: proposal.evidenceRefs,
							temperatureRelation: proposal.temperatureRelation,
							humidityRelation: proposal.humidityRelation,
							weatherCondition: proposal.weatherCondition,
							summary: summaryFor(proposal),
							requiresAdditionalContext:
								proposal.outcome === 'recommend_review'
									? proposal.category === 'ventilation_review'
										? ['window_safety', 'outdoor_air_quality', 'comfort_preferences', 'user_intent']
										: ['comfort_preferences', 'user_intent']
									: [],
						},
					],
	};
};
