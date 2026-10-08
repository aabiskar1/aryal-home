import {collectAuditData, type AuditData} from '../audit/collection.js';
import {buildAuditInventory} from '../audit/inventory.js';
import {formatAuditReport} from '../audit/presentation.js';
import {auditInventory} from '../audit/rules.js';

export type AuditCliResult = {exitCode: 0 | 1 | 2; output: string};

/** Separate maintenance entrypoint; injectable read-only collection keeps failure tests local. */
export const runHaAuditCli = async (
	args: readonly string[],
	collect: () => Promise<AuditData> = collectAuditData,
): Promise<AuditCliResult> => {
	if (args.length === 1 && args[0] === '--help') {
		return {
			exitCode: 0,
			output:
				'Usage: npm run ha-audit -- [--json]\nRead-only Home Assistant metadata and local policy audit. No model or execution.',
		};
	}

	if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
		return {
			exitCode: 2,
			output: JSON.stringify({
				outcome: 'invalid_arguments',
				reason: 'use_no_flags_or_json',
				exitCode: 2,
			}),
		};
	}

	try {
		const data = await collect();
		const report = auditInventory(buildAuditInventory(data));
		return {exitCode: 0, output: formatAuditReport(report, args[0] === '--json', data.redactions)};
	} catch {
		return {
			exitCode: 1,
			output: JSON.stringify({
				outcome: 'audit_failed',
				reason: 'ha_config_registry_or_policy_unavailable',
				exitCode: 1,
			}),
		};
	}
};
