import {createInterface} from 'node:readline/promises';
import {buildAuditInventory} from '../audit/inventory.js';
import {auditInventory} from '../audit/rules.js';
import {formatAuditReport, redactAuditText} from '../audit/presentation.js';
import {deriveFixCandidates} from '../audit/fixes/planning.js';
import {
	createFixDependencies,
	applyAuditFix,
	type FixDependencies,
} from '../audit/fixes/execution.js';
import {presentFixCandidate} from '../audit/fixes/presentation.js';
import type {AuditCliResult} from './ha-audit.js';

export type FixInteraction = {
	interactive: boolean;
	write: (text: string) => void;
	confirm: (prompt: string, signal: AbortSignal) => Promise<string>;
};

/** Testable sequential interaction; explicit y/yes is the sole confirmation path. */
export const runAuditFixSession = async (
	dependencies: FixDependencies,
	io: FixInteraction,
	signal: AbortSignal,
): Promise<AuditCliResult> => {
	if (!io.interactive) {
		return {
			exitCode: 2,
			output: 'Invalid arguments: --fix requires interactive input and output terminals.',
		};
	}

	let applied = 0;
	let skipped = 0;
	let declined = 0;
	let failed = 0;
	try {
		let snapshot = await dependencies.collect();
		const initialReport = auditInventory(buildAuditInventory(snapshot.data));
		io.write(formatAuditReport(initialReport, 'compact', snapshot.data.redactions));
		const initial = deriveFixCandidates(snapshot);
		io.write(
			`Found ${initialReport.summary.warnings} warnings. Fixable issues: ${initial.candidates.length}.`,
		);
		for (const issue of initial.nonFixable) {
			io.write(
				redactAuditText(
					`Non-fixable: ${issue.code.toUpperCase()} ${issue.entityId ?? ''}: ${issue.reason}`,
					snapshot.data.redactions,
				),
			);
		}

		io.write('Proposed changes (each requires a separate explicit yes):');

		const attempted = new Set<string>();
		while (!signal.aborted) {
			const candidate = deriveFixCandidates(snapshot).candidates.find(
				(candidate) => !attempted.has(`${candidate.type}:${candidate.entityId}`),
			);
			if (candidate === undefined) {
				break;
			}

			attempted.add(`${candidate.type}:${candidate.entityId}`);
			io.write(presentFixCandidate(candidate, snapshot.data.redactions));
			// Sequential prompts and writes are required: never parallelize this loop.
			// eslint-disable-next-line no-await-in-loop
			const answer = await io.confirm('Apply? [y/N] ', signal);
			if (signal.aborted) {
				break;
			}

			if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
				declined++;
				io.write('Declined. No change made.');
				continue;
			}

			// eslint-disable-next-line no-await-in-loop
			const result = await applyAuditFix(candidate, dependencies, signal);
			if (result === 'verified') {
				applied++;
				io.write('Applied and verified.');
				// Re-audit immediately after each success before proposing any later fix.
				// eslint-disable-next-line no-await-in-loop
				snapshot = await dependencies.collect();
				const refreshedReport = auditInventory(buildAuditInventory(snapshot.data));
				io.write(
					formatAuditReport(
						refreshedReport,
						'compact',
						snapshot.data.redactions,
						'Read-only audit snapshot; remediation results are reported separately.',
					),
				);
			} else if (result === 'changed') {
				skipped++;
				io.write('Skipped: underlying state changed since audit. Re-run audit.');
			} else {
				failed++;
				io.write(
					'Failed: mutation or verification failed. Success is not confirmed; inspect current state before retrying.',
				);
				// An uncertain write must never be followed by another write in this session.
				break;
			}
		}
	} catch {
		if (!signal.aborted) {
			failed++;
			io.write('Fix session failed: fresh audit, policy, registry, or input unavailable.');
		}
	}

	io.write(
		`Applied ${applied} fixes.\nSkipped ${skipped}.\nDeclined ${declined}.\nFailed ${failed}.`,
	);
	if (signal.aborted) {
		io.write('Interrupted. No further writes will be attempted.');
	}

	io.write('Re-running audit...');
	try {
		const final = await dependencies.collect();
		const report = auditInventory(buildAuditInventory(final.data));
		io.write(
			formatAuditReport(
				report,
				'compact',
				final.data.redactions,
				'Read-only audit snapshot; remediation results are reported separately.',
			),
		);
		if (report.summary.errors === 0 && report.summary.warnings === 0) {
			io.write('No actionable warnings remain.');
		}
	} catch {
		failed++;
		io.write('Final audit failed; remaining findings could not be confirmed.');
	}

	return {
		exitCode: signal.aborted || failed > 0 || skipped > 0 ? 1 : 0,
		output: 'Fix session finished.',
	};
};

export const runInteractiveAuditFix = async (): Promise<AuditCliResult> => {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return {
			exitCode: 2,
			output: 'Invalid arguments: --fix requires interactive input and output terminals.',
		};
	}

	const controller = new AbortController();
	const terminal = createInterface({input: process.stdin, output: process.stdout});
	const interrupt = (): void => {
		controller.abort();
	};

	process.on('SIGINT', interrupt);
	terminal.on('SIGINT', interrupt);
	terminal.on('close', interrupt);
	try {
		return await runAuditFixSession(
			createFixDependencies(),
			{
				interactive: true,
				write(text) {
					console.log(text);
				},
				confirm: async (prompt, signal) => terminal.question(prompt, {signal}),
			},
			controller.signal,
		);
	} finally {
		process.off('SIGINT', interrupt);
		terminal.close();
	}
};
