import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {env} from '../src/config/env.js';
import {loadEntityPolicy} from '../src/config/policy.js';
import {formatExecutionCliResult, runExecutionCli} from '../src/cli/execution.js';
import * as dispatcher from '../src/execution/dispatcher.js';
import {getHomeAssistantStates} from '../src/home-assistant/client.js';
import {getHomeAssistantRegistries} from '../src/home-assistant/registry-client.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {requestOllamaChat} from '../src/ollama/client.js';
import * as pipeline from '../src/planning/pipeline.js';

const http = vi.hoisted(() => {
	const get = vi.fn();
	const post = vi.fn();
	return {get, post, extend: vi.fn(() => ({get, post}))};
});
vi.mock('got', () => ({default: {extend: http.extend}}));
vi.mock('node:timers/promises', () => ({setTimeout: vi.fn().mockResolvedValue(undefined)}));
vi.mock('../src/config/env.js', () => ({
	env: {
		HA_URL: 'https://ha.example.test',
		HA_TOKEN: 'test-token-for-cli',
		OLLAMA_MODEL: 'example-model',
		PLANNING_REQUEST_MAX_BYTES: 100_000,
		DRY_RUN: false,
	},
}));
vi.mock('../src/config/policy.js', () => ({loadEntityPolicy: vi.fn()}));
vi.mock('../src/home-assistant/client.js', () => ({getHomeAssistantStates: vi.fn()}));
vi.mock('../src/home-assistant/registry-client.js', () => ({getHomeAssistantRegistries: vi.fn()}));
vi.mock('../src/ollama/client.js', () => ({requestOllamaChat: vi.fn()}));

const target = 'light.example_target';
const other = 'switch.example_other';
const instruction = 'Turn on Example Lamp';
const state = (entityId = target, value = 'off'): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {friendly_name: entityId === target ? 'Example Lamp' : 'Example Switch'},
	last_changed: '2026-10-07T00:00:00+00:00',
	last_updated: '2026-10-07T00:00:00+00:00',
});
const proposal = (entityId = target) => ({entityId, action: 'turn_on', reason: 'Example request.'});
const plan = (actions = [proposal()]) =>
	JSON.stringify({
		outcome: 'propose_actions',
		summary: 'Proposed plan: Turn on example targets.',
		actions,
	});

let executionSpy: MockInstance<typeof dispatcher.executeReadyCommands>;
let planningSpy: MockInstance<typeof pipeline.runPlanningPipeline>;
beforeEach(() => {
	vi.clearAllMocks();
	env.DRY_RUN = false;
	executionSpy = vi.spyOn(dispatcher, 'executeReadyCommands');
	planningSpy = vi.spyOn(pipeline, 'runPlanningPipeline');
	vi.mocked(getHomeAssistantStates)
		.mockReset()
		.mockResolvedValue([state(), state(other)]);
	vi.mocked(getHomeAssistantRegistries)
		.mockReset()
		.mockResolvedValue({
			status: 'available',
			entities: [target, other].map((entityId) => ({
				entity_id: entityId,
				device_id: 'example_device',
				area_id: null,
				labels: ['example_label'],
				disabled_by: null,
			})),
			devices: [{id: 'example_device', area_id: 'example_area', labels: [], disabled_by: null}],
			areas: [{area_id: 'example_area', name: 'Example Room', aliases: [], labels: []}],
			labels: [{label_id: 'example_label'}],
		});
	vi.mocked(loadEntityPolicy)
		.mockReset()
		.mockResolvedValue({
			version: 1,
			allow: [{domain: 'light'}, {domain: 'switch'}],
			deny: [],
		});
	vi.mocked(requestOllamaChat).mockReset().mockResolvedValue(plan());
	http.post.mockReset().mockResolvedValue({statusCode: 200, body: []});
	http.get.mockReset().mockImplementation(async (path: string) => ({
		statusCode: 200,
		body: state(path.slice('states/'.length), 'on'),
	}));
});
afterEach(() => vi.restoreAllMocks());

