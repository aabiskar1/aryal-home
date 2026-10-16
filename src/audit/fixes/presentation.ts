import {redactAuditText} from '../presentation.js';
import type {AuditFixCandidate} from './planning.js';

export const presentFixCandidate = (
	candidate: AuditFixCandidate,
	redactions: readonly string[],
): string => {
	const lines =
		candidate.type === 'disable_stale_entity'
			? [
					candidate.entityId,
					'Issue: unusable exact-name duplicate with one usable sibling on the same registry device.',
					`Usable sibling: ${candidate.siblingId}`,
					'Proposed fix: disable this registry entity only.',
					'Current: disabled_by=null (enabled)',
					'New: disabled_by="user" (disabled)',
					`Exact registry update: ${JSON.stringify({type: 'config/entity_registry/update', entity_id: candidate.entityId, disabled_by: 'user'})}`,
				]
			: [
					candidate.entityId,
					'Issue: suspicious actionable name on a currently permitted entity.',
					'Proposed fix: append one exact deny selector to config/entity-policy.json.',
					`Policy change: deny += ${JSON.stringify({entityId: candidate.entityId})}`,
					'Current policy effect: allowed',
					'New policy effect: denied; existing allow and deny entries preserved.',
				];
	return lines.map((line) => redactAuditText(line, redactions)).join('\n');
};
