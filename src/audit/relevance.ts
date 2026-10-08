import type {DiscoveredEntity} from '../home-assistant/discovery.js';
import {resolveEntityPolicy} from '../policy/resolver.js';
import type {EntityPolicy} from '../policy/schemas.js';
import type {AuditEntity} from './inventory.js';

/** Audit attention only: these IDs are never permissions or planning/execution inputs. */
export const configuredPolicyTargets = (
	entities: DiscoveredEntity[],
	policy: EntityPolicy,
): ReadonlySet<string> => {
	// Ask the existing selector resolver about configuration independently of transient state
	// and incomplete-reference eligibility. Unknown registry selectors remain unknown, so
	// they cannot grant a match and unknown deny selectors still exclude the entity.
	// Disablement remains excluded. Only copies go through this audit-only view.
	const selectionView = entities.map((entity): DiscoveredEntity => ({
		...entity,
		homeAssistantState: {...entity.homeAssistantState, state: 'on'},
		metadata:
			entity.metadata.status === 'unavailable'
				? {status: 'unavailable', reason: 'registry_failure'}
				: entity.metadata,
	}));
	return resolveEntityPolicy(selectionView, policy).allowedEntityIds;
};

export const isAuditRelevant = (
	entity: Omit<AuditEntity, 'aryalRelevant'>,
	configuredTargets: ReadonlySet<string>,
): boolean =>
	entity.hasCurrentState &&
	entity.disabledSources.length === 0 &&
	(entity.supportedActions.length > 0 || entity.observationSupported) &&
	configuredTargets.has(entity.entityId);
