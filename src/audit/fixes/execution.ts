import {z} from 'zod';
import {collectAuditData} from '../collection.js';
import {auditInventory} from '../rules.js';
import {buildAuditInventory} from '../inventory.js';
import {fingerprint} from './fingerprint.js';
import {deriveFixCandidates, type AuditFixCandidate, type FixSnapshot} from './planning.js';
import {readFixPolicy, writeExactPolicyDeny} from './policy.js';
import {inspectDisableTargets, disableStaleRegistryEntity} from './registry.js';

export type FixOutcome = 'verified' | 'changed' | 'failed';
export type FixDependencies = {
	collect: () => Promise<FixSnapshot>;
	disable: (
		candidate: Extract<AuditFixCandidate, {type: 'disable_stale_entity'}>,
		beforeWrite: () => Promise<boolean>,
		signal: AbortSignal,
	) => Promise<FixOutcome>;
	deny: (
		entityId: string,
		expectedText: string,
		beforeWrite: () => Promise<boolean>,
		signal: AbortSignal,
	) => Promise<FixOutcome>;
};

export const createFixDependencies = (): FixDependencies => {
	const config = z.object({HA_URL: z.url(), HA_TOKEN: z.string().min(1)}).parse(process.env);
	return {
		async collect() {
			const data = await collectAuditData();
			const document = data.policy === undefined ? undefined : await readFixPolicy();
			if (fingerprint(document?.policy) !== fingerprint(data.policy)) {
				throw new Error('Policy changed during collection.');
			}

			const report = auditInventory(buildAuditInventory(data));
			const ids = [
				...new Set(
					report.findings
						.filter(
							(finding) =>
								finding.code === 'duplicate_friendly_name' &&
								finding.details.match === 'exact' &&
								Array.isArray(finding.details.entityIds) &&
								finding.details.entityIds.length === 2 &&
								finding.details.policyPermitted === false &&
								['light', 'switch'].includes(String(finding.details.domain)) &&
								['unavailable', 'unknown', 'no_current_state'].includes(
									String(finding.details.state),
								),
						)
						.flatMap((finding) => {
							const ids = finding.details.entityIds;
							return Array.isArray(ids)
								? ids.filter(
										(id): id is string =>
											typeof id === 'string' && /^(?:light|switch)\.[0-9_a-z]+$/v.test(id),
									)
								: [];
						}),
				),
			];
			return {
				data,
				policyText: document?.text,
				registryEvidence: await inspectDisableTargets(config.HA_URL, config.HA_TOKEN, ids),
			};
		},
		disable: async (candidate, beforeWrite, signal) =>
			disableStaleRegistryEntity(
				{url: config.HA_URL, token: config.HA_TOKEN},
				{entityId: candidate.entityId, expectedDigest: candidate.registryDigest},
				beforeWrite,
				{signal},
			),
		deny: async (entityId, expectedText, beforeWrite, signal) =>
			writeExactPolicyDeny(entityId, expectedText, beforeWrite, {signal}),
	};
};

/** Re-derive from fresh production reads at the final write boundary; never trust a candidate alone. */
export const applyAuditFix = async (
	candidate: AuditFixCandidate,
	dependencies: FixDependencies,
	signal: AbortSignal,
): Promise<FixOutcome> => {
	const stillMatches = async (): Promise<boolean> => {
		if (signal.aborted) {
			return false;
		}

		const snapshot = await dependencies.collect();
		return deriveFixCandidates(snapshot).candidates.some(
			(fresh) => fingerprint(fresh) === fingerprint(candidate),
		);
	};

	try {
		if (!(await stillMatches())) {
			return 'changed';
		}

		if (candidate.type === 'disable_stale_entity') {
			return await dependencies.disable(candidate, stillMatches, signal);
		}

		if (candidate.type !== 'deny_policy_entity') {
			return 'failed';
		}

		const snapshot = await dependencies.collect();
		if (snapshot.policyText === undefined || !(await stillMatches())) {
			return 'changed';
		}

		const result = await dependencies.deny(
			candidate.entityId,
			snapshot.policyText,
			stillMatches,
			signal,
		);
		if (result !== 'verified') {
			return result;
		}

		const verified = await dependencies.collect();
		const entity = buildAuditInventory(verified.data).entities.find(
			(entity) => entity.entityId === candidate.entityId,
		);
		return entity !== undefined &&
			!entity.policyPermitted &&
			verified.data.policy?.deny.some(
				(selector) =>
					Object.keys(selector).length === 1 && selector.entityId === candidate.entityId,
			)
			? 'verified'
			: 'failed';
	} catch {
		return 'failed';
	}
};
