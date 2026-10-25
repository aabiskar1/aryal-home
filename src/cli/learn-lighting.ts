import {redactAuditText} from '../audit/presentation.js';
import {
	analyseLightingHistory,
	type LearningOptions,
	type LearningReport,
} from '../lighting-learning/analysis.js';

const help = [
	'Usage: npm run learn-lighting -- --area "Example Room" [--days 10] [--json]',
	'Explicit read-only, advisory history analysis. No model, services, policy writes, or preference activation.',
	'--area: exact HA registry area name or alias; required.',
	'--days: integer from 1 to 30; default 10; rolling 24-hour periods.',
	'--json: aggregate structured report; no raw history or entity/user identifiers.',
	'--help: show help without HA access.',
	'Recorder retention/exclusions may limit history. Account attribution does not prove direct human interaction.',
].join('\n');

export const formatLearningReport = (report: LearningReport, isJson: boolean): string => {
	const {redactions = [], ...publicReport} = report;
	const safe = JSON.parse(
		JSON.stringify(publicReport, (_key, value: unknown) =>
			typeof value === 'string' ? redactAuditText(value, redactions) : value,
		),
	) as Omit<LearningReport, 'redactions'>;
	if (isJson) {
		return JSON.stringify(safe, undefined, 2);
	}

	return [
		`${safe.area} lighting preference`,
		`Illuminance sensors: ${safe.sensors}; permitted lights: ${safe.lights}; known aggregates: ${safe.aggregateLights}`,
		`Requested window: ${safe.daysRequested} days; days with historical updates: ${safe.history.daysWithRecords}`,
		`Descriptive light-on events: ${safe.events.episodes}; with fresh pre-event lux: ${safe.events.withFreshLux}`,
		`Independence established: ${safe.events.independent}; event attribution: ${JSON.stringify(safe.events.provenance)}`,
		`Qualifying interaction-supported events: ${safe.estimate?.reliableEpisodes ?? 0}; independent supporting days: ${safe.estimate?.independentDays ?? 0}`,
		...(safe.estimate?.estimatedLux === undefined
			? []
			: [
					`Estimated historical lights-on level: approximately ${safe.estimate.estimatedLux} lx (advisory only)`,
				]),
		`Assessment: ${safe.assessment}`,
		`Reason: ${safe.reason}`,
		...(safe.assessment === 'ambiguous_event_provenance'
			? [
					'Unable to estimate reliably: these APIs did not establish direct human interaction. Account attribution alone is insufficient.',
				]
			: []),
		...(safe.history.missingSeries > 0
			? [
					'Some requested entities have no history. Recorder exclusions or retention may be responsible; the cause cannot be determined from this response.',
				]
			: []),
		`Context: HA timezone ${safe.context.timezoneAvailable ? 'available' : 'unavailable'}; solar ${safe.context.solar}; historical weather not collected.`,
		`Daylight episodes: ${JSON.stringify(safe.context.daylightCounts)}; contextual comparison: ${safe.estimate?.contextGrouping ?? 'insufficient_samples'}`,
		'Limitations: Recorder retention/exclusions unverified; account attribution is not proof of human interaction; current configured location/timezone assumed applicable historically.',
		'Status: no preference activated. No Home Assistant writes.',
	].join('\n');
};

export const runLearnLightingCli = async (
	args: readonly string[],
	analyse: (options: LearningOptions) => Promise<LearningReport> = analyseLightingHistory,
): Promise<{exitCode: 0 | 1 | 2; output: string}> => {
	if (args.length === 1 && args[0] === '--help') {
		return {exitCode: 0, output: help};
	}

	let area: string | undefined;
	let days = 10;
	let isJson = false;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]!;
		if (seen.has(flag) || !['--area', '--days', '--json'].includes(flag)) {
			return {exitCode: 2, output: help};
		}

		seen.add(flag);
		if (flag === '--json') {
			isJson = true;
		} else {
			const value = args[++index];
			if (value === undefined || value.startsWith('--')) {
				return {exitCode: 2, output: help};
			}

			if (flag === '--area') {
				area = value.trim();
			} else if (/^\d+$/v.test(value)) {
				days = Number(value);
			} else {
				return {exitCode: 2, output: help};
			}
		}
	}

	if (
		area === undefined ||
		area.length === 0 ||
		area.length > 120 ||
		!Number.isSafeInteger(days) ||
		days < 1 ||
		days > 30
	) {
		return {exitCode: 2, output: help};
	}

	try {
		const report = await analyse({area, days});
		return {exitCode: 0, output: formatLearningReport(report, isJson)};
	} catch {
		return {
			exitCode: 1,
			output: JSON.stringify({
				assessment: 'analysis_failed',
				reason: 'ha_history_config_or_policy_unavailable_or_invalid',
				status: 'not_activated',
			}),
		};
	}
};
