import {mkdtemp, rm, readFile, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	runLightingThresholdCli,
	type ThresholdDependencies,
} from '../src/cli/lighting-threshold.js';
import {
	readThresholdPreferences,
	changeThresholdPreference,
} from '../src/lighting-thresholds/preferences.js';
import {resolveThresholdRoom} from '../src/lighting-thresholds/room.js';
import {auditData, location, sensorId, lightId, at} from './lighting-learning-fixture.js';

let directory: string;
let path: string;
let deps: ThresholdDependencies;
const confirm = vi.fn(async (_prompt: string) => true);
const io = {interactive: true, confirm};
const savedRooms = async () => {
	const snapshot = await readThresholdPreferences(path);
	return snapshot.preferences.rooms;
};

const savedThreshold = async () => {
	const rooms = await savedRooms();
	return rooms[0]?.thresholdLux;
};

const args = (mode: string, ...extra: string[]) => ['--area', 'Example Room', mode, ...extra];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'aryal-threshold-cli-'));
	path = join(directory, 'preferences.json');
	deps = {
		collect: vi.fn(async () => auditData()),
		now: () => at('2026-10-10T20:00:00Z'),
		read: async () => readThresholdPreferences(path),
		change: vi.fn(
			async (
				change: Parameters<typeof changeThresholdPreference>[0],
				expected: Parameters<typeof changeThresholdPreference>[1],
			) => changeThresholdPreference(change, expected, path),
		),
		client: vi.fn(() => ({
			config: vi.fn(async () => location),
			history: vi.fn(async () => []),
			logbook: vi.fn(async () => []),
		})),
	};
	confirm.mockReset().mockResolvedValue(true);
});
afterEach(async () => rm(directory, {recursive: true, force: true}));

