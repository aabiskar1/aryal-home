import {z} from 'zod';
import {
	canonicalActions,
	resolveAction,
	type CanonicalAction,
} from '../home-assistant/capabilities.js';
import {getDomainFromEntityId} from '../home-assistant/discovery.js';
import type {NormalizedEntityState} from '../home-assistant/state-normalizer.js';
import type {PlanValidationResult, ValidatedAction} from '../planning/policy.js';
import type {PlanOutcome} from '../planning/schemas.js';

// Private construction boundary: no service data or descriptive model text is admitted.
const executionReadyCommandSchema = z
	.strictObject({
		domain: z.enum(['light', 'switch']),
		service: z.enum(canonicalActions),
		target: z
			.strictObject({entity_id: z.string().regex(/^(?:light|switch)\.[0-9_a-z]+$/v)})
			.readonly(),
	})
	.refine(({domain, target}) => getDomainFromEntityId(target.entity_id) === domain)
	.readonly()
	.brand<'ExecutionReadyCommand'>();

// Construction provenance only; future dispatch still requires fresh policy/state validation.
export type ExecutionReadyCommand = z.infer<typeof executionReadyCommandSchema>;

export type ReadinessRejectionReason =
	| 'duplicate_action'
	| 'conflicting_actions'
	| 'no_op'
	| 'ineligible_state'
	| 'not_in_context'
	| 'unsupported_action';

export type ExecutionReadinessResult = {
	outcome: PlanOutcome;
	commands: ExecutionReadyCommand[];
	acceptedActions: ValidatedAction[];
	rejectedActions: Array<{action: ValidatedAction; reason: ReadinessRejectionReason}>;
};

type ActionGroup = {actions: Set<CanonicalAction>; count: number};

const rejectionReason = (
	action: ValidatedAction,
	group: ActionGroup,
	states: readonly NormalizedEntityState[],
): ReadinessRejectionReason | undefined => {
	if (group.actions.size > 1) {
		return 'conflicting_actions';
	}

	if (group.count > 1) {
		return 'duplicate_action';
	}

	if (states.length === 0) {
		return 'not_in_context';
	}

	const state = states[0]!;
	if (
		states.length !== 1 ||
		(state.state !== 'on' && state.state !== 'off') ||
		!state.supportedActions.includes(action.action)
	) {
		return 'ineligible_state';
	}

	const domain = getDomainFromEntityId(action.entityId);
	if (state.domain !== domain || resolveAction(domain, action.action) === undefined) {
		return 'unsupported_action';
	}

	if (state.state === (action.action === 'turn_on' ? 'on' : 'off')) {
		return 'no_op';
	}

	return undefined;
};

/** Prepare commands from planning-validated proposals using only the selected planning snapshot. */
export const prepareExecutionReadyCommands = (
	plan: PlanValidationResult,
	selectedStates: readonly NormalizedEntityState[],
): ExecutionReadinessResult => {
	const commands: ExecutionReadyCommand[] = [];
	const acceptedActions: ValidatedAction[] = [];
	const rejectedActions: ExecutionReadinessResult['rejectedActions'] = [];
	const groups = new Map<string, ActionGroup>();
	const states = new Map<string, NormalizedEntityState[]>();

	for (const action of plan.actions) {
		const group = groups.get(action.entityId) ?? {actions: new Set<CanonicalAction>(), count: 0};
		group.actions.add(action.action);
		group.count++;
		groups.set(action.entityId, group);
	}

	for (const state of selectedStates) {
		const group = states.get(state.entityId) ?? [];
		group.push(state);
		states.set(state.entityId, group);
	}

	for (const action of plan.actions) {
		const reason = rejectionReason(
			action,
			groups.get(action.entityId)!,
			states.get(action.entityId) ?? [],
		);
		if (reason !== undefined) {
			rejectedActions.push({action, reason});
			continue;
		}

		// Reconstruct routing from the canonical action and entity ID; never copy proposal routing.
		const resolved = resolveAction(getDomainFromEntityId(action.entityId), action.action)!;
		const command = executionReadyCommandSchema.safeParse({
			domain: resolved.domain,
			service: resolved.service,
			target: {entity_id: action.entityId},
		});
		if (!command.success) {
			rejectedActions.push({action, reason: 'unsupported_action'});
			continue;
		}

		commands.push(command.data);
		acceptedActions.push(action);
	}

	return {
		outcome:
			plan.outcome === 'propose_actions' && commands.length === 0 ? 'no_action' : plan.outcome,
		commands,
		acceptedActions,
		rejectedActions,
	};
};
