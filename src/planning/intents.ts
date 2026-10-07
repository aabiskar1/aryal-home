import {supportedDomains} from '../home-assistant/capabilities.js';
import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import type {ResolvedEntityPolicy} from '../policy/resolver.js';
import type {ExecutionReadinessResult} from '../execution/readiness.js';
import type {PlanValidationResult} from './policy.js';
import type {ConcretePlan, Plan, ProposedAction, SetAction} from './schemas.js';

export type SetScopeContext = {
	area: string;
	aliases: string[];
	domain: SetAction['scope']['domain'];
};

export type IntentRejectionReason =
	| 'ambiguous_scope'
	| 'unknown_scope'
	| 'zero_permitted_matches'
	| 'incomplete_scope_context'
	| 'single_target_context'
	| 'set_intent_required'
	| 'contextual_subset_requires_set_intent';

export type SetExpansion = {
	intentIndex: number;
	intentType: 'set_action';
	action: SetAction['action'];
	// Only application-resolved names are emitted, never untrusted scope text.
	scope?: SetAction['scope'];
	matchedCount: number;
	expandedActions: Array<Pick<ProposedAction, 'entityId' | 'action'>>;
	// Non-permitted inventory never enters model context or member diagnostics.
	excludedCounts: {ineligible: number; notPermitted: number};
	rejection?: IntentRejectionReason;
};

export type IntentExpansionResult = {
	plan: ConcretePlan;
	sets: SetExpansion[];
	rejectedIntents: Array<{
		intentIndex: number;
		intentType: 'entity_action' | 'set_action';
		reason: IntentRejectionReason;
	}>;
};

const normalizeArea = (value: string): string => value.normalize('NFKC').trim().toLowerCase();
const compareIds = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
const isPermitted = (entity: DiscoveredEntity, policy: ResolvedEntityPolicy): boolean =>
	policy.allowedEntityIds.has(entity.entityId) && !policy.deniedEntityIds.has(entity.entityId);

const hasMatchingArea = (entity: DiscoveredEntity, name: string): boolean =>
	entity.metadata.status === 'available' &&
	[entity.metadata.areaName, ...entity.metadata.areaAliases].some(
		(value) => value !== undefined && normalizeArea(value) === normalizeArea(name),
	);

const areaMembers = (entities: DiscoveredEntity[], areaId: string, domain: string) =>
	entities.filter(
		(entity) =>
			entity.domain === domain &&
			entity.metadata.status === 'available' &&
			entity.metadata.areaId === areaId,
	);

/** Individual members of relevant multi-member scopes need explicit targeting or a set intent. */
const contextualCollectionTargets = (
	entities: DiscoveredEntity[],
	policy: ResolvedEntityPolicy,
	contextEntityIds: ReadonlySet<string>,
): ReadonlySet<string> => {
	const scopes = new Map<string, Set<string>>();
	const domains = new Set<string>(supportedDomains);
	for (const entity of entities) {
		const {metadata} = entity;
		if (
			!isPermitted(entity, policy) ||
			metadata.status !== 'available' ||
			metadata.areaId === undefined ||
			metadata.areaName === undefined ||
			!domains.has(entity.domain)
		) {
			continue;
		}

		const key = `${metadata.areaId}:${entity.domain}`;
		const members = scopes.get(key) ?? new Set<string>();
		members.add(entity.entityId);
		scopes.set(key, members);
	}

	const targets = new Set<string>();
	for (const members of scopes.values()) {
		if (members.size > 1) {
			for (const entityId of members) {
				if (contextEntityIds.has(entityId)) {
					targets.add(entityId);
				}
			}
		}
	}

	return targets;
};

