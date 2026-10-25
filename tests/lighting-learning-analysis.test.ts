import {describe, expect, it, vi} from 'vitest';
import {
	analyseLightingHistory,
	type LearningDependencies,
} from '../src/lighting-learning/analysis.js';
import {selectLightingScope} from '../src/lighting-learning/scope.js';
import {formatLearningReport, runLearnLightingCli} from '../src/cli/learn-lighting.js';
import {
	auditData,
	historical,
	lightId,
	location,
	lux,
	sensorId,
	transition,
} from './lighting-learning-fixture.js';

const dependencies = (): LearningDependencies => ({
	collect: vi.fn(async () => auditData()),
	client: {
		config: vi.fn(async () => location),
		history: vi.fn(async () => [
			[historical(lightId, 'off', '2026-10-10T19:00:00Z'), ...transition()],
			[lux('20', '2026-10-10T19:50:00Z'), lux()],
		]),
		logbook: vi.fn(async () => []),
	},
	now: () => new Date('2026-10-11T00:00:00Z'),
});

describe('policy and metadata selection', () => {
	it('discovers exact supported sensor and light through registry device area and existing policy', () => {
		const selected = selectLightingScope(auditData(), 'example alias');
		expect(selected.kind).toBe('available');
		if (selected.kind === 'available') {
			expect(selected.scope.sensor.entityId).toBe(sensorId);
			expect(selected.scope.lights.map((light) => light.entityId)).toEqual([lightId]);
		}
	});
	it.each([lightId, sensorId])('excludes denied %s without granting anything', (entityId) => {
		const data = auditData();
		data.policy!.deny.push({entityId});
		const before = structuredClone(data.policy);
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
		expect(data.policy).toEqual(before);
	});
	it('defaults to deny when policy is absent', () => {
		const data = auditData();
		data.policy = undefined;
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it.each(['unknown', 'unavailable'])('excludes currently %s sensors', (state) => {
		const data = auditData();
		data.states[1]!.state = state;
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it.each(['humidity', 'brightness', 'motion', ''])(
		'does not infer illuminance from a sensor name or class %s',
		(device_class) => {
			const data = auditData();
			data.states[1]!.attributes.device_class = device_class;
			expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
		},
	);
	it.each(['lm', 'lux', ''])('requires canonical current lx units: %s', (unit) => {
		const data = auditData();
		data.states[1]!.attributes.unit_of_measurement = unit;
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it.each(['NaN', '-1', 'Infinity', '0x10'])('rejects invalid current reading %s', (reading) => {
		const data = auditData();
		data.states[1]!.state = reading;
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it('does not select a second, wrong-room sensor', () => {
		const data = auditData();
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		data.registries.entities[1]!.area_id = 'other_area';
		data.registries.areas.push({
			area_id: 'other_area',
			name: 'Other Room',
			aliases: [],
			labels: [],
		});
		data.states[1]!.attributes.area_name = 'Example Room';
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it('rejects multiple permitted illuminance sensors instead of averaging or choosing', () => {
		const data = auditData();
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		data.states.push({...lux(), entity_id: 'sensor.example_second'});
		data.registries.entities.push({
			...data.registries.entities[1]!,
			entity_id: 'sensor.example_second',
		});
		data.policy!.allow.push({entityId: 'sensor.example_second'});
		expect(selectLightingScope(data, 'Example Room')).toMatchObject({
			kind: 'unsupported_configuration',
			reason: 'multiple_illuminance_sensors',
		});
	});
	it.each(['entity', 'device', 'parent'] as const)('excludes %s disablement', (level) => {
		const data = auditData();
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		if (level === 'entity') {
			data.registries.entities[1]!.disabled_by = 'user';
		} else if (level === 'device') {
			data.registries.devices[0]!.disabled_by = 'user';
		} else {
			data.registries.devices[0]!.parent_device_id = 'example_parent';
			data.registries.devices.push({
				id: 'example_parent',
				area_id: null,
				labels: [],
				disabled_by: 'user',
			});
		}

		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it('requires complete registry associations, never friendly-name room inference', () => {
		const data = auditData();
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		data.registries.devices[0]!.area_id = null;
		data.states[1]!.attributes.friendly_name = 'Example Room Illuminance';
		data.states[1]!.attributes.area_name = 'Example Room';
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
	});
	it('fails closed on registry failure, incomplete references and ambiguous areas', () => {
		const data = auditData();
		expect(
			selectLightingScope({...data, registries: {status: 'unavailable'}}, 'Example Room').kind,
		).toBe('unsupported_configuration');
		if (data.registries.status !== 'available') {
			throw new Error('fixture');
		}

		data.registries.entities[1]!.device_id = 'missing_device';
		expect(selectLightingScope(data, 'Example Room').kind).toBe('unsupported_configuration');
		data.registries.areas.push({
			area_id: 'example_second_area',
			name: 'Other',
			aliases: ['Example Room'],
			labels: [],
		});
		expect(selectLightingScope(data, 'Example Room')).toMatchObject({
			reason: 'area_missing_or_ambiguous',
		});
	});
	it('recognizes only explicit group membership metadata', () => {
		const data = auditData();
		data.states[0]!.attributes.entity_id = ['light.example_member'];
		const result = selectLightingScope(data, 'Example Room');
		expect(result.kind === 'available' && result.scope.aggregateIds.has(lightId)).toBe(true);
		data.states[0]!.attributes.entity_id = 'invalid';
		expect(selectLightingScope(data, 'Example Room')).toMatchObject({
			reason: 'invalid_group_membership',
		});
	});
});

describe('read-only analysis orchestration', () => {
	it('uses bounded daily slices, restricted targets and explicit end times', async () => {
		const deps = dependencies();
		const report = await analyseLightingHistory({area: 'Example Room', days: 10}, deps);
		expect(deps.client.history).toHaveBeenCalledTimes(10);
		for (const [input] of vi.mocked(deps.client.history).mock.calls) {
			expect(input.entityIds).toEqual([sensorId, lightId]);
			expect(Date.parse(input.end) - Date.parse(input.start)).toBe(86_400_000);
		}

		expect(report).toMatchObject({
			sensors: 1,
			lights: 1,
			status: 'not_activated',
			assessment: 'ambiguous_event_provenance',
		});
		expect(report.estimate?.estimatedLux).toBeUndefined();
	});
	it('enriches descriptive events with historical daylight and local temporal bins', async () => {
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, dependencies());
		expect(report.context).toMatchObject({
			timezoneAvailable: true,
			solar: 'approximate_configured_location',
			weather: 'not_collected',
			daylightCounts: {night: 1},
			timeOfDayCounts: {evening: 1},
		});
	});
	it('reports missing Recorder history without claiming exclusion or retention was proven', async () => {
		const deps = dependencies();
		vi.mocked(deps.client.history).mockResolvedValue([]);
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, deps);
		expect(report).toMatchObject({
			assessment: 'insufficient_history',
			reason: 'missing_history_possible_recorder_exclusion_or_retention',
		});
		expect(report.history).toMatchObject({
			missingSeries: 2,
			samples: 0,
			coverage: 'unverified_recorder_retention_and_exclusions',
		});
	});
	it('does not fail otherwise valid analysis when logbook attribution is unavailable', async () => {
		const deps = dependencies();
		vi.mocked(deps.client.logbook).mockRejectedValue(new Error('private failure'));
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, deps);
		expect(report.history.logbook).toBe('unavailable');
		expect(report.assessment).toBe('ambiguous_event_provenance');
	});
	it('marks all earliest timestamp duplicates as snapshots even when the response is reordered', async () => {
		const deps = dependencies();
		const changes = transition();
		const history = [
			[changes[1]!, changes[0]!],
			[lux(), lux('20', '2026-10-10T19:50:00Z')],
		];
		vi.mocked(deps.client.history).mockResolvedValue(history);
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, deps);
		expect(report.events.episodes).toBe(1);
		expect(report.events.withFreshLux).toBe(1);
	});
	it('does not substitute current or mismatched weather for historical evidence', async () => {
		const deps = dependencies();
		const data = auditData();
		data.states.push({
			...historical('weather.example', 'sunny'),
			attributes: {cloud_coverage: 0, forecast: [{datetime: '2026-10-10T20:00:00Z'}]},
		});
		vi.mocked(deps.collect).mockResolvedValue(data);
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, deps);
		expect(report.context.weather).toBe('not_collected');
		expect(deps.client.history).toHaveBeenCalledWith(
			expect.objectContaining({entityIds: [sensorId, lightId]}),
		);
	});
	it('does not read history or configuration for denied or unsupported room scopes', async () => {
		const deps = dependencies();
		const data = auditData();
		data.policy!.deny.push({entityId: sensorId});
		vi.mocked(deps.collect).mockResolvedValue(data);
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, deps);
		expect(report.assessment).toBe('unsupported_configuration');
		expect(deps.client.history).not.toHaveBeenCalled();
		expect(deps.client.config).not.toHaveBeenCalled();
	});
	it.each([0, 31, 1.5, NaN])('rejects invalid lookback %s before any reads', async (days) => {
		const deps = dependencies();
		await expect(analyseLightingHistory({area: 'Example Room', days}, deps)).rejects.toThrow();
		expect(deps.collect).not.toHaveBeenCalled();
	});
});

describe('learning CLI and privacy', () => {
	it('provides help without configuration or HA access', async () => {
		const analyse = vi.fn();
		const result = await runLearnLightingCli(['--help'], analyse);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('--days');
		expect(analyse).not.toHaveBeenCalled();
	});
	it.each(
		[
			[],
			['--area'],
			['--area', '--json'],
			['--days', '10'],
			['--area', 'Example Room', '--days', '31'],
			['--area', 'Example Room', '--days', '1.5'],
			['--area', 'Example Room', '--days', 'NaN'],
			['--area', 'Example Room', '--days', ''],
			['--area', 'Example Room', '--json', '--json'],
			['--area', 'Example Room', '--activate'],
			['--help', '--json'],
		].map((args) => ({args})),
	)('rejects invalid arguments before reads: %j', async ({args}) => {
		const analyse = vi.fn();
		const result = await runLearnLightingCli(args, analyse);
		expect(result.exitCode).toBe(2);
		expect(analyse).not.toHaveBeenCalled();
	});
	it('defaults to ten days and returns an understandable insufficient assessment', async () => {
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, dependencies());
		const analyse = vi.fn(async () => report);
		const result = await runLearnLightingCli(['--area', 'Example Room'], analyse);
		expect(analyse).toHaveBeenCalledWith({area: 'Example Room', days: 10});
		expect(result.output).toContain('ambiguous_event_provenance');
		expect(result.output).toContain('no preference activated');
	});
	it('redacts credentials and omits entity IDs, coordinates, event logs, user IDs and reading times', async () => {
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, dependencies());
		report.area = 'private-test-token https://ha.example.test 192.0.2.1\u{1B}';
		const modes: boolean[] = [false, true];
		for (const mode of modes) {
			const output = formatLearningReport(report, mode);
			for (const privateValue of [
				'private-test-token',
				'ha.example.test',
				'192.0.2.1',
				lightId,
				sensorId,
				'latitude',
				'longitude',
				'2026-10-10',
				'\u{1B}',
			]) {
				expect(output).not.toContain(privateValue);
			}
		}
	});
	it('never prints raw exceptions or echoes invalid private input', async () => {
		const result = await runLearnLightingCli(['--area', 'Example Room'], async () => {
			throw new Error('private-test-token https://ha.example.test');
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('analysis_failed');
		expect(result.output).not.toContain('private-test-token');
	});
	it('supports aggregate JSON without raw history', async () => {
		const report = await analyseLightingHistory({area: 'Example Room', days: 1}, dependencies());
		const result = await runLearnLightingCli(
			['--area', 'Example Room', '--days', '1', '--json'],
			async () => report,
		);
		expect(JSON.parse(result.output)).toMatchObject({
			status: 'not_activated',
			events: {episodes: 1},
		});
	});
});
