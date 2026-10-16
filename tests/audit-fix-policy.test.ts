import type * as Filesystem from 'node:fs/promises';
import {
	mkdtemp,
	readFile,
	writeFile,
	readdir,
	rm,
	chmod,
	stat,
	symlink,
	link,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {appendExactDeny, readFixPolicy, writeExactPolicyDeny} from '../src/audit/fixes/policy.js';

const fs = vi.hoisted(() => ({rename: vi.fn()}));
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof Filesystem>();
	fs.rename.mockImplementation(actual.rename);
	return {...actual, rename: fs.rename};
});

let directory: string;
let path: string;
const text =
	'{\n  "version": 2,\n  "allow": [{"domain":"light"},{"areaId":"example_room"}],\n  "deny": [{"entityId":"switch.example_other"}]\n}\n';
const yes = async () => true;
const signal = () => new AbortController().signal;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'aryal-fix-policy-'));
	path = join(directory, 'entity-policy.json');
	await writeFile(path, text);
	const actual = await vi.importActual<typeof Filesystem>('node:fs/promises');
	fs.rename.mockReset().mockImplementation(actual.rename);
});
afterEach(async () => rm(directory, {recursive: true, force: true}));

describe('exact-deny policy changes', () => {
	it('appends only an exact deny, preserving unrelated bytes, entries, ordering and version', () => {
		const next = appendExactDeny(text, 'light.example_status');
		expect(next).toBe(
			text.replace(
				'"switch.example_other"}]',
				'"switch.example_other"},{"entityId":"light.example_status"}]',
			),
		);
		expect(JSON.parse(next)).toEqual({
			...(JSON.parse(text) as Record<string, unknown>),
			deny: [{entityId: 'switch.example_other'}, {entityId: 'light.example_status'}],
		});
	});

	it.each([
		'{"version":1,"allow":[],"deny":[]}',
		'{"deny": [\n  ], "allow": [{"entityId":"light.example_deny"}], "version":2}',
		JSON.stringify({version: 2, allow: [{labelId: 'a"deny": [b'}], deny: []}),
	])('handles empty/whitespace arrays and deny text in string values (%s)', (original) => {
		const next = JSON.parse(appendExactDeny(original, 'switch.example_status')) as {
			deny: unknown[];
		};
		expect(next.deny).toEqual([{entityId: 'switch.example_status'}]);
	});

	it.each(['light.*', '*', 'light.bad id', 'lock.example_lock', 'sensor.example_temperature'])(
		'rejects unsupported or broad identifiers %s',
		(id) => {
			expect(() => appendExactDeny(text, id)).toThrow();
		},
	);

	it.each(['not-json', '{"version":5}', '{"version":1,"allow":[],"deny":[],"extra":true}'])(
		'refuses malformed policy %s',
		async (invalid) => {
			await writeFile(path, invalid);
			expect(
				await writeExactPolicyDeny('light.example_status', invalid, yes, {
					signal: signal(),
					path,
				}),
			).toBe('failed');
			expect(await readFile(path, 'utf8')).toBe(invalid);
			expect(fs.rename).not.toHaveBeenCalled();
		},
	);

	it('rejects malformed resulting policy without replacing original', async () => {
		expect(
			await writeExactPolicyDeny('light.invalid id', text, yes, {signal: signal(), path}),
		).toBe('failed');
		expect(await readFile(path, 'utf8')).toBe(text);
		expect(fs.rename).not.toHaveBeenCalled();
	});

	it('uses a same-directory fully written/synced temp file and atomic rename, then verifies', async () => {
		await chmod(path, 0o640);
		const beforeWrite = vi.fn(async () => {
			expect(await readFile(path, 'utf8')).toBe(text);
			const files = await readdir(directory);
			const temporary = files.find((name) => name.endsWith('.tmp'))!;
			const staged = JSON.parse(await readFile(join(directory, temporary), 'utf8')) as unknown;
			expect(staged).toMatchObject({
				deny: [{entityId: 'switch.example_other'}, {entityId: 'light.example_status'}],
			});
			return true;
		});
		expect(
			await writeExactPolicyDeny('light.example_status', text, beforeWrite, {
				signal: signal(),
				path,
			}),
		).toBe('verified');
		expect(beforeWrite).toHaveBeenCalledOnce();
		expect(fs.rename).toHaveBeenCalledExactlyOnceWith(
			expect.stringMatching(/\.audit-fix-.*\.tmp$/v),
			path,
		);
		const verified = await readFixPolicy(path);
		expect(verified.policy.deny).toEqual([
			{entityId: 'switch.example_other'},
			{entityId: 'light.example_status'},
		]);
		const metadata = await stat(path);
		expect(metadata.mode % 0o1000).toBe(0o640);
		expect(await readdir(directory)).toEqual(['entity-policy.json']);
	});

	it('skips an earlier concurrent policy change without replacing it', async () => {
		await writeFile(path, text + ' ');
		expect(
			await writeExactPolicyDeny('light.example_status', text, yes, {signal: signal(), path}),
		).toBe('changed');
		expect(await readFile(path, 'utf8')).toBe(text + ' ');
		expect(fs.rename).not.toHaveBeenCalled();
	});

	it('compares policy bytes again immediately before rename', async () => {
		const beforeWrite = async () => {
			await writeFile(path, text + '\n');
			return true;
		};

		expect(
			await writeExactPolicyDeny('light.example_status', text, beforeWrite, {
				signal: signal(),
				path,
			}),
		).toBe('changed');
		expect(await readFile(path, 'utf8')).toBe(text + '\n');
		expect(fs.rename).not.toHaveBeenCalled();
		expect(await readdir(directory)).toEqual(['entity-policy.json']);
	});

	it('skips on fresh HA refusal and cleans temporary/lock files', async () => {
		expect(
			await writeExactPolicyDeny('light.example_status', text, async () => false, {
				signal: signal(),
				path,
			}),
		).toBe('changed');
		expect(await readFile(path, 'utf8')).toBe(text);
		expect(await readdir(directory)).toEqual(['entity-policy.json']);
	});

	it('Ctrl+C before commit leaves the original intact', async () => {
		const controller = new AbortController();
		const beforeWrite = async () => {
			controller.abort();
			return true;
		};

		expect(
			await writeExactPolicyDeny('light.example_status', text, beforeWrite, {
				signal: controller.signal,
				path,
			}),
		).toBe('changed');
		expect(await readFile(path, 'utf8')).toBe(text);
		expect(fs.rename).not.toHaveBeenCalled();
	});

	it('does not claim success on a failed replace and cleans staging files', async () => {
		fs.rename.mockRejectedValueOnce(new Error('denied'));
		expect(
			await writeExactPolicyDeny('light.example_status', text, yes, {signal: signal(), path}),
		).toBe('failed');
		expect(await readFile(path, 'utf8')).toBe(text);
		expect(await readdir(directory)).toEqual(['entity-policy.json']);
	});

	it('reports failed verification if file changes immediately after rename', async () => {
		const actual = await vi.importActual<typeof Filesystem>('node:fs/promises');
		fs.rename.mockImplementationOnce(async (temporary: string, target: string) => {
			await actual.rename(temporary, target);
			await writeFile(target, text);
		});
		expect(
			await writeExactPolicyDeny('light.example_status', text, yes, {signal: signal(), path}),
		).toBe('failed');
	});

	it('refuses an existing session lock without deleting another session lock', async () => {
		await writeFile(path + '.audit-fix.lock', 'other-session');
		expect(
			await writeExactPolicyDeny('light.example_status', text, yes, {signal: signal(), path}),
		).toBe('failed');
		expect(await readFile(path + '.audit-fix.lock', 'utf8')).toBe('other-session');
		expect(fs.rename).not.toHaveBeenCalled();
	});

	it('never creates a missing policy', async () => {
		const missing = join(directory, 'missing.json');
		expect(
			await writeExactPolicyDeny('light.example_status', text, yes, {
				signal: signal(),
				path: missing,
			}),
		).toBe('failed');
		expect(await readdir(directory)).toEqual(['entity-policy.json']);
	});

	it('refuses symlinks and hard-linked policies', async () => {
		const symbolic = join(directory, 'symbolic.json');
		const hard = join(directory, 'hard.json');
		await symlink(path, symbolic);
		await expect(readFixPolicy(symbolic)).rejects.toThrow();
		await link(path, hard);
		await expect(readFixPolicy(hard)).rejects.toThrow();
	});
});
