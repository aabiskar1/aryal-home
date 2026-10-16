import {beforeEach, expect, it, vi} from 'vitest';
import {runHaAuditCli} from '../src/cli/ha-audit.js';

const fix = vi.hoisted(() => vi.fn(async () => ({exitCode: 0, output: 'Fix session finished.'})));
vi.mock('../src/cli/ha-audit-fix.js', () => ({runInteractiveAuditFix: fix}));
beforeEach(() => vi.clearAllMocks());

it('accepts isolated --fix and delegates to the separate interactive entrypoint', async () => {
	const collect = vi.fn();
	expect(await runHaAuditCli(['--fix'], collect)).toEqual({
		exitCode: 0,
		output: 'Fix session finished.',
	});
	expect(fix).toHaveBeenCalledOnce();
	expect(collect).not.toHaveBeenCalled();
});

it.each([
	['--fix', '--json'],
	['--fix', '--verbose'],
	['--fix', '--fix'],
	['--fix', '--help'],
	['--unknown'],
])('never enters remediation for invalid flags %j', async (...args) => {
	const collect = vi.fn();
	const result = await runHaAuditCli(args, collect);
	expect(result.exitCode).toBe(2);
	expect(fix).not.toHaveBeenCalled();
	expect(collect).not.toHaveBeenCalled();
});

it('never imports/invokes remediation for default or help', async () => {
	await runHaAuditCli(['--help']);
	await runHaAuditCli([], async () => {
		throw new Error('No HA in test.');
	});
	expect(fix).not.toHaveBeenCalled();
});