describe('threshold CLI preferences and confirmation', () => {
	it('shows help without HA, environment or file access', async () => {
		const result = await runLightingThresholdCli(['--help'], deps, io);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('--set');
		expect(deps.collect).not.toHaveBeenCalled();
		expect(await readdir(directory)).toEqual([]);
	});
	it.each(
		[
			[],
			['--suggest'],
			args('--set'),
			args('--set', '0'),
			args('--set', '1001'),
			args('--set', 'NaN'),
			args('--set', '-1'),
			args('--set', 'Infinity'),
			args('--show', '--suggest'),
			args('--suggest', '--days', '11'),
			args('--suggest', '--days', '1.5'),
			args('--suggest', '--starting-lux', '0'),
			args('--show', '--days', '2'),
			args('--set', '40', '--json'),
			args('--set', '40', '--yes'),
			args('--suggest', '--json', '--json'),
			['--help', '--suggest'],
			['--area', '--suggest'],
			args('--activate'),
		].map((input) => ({input})),
	)('rejects invalid input before reads: $input', async ({input}) => {
		await expect(runLightingThresholdCli(input, deps, io)).resolves.toMatchObject({exitCode: 2});
		expect(deps.collect).not.toHaveBeenCalled();
		expect(deps.change).not.toHaveBeenCalled();
	});
	it('requires interactive confirmation for writes before any reads', async () => {
		const result = await runLightingThresholdCli(args('--set', '40'), deps, {
			...io,
			interactive: false,
		});
		expect(result.exitCode).toBe(2);
		expect(deps.collect).not.toHaveBeenCalled();
		expect(deps.change).not.toHaveBeenCalled();
	});
	it('suggests without creating preferences or prompting', async () => {
		const result = await runLightingThresholdCli(args('--suggest'), deps, io);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Suggested darkness threshold: 40 lx');
		expect(result.output).toContain('Current brightness: 30 lx');
		expect(result.output).toContain('Dark');
		expect(result.output).toContain('not a learned preference');
		expect(confirm).not.toHaveBeenCalled();
		expect(deps.change).not.toHaveBeenCalled();
		expect(await readdir(directory)).toEqual([]);
	});
	it('saves only after a preview and explicit yes, then shows and adjusts without history', async () => {
		const result = await runLightingThresholdCli(args('--set', '40'), deps, io);
		expect(result.exitCode).toBe(0);
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining('not set -> 40 lx'));
		expect(await savedRooms()).toEqual([{areaId: 'example_area', thresholdLux: 40}]);
		const shown = await runLightingThresholdCli(args('--show', '--json'), deps, io);
		expect(JSON.parse(shown.output)).toMatchObject({
			configuredLux: 40,
			current: {assessment: 'dark'},
			runtimeEffect: 'none',
		});
		await runLightingThresholdCli(args('--set', '20'), deps, io);
		expect(await savedThreshold()).toBe(20);
		expect(deps.client).not.toHaveBeenCalled();
	});
	it('declines safely without creating a file', async () => {
		confirm.mockResolvedValue(false);
		const result = await runLightingThresholdCli(args('--set', '40'), deps, io);
		expect(result.output).toContain('Declined');
		expect(deps.change).not.toHaveBeenCalled();
		expect(await readdir(directory)).toEqual([]);
	});
	it('resets only after confirmation, removes the stored threshold and leaves no active default', async () => {
		await runLightingThresholdCli(args('--set', '40'), deps, io);
		confirm.mockResolvedValue(false);
		await runLightingThresholdCli(args('--reset'), deps, io);
		expect(await savedRooms()).toHaveLength(1);
		confirm.mockResolvedValue(true);
		await runLightingThresholdCli(args('--reset'), deps, io);
		expect(await savedRooms()).toEqual([]);
		const shown = await runLightingThresholdCli(args('--show'), deps, io);
		expect(shown.output).toContain('not set');
		expect(shown.output).toContain('no_configured_threshold');
	});
	it('does not prompt or write when the preference already matches', async () => {
		await runLightingThresholdCli(args('--reset'), deps, io);
		expect(confirm).not.toHaveBeenCalled();
		await runLightingThresholdCli(args('--set', '40'), deps, io);
		confirm.mockClear();
		vi.mocked(deps.change).mockClear();
		await runLightingThresholdCli(args('--set', '40'), deps, io);
		expect(confirm).not.toHaveBeenCalled();
		expect(deps.change).not.toHaveBeenCalled();
	});
	it('refuses to overwrite a malformed preference file', async () => {
		await writeFile(path, 'broken');
		await expect(runLightingThresholdCli(args('--set', '40'), deps, io)).resolves.toMatchObject({
			exitCode: 1,
		});
		expect(confirm).not.toHaveBeenCalled();
		expect(await readFile(path, 'utf8')).toBe('broken');
	});
	it('refuses a concurrent change made while the confirmation is pending', async () => {
		confirm.mockImplementationOnce(async () => {
			await writeFile(path, '{"version":1,"rooms":[]}');
			return true;
		});
		await expect(runLightingThresholdCli(args('--set', '40'), deps, io)).resolves.toMatchObject({
			exitCode: 1,
		});
		expect(await savedRooms()).toEqual([]);
	});
	it('keeps configured values separate from suggestions', async () => {
		await runLightingThresholdCli(args('--set', '60'), deps, io);
		const result = await runLightingThresholdCli(
			args('--suggest', '--starting-lux', '50', '--json'),
			deps,
			io,
		);
		expect(JSON.parse(result.output)).toMatchObject({configuredLux: 60, suggestedLux: 50});
		expect(await savedThreshold()).toBe(60);
	});
});