const excludedMemberCounts = (
	members: DiscoveredEntity[],
	policy: ResolvedEntityPolicy,
	action: SetAction['action'],
): SetExpansion['excludedCounts'] => {
	const counts = {ineligible: 0, notPermitted: 0};
	for (const member of members) {
		if (isPermitted(member, policy)) {
			continue;
		}

		const state = normalizeState(member);
		if (!state.supportedActions.includes(action) || !['on', 'off'].includes(state.state)) {
			counts.ineligible++;
		} else {
			counts.notPermitted++;
		}
	}

	return counts;
};

/** Advertise only complete permitted scopes backed by validated registry metadata. */
export const createSetScopeContext = (
	entities: DiscoveredEntity[],
	policy: ResolvedEntityPolicy,
	contextEntityIds: ReadonlySet<string>,
): SetScopeContext[] => {
	const scopes: SetScopeContext[] = [];
	const visited = new Set<string>();
	for (const entity of entities) {
		const {metadata} = entity;
		if (
			!isPermitted(entity, policy) ||
			!contextEntityIds.has(entity.entityId) ||
			metadata.status !== 'available' ||
			metadata.areaId === undefined ||
			metadata.areaName === undefined
		) {
			continue;
		}

		const domain = supportedDomains.find((domain) => domain === entity.domain);
		if (domain === undefined) {
			continue;
		}

		const key = `${metadata.areaId}:${domain}`;
		if (visited.has(key)) {
			continue;
		}

		visited.add(key);

		const isComplete = areaMembers(entities, metadata.areaId, domain)
			.filter((member) => isPermitted(member, policy))
			.every((member) => contextEntityIds.has(member.entityId));
		if (isComplete) {
			scopes.push({
				area: metadata.areaName,
				aliases: metadata.areaAliases.toSorted(compareIds),
				domain,
			});
		}
	}

	return scopes.toSorted((a, b) => compareIds(`${a.area}:${a.domain}`, `${b.area}:${b.domain}`));
};

/** Resolve semantic scopes, then emit only concrete proposals into the existing safety pipeline. */
export const expandPlanIntents = (
	plan: Plan,
	entities: DiscoveredEntity[],
	policy: ResolvedEntityPolicy,
	context: {
		entityIds: ReadonlySet<string>;
		setScopes: readonly SetScopeContext[];
		singleTarget: boolean;
		requiresSetIntent: boolean;
	},
): IntentExpansionResult => {
	const actions: ProposedAction[] = [];
	const sets: SetExpansion[] = [];
	const rejectedIntents: IntentExpansionResult['rejectedIntents'] = [];
	const contextualTargets = context.singleTarget
		? new Set<string>()
		: contextualCollectionTargets(entities, policy, context.entityIds);
	for (const [intentIndex, intent] of plan.actions.entries()) {
		if (!('type' in intent)) {
			if (context.requiresSetIntent || contextualTargets.has(intent.entityId)) {
				rejectedIntents.push({
					intentIndex,
					intentType: 'entity_action',
					reason: context.requiresSetIntent
						? 'set_intent_required'
						: 'contextual_subset_requires_set_intent',
				});
			} else {
				actions.push(intent);
			}

			continue;
		}

		const expansion: SetExpansion = {
			intentIndex,
			intentType: 'set_action',
			action: intent.action,
			matchedCount: 0,
			expandedActions: [],
			excludedCounts: {ineligible: 0, notPermitted: 0},
		};
		sets.push(expansion);
		const matches = entities.filter((entity) => hasMatchingArea(entity, intent.scope.area));
		const areaIds = new Set(
			matches.flatMap((entity) =>
				entity.metadata.status === 'available' && entity.metadata.areaId !== undefined
					? [entity.metadata.areaId]
					: [],
			),
		);
		const [areaId] = areaIds;
		let rejection: IntentRejectionReason | undefined;
		if (context.singleTarget) {
			rejection = 'single_target_context';
		} else if (areaIds.size > 1) {
			rejection = 'ambiguous_scope';
		} else if (areaId === undefined) {
			rejection = 'unknown_scope';
		} else {
			const members = areaMembers(entities, areaId, intent.scope.domain);
			const permitted = members.filter((entity) => isPermitted(entity, policy));
			expansion.matchedCount = permitted.length;
			expansion.excludedCounts = excludedMemberCounts(members, policy, intent.action);

			const shownScope = context.setScopes.find(
				(scope) =>
					scope.domain === intent.scope.domain &&
					[scope.area, ...scope.aliases].some(
						(name) => normalizeArea(name) === normalizeArea(intent.scope.area),
					),
			);
			if (permitted.length === 0) {
				rejection = 'zero_permitted_matches';
			} else if (
				shownScope === undefined ||
				permitted.some((member) => !context.entityIds.has(member.entityId))
			) {
				rejection = 'incomplete_scope_context';
			} else {
				expansion.scope = {area: shownScope.area, domain: intent.scope.domain};
				for (const member of permitted.toSorted((a, b) => compareIds(a.entityId, b.entityId))) {
					const action: ProposedAction = {
						entityId: member.entityId,
						action: intent.action,
						reason: intent.reason,
					};
					actions.push(action);
					expansion.expandedActions.push({entityId: action.entityId, action: action.action});
				}
			}
		}

		if (rejection !== undefined) {
			expansion.rejection = rejection;
			rejectedIntents.push({intentIndex, intentType: 'set_action', reason: rejection});
		}
	}

	return {
		plan: {
			outcome:
				plan.outcome === 'propose_actions' && actions.length === 0
					? 'insufficient_context'
					: plan.outcome,
			summary: plan.summary,
			actions,
		},
		sets,
		rejectedIntents,
	};
};

