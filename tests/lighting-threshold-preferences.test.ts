import {
	mkdtemp,
	readFile,
	writeFile,
	rm,
	symlink,
	link,
	stat,
	readdir,
	mkdir,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	changeThresholdPreference,
	readThresholdPreferences,
	thresholdPreferencesSchema,
} from '../src/lighting-thresholds/preferences.js';

let directory: string;
let path: string;
const savedRooms = async () => {
	const snapshot = await readThresholdPreferences(path);
	return snapshot.preferences.rooms;
};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'aryal-threshold-test-'));
	path = join(directory, 'preferences.json');
});
afterEach(async () => rm(directory, {recursive: true, force: true}));

describe('separate local advisory preferences', () => {
	it('reads missing preferences without creating files', async () => {
		expect(await readThresholdPreferences(path)).toEqual({
			text: undefined,
			preferences: {version: 1, rooms: []},
		});
		expect(await readdir(directory)).toEqual([]);
	});
	it('creates a validated private file and verifies it after atomic replacement', async () => {
		await changeThresholdPreference(
			{areaId: 'example_area', thresholdLux: 40},
			await readThresholdPreferences(path),
			path,
		);
		expect(await savedRooms()).toEqual([{areaId: 'example_area', thresholdLux: 40}]);
		const info = await stat(path);
		expect(info.mode % 0o1000).toBe(0o600);
		expect(await readdir(directory)).toEqual(['preferences.json']);
	});
	it('adjusts one room and preserves other preferences', async () => {
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				rooms: [
					{areaId: 'example_area', thresholdLux: 40},
					{areaId: 'other_area', thresholdLux: 80},
				],
			}),
		);
		await changeThresholdPreference(
			{areaId: 'example_area', thresholdLux: 55.5},
			await readThresholdPreferences(path),
			path,
		);
		expect(await savedRooms()).toEqual([
			{areaId: 'other_area', thresholdLux: 80},
			{areaId: 'example_area', thresholdLux: 55.5},
		]);
	});
	it('resets only the selected room without installing a default', async () => {
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				rooms: [
					{areaId: 'example_area', thresholdLux: 40},
					{areaId: 'other_area', thresholdLux: 80},
				],
			}),
		);
		await changeThresholdPreference(
			{areaId: 'example_area', thresholdLux: undefined},
			await readThresholdPreferences(path),
			path,
		);
		expect(await savedRooms()).toEqual([{areaId: 'other_area', thresholdLux: 80}]);
	});
	it.each([
		'not JSON',
		'{"version":2,"rooms":[]}',
		'{"version":1,"rooms":[{"areaId":"example","thresholdLux":0}]}',
		'{"version":1,"rooms":[],"allow":["all"]}',
		'{"version":1,"rooms":[{"areaId":"example","thresholdLux":40},{"areaId":"example","thresholdLux":50}]}',
	])('rejects malformed configuration without rewriting it', async (text) => {
		await writeFile(path, text);
		await expect(readThresholdPreferences(path)).rejects.toThrow();
		expect(await readFile(path, 'utf8')).toBe(text);
	});
	it.each([0, 1001, NaN, Infinity])(
		'rejects invalid writes %s before creating files',
		async (thresholdLux) => {
			await expect(
				changeThresholdPreference(
					{areaId: 'example', thresholdLux},
					await readThresholdPreferences(path),
					path,
				),
			).rejects.toThrow();
			expect(await readdir(directory)).toEqual([]);
		},
	);
	it('refuses to overwrite changes since the preview and cleans the lock', async () => {
		const snapshot = await readThresholdPreferences(path);
		const newer = JSON.stringify({version: 1, rooms: [{areaId: 'other', thresholdLux: 60}]});
		await writeFile(path, newer);
		await expect(
			changeThresholdPreference({areaId: 'example', thresholdLux: 40}, snapshot, path),
		).rejects.toThrow('changed');
		expect(await readFile(path, 'utf8')).toBe(newer);
		expect(await readdir(directory)).toEqual(['preferences.json']);
	});
	it('refuses overlapping writers without deleting their lock', async () => {
		await writeFile(`${path}.lock`, 'existing');
		await expect(
			changeThresholdPreference(
				{areaId: 'example', thresholdLux: 40},
				await readThresholdPreferences(path),
				path,
			),
		).rejects.toThrow();
		expect(await readFile(`${path}.lock`, 'utf8')).toBe('existing');
	});
	it.each(['symlink', 'hardlink'] as const)('refuses a %s preference file', async (kind) => {
		const original = join(directory, 'original.json');
		await writeFile(original, '{"version":1,"rooms":[]}');
		if (kind === 'symlink') {
			await symlink(original, path);
		} else {
			await link(original, path);
		}

		await expect(readThresholdPreferences(path)).rejects.toThrow();
	});
	it('rejects oversized files and directories', async () => {
		await writeFile(path, ' '.repeat(65_537));
		await expect(readThresholdPreferences(path)).rejects.toThrow();
		await expect(readThresholdPreferences(directory)).rejects.toThrow();
	});
	it('refuses a missing parent directory without creating infrastructure', async () => {
		const otherPath = join(directory, 'missing', 'preferences.json');
		await expect(
			changeThresholdPreference(
				{areaId: 'example', thresholdLux: 40},
				await readThresholdPreferences(otherPath),
				otherPath,
			),
		).rejects.toThrow();
		expect(await readdir(directory)).toEqual([]);
	});
	it('validates version, duplicate rooms, unknown keys and threshold ranges', () => {
		expect(
			thresholdPreferencesSchema.safeParse({
				version: 1,
				rooms: [{areaId: 'example', thresholdLux: 40, active: true}],
			}).success,
		).toBe(false);
	});
	it('bounds the serialized result before opening a writer lock', async () => {
		const snapshot = {
			text: undefined,
			preferences: {
				version: 1 as const,
				rooms: Array.from({length: 128}, (_, index) => ({
					areaId: `${index}${'\u{0}'.repeat(120)}`,
					thresholdLux: 40,
				})),
			},
		};
		await expect(
			changeThresholdPreference(
				{areaId: snapshot.preferences.rooms[0]!.areaId, thresholdLux: 50},
				snapshot,
				path,
			),
		).rejects.toThrow();
		expect(await readdir(directory)).toEqual([]);
	});
});
