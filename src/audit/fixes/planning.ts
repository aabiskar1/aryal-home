import type {AuditData} from '../collection.js';
import {buildAuditInventory, compareText, type AuditEntity} from '../inventory.js';
import {auditInventory, type AuditFinding} from '../rules.js';
import {fingerprint} from './fingerprint.js';
import type {RegistryEvidence} from './registry.js';

export type FixSnapshot = {
	data: AuditData;
	policyText: string | undefined;
	registryEvidence: Record<string, RegistryEvidence>;
};

type FixBase = {entityId: string; preconditionDigest: string};
export type AuditFixCandidate =
	| (FixBase & {type: 'disable_stale_entity'; siblingId: string; registryDigest: string})
	| (FixBase & {type: 'deny_policy_entity'});
export type NonFixable = {entityId: string | undefined; code: string; reason: string};

const digestFor = (snapshot: FixSnapshot, ids: readonly string[]): string => {
	const {data} = snapshot;
	if (data.registries.status !== 'available') {
		throw new Error('Fix requires registries.');
	}

	return fingerprint({
		policyText: snapshot.policyText,
		policy: data.policy,
		states: data.states
			.filter((state) => ids.includes(state.entity_id))
			.toSorted((a, b) => compareText(a.entity_id, b.entity_id)),
		entities: data.registries.entities
			.filter((entry) => ids.includes(entry.entity_id))
			.toSorted((a, b) => compareText(a.entity_id, b.entity_id)),
		devices: data.registries.devices.toSorted((a, b) => compareText(a.id, b.id)),
		areas: data.registries.areas.toSorted((a, b) => compareText(a.area_id, b.area_id)),
		labels: data.registries.labels.toSorted((a, b) => compareText(a.label_id, b.label_id)),
		evidence: Object.fromEntries(ids.map((id) => [id, snapshot.registryEvidence[id]])),
	});
};

const isUnambiguousPair = (
	entity: AuditEntity,
	sibling: AuditEntity | undefined,
	group: AuditEntity[],
	finding: AuditFinding,
): sibling is AuditEntity =>
	group.length === 2 &&
	sibling !== undefined &&
	finding.details.match === 'exact' &&
	sibling.domain === entity.domain &&
	['light', 'switch'].includes(entity.domain) &&
	entity.deviceId !== undefined &&
	sibling.deviceId === entity.deviceId;

const planDuplicateFix = (
	snapshot: FixSnapshot,
	entity: AuditEntity,
	finding: AuditFinding,
	allEntities: readonly AuditEntity[],
): AuditFixCandidate | string => {
	const ids = finding.details.entityIds;
	const group = Array.isArray(ids)
		? allEntities.filter((member) => ids.includes(member.entityId))
		: [];
	const sibling = group.find((member) => member.entityId !== entity.entityId);
	const evidence = snapshot.registryEvidence[entity.entityId];
	const siblingEvidence =
		sibling === undefined ? undefined : snapshot.registryEvidence[sibling.entityId];
	const registry = snapshot.data.registries;
	const hasMatchingEvidence =
		registry.status === 'available' &&
		[entity, sibling].every(
			(member) =>
				member !== undefined &&
				fingerprint(snapshot.registryEvidence[member.entityId]?.entry) ===
					fingerprint(registry.entities.find((entry) => entry.entity_id === member.entityId)),
		);
	if (!isUnambiguousPair(entity, sibling, group, finding)) {
		return 'Ambiguous duplicate: require exactly two exact-name members in the same light/switch domain and registry device.';
	}

	if (entity.policyPermitted) {
		return 'Entity is currently policy-permitted; automatic disable is not offered.';
	}

	if (
		!['unavailable', 'unknown', 'no_current_state'].includes(entity.state) ||
		!sibling.hasCurrentState ||
		!['on', 'off'].includes(sibling.state)
	) {
		return 'Require one unusable candidate and one currently usable binary-state sibling.';
	}

	if (
		!entity.metadataComplete ||
		!sibling.metadataComplete ||
		entity.disabledSources.length > 0 ||
		sibling.disabledSources.length > 0
	) {
		return 'Require complete metadata and both registry members enabled.';
	}

	if (evidence === undefined || siblingEvidence === undefined || !hasMatchingEvidence) {
		return 'Verified admin registry-disable capability and matching registry identity evidence are required.';
	}

	return {
		type: 'disable_stale_entity',
		entityId: entity.entityId,
		siblingId: sibling.entityId,
		registryDigest: evidence.digest,
		preconditionDigest: digestFor(snapshot, [entity.entityId, sibling.entityId]),
	};
};

/** Pure, closed remediation vocabulary. Audit rules and severities are not modified. */
export const deriveFixCandidates = (
	snapshot: FixSnapshot,
): {candidates: AuditFixCandidate[]; nonFixable: NonFixable[]} => {
	const inventory = buildAuditInventory(snapshot.data);
	const report = auditInventory(inventory);
	const entities = new Map(inventory.entities.map((entity) => [entity.entityId, entity]));
	const candidates: AuditFixCandidate[] = [];
	const nonFixable: NonFixable[] = [];
	for (const finding of report.findings) {
		const entity = entities.get(finding.entityId ?? '');
		if (
			finding.code === 'suspicious_actionable_name' &&
			entity?.policyPermitted &&
			snapshot.policyText !== undefined &&
			/^(?:light|switch)\.[0-9_a-z]+$/v.test(entity.entityId)
		) {
			candidates.push({
				type: 'deny_policy_entity',
				entityId: entity.entityId,
				preconditionDigest: digestFor(snapshot, [entity.entityId]),
			});
			continue;
		}

		let reason = 'Manual review required; no supported deterministic fix.';
		if (finding.code === 'suspicious_actionable_name') {
			reason = entity?.policyPermitted
				? 'An existing valid policy document and a supported exact entity ID are required.'
				: 'Not currently policy-permitted; no additional deny is proposed.';
		}

		if (finding.code === 'duplicate_friendly_name' && entity !== undefined) {
			const proposed = planDuplicateFix(snapshot, entity, finding, inventory.entities);
			if (typeof proposed !== 'string') {
				candidates.push(proposed);
				continue;
			}

			reason = proposed;
		}

		if (
			finding.severity !== 'info' ||
			(entity !== undefined &&
				entity.supportedActions.length > 0 &&
				['duplicate_friendly_name', 'suspicious_actionable_name'].includes(finding.code))
		) {
			nonFixable.push({entityId: finding.entityId, code: finding.code, reason});
		}
	}

	return {candidates, nonFixable};
};