describe('execution CLI orchestration', () => {
	it('plans natural language and executes only the resulting ready commands through the production API', async () => {
		const result = await runExecutionCli(instruction);
		expect(planningSpy).toHaveBeenCalledExactlyOnceWith(
			instruction,
			expect.any(Array),
			expect.objectContaining({allowedEntityIds: new Set([target, other])}),
			{model: 'example-model', maxRequestBytes: 100_000, chat: requestOllamaChat},
		);
		expect(executionSpy).toHaveBeenCalledExactlyOnceWith(result.readiness?.commands);
		expect(result).toMatchObject({exitCode: 0, outcome: 'all_confirmed'});
		expect(result.execution?.results[0]).toMatchObject({
			outcome: 'confirmed',
			command: {target: {entity_id: target}, service: 'turn_on'},
		});
		expect(getHomeAssistantStates).toHaveBeenCalledTimes(2);
		expect(loadEntityPolicy).toHaveBeenCalledTimes(2);
		expect(http.post).toHaveBeenCalledExactlyOnceWith('services/light/turn_on', {
			json: {entity_id: target},
			responseType: 'json',
		});
	});

	it('lets planning run under DRY_RUN=true but makes no POST or confirmation read', async () => {
		env.DRY_RUN = true;
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({exitCode: 3, outcome: 'execution_disabled', reason: 'dry_run'});
		expect(result.readiness?.outcome).toBe('ready');
		expect(executionSpy).toHaveBeenCalledTimes(1);
		expect(getHomeAssistantStates).toHaveBeenCalledTimes(1);
		expect(loadEntityPolicy).toHaveBeenCalledTimes(1);
		expect(http.post).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
		expect(formatExecutionCliResult(result)).toContain('Execution is disabled by configuration');
	});

	it.each([true, false])(
		'returns valid model no_action without execution under DRY_RUN=%s',
		async (dryRun) => {
			env.DRY_RUN = dryRun;
			vi.mocked(requestOllamaChat).mockResolvedValue(
				JSON.stringify({
					outcome: 'no_action',
					summary: 'Proposed plan: No change needed.',
					actions: [],
				}),
			);
			const result = await runExecutionCli(instruction);
			expect(result).toMatchObject({exitCode: 0, outcome: 'no_action'});
			expect(executionSpy).not.toHaveBeenCalled();
			expect(http.post).not.toHaveBeenCalled();
		},
	);

	it('skips execution when deterministic selection finds insufficient context', async () => {
		const result = await runExecutionCli('Turn on light.example_missing');
		expect(result).toMatchObject({exitCode: 1, outcome: 'insufficient_context'});
		expect(executionSpy).not.toHaveBeenCalled();
		expect(requestOllamaChat).not.toHaveBeenCalled();
		expect(http.post).not.toHaveBeenCalled();
	});

	it('skips execution for model insufficient_context', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(
			JSON.stringify({
				outcome: 'insufficient_context',
				summary: 'Proposed plan: More context is required.',
				actions: [],
			}),
		);
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'insufficient_context'});
		expect(executionSpy).not.toHaveBeenCalled();
	});

	it('distinguishes all post-model rejections from model no_action', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(plan([proposal('light.example_missing')]));
		const result = await runExecutionCli(instruction);
		expect(result.planning?.outcome).toBe('no_action');
		expect(result.planning?.rejectedActions[0]).toMatchObject({
			entityId: 'light.example_missing',
			reason: 'not_allowed',
		});
		expect(result).toMatchObject({exitCode: 1, outcome: 'rejected'});
		expect(executionSpy).not.toHaveBeenCalled();
	});

	it.each(['duplicate', 'no_op'])(
		'skips execution when readiness rejects all actions as %s',
		async (kind) => {
			if (kind === 'duplicate') {
				vi.mocked(requestOllamaChat).mockResolvedValue(plan([proposal(), proposal()]));
			} else {
				vi.mocked(getHomeAssistantStates).mockResolvedValue([state(target, 'on')]);
			}

			const result = await runExecutionCli(instruction);
			expect(result).toMatchObject({
				exitCode: 1,
				outcome: 'rejected',
				readiness: {outcome: 'rejected', commands: []},
			});
			expect(executionSpy).not.toHaveBeenCalled();
			expect(http.post).not.toHaveBeenCalled();
		},
	);

	it('reports partial batch success as unsuccessful exit', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(plan([proposal(), proposal(other)]));
		http.post.mockResolvedValueOnce({statusCode: 500, body: []});
		const result = await runExecutionCli(`Turn on ${target} and ${other}`);
		expect(result).toMatchObject({
			exitCode: 1,
			outcome: 'partial_success',
			execution: {outcome: 'partial_success'},
		});
	});

	it('does not report full success when earlier proposals were rejected', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(
			plan([proposal(), proposal('light.example_missing')]),
		);
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({
			exitCode: 1,
			outcome: 'partial_success',
			reason: 'earlier_proposals_rejected',
			execution: {outcome: 'all_confirmed'},
		});
	});
	it('reports partial success when readiness rejects some proposals', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(plan([proposal(), proposal(), proposal(other)]));
		const result = await runExecutionCli(`Turn on ${target} and ${other}`);
		expect(result).toMatchObject({
			exitCode: 1,
			outcome: 'partial_success',
			execution: {outcome: 'all_confirmed'},
		});
		expect(result.readiness?.rejectedActions).toHaveLength(2);
		expect(http.post).toHaveBeenCalledExactlyOnceWith('services/switch/turn_on', {
			json: {entity_id: other},
			responseType: 'json',
		});
	});

	it('reports freshly denied targets as skipped with a nonzero exit', async () => {
		vi.mocked(loadEntityPolicy)
			.mockResolvedValueOnce({version: 1, allow: [{domain: 'light'}], deny: []})
			.mockResolvedValue({version: 1, allow: [{domain: 'light'}], deny: [{entityId: target}]});
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'no_authorized_commands'});
		expect(result.execution?.results[0]).toMatchObject({
			outcome: 'skipped_not_authorized',
			entityId: target,
			reason: 'denied',
		});
		expect(http.post).not.toHaveBeenCalled();
	});

	it('reports all failed dispatches with a nonzero exit and sanitized diagnostics', async () => {
		http.post.mockRejectedValue(new Error(`RAW_RESPONSE_BODY ${env.HA_TOKEN}`));
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'all_failed'});
		expect(formatExecutionCliResult(result)).not.toContain('RAW_RESPONSE_BODY');
		expect(formatExecutionCliResult(result)).not.toContain(env.HA_TOKEN);
	});

	it('rejects failed confirmation with nonzero exit', async () => {
		http.get.mockResolvedValue({statusCode: 404, body: {message: 'RAW_RESPONSE_BODY'}});
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'all_failed'});
		expect(result.execution?.results[0]).toMatchObject({
			outcome: 'confirmation_failed',
			reason: 'target_missing',
		});
	});

	it.each([
		'',
		' '.repeat(3),
		'--domain light --service turn_on --target light.example_target',
		'Turn on Example Lamp --service turn_on',
		'{"domain":"light","service":"turn_on","entity_id":"light.example_target"}',
		'[{"service":"turn_on"}]',
	])('rejects empty or routing input %j before reads and planning', async (input) => {
		const result = await runExecutionCli(input);
		expect(result).toMatchObject({exitCode: 2, outcome: 'invalid_instruction'});
		expect(getHomeAssistantStates).not.toHaveBeenCalled();
		expect(planningSpy).not.toHaveBeenCalled();
		expect(executionSpy).not.toHaveBeenCalled();
		expect(formatExecutionCliResult(result)).toContain('natural-language instruction only');
	});

	it('omits model prose and registry metadata, and redacts credentials in instruction output', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(
			JSON.stringify({
				outcome: 'propose_actions',
				summary: `Proposed plan: ${env.HA_TOKEN} example_device`,
				actions: [{...proposal(), reason: `${env.HA_TOKEN} example_area example_label`}],
			}),
		);
		const result = await runExecutionCli(`${instruction} ${env.HA_TOKEN}`);
		const output = formatExecutionCliResult(result);
		expect(output).not.toContain(env.HA_TOKEN);
		expect(output).not.toContain('example_device');
		expect(output).not.toContain('example_area');
		expect(output).not.toContain('example_label');
		expect(output).toContain('[redacted]');
		expect(JSON.parse(output)).toMatchObject({
			instruction: `${instruction} [redacted]`,
			outcome: 'all_confirmed',
		});
	});
	it('does not echo non-entity model targets into rejection diagnostics', async () => {
		vi.mocked(requestOllamaChat).mockResolvedValue(plan([proposal('example_device')]));
		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'rejected'});
		expect(result.planning?.rejectedActions[0]).toEqual({action: 'turn_on', reason: 'not_allowed'});
		expect(formatExecutionCliResult(result)).not.toContain('example_device');
	});

	it.each(['state', 'model', 'execution'])('sanitizes unexpected %s errors', async (stage) => {
		const error = new Error(`RAW_ERROR ${env.HA_TOKEN}`);
		if (stage === 'state') {
			vi.mocked(getHomeAssistantStates).mockRejectedValue(error);
		} else if (stage === 'model') {
			vi.mocked(requestOllamaChat).mockRejectedValue(error);
		} else {
			executionSpy.mockRejectedValue(error);
		}

		const result = await runExecutionCli(instruction);
		expect(result).toMatchObject({
			exitCode: 1,
			outcome: 'unexpected_error',
			reason: 'operation_failed',
		});
		expect(formatExecutionCliResult(result)).not.toContain('RAW_ERROR');
		expect(formatExecutionCliResult(result)).not.toContain(env.HA_TOKEN);
	});
});

