import {getDomainFromEntityId} from '../home-assistant/discovery.js';
import {resolveAction, type ResolvedAction} from '../home-assistant/capabilities.js';
import type {ResolvedEntityPolicy} from '../policy/resolver.js';
import type {ConcretePlan, PlanOutcome, ProposedAction} from './schemas.js';

export type RejectionReason = 'denied' | 'not_allowed' | 'not_in_context' | 'unsupported_action';

// Planning-time authorization only; this is not an execution-ready service command.
export type ValidatedAction = ProposedAction & ResolvedAction;

export type RejectedAction = {
	action: ProposedAction;
	reason: RejectionReason;
};

export type PlanValidationResult = {
	outcome: PlanOutcome;
	summary: string;
	actions: ValidatedAction[];
	rejectedActions: RejectedAction[];
};

export const validatePlan = (
	plan: ConcretePlan,
	policy: ResolvedEntityPolicy,
	contextEntityIds: ReadonlySet<string>,
): PlanValidationResult => {
	const actions: ValidatedAction[] = [];
	const rejectedActions: RejectedAction[] = [];

	for (const action of plan.actions) {
		const canonicalProposedAction: ProposedAction = {
			entityId: action.entityId,
			action: action.action,
			reason: action.reason,
		};
		let reason: RejectionReason | undefined;
		let resolvedAction: ResolvedAction | undefined;

		if (policy.deniedEntityIds.has(action.entityId)) {
			reason = 'denied';
		} else if (policy.allowedEntityIds.has(action.entityId)) {
			if (contextEntityIds.has(action.entityId)) {
				resolvedAction = resolveAction(getDomainFromEntityId(action.entityId), action.action);

				if (resolvedAction === undefined) {
					reason = 'unsupported_action';
				}
			} else {
				reason = 'not_in_context';
			}
		} else {
			reason = 'not_allowed';
		}

		if (reason === undefined && resolvedAction !== undefined) {
			actions.push({...canonicalProposedAction, ...resolvedAction});
		} else {
			rejectedActions.push({
				action: canonicalProposedAction,
				reason: reason ?? 'unsupported_action',
			});
		}
	}

	if (plan.outcome === 'propose_actions' && actions.length === 0) {
		return {
			outcome: 'no_action',
			summary:
				'Proposed plan: No actions are proposed because all generated actions were rejected by deterministic post-model validation.',
			actions,
			rejectedActions,
		};
	}

	return {
		outcome: plan.outcome,
		summary: plan.summary,
		actions,
		rejectedActions,
	};
};
