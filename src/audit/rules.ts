import {compareText, type AuditEntity, type AuditInventory} from './inventory.js';

export type AuditFinding = {
	severity: 'error' | 'warn' | 'info';
	code: string;
	entityId?: string;
	deviceId?: string;
	details: Record<string, unknown>;
	reason: string;
	suggestion: string;
};

export type AuditReport = {
	summary: {
		entitiesScanned: number;
		stateEntitiesScanned: number;
		devicesScanned: number;
		areasScanned: number;
		errors: number;
		warnings: number;
		info: number;
	};
	findings: AuditFinding[];
};

type EntityFinding = Omit<AuditFinding, 'entityId' | 'deviceId' | 'details'> & {
	details?: Record<string, unknown>;
};

const findingFor = (entity: AuditEntity, finding: EntityFinding): AuditFinding => ({
	severity: finding.severity,
	code: finding.code,
	entityId: entity.entityId,
	details: {
		name: entity.name,
		domain: entity.domain,
		area: entity.area,
		entityArea: entity.entityArea,
		deviceArea: entity.deviceArea,
		parentDeviceArea: entity.parentDeviceArea,
		areaSource: entity.areaSource,
		state: entity.state,
		...finding.details,
	},
	reason: finding.reason,
	suggestion: finding.suggestion,
});

const areaFindings = (entity: AuditEntity): AuditFinding[] => {
	const findings: AuditFinding[] = [];
	if (!entity.metadataComplete) {
		findings.push(
			findingFor(entity, {
				severity: 'error',
				code: 'incomplete_metadata',
				reason: 'Registry references are incomplete; runtime policy excludes this entity.',
				suggestion:
					'Review referenced devices, parent devices, areas, and labels in Home Assistant.',
			}),
		);
	} else if (
		entity.area === undefined &&
		(entity.supportedActions.length > 0 || entity.observationSupported)
	) {
		findings.push(
			findingFor(entity, {
				severity: 'warn',
				code: 'missing_area',
				reason:
					'Supported entity has no effective registry area and cannot participate in area-based reasoning.',
				suggestion:
					'Assign the entity or its device to the correct Home Assistant area; a name is not an area assignment.',
				details: {
					deviceClass: entity.deviceClass,
					observationSupported: entity.observationSupported,
					policyPermitted: entity.policyPermitted,
				},
			}),
		);
	}

	if (
		entity.entityAreaId !== undefined &&
		entity.deviceAreaId !== undefined &&
		entity.entityAreaId !== entity.deviceAreaId
	) {
		findings.push(
			findingFor(entity, {
				severity: 'warn',
				code: 'entity_device_area_mismatch',
				reason:
					'The entity area overrides a different direct device area. This may be intentional.',
				suggestion: 'Review both area assignments in Home Assistant. No correction is implied.',
			}),
		);
	}

	return findings;
};

const stateFindings = (entity: AuditEntity): AuditFinding[] => {
	const findings: AuditFinding[] = [];
	if (!entity.hasCurrentState) {
		findings.push(
			findingFor(entity, {
				severity: 'info',
				code: 'registry_entity_without_state',
				reason:
					'The entity registry contains this entry, but the current state list does not. This alone does not prove staleness.',
				suggestion: 'Review disablement and integration availability in Home Assistant.',
			}),
		);
	} else if (entity.state === 'unavailable' || entity.state === 'unknown') {
		findings.push(
			findingFor(entity, {
				severity: 'warn',
				code: 'unusable_current_state',
				reason:
					'Home Assistant currently reports unavailable or unknown; runtime policy excludes this state.',
				suggestion:
					'Check the device and integration in Home Assistant before relying on this entity.',
			}),
		);
	}

	if (entity.disabledSources.length > 0) {
		findings.push(
			findingFor(entity, {
				severity: 'info',
				code: 'registry_disabled',
				reason: 'The entity, device, or parent device is disabled by registry metadata.',
				suggestion:
					'Review the recorded disablement in Home Assistant; do not enable it solely to silence an audit.',
				details: {disabledSources: entity.disabledSources},
			}),
		);
	}

	return findings;
};

const nameKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase();
const genericNames = new Set([
	'light',
	'switch',
	'sensor',
	'temperature',
	'humidity',
	'occupancy',
	'presence',
]);
const suspiciousTerms = new Set(['status', 'indicator', 'diagnostic', 'debug']);

