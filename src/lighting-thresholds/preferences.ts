import {constants} from 'node:fs';
import {open, rename, unlink} from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {thresholdLuxSchema} from './evaluation.js';

export const THRESHOLD_PREFERENCES_PATH = 'config/lighting-thresholds.json';
const areaIdSchema = z.string().min(1).max(128);
export const thresholdPreferencesSchema = z
	.strictObject({
		version: z.literal(1),
		rooms: z
			.array(z.strictObject({areaId: areaIdSchema, thresholdLux: thresholdLuxSchema}))
			.max(128),
	})
	.refine((value) => new Set(value.rooms.map((room) => room.areaId)).size === value.rooms.length);
export type PreferenceSnapshot = {
	text: string | undefined;
	preferences: z.infer<typeof thresholdPreferencesSchema>;
};

/** Missing preferences are not created by reads. Reject links, non-files and oversized input. */
export const readThresholdPreferences = async (
	path = THRESHOLD_PREFERENCES_PATH,
): Promise<PreferenceSnapshot> => {
	try {
		const file = await open(path, constants.O_RDONLY + constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536) {
				throw new Error('Invalid threshold preference file.');
			}

			const buffer = Buffer.alloc(65_537);
			const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 65_536) {
				throw new Error('Threshold preferences exceed the size limit.');
			}

			const text = buffer.subarray(0, bytesRead).toString('utf8');
			return {text, preferences: thresholdPreferencesSchema.parse(JSON.parse(text))};
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return {text: undefined, preferences: {version: 1, rooms: []}};
		}

		throw error;
	}
};

/** Called only after CLI confirmation; replace just the selected room's preference atomically. */
export const changeThresholdPreference = async (
	change: {areaId: string; thresholdLux: number | undefined},
	expected: PreferenceSnapshot,
	path = THRESHOLD_PREFERENCES_PATH,
): Promise<void> => {
	const areaId = areaIdSchema.parse(change.areaId);
	const threshold =
		change.thresholdLux === undefined ? undefined : thresholdLuxSchema.parse(change.thresholdLux);
	const rooms = expected.preferences.rooms.filter((room) => room.areaId !== areaId);
	if (threshold !== undefined) {
		rooms.push({areaId, thresholdLux: threshold});
	}

	const next = thresholdPreferencesSchema.parse({version: 1, rooms});
	const text = `${JSON.stringify(next, undefined, 2)}\n`;
	if (Buffer.byteLength(text) > 65_536) {
		throw new Error('Threshold preferences exceed the size limit.');
	}

	const temporary = `${path}.${randomUUID()}.tmp`;
	const lockPath = `${path}.lock`;
	const lock = await open(lockPath, 'wx', 0o600);
	let hasTemporary = false;
	try {
		await lock.close();
		const current = await readThresholdPreferences(path);
		if (current.text !== expected.text) {
			throw new Error('Preferences changed after the preview; retry.');
		}

		const file = await open(temporary, 'wx', 0o600);
		hasTemporary = true;
		try {
			await file.writeFile(text, 'utf8');
			await file.sync();
		} finally {
			await file.close();
		}

		const beforeReplacement = await readThresholdPreferences(path);
		if (beforeReplacement.text !== expected.text) {
			throw new Error('Preferences changed before replacement; retry.');
		}

		await rename(temporary, path);
		hasTemporary = false;
		const verified = await readThresholdPreferences(path);
		if (verified.text !== text) {
			throw new Error('Preference verification failed.');
		}
	} finally {
		if (hasTemporary) {
			await unlink(temporary).catch(() => undefined);
		}

		await unlink(lockPath);
	}
};
