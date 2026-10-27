import {z} from 'zod';
import {collectAuditData} from '../audit/collection.js';
import {redactAuditText} from '../audit/presentation.js';
import {createHistoryClient} from '../home-assistant/history-client.js';
import type {LearningLocation} from '../home-assistant/history-schemas.js';
import {readThresholdPreferences} from '../lighting-thresholds/preferences.js';
import {selectAssessmentContext} from '../assessment/context.js';
import {selectEnvironmentContext} from '../assessment/environment-context.js';
import {assessContext} from '../assessment/pipeline.js';
import type {OllamaChatTransport} from '../ollama/client.js';

export type AssessmentDependencies = {
	collect: typeof collectAuditData;
	read: typeof readThresholdPreferences;
	location: () => Promise<LearningLocation>;
	chat: OllamaChatTransport;
	config: () => {model: string; maxRequestBytes: number};
	now: () => number;
};
const dependencies: AssessmentDependencies = {
	collect: collectAuditData,
	read: readThresholdPreferences,
	now: () => Date.now(),
	async location() {
		const env = z.object({HA_URL: z.url(), HA_TOKEN: z.string().min(1)}).parse(process.env);
		return createHistoryClient(env.HA_URL, env.HA_TOKEN).config();
	},
	async chat(request) {
		// Lazy loading keeps --help and argument validation independent of HA/model configuration.
		const {requestOllamaChat} = await import('../ollama/client.js');
		return requestOllamaChat(request);
	},
	config() {
		const env = z
			.object({
				OLLAMA_MODEL: z.string().min(1).max(120).default('gemma4:e2b'),
				PLANNING_REQUEST_MAX_BYTES: z.coerce.number().int().min(8192).default(24_576),
			})
			.parse(process.env);
		return {model: env.OLLAMA_MODEL, maxRequestBytes: env.PLANNING_REQUEST_MAX_BYTES};
	},
};
const help =
	'Usage: npm run assess-home -- --area "Example Room" [--goal lighting_comfort|environment_comfort]\nExplicit read-only assessment; default lighting_comfort. No instructions, device control, approvals or preference changes.';

export const runAssessmentCli = async (
	args: readonly string[],
	deps: AssessmentDependencies = dependencies,
): Promise<{exitCode: number; output: string}> => {
	if (args.length === 1 && args[0] === '--help') {
		return {exitCode: 0, output: help};
	}

	if (args.length !== 2 && args.length !== 4) {
		return {exitCode: 2, output: help};
	}

	const flags = new Map<string, string>();

	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index]!;
		const value = args[index + 1]!;
		if (!['--area', '--goal'].includes(flag) || flags.has(flag) || value.startsWith('--')) {
			return {exitCode: 2, output: help};
		}

		flags.set(flag, value);
	}

	const area = z.string().trim().min(1).max(120).safeParse(flags.get('--area'));
	const goal = z
		.enum(['lighting_comfort', 'environment_comfort'])
		.safeParse(flags.get('--goal') ?? 'lighting_comfort');
	if (!area.success || !goal.success) {
		return {exitCode: 2, output: help};
	}

	try {
		const data = await deps.collect();
		const capturedAt = deps.now();
		const preferences = goal.data === 'lighting_comfort' ? await deps.read() : undefined;
		let location: LearningLocation | undefined;
		try {
			location = await deps.location();
		} catch {
			// Local time/daylight are optional context, never replacements for required lux.
		}

		const selected =
			goal.data === 'environment_comfort'
				? selectEnvironmentContext({data, area: area.data, location, now: capturedAt})
				: selectAssessmentContext({
						data,
						area: area.data,
						preferences: preferences!.preferences,
						location,
						now: capturedAt,
					});
		const result = await assessContext({
			selected,
			chat: deps.chat,
			...deps.config(),
			now: deps.now,
		});
		return {
			exitCode:
				result.validation === 'accepted' && result.outcome !== 'insufficient_context' ? 0 : 1,
			output: JSON.stringify(
				{context: selected.context, decision: result},
				(_key, value: unknown) =>
					typeof value === 'string' ? redactAuditText(value, data.redactions) : value,
				2,
			),
		};
	} catch {
		return {
			exitCode: 1,
			output: JSON.stringify({
				outcome: 'insufficient_context',
				issues: ['context_unavailable_or_invalid'],
				model: 'not_called',
				executionAuthority: 'none',
			}),
		};
	}
};
