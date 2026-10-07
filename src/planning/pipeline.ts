import {
	prepareExecutionReadyCommands,
	type ExecutionReadinessResult,
} from '../execution/readiness.js';
import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import type {OllamaChatTransport} from '../ollama/client.js';
import {selectAllowedEntities, type ResolvedEntityPolicy} from '../policy/resolver.js';
import {createPlan} from './planner.js';
import {validatePlan, type PlanValidationResult} from './policy.js';
import {selectRelevantContext, type SelectionOptions, type SelectionResult} from './relevance.js';
import type {ConcretePlan} from './schemas.js';
import {createSetScopeContext, expandPlanIntents, expansionDiagnostics} from './intents.js';

export type PlanningPipelineResult = {
	selection: SelectionResult;
	permittedCount: number;
	validatedPlan: PlanValidationResult;
	executionReadiness: ExecutionReadinessResult;
	intentExpansion: ReturnType<typeof expansionDiagnostics>;
};

export type PipelineOptions = SelectionOptions & {chat: OllamaChatTransport};

const insufficientPlan = (
	reason: Extract<SelectionResult, {kind: 'insufficient_context'}>['reason'],
): ConcretePlan => ({
	outcome: 'insufficient_context',
	summary:
		reason === 'over_budget'
			? 'Proposed plan: The complete permitted context exceeds the configured planning budget.'
			: 'Proposed plan: No permitted relevant context was found for this request.',
	actions: [],
});

export const runPlanningPipeline = async (
	instruction: string,
	entities: DiscoveredEntity[],
	policy: ResolvedEntityPolicy,
	options: PipelineOptions,
): Promise<PlanningPipelineResult> => {
	const permitted = selectAllowedEntities(entities, policy).filter(
		(entity) => !policy.deniedEntityIds.has(entity.entityId),
	);
	const candidates = permitted.map((entity) => ({
		state: normalizeState(entity),
		areaAliases: entity.metadata.status === 'available' ? entity.metadata.areaAliases : [],
	}));
	const selection = selectRelevantContext(instruction, candidates, {
		...options,
		getSetScopes: (entityIds) => createSetScopeContext(entities, policy, entityIds),
	});

	if (selection.kind === 'insufficient_context') {
		const validatedPlan = validatePlan(insufficientPlan(selection.reason), policy, new Set());
		const executionReadiness = prepareExecutionReadyCommands(validatedPlan, []);
		return {
			selection,
			permittedCount: permitted.length,
			validatedPlan,
			executionReadiness,
			intentExpansion: expansionDiagnostics(
				{plan: validatedPlan, sets: [], rejectedIntents: []},
				validatedPlan,
				executionReadiness,
			),
		};
	}

	const plan = await createPlan(
		{
			instruction,
			states: selection.states,
			setScopes: selection.setScopes,
			intentMode: selection.intentMode,
		},
		options.chat,
	);
	const expansion = expandPlanIntents(plan, entities, policy, {
		entityIds: selection.contextEntityIds,
		setScopes: selection.setScopes,
		singleTarget: selection.reasons.some((reason) =>
			['exact_entity', 'friendly_name'].includes(reason),
		),
		requiresSetIntent: selection.requiresSetIntent,
	});
	const validatedPlan = validatePlan(expansion.plan, policy, selection.contextEntityIds);
	const executionReadiness = prepareExecutionReadyCommands(validatedPlan, selection.states);

	return {
		selection,
		permittedCount: permitted.length,
		validatedPlan,
		executionReadiness,
		intentExpansion: expansionDiagnostics(expansion, validatedPlan, executionReadiness),
	};
};