const extra = 'light.example_z_target';
const collectionInstruction = 'Turn on all Example Room lights';
const collectionPlan = () =>
	JSON.stringify({
		outcome: 'propose_actions',
		summary: 'Proposed plan: Turn on the complete permitted light set.',
		actions: [
			{
				type: 'set_action',
				action: 'turn_on',
				scope: {area: 'Example Room', domain: 'light'},
				reason: 'RAW_SET_REASON must not be printed.',
			},
		],
	});
const configureCollection = (extraState = 'off') => {
	vi.mocked(getHomeAssistantStates).mockResolvedValue([
		state(),
		state(extra, extraState),
		state(other),
	]);
	vi.mocked(getHomeAssistantRegistries).mockResolvedValue({
		status: 'available',
		entities: [target, extra, other].map((entityId) => ({
			entity_id: entityId,
			device_id: null,
			area_id: 'example_area',
			labels: [],
			disabled_by: null,
		})),
		devices: [],
		areas: [
			{area_id: 'example_area', name: 'Example Room', aliases: ['Example Alias'], labels: []},
		],
		labels: [],
	});
	vi.mocked(requestOllamaChat).mockResolvedValue(collectionPlan());
};

describe('set expansion execution and diagnostics', () => {
	it('executes expanded commands through fresh authorization and confirmation, with sanitized diagnostics', async () => {
		configureCollection();
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 0, outcome: 'all_confirmed'});
		expect(result.planning?.intentExpansion.sets[0]).toMatchObject({
			intentType: 'set_action',
			matchedCount: 2,
			expandedActions: [
				{entityId: target, action: 'turn_on'},
				{entityId: extra, action: 'turn_on'},
			],
		});
		expect(executionSpy).toHaveBeenCalledExactlyOnceWith(result.readiness?.commands);
		expect(getHomeAssistantStates).toHaveBeenCalledTimes(3);
		expect(loadEntityPolicy).toHaveBeenCalledTimes(3);
		expect(http.post).toHaveBeenCalledTimes(2);
		expect(http.post.mock.calls).toEqual([
			['services/light/turn_on', {json: {entity_id: target}, responseType: 'json'}],
			['services/light/turn_on', {json: {entity_id: extra}, responseType: 'json'}],
		]);
		expect(http.get).toHaveBeenCalledTimes(2);
		const output = formatExecutionCliResult(result);
		expect(output).not.toContain('RAW_SET_REASON');
		expect(output).not.toContain('example_area');
		expect(output).not.toContain('example_device');
	});

	it('honors DRY_RUN for every expanded member before fresh reads or any POST', async () => {
		configureCollection();
		env.DRY_RUN = true;
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 3, outcome: 'execution_disabled'});
		expect(result.readiness?.commands).toHaveLength(2);
		expect(http.post).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
		expect(getHomeAssistantStates).toHaveBeenCalledTimes(1);
	});

	it('allows set no-ops without dropping remaining executable members or implying partial failure', async () => {
		configureCollection('on');
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 0, outcome: 'all_confirmed'});
		expect(result.planning?.intentExpansion.satisfiedCount).toBe(1);
		expect(result.readiness?.rejectedActions).toEqual([
			{entityId: extra, action: 'turn_on', reason: 'no_op'},
		]);
		expect(http.post).toHaveBeenCalledTimes(1);
	});

	it('reports an already-satisfied set without dispatch or claiming executed success', async () => {
		configureCollection('on');
		vi.mocked(getHomeAssistantStates).mockResolvedValue([state(target, 'on'), state(extra, 'on')]);
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 0, outcome: 'no_action'});
		expect(result.planning?.intentExpansion.satisfiedCount).toBe(2);
		expect(executionSpy).not.toHaveBeenCalled();
		expect(http.post).not.toHaveBeenCalled();
	});

	it('does not call a set complete when only no-ops and excluded members remain', async () => {
		configureCollection('unavailable');
		vi.mocked(getHomeAssistantStates).mockResolvedValue([
			state(target, 'on'),
			state(extra, 'unavailable'),
		]);
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'rejected'});
		expect(result.planning?.intentExpansion).toMatchObject({
			outcome: 'partial',
			satisfiedCount: 1,
			unprocessedCount: 1,
		});
		expect(executionSpy).not.toHaveBeenCalled();
	});

	it.each(['unavailable', 'denied'])(
		'shows %s exclusions as partial processing even when all ready commands confirm',
		async (condition) => {
			configureCollection(condition === 'unavailable' ? 'unavailable' : 'off');
			if (condition === 'denied') {
				vi.mocked(loadEntityPolicy).mockResolvedValue({
					version: 1,
					allow: [{domain: 'light'}],
					deny: [{entityId: extra}],
				});
			}

			const result = await runExecutionCli(collectionInstruction);
			expect(result).toMatchObject({
				exitCode: 1,
				outcome: 'partial_success',
				execution: {outcome: 'all_confirmed'},
			});
			expect(result.planning?.intentExpansion).toMatchObject({
				outcome: 'partial',
				unprocessedCount: 1,
			});
			expect(result.readiness?.commands).toHaveLength(1);
			expect(http.post).toHaveBeenCalledTimes(1);
		},
	);

	it('removes an expanded member when policy changes before dispatch', async () => {
		configureCollection();
		vi.mocked(loadEntityPolicy)
			.mockResolvedValueOnce({version: 1, allow: [{domain: 'light'}], deny: []})
			.mockResolvedValue({version: 1, allow: [{domain: 'light'}], deny: [{entityId: extra}]});
		const result = await runExecutionCli(collectionInstruction);
		expect(result.readiness?.commands).toHaveLength(2);
		expect(result).toMatchObject({exitCode: 1, outcome: 'partial_success'});
		expect(result.execution?.results[1]).toMatchObject({
			outcome: 'skipped_not_authorized',
			reason: 'denied',
		});
		expect(http.post).toHaveBeenCalledTimes(1);
		expect(http.post).toHaveBeenCalledWith(
			'services/light/turn_on',
			expect.objectContaining({json: {entity_id: target}}),
		);
	});

	it('reauthorizes later expanded members after earlier confirmation deferral', async () => {
		configureCollection();
		http.get.mockImplementation(async (path: string) => {
			vi.mocked(loadEntityPolicy).mockResolvedValue({
				version: 1,
				allow: [{domain: 'light'}],
				deny: [{entityId: extra}],
			});
			return {statusCode: 200, body: state(path.slice('states/'.length), 'on')};
		});
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'partial_success'});
		expect(result.execution?.results[1]).toMatchObject({
			outcome: 'skipped_not_authorized',
			reason: 'denied',
		});
		expect(http.post).toHaveBeenCalledTimes(1);
		expect(getHomeAssistantStates).toHaveBeenCalledTimes(3);
	});

	it('fails closed for an individual subset of an all request', async () => {
		configureCollection();
		vi.mocked(requestOllamaChat).mockResolvedValue(plan());
		const result = await runExecutionCli(collectionInstruction);
		expect(result).toMatchObject({exitCode: 1, outcome: 'insufficient_context'});
		expect(result.planning?.intentExpansion.rejectedIntents[0]?.reason).toBe('set_intent_required');
		expect(executionSpy).not.toHaveBeenCalled();
		expect(http.post).not.toHaveBeenCalled();
	});
});