const nameFindings = (entity: AuditEntity): AuditFinding[] => {
	const findings: AuditFinding[] = [];
	if (entity.name !== undefined && genericNames.has(nameKey(entity.name))) {
		findings.push(
			findingFor(entity, {
				severity: 'warn',
				code: 'generic_friendly_name',
				reason: 'The friendly name is exactly a generic entity or observation class name.',
				suggestion:
					'Consider a distinctive friendly name in Home Assistant; names do not establish area authority.',
			}),
		);
	}

	const tokens =
		`${entity.name ?? ''} ${entity.entityId}`
			.normalize('NFKC')
			.toLowerCase()
			.match(/[\p{Letter}\p{Number}]+/gv) ?? [];
	const terms = [...new Set(tokens.filter((token) => suspiciousTerms.has(token)))].toSorted(
		compareText,
	);
	if (entity.supportedActions.length > 0 && terms.length > 0) {
		findings.push(
			findingFor(entity, {
				severity: 'warn',
				code: 'suspicious_actionable_name',
				reason:
					'A whole name/identifier token suggests a status, indicator, diagnostic, or debug control. This is a review hint, not a safety classification.',
				suggestion:
					'Review Home Assistant metadata and ARYAL policy before treating it as an ordinary room control. No change was made.',
				details: {matchedTerms: terms},
			}),
		);
	}

	return findings;
};

const omissionReasons = (entity: AuditEntity): string[] => {
	const reasons: string[] = [];
	if (!entity.hasCurrentState) {
		reasons.push('no_current_state');
	}

	if (!entity.metadataComplete) {
		reasons.push('incomplete_metadata');
	}

	if (entity.disabledSources.length > 0) {
		reasons.push('registry_disabled');
	}

	if (!entity.observationNormalizable) {
		reasons.push('unusable_observation_state');
	}

	if (!entity.policyPermitted) {
		reasons.push('not_policy_permitted');
	}

	return reasons;
};

const readinessFindings = (entity: AuditEntity): AuditFinding[] => {
	const findings: AuditFinding[] = [];
	if (entity.observationSupported) {
		const reasons = omissionReasons(entity);
		findings.push(
			findingFor(entity, {
				severity: 'info',
				code: 'observation_readiness',
				reason:
					'Observation exposure grants read-only evidence, never action authority. Eligibility is a snapshot; selection also depends on the request and budget.',
				suggestion:
					'Review state, metadata, and policy as needed. A missing area prevents area-conditioned use but does not by itself prevent unscoped evidence.',
				details: {
					deviceClass: entity.deviceClass,
					unit: entity.unit,
					normalizable: entity.observationNormalizable,
					currentStateUsable: entity.observationNormalizable,
					hasArea: entity.area !== undefined,
					policyExposed: entity.policyPermitted,
					eligibleForPlanning: reasons.length === 0,
					areaReasoningReady: reasons.length === 0 && entity.area !== undefined,
					omissionReasons: reasons,
				},
			}),
		);
		if (!entity.policyPermitted) {
			findings.push(
				findingFor(entity, {
					severity: 'info',
					code: 'observation_not_exposed',
					reason:
						'The supported observation is not currently permitted by ARYAL policy resolution, which also excludes disabled, incomplete, unavailable, and unknown entities.',
					suggestion:
						'Review eligibility first, then allow/deny selectors. Add an explicit entity allow only if you want this evidence; deny rules still win.',
					details: {deviceClass: entity.deviceClass, omissionReasons: reasons},
				}),
			);
		}
	}

	if (entity.supportedActions.length > 0) {
		findings.push(
			findingFor(entity, {
				severity: 'info',
				code: 'actionable_readiness',
				reason:
					'Only light/switch power actions are supported. Policy permission and area metadata are hints, not execution authorization.',
				suggestion:
					'Review policy and metadata. Actual requests still require planning, readiness, fresh authorization, and confirmation.',
				details: {
					policyPermitted: entity.policyPermitted,
					hasArea: entity.area !== undefined,
					supportedActions: entity.supportedActions,
					currentStateUsable: entity.hasCurrentState && ['on', 'off'].includes(entity.state),
				},
			}),
		);
	}

	return findings;
};

