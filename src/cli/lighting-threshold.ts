import {createInterface} from 'node:readline/promises';
import {z} from 'zod';
import {collectAuditData} from '../audit/collection.js';
import {redactAuditText} from '../audit/presentation.js';
import {createHistoryClient} from '../home-assistant/history-client.js';
import {PRACTICAL_DARKNESS_LUX, thresholdLuxSchema} from '../lighting-thresholds/evaluation.js';
import {
	readThresholdPreferences,
	changeThresholdPreference,
} from '../lighting-thresholds/preferences.js';
import {
	buildThresholdReport,
	type ThresholdReport,
	type ThresholdReadDependencies,
} from '../lighting-thresholds/recommendation.js';
import {resolveThresholdRoom} from '../lighting-thresholds/room.js';

const help = [
	'Usage: npm run lighting-threshold -- --area "Example Room" --suggest [--starting-lux 40] [--days 3] [--json]',
	'       npm run lighting-threshold -- --area "Example Room" --show [--json]',
	'       npm run lighting-threshold -- --area "Example Room" --set 40',
	'       npm run lighting-threshold -- --area "Example Room" --reset',
	'Thresholds: finite 1-1000 lx; default practical starting point 40 lx, not a universal standard or learned preference.',
	'--days: 1-10, default 3. History only checks the suggested starting point; it never silently adjusts it.',
	'--set/--reset require interactive terminals and explicit confirmation; no --yes bypass.',
	'Preferences remain disconnected from planning and execution. No HA writes. --help needs no HA access.',
].join('\n');

type Options = {
	area: string;
	mode: 'suggest' | 'show' | 'set' | 'reset';
	thresholdLux: number | undefined;
	startingLux: number;
	days: number;
	isJson: boolean;
};
const parseOptions = (args: readonly string[]): Options => {
	const flags = new Map<string, string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]!;
		if (
			flags.has(flag) ||
			![
				'--area',
				'--suggest',
				'--show',
				'--set',
				'--reset',
				'--starting-lux',
				'--days',
				'--json',
			].includes(flag)
		) {
			throw new Error('Invalid arguments.');
		}

		const isNeedsValue = ['--area', '--set', '--starting-lux', '--days'].includes(flag);
		const value = isNeedsValue ? args[++index] : '';
		if (value === undefined || value.startsWith('--')) {
			throw new Error('Missing argument.');
		}

		flags.set(flag, value);
	}

	const modes = ['suggest', 'show', 'set', 'reset'] as const;
	const selected = modes.filter((mode) => flags.has(`--${mode}`));
	const area = flags.get('--area')?.trim();
	if (selected.length !== 1 || area === undefined || area.length === 0 || area.length > 120) {
		throw new Error('Require one room and operation.');
	}

	const mode = selected[0]!;
	if (
		(mode !== 'suggest' && (flags.has('--days') || flags.has('--starting-lux'))) ||
		(['set', 'reset'].includes(mode) && flags.has('--json'))
	) {
		throw new Error('Options incompatible with the operation.');
	}

	const numeric = (flag: string, fallback: number): number => {
		const text = flags.get(flag);
		if (text !== undefined && !/^\d+(?:\.\d+)?$/v.test(text)) {
			throw new Error('Invalid numeric argument.');
		}

		return text === undefined ? fallback : Number(text);
	};

	const days = z.number().int().min(1).max(10).parse(numeric('--days', 3));
	return {
		area,
		mode,
		days,
		thresholdLux: mode === 'set' ? thresholdLuxSchema.parse(numeric('--set', 0)) : undefined,
		startingLux: thresholdLuxSchema.parse(numeric('--starting-lux', PRACTICAL_DARKNESS_LUX)),
		isJson: flags.has('--json'),
	};
};

export type ThresholdDependencies = ThresholdReadDependencies & {
	read: typeof readThresholdPreferences;
	change: typeof changeThresholdPreference;
};
export type ThresholdInteraction = {
	interactive: boolean;
	confirm: (prompt: string) => Promise<boolean>;
};
const dependencies: ThresholdDependencies = {
	collect: collectAuditData,
	now: () => Date.now(),
	read: readThresholdPreferences,
	change: changeThresholdPreference,
	client() {
		const env = z.object({HA_URL: z.url(), HA_TOKEN: z.string().min(1)}).parse(process.env);
		return createHistoryClient(env.HA_URL, env.HA_TOKEN);
	},
};
const interaction: ThresholdInteraction = {
	interactive: process.stdin.isTTY && process.stdout.isTTY,
	async confirm(prompt) {
		const reader = createInterface({input: process.stdin, output: process.stdout});
		const controller = new AbortController();
		const interrupt = () => {
			controller.abort();
		};

		reader.once('SIGINT', interrupt);
		reader.once('close', interrupt);
		try {
			const answer = await reader.question(prompt, {signal: controller.signal});
			return ['y', 'yes'].includes(answer.trim().toLowerCase());
		} catch {
			return false;
		} finally {
			reader.close();
		}
	},
};

