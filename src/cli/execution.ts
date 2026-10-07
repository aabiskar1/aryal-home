import {env} from '../config/env.js';
import {loadEntityPolicy} from '../config/policy.js';
import {executeReadyCommands, type ExecutionResult} from '../execution/dispatcher.js';
import {getHomeAssistantStates} from '../home-assistant/client.js';
import {discoverEntities} from '../home-assistant/discovery.js';
import {getHomeAssistantRegistries} from '../home-assistant/registry-client.js';
import {requestOllamaChat} from '../ollama/client.js';
import {runPlanningPipeline, type PlanningPipelineResult} from '../planning/pipeline.js';
import {selectionDiagnostic} from '../planning/relevance.js';
import {resolveEntityPolicy} from '../policy/resolver.js';

const targetDiagnostic = (entityId: string) =>
	/^[0-9_a-z]+\.[0-9_a-z]+$/v.test(entityId) ? {entityId} : {};

const planningDiagnostics = (plan: PlanningPipelineResult) => ({
	selection: selectionDiagnostic(plan.selection, plan.permittedCount),
	outcome: plan.validatedPlan.outcome,
	intentExpansion: plan.intentExpansion,
	actions: plan.validatedPlan.actions.map(({entityId, action, domain, service}) => ({
		entityId,
		action,
		domain,
		service,
	})),
	rejectedActions: plan.validatedPlan.rejectedActions.map(({action, reason}) => ({
		...targetDiagnostic(action.entityId),
		action: action.action,
		reason,
	})),
});

const readinessDiagnostics = (plan: PlanningPipelineResult) => ({
	outcome: plan.executionReadiness.outcome,
	commands: plan.executionReadiness.commands,
	rejectedActions: plan.executionReadiness.rejectedActions.map(({action, reason}) => ({
		entityId: action.entityId,
		action: action.action,
		reason,
	})),
});

export type ExecutionCliResult = {
	instruction: string;
	exitCode: 0 | 1 | 2 | 3;
	outcome:
		| ExecutionResult['outcome']
		| 'no_action'
		| 'insufficient_context'
		| 'rejected'
		| 'invalid_instruction'
		| 'unexpected_error';
	reason?:
		| 'missing_instruction'
		| 'instruction_only'
		| 'no_execution_ready_commands'
		| 'dry_run'
		| 'earlier_proposals_rejected'
		| 'operation_failed';
	planning?: ReturnType<typeof planningDiagnostics>;
	readiness?: ReturnType<typeof readinessDiagnostics>;
	execution?: ExecutionResult;
};

/** Instruction-only orchestration. Production readers and execution API cannot be overridden. */
export const runExecutionCli = async (instruction: string): Promise<ExecutionCliResult> => {
	const text = instruction.trim();
	if (
		text.length === 0 ||
		text.startsWith('{') ||
		text.startsWith('[') ||
		/(?:^|\s)--?[a-z]/iv.test(text)
	) {
		return {
			instruction: text,
			exitCode: 2,
			outcome: 'invalid_instruction',
			reason: text.length === 0 ? 'missing_instruction' : 'instruction_only',
		};
	}

	let diagnostics: Pick<ExecutionCliResult, 'planning' | 'readiness'> = {};
	try {
		const [states, registries, policy] = await Promise.all([
			getHomeAssistantStates(),
			getHomeAssistantRegistries(env.HA_URL, env.HA_TOKEN),
			loadEntityPolicy(),
		]);
		const entities = discoverEntities(states, registries);
		const plan = await runPlanningPipeline(text, entities, resolveEntityPolicy(entities, policy), {
			model: env.OLLAMA_MODEL,
			maxRequestBytes: env.PLANNING_REQUEST_MAX_BYTES,
			chat: requestOllamaChat,
		});
		diagnostics = {planning: planningDiagnostics(plan), readiness: readinessDiagnostics(plan)};
		const base = {instruction: text, ...diagnostics};
		if (plan.validatedPlan.outcome === 'insufficient_context') {
			return {...base, exitCode: 1, outcome: 'insufficient_context'};
		}

		const rejectedCount = plan.intentExpansion.unprocessedCount;
		if (plan.validatedPlan.outcome === 'no_action' && rejectedCount === 0) {
			return {...base, exitCode: 0, outcome: 'no_action'};
		}

		if (plan.executionReadiness.commands.length === 0) {
			if (rejectedCount === 0 && plan.intentExpansion.satisfiedCount > 0) {
				return {...base, exitCode: 0, outcome: 'no_action'};
			}

			return {...base, exitCode: 1, outcome: 'rejected', reason: 'no_execution_ready_commands'};
		}

		const execution = await executeReadyCommands(plan.executionReadiness.commands);
		if (execution.outcome === 'execution_disabled') {
			return {...base, execution, exitCode: 3, outcome: 'execution_disabled', reason: 'dry_run'};
		}

		if (execution.outcome === 'all_confirmed' && rejectedCount > 0) {
			return {
				...base,
				execution,
				exitCode: 1,
				outcome: 'partial_success',
				reason: 'earlier_proposals_rejected',
			};
		}

		return {
			...base,
			execution,
			exitCode: execution.outcome === 'all_confirmed' ? 0 : 1,
			outcome: execution.outcome,
		};
	} catch {
		return {
			...diagnostics,
			instruction: text,
			exitCode: 1,
			outcome: 'unexpected_error',
			reason: 'operation_failed',
		};
	}
};

/** Pretty JSON with no untrusted model prose or raw exceptions; redact credentials even in input. */
export const formatExecutionCliResult = (result: ExecutionCliResult): string => {
	let message: string | undefined;
	if (result.outcome === 'execution_disabled') {
		message = 'Execution is disabled by configuration (DRY_RUN=true). No service calls were made.';
	} else if (result.outcome === 'invalid_instruction') {
		message =
			'Provide a natural-language instruction only. Routing flags and service JSON are not accepted.';
	}

	return JSON.stringify(
		{...result, ...(message !== undefined && {message})},
		(_key, value: unknown) =>
			typeof value === 'string' ? value.replaceAll(env.HA_TOKEN, '[redacted]') : value,
		2,
	);
};