const duplicateNameFindings = (entities: AuditEntity[]): AuditFinding[] => {
	const groups = new Map<string, AuditEntity[]>();
	for (const entity of entities) {
		if (entity.name === undefined || entity.name.trim().length === 0) {
			continue;
		}

		const key = nameKey(entity.name);
		groups.set(key, [...(groups.get(key) ?? []), entity]);
	}

	const findings: AuditFinding[] = [];
	for (const group of groups.values()) {
		if (group.length < 2) {
			continue;
		}

		for (const entity of group) {
			findings.push(
				findingFor(entity, {
					severity: 'warn',
					code: 'duplicate_friendly_name',
					reason:
						'Different entity IDs share the same friendly name after case/Unicode/whitespace normalization.',
					suggestion:
						'Review friendly names and area metadata to make explicit targets distinguishable.',
					details: {
						match: group.every((member) => member.name === entity.name) ? 'exact' : 'normalized',
						entityIds: group.map((member) => member.entityId).toSorted(compareText),
					},
				}),
			);
		}
	}

	return findings;
};

const deviceAreaFindings = (entities: AuditEntity[]): AuditFinding[] => {
	const groups = new Map<string, AuditEntity[]>();
	for (const entity of entities) {
		if (entity.deviceId !== undefined && entity.areaId !== undefined) {
			groups.set(entity.deviceId, [...(groups.get(entity.deviceId) ?? []), entity]);
		}
	}

	const findings: AuditFinding[] = [];
	for (const [deviceId, group] of groups) {
		const areaIds = new Set(group.map((entity) => entity.areaId));
		if (areaIds.size < 2) {
			continue;
		}

		findings.push({
			severity: 'warn',
			code: 'device_entities_multiple_areas',
			deviceId,
			details: {
				areas: [
					...new Set(group.flatMap((entity) => (entity.area === undefined ? [] : [entity.area]))),
				].toSorted(compareText),
				entityIds: group.map((entity) => entity.entityId).toSorted(compareText),
			},
			reason:
				'Entities attached to the same direct device have different effective registry areas. Overrides may be intentional.',
			suggestion:
				'Review device/entity area assignments in Home Assistant. No automatic correction is appropriate.',
		});
	}

	return findings;
};

const policyFindings = (inventory: AuditInventory): AuditFinding[] => {
	if (inventory.policy === undefined) {
		return [
			{
				severity: 'info',
				code: 'policy_not_configured',
				details: {},
				reason:
					'No local entity policy exists; this audit reports default-deny exposure and does not create a policy.',
				suggestion:
					'Create and review a local entity policy deliberately before using ARYAL planning.',
			},
		];
	}

	const registryIds = new Set(inventory.entities.map((entity) => entity.entityId));
	return (['allow', 'deny'] as const).flatMap((source) =>
		[
			...new Set(
				inventory.policy![source].flatMap((selector) =>
					selector.entityId === undefined ? [] : [selector.entityId],
				),
			),
		]
			.filter((entityId) => !inventory.stateEntityIds.has(entityId))
			.map((entityId): AuditFinding => ({
				severity: 'warn',
				code: `policy_${source}_entity_not_discovered`,
				entityId,
				details: {registryPresent: registryIds.has(entityId)},
				reason: 'An explicit entity policy reference is absent from current state-based discovery.',
				suggestion:
					'Check spelling, disablement, and integration availability; retain intentional deny entries as needed. The policy was not changed.',
			})),
	);
};

/** Pure deterministic findings. No name-derived area or permission inference. */
export const auditInventory = (inventory: AuditInventory): AuditReport => {
	const findings = [
		...inventory.entities.flatMap((entity) => [
			...areaFindings(entity),
			...stateFindings(entity),
			...nameFindings(entity),
			...readinessFindings(entity),
		]),
		...duplicateNameFindings(inventory.entities),
		...deviceAreaFindings(inventory.entities),
		...policyFindings(inventory),
	].toSorted((left, right) =>
		compareText(
			`${left.entityId ?? ''}\0${left.deviceId ?? ''}\0${left.code}`,
			`${right.entityId ?? ''}\0${right.deviceId ?? ''}\0${right.code}`,
		),
	);

	return {
		summary: {
			entitiesScanned: inventory.entities.length,
			stateEntitiesScanned: inventory.stateEntityIds.size,
			devicesScanned: inventory.devicesScanned,
			areasScanned: inventory.areasScanned,
			errors: findings.filter((finding) => finding.severity === 'error').length,
			warnings: findings.filter((finding) => finding.severity === 'warn').length,
			info: findings.filter((finding) => finding.severity === 'info').length,
		},
		findings,
	};
};