export const presentThresholdReport = (
	report: ThresholdReport,
	isJson: boolean,
	redactions: readonly string[],
): string => {
	const safe = JSON.parse(
		JSON.stringify(report, (_key, value: unknown) =>
			typeof value === 'string' ? redactAuditText(value, redactions) : value,
		),
	) as ThresholdReport;
	if (isJson) {
		return JSON.stringify(safe, undefined, 2);
	}

	return [
		`${safe.area} darkness threshold`,
		`Configured threshold: ${safe.configuredLux === undefined ? 'not set' : `${safe.configuredLux} lx`}`,
		...(safe.suggestedLux === undefined
			? []
			: [`Suggested darkness threshold: ${safe.suggestedLux} lx`]),
		...(safe.current.assessment === 'insufficient_context'
			? [`Assessment: insufficient context (${safe.current.reason}); sensor: ${safe.sensorStatus}`]
			: [
					`Current brightness: ${safe.current.lux} lx`,
					`Assessment at ${safe.current.thresholdLux} lx: ${safe.current.assessment === 'dark' ? 'Dark' : 'Not dark'}`,
				]),
		`Source: ${{practical_starting_point_not_learned: 'Practical indoor starting point; adjustable, not a learned preference.', user_configured: 'User-configured room preference.', not_configured: 'No room preference configured.'}[safe.source]}`,
		...(safe.currentLocalTime === undefined
			? []
			: [
					`Local time: ${safe.currentLocalTime}; calculated daylight: ${safe.currentDaylight ?? 'unavailable'}`,
				]),
		...(safe.evidence === undefined
			? []
			: [
					`History check: ${safe.evidence.status}; ${safe.evidence.halfHourBins} half-hour observations across ${safe.evidence.localDays} local dates with known permitted lights off.`,
					`Historical daylight coverage: ${{unavailable: 'unavailable', limited_daylight_conditions: 'limited; the range may not represent the full day', daylight_and_night_observed: 'daylight and night sampled'}[safe.evidence.contextCoverage]}.`,
					...(safe.evidence.observedLux === undefined
						? []
						: [
								`Observed ambient range (10th-90th percentile): ${safe.evidence.observedLux.lower.toFixed(1)}-${safe.evidence.observedLux.upper.toFixed(1)} lx.`,
							]),
					'History does not establish a preferred lighting level. Sensor placement, unobserved lights and incomplete recording may affect readings.',
				]),
		'Advisory only. No connection to planning or execution. Use --set to save a value with confirmation.',
	].join('\n');
};

const changePreference = async (
	options: Options,
	deps: ThresholdDependencies,
	io: ThresholdInteraction,
): Promise<string> => {
	const data = await deps.collect();
	const room = resolveThresholdRoom(data, options.area);
	const snapshot = await deps.read();
	const current = snapshot.preferences.rooms.find(
		(preference) => preference.areaId === room.areaId,
	)?.thresholdLux;
	const next = options.mode === 'reset' ? undefined : options.thresholdLux;
	if (current === next) {
		return 'Preference already matches; no changes made.';
	}

	const preview = redactAuditText(
		`${room.area}: ${current === undefined ? 'not set' : `${current} lx`} -> ${next === undefined ? 'not set' : `${next} lx`}. Save this local advisory preference? [y/N] `,
		data.redactions,
	);
	if (!(await io.confirm(preview))) {
		return 'Declined. No preferences changed.';
	}

	await deps.change({areaId: room.areaId, thresholdLux: next}, snapshot);
	return options.mode === 'reset'
		? 'Room threshold reset. Planning and execution unchanged.'
		: `Saved ${next!} lx for this room. Planning and execution unchanged.`;
};

export const runLightingThresholdCli = async (
	args: readonly string[],
	deps: ThresholdDependencies = dependencies,
	io: ThresholdInteraction = interaction,
): Promise<{exitCode: 0 | 1 | 2; output: string}> => {
	if (args.length === 1 && args[0] === '--help') {
		return {exitCode: 0, output: help};
	}

	let options: Options;
	try {
		options = parseOptions(args);
	} catch {
		return {exitCode: 2, output: help};
	}

	if (['set', 'reset'].includes(options.mode) && !io.interactive) {
		return {
			exitCode: 2,
			output: 'Preference changes require interactive input/output and explicit confirmation.',
		};
	}

	try {
		if (options.mode === 'set' || options.mode === 'reset') {
			return {exitCode: 0, output: await changePreference(options, deps, io)};
		}

		const data = await deps.collect();
		const room = resolveThresholdRoom(data, options.area);
		const saved = await deps.read();
		const configuredLux = saved.preferences.rooms.find(
			(preference) => preference.areaId === room.areaId,
		)?.thresholdLux;
		const report = await buildThresholdReport({
			room,
			mode: options.mode,
			configuredLux,
			now: deps.now(),
			startingLux: options.startingLux,
			days: options.days,
			...(options.mode === 'suggest' && {client: deps.client()}),
		});
		return {exitCode: 0, output: presentThresholdReport(report, options.isJson, data.redactions)};
	} catch {
		return {
			exitCode: 1,
			output:
				'Threshold operation failed: room, Home Assistant or local preference data unavailable, invalid or changed. No execution authority was granted.',
		};
	}
};
