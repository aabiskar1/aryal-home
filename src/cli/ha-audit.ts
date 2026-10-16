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
			output: [
				'Usage: npm run ha-audit -- [--verbose | --json | --fix | --help]',
				'Home Assistant metadata and local policy audit. Read-only unless --fix is selected. No model or service execution.',
				'Default: compact errors/warnings and counts; INFO detail omitted.',
				'--verbose: full human-readable findings with reasons and suggestions; routine registry status summarized.',
				'--json: complete structured output with all findings.',
				'--fix: interactive entity-disable/policy-deny remediation; confirm each write [y/N].',
				'--help: show this help. Use each flag on its own.',
			].join('\n'),
		};
	}

	if (
		args.length > 1 ||
		(args.length === 1 && !['--json', '--verbose', '--fix'].includes(args[0]!))
	) {
		return {
			exitCode: 2,
			output: JSON.stringify({
				outcome: 'invalid_arguments',
				reason: 'use_no_flags_or_one_of_verbose_json_fix_help',
				exitCode: 2,
			}),
		};
	}

	try {
		if (args[0] === '--fix') {
			const {runInteractiveAuditFix} = await import('./ha-audit-fix.js');
			return await runInteractiveAuditFix();
		}

		const data = await collect();
		const report = auditInventory(buildAuditInventory(data));
		const mode = args[0] === '--json' ? 'json' : args[0] === '--verbose' ? 'verbose' : 'compact';
		return {exitCode: 0, output: formatAuditReport(report, mode, data.redactions)};
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
