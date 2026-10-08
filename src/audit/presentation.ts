import {isIP} from 'node:net';
import type {AuditReport, AuditFinding} from './rules.js';

const redact = (value: string, redactions: readonly string[]): string => {
	let result = value;
	for (const secret of redactions
		.filter((secret) => secret.length > 0)
		.toSorted((left, right) => right.length - left.length)) {
		result = result.replaceAll(secret, '[redacted]');
	}

	return result
		.replaceAll(/\b(?:https?|wss?):\/\/\S+/giv, '[redacted-url]')
		.replaceAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gv, '[redacted-address]')
		.replaceAll(/(?<![\d:a-f])[\d:a-f]{2,39}(?![\d:a-f])/giv, (address) =>
			isIP(address) === 6 ? '[redacted-address]' : address,
		)
		.replaceAll(/[\p{Control}\p{Format}]/gv, ' ');
};

const humanFinding = (finding: AuditFinding): string => {
	const heading = `[${finding.severity.toUpperCase()}] ${finding.code.toUpperCase()}${finding.entityId === undefined ? '' : ` ${finding.entityId}`}${finding.deviceId === undefined ? '' : ` device=${finding.deviceId}`}`;
	const detailFields = Object.entries(finding.details).map(
		([key, value]) => `${key}=${value === null ? 'none' : JSON.stringify(value)}`,
	);
	return [
		heading,
		`  ${detailFields.join(' ')}`,
		`  reason: ${finding.reason}`,
		`  suggestion: ${finding.suggestion}`,
	].join('\n');
};

/** Whitelisted report fields only; known credentials and address strings are redacted in values. */
export const formatAuditReport = (
	report: AuditReport,
	isJson: boolean,
	redactions: readonly string[] = [],
): string => {
	const safeReport = JSON.parse(
		JSON.stringify(report, (_key, value: unknown) =>
			typeof value === 'string' ? redact(value, redactions) : (value ?? null),
		),
	) as AuditReport;
	if (isJson) {
		return JSON.stringify(safeReport, undefined, 2);
	}

	const {summary} = safeReport;
	const routineCodes = new Set(['registry_disabled', 'registry_entity_without_state']);
	const severityOrder = {error: 0, warn: 1, info: 2};
	const detailedFindings = safeReport.findings
		.filter((finding) => !routineCodes.has(finding.code))
		.toSorted((left, right) => severityOrder[left.severity] - severityOrder[right.severity]);
	const routineSummary = [...routineCodes].map(
		(code) => `${code}=${safeReport.findings.filter((finding) => finding.code === code).length}`,
	);
	return [
		`HA metadata audit: ${summary.entitiesScanned} entities (${summary.stateEntitiesScanned} with states), ${summary.devicesScanned} devices, ${summary.areasScanned} areas.`,
		`Findings: ${summary.errors} ERROR, ${summary.warnings} WARN, ${summary.info} INFO.`,
		'Read-only. Observation exposure grants evidence, not control. Suggestions are review hints; no changes were made.',
		`Routine registry status (per-entity details in --json): ${routineSummary.join(', ')}.`,
		...detailedFindings.map((finding) => humanFinding(finding)),
	].join('\n');
};