describe('policy, room and privacy restrictions', () => {
	it.each([
		'sensor_denied',
		'no_policy',
		'sensor_unavailable',
		'sensor_disabled',
		'multiple_sensors',
		'wrong_room',
		'missing_area',
	])('does not expose lux for %s', async (condition) => {
		const data = auditData();
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		switch (condition) {
			case 'sensor_denied': {
				data.policy!.deny.push({entityId: sensorId});

				break;
			}

			case 'no_policy': {
				data.policy = undefined;

				break;
			}

			case 'sensor_unavailable': {
				data.states[1]!.state = 'unavailable';

				break;
			}

			case 'sensor_disabled': {
				data.registries.entities[1]!.disabled_by = 'user';

				break;
			}

			case 'wrong_room': {
				data.registries.entities[1]!.area_id = 'other_area';
				data.registries.areas.push({area_id: 'other_area', name: 'Other', aliases: [], labels: []});

				break;
			}

			case 'missing_area': {
				data.registries.devices[0]!.area_id = null;
				data.states[1]!.attributes.area_name = 'Example Room';

				break;
			}

			case 'multiple_sensors': {
				data.states.push({...data.states[1]!, entity_id: 'sensor.example_second'});
				data.registries.entities.push({
					...data.registries.entities[1]!,
					entity_id: 'sensor.example_second',
				});
				data.policy!.allow.push({entityId: 'sensor.example_second'});

				break;
			}
			// No default
		}

		vi.mocked(deps.collect).mockResolvedValue(data);
		const result = await runLightingThresholdCli(args('--suggest', '--json'), deps, io);
		const report = JSON.parse(result.output) as {
			current: {assessment: string};
			suggestedLux: number;
		};
		expect(report.current.assessment).toBe('insufficient_context');
		expect(report.suggestedLux).toBe(40);
		expect(result.output).not.toContain('"lux"');
		expect(deps.change).not.toHaveBeenCalled();
	});
	it('never treats denied or unavailable lights as complete history coverage', () => {
		const data = auditData();
		data.policy!.deny.push({entityId: lightId});
		expect(resolveThresholdRoom(data, 'Example Room').lightCoverageComplete).toBe(false);
	});
	it.each(['missing_state', 'unavailable', 'disabled', 'incomplete_metadata'])(
		'refuses history coverage when another registered room light is %s',
		async (condition) => {
			const data = auditData();
			if (data.registries.status !== 'available') {
				throw new Error('fixture');
			}

			data.registries.entities.push({
				...data.registries.entities[0]!,
				entity_id: 'light.example_second',
				disabled_by: condition === 'disabled' ? 'user' : null,
				labels: condition === 'incomplete_metadata' ? ['example_missing_label'] : [],
			});
			if (condition !== 'missing_state') {
				data.states.push({
					...data.states[0]!,
					entity_id: 'light.example_second',
					state: condition === 'unavailable' ? 'unavailable' : 'off',
				});
			}

			expect(resolveThresholdRoom(data, 'Example Room').lightCoverageComplete).toBe(false);
			vi.mocked(deps.collect).mockResolvedValue(data);
			const transport = deps.client();
			vi.mocked(deps.client).mockReturnValue(transport);
			const result = await runLightingThresholdCli(args('--suggest', '--json'), deps, io);
			expect(JSON.parse(result.output)).toMatchObject({
				current: {assessment: 'dark'},
				evidence: {status: 'incomplete_sensor_or_light_coverage'},
			});
			expect(transport.history).not.toHaveBeenCalled();
		},
	);
	it('saving a local preference never grants exposure to a denied sensor', async () => {
		const data = auditData();
		data.policy!.deny.push({entityId: sensorId});
		const policy = structuredClone(data.policy);
		vi.mocked(deps.collect).mockResolvedValue(data);
		const result = await runLightingThresholdCli(args('--set', '40'), deps, io);
		expect(result.exitCode).toBe(0);
		expect(data.policy).toEqual(policy);
		const shown = await runLightingThresholdCli(args('--show', '--json'), deps, io);
		expect(JSON.parse(shown.output)).toMatchObject({
			configuredLux: 40,
			current: {assessment: 'insufficient_context'},
		});
	});
	it('keeps preferences associated with stable registry area IDs after a room rename', async () => {
		await runLightingThresholdCli(args('--set', '40'), deps, io);
		const data = auditData();
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		data.registries.areas[0]!.name = 'Renamed Room';
		vi.mocked(deps.collect).mockResolvedValue(data);
		const result = await runLightingThresholdCli(
			['--area', 'Renamed Room', '--show', '--json'],
			deps,
			io,
		);
		expect(JSON.parse(result.output)).toMatchObject({configuredLux: 40});
	});
	it('does not print sensor IDs, credentials, raw history or private exceptions', async () => {
		const result = await runLightingThresholdCli(args('--suggest', '--json'), deps, io);
		for (const value of [
			sensorId,
			lightId,
			'example_area',
			'private-test-token',
			'ha.example.test',
			'last_changed',
		]) {
			expect(result.output).not.toContain(value);
		}

		vi.mocked(deps.collect).mockRejectedValue(
			new Error('private-test-token https://ha.example.test'),
		);
		const failed = await runLightingThresholdCli(args('--suggest'), deps, io);
		expect(failed.exitCode).toBe(1);
		expect(failed.output).not.toContain('private-test-token');
	});
});