/** Show every permitted member's downstream decision without duplicating safety checks. */
export const expansionDiagnostics = (
	expansion: IntentExpansionResult,
	validated: PlanValidationResult,
	readiness: ExecutionReadinessResult,
) => {
	const actionKey = (action: Pick<ProposedAction, 'entityId' | 'action'>) =>
		`${action.entityId}:${action.action}`;
	const policyRejections = new Map(
		validated.rejectedActions.map((member) => [actionKey(member.action), member.reason]),
	);
	const readinessRejections = new Map(
		readiness.rejectedActions.map((member) => [actionKey(member.action), member.reason]),
	);
	const expandedKeys = new Set(
		expansion.sets.flatMap((set) => set.expandedActions.map((action) => actionKey(action))),
	);
	const sets = expansion.sets.map((set) => ({
		...set,
		members: set.expandedActions.map((action) => {
			const reason =
				policyRejections.get(actionKey(action)) ?? readinessRejections.get(actionKey(action));
			return {
				...action,
				status:
					reason === undefined ? 'ready' : reason === 'no_op' ? 'already_satisfied' : 'rejected',
				...(reason !== undefined && {reason}),
			};
		}),
	}));
	const isSetNoOp = (member: ExecutionReadinessResult['rejectedActions'][number]) =>
		member.reason === 'no_op' && expandedKeys.has(actionKey(member.action));
	const unprocessedCount =
		expansion.rejectedIntents.length +
		sets.reduce(
			(total, set) => total + set.excludedCounts.ineligible + set.excludedCounts.notPermitted,
			0,
		) +
		validated.rejectedActions.length +
		readiness.rejectedActions.filter((member) => !isSetNoOp(member)).length;
	const satisfiedCount = readiness.rejectedActions.filter((member) => isSetNoOp(member)).length;
	const processedCount = readiness.commands.length + satisfiedCount;
	const outcome =
		sets.length === 0 && expansion.rejectedIntents.length === 0
			? 'none'
			: unprocessedCount === 0
				? 'complete'
				: processedCount > 0
					? 'partial'
					: 'rejected';
	return {
		outcome,
		sets,
		rejectedIntents: expansion.rejectedIntents,
		unprocessedCount,
		satisfiedCount,
	};
};
