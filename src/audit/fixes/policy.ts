import {constants} from 'node:fs';
import {open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {entityPolicySchema, type EntityPolicy} from '../../policy/schemas.js';

const policyPath = 'config/entity-policy.json';

/** Reject symlinks and missing/non-regular policies; never create a new policy. */
export const readFixPolicy = async (
	path = policyPath,
): Promise<{text: string; policy: EntityPolicy; mode: number}> => {
	const file = await open(path, constants.O_RDONLY + constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1) {
			throw new Error('Fix requires a regular policy file.');
		}

		const text = await file.readFile('utf8');
		return {text, policy: entityPolicySchema.parse(JSON.parse(text)), mode: stat.mode % 0o1000};
	} finally {
		await file.close();
	}
};

/** Insert only one exact deny selector, preserving every original byte outside that insertion. */
export const appendExactDeny = (text: string, entityId: string): string => {
	z.string()
		.regex(/^(?:light|switch)\.[0-9_a-z]+$/v)
		.parse(entityId);
	const policy = entityPolicySchema.parse(JSON.parse(text));
	const next = entityPolicySchema.parse({...policy, deny: [...policy.deny, {entityId}]});
	// Locate the top-level deny array using JSON tokens, never matching text inside string values.
	// eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator helpers are outside the ES2024 TypeScript target.
	const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[,:\[\]\{\}]/gv)];
	let depth = 0;
	let start = -1;
	let end = -1;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (
			depth === 1 &&
			token[0] === '"deny"' &&
			tokens[index + 1]?.[0] === ':' &&
			tokens[index + 2]?.[0] === '['
		) {
			start = tokens[index + 2]!.index + 1;
		}

		if (start >= 0 && depth === 2 && token[0] === ']') {
			end = token.index;
			break;
		}

		if (['{', '['].includes(token[0])) {
			depth++;
		} else if (['}', ']'].includes(token[0])) {
			depth--;
		}
	}

	if (start < 0 || end < start) {
		throw new Error('Policy deny array could not be located.');
	}

	const content = text.slice(start, end).trimEnd();
	const insertion = start + content.length;
	const result =
		text.slice(0, insertion) +
		(policy.deny.length === 0 ? '' : ',') +
		JSON.stringify({entityId}) +
		text.slice(insertion);
	const parsed = entityPolicySchema.parse(JSON.parse(result));
	if (JSON.stringify(parsed) !== JSON.stringify(next)) {
		throw new Error('Policy mutation must only append an exact deny.');
	}

	return result;
};

/** Same-directory atomic replacement, restrictive temp mode, optimistic byte comparison, no broad rewrite. */
export const writeExactPolicyDeny = async (
	entityId: string,
	expectedText: string,
	beforeWrite: () => Promise<boolean>,
	{signal, path = policyPath}: {signal: AbortSignal; path?: string},
): Promise<'verified' | 'changed' | 'failed'> => {
	const temporary = `${path}.audit-fix-${randomUUID()}.tmp`;
	const lockPath = `${path}.audit-fix.lock`;
	let isLocked = false;
	let isCreated = false;
	try {
		const lock = await open(lockPath, 'wx', 0o600);
		isLocked = true;
		await lock.close();
		const current = await readFixPolicy(path);
		if (current.text !== expectedText || signal.aborted) {
			return 'changed';
		}

		const next = appendExactDeny(current.text, entityId);
		const file = await open(temporary, 'wx', 0o600);
		isCreated = true;
		try {
			await file.writeFile(next, 'utf8');
			await file.chmod(current.mode);
			await file.sync();
		} finally {
			await file.close();
		}

		const isFresh = await beforeWrite();
		const lastPolicy = await readFixPolicy(path);
		if (!isFresh || lastPolicy.text !== expectedText || signal.aborted) {
			return 'changed';
		}

		await rename(temporary, path);
		isCreated = false;
		const verified = await readFixPolicy(path);
		return verified.text === next &&
			verified.policy.deny.some(
				(selector) => Object.keys(selector).length === 1 && selector.entityId === entityId,
			)
			? 'verified'
			: 'failed';
	} catch {
		return 'failed';
	} finally {
		if (isCreated) {
			await unlink(temporary).catch(() => undefined);
		}

		if (isLocked) {
			await unlink(lockPath).catch(() => undefined);
		}
	}
};
