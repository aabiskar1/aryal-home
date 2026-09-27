import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import type {OllamaChatTransport} from '../ollama/client.js';
import {selectAllowedEntities, type ResolvedEntityPolicy} from '../policy/resolver.js';
import {createPlan} from './planner.js';
import {validatePlan, type PlanValidationResult} from './policy.js';
import {selectRelevantContext, type SelectionOptions, type SelectionResult} from './relevance.js';
import type {Plan} from './schemas.js';

export type PlanningPipelineResult = {
	selection: SelectionResult;
	permittedCount: number;
	validatedPlan: PlanValidationResult;
};

export type PipelineOptions = SelectionOptions & {chat: OllamaChatTransport};

const insufficientPlan = (
	reason: Extract<SelectionResult, {kind: 'insufficient_context'}>['reason'],
): Plan => ({
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
	const permitted = selectAllowedEntities(entities, policy);
	const candidates = permitted.map((entity) => ({
		state: normalizeState(entity),
		areaAliases: entity.metadata.status === 'available' ? entity.metadata.areaAliases : [],
	}));
	const selection = selectRelevantContext(instruction, candidates, options);

	if (selection.kind === 'insufficient_context') {
		return {
			selection,
			permittedCount: permitted.length,
			validatedPlan: validatePlan(insufficientPlan(selection.reason), policy, new Set()),
		};
	}

	const plan = await createPlan({instruction, states: selection.states}, options.chat);

	return {
		selection,
		permittedCount: permitted.length,
		validatedPlan: validatePlan(plan, policy, selection.contextEntityIds),
	};
};
