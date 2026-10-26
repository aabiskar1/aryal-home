import {describe, expect, it, vi} from 'vitest';
import type {createHistoryClient} from '../src/home-assistant/history-client.js';
import {
	collectAmbientHistory,
	summariseAmbientHistory,
} from '../src/lighting-thresholds/history.js';
import {resolveThresholdRoom} from '../src/lighting-thresholds/room.js';
import {buildThresholdReport} from '../src/lighting-thresholds/recommendation.js';
import {auditData, historical, lightId, location, lux, at} from './lighting-learning-fixture.js';

const start = at('2026-10-10T00:00:00Z');
const end = at('2026-10-12T00:00:00Z');
const sensor = Array.from({length: 16}, (_, index) => {
	const offset = index * 5;
	return lux(
		String(10 + offset),
		`2026-10-${index < 8 ? '10' : '11'}T${String(12 + Math.floor((index % 8) / 2)).padStart(2, '0')}:${index % 2 === 0 ? '00' : '30'}:00Z`,
	);
});
const off = historical(lightId, 'off', '2026-10-10T00:00:00Z');
const summarise = (extra: Partial<Parameters<typeof summariseAmbientHistory>[0]> = {}) =>
	summariseAmbientHistory({
		sensor,
		lights: [[off]],
		start,
		end,
		location,
		thresholdLux: 40,
		days: 2,
		...extra,
	});
const client = () => ({
	config: vi.fn(async () => location),
	history: vi.fn(
		async (_request: Parameters<ReturnType<typeof createHistoryClient>['history']>[0]) => [
			[off],
			[lux('20', '2026-10-10T00:00:00Z'), ...sensor],
		],
	),
	logbook: vi.fn(async () => []),
});

describe('ambient history checks without learned preferences', () => {
	it('checks the starting point using half-hour observations over multiple local dates', () => {
		expect(summarise()).toMatchObject({
			status: 'starting_point_within_observed_range',
			halfHourBins: 16,
			localDays: 2,
			alignedOffReadings: 16,
		});
	});
	it.each([
		{value: '1', status: 'starting_point_above_observed_range'},
		{value: '100', status: 'starting_point_below_observed_range'},
	])(
		'explains observations around $value lx without inventing a new threshold',
		({value, status}) => {
			expect(summarise({sensor: sensor.map((row) => ({...row, state: value}))}).status).toBe(
				status,
			);
		},
	);
	it('does not let frequent sensor updates dominate the observational check', () => {
		const repeated = [...sensor, lux('900', '2026-10-10T12:01:00Z')];
		expect(summarise({sensor: repeated}).halfHourBins).toBe(16);
		expect(summarise({sensor: repeated}).observedLux).toEqual(summarise().observedLux);
	});
	it.each(['on', 'unknown', 'unavailable'])(
		'rejects alignment when a known light is %s',
		(state) => {
			expect(summarise({lights: [[{...off, state}]]})).toMatchObject({
				status: 'insufficient_off_light_history',
				halfHourBins: 0,
			});
		},
	);
	it('requires every supplied light to have off-state evidence', () => {
		expect(summarise({lights: [[off], []]}).halfHourBins).toBe(0);
		expect(summarise({lights: []}).halfHourBins).toBe(0);
	});
	it('does not apply a current or future off state to an earlier reading', () => {
		expect(
			summarise({
				sensor: [sensor[0]!],
				lights: [[historical(lightId, 'off', '2026-10-10T13:00:00Z')]],
			}).halfHourBins,
		).toBe(0);
	});
	it('requires a one-minute settling period after switch-off', () => {
		const time = '2026-10-10T12:00:00Z';
		expect(
			summarise({
				sensor: [lux('30', time)],
				lights: [[historical(lightId, 'off', '2026-10-10T11:59:01Z')]],
			}).halfHourBins,
		).toBe(0);
		expect(
			summarise({
				sensor: [lux('30', time)],
				lights: [[historical(lightId, 'off', '2026-10-10T11:59:00Z')]],
			}).halfHourBins,
		).toBe(1);
	});
	it('excludes restored light states, snapshots and attribute-only sensor updates', () => {
		expect(summarise({lights: [[{...off, attributes: {restored: true}}]]}).halfHourBins).toBe(0);
		expect(
			summarise({sensor: sensor.map((row) => ({...row, initialSnapshot: true}))}).halfHourBins,
		).toBe(0);
		expect(
			summarise({sensor: sensor.map((row) => ({...row, last_changed: off.last_changed}))})
				.halfHourBins,
		).toBe(0);
	});
	it('deduplicates and orders samples, preserving conflicting states as barriers', () => {
		expect(summarise({sensor: [...sensor, ...sensor]}).halfHourBins).toBe(16);
		const rows = [sensor[0]!, {...sensor[0]!, state: '900'}];
		expect(summarise({sensor: rows}).halfHourBins).toBe(0);
	});
	it.each(['NaN', 'Infinity', '-1', 'unknown'])(
		'rejects invalid historical readings %s',
		(state) => {
			expect(summarise({sensor: sensor.map((row) => ({...row, state}))}).halfHourBins).toBe(0);
		},
	);
	it('rejects incompatible historical units and classes', () => {
		expect(
			summarise({
				sensor: sensor.map((row) => ({
					...row,
					attributes: {device_class: 'illuminance', unit_of_measurement: 'lm'},
				})),
			}).halfHourBins,
		).toBe(0);
	});
	it('reports sparse coverage rather than treating a single day as sufficient', () => {
		expect(summarise({sensor: sensor.slice(0, 8)}).status).toBe('insufficient_off_light_history');
	});
	it('uses historical local time and solar conditions, never today’s state', () => {
		const result = summarise({
			sensor: [lux('30', '2026-10-10T00:30:00Z'), lux('35', '2026-10-10T12:30:00Z')],
		});
		expect(result.daylightCounts).toEqual({night: 1, daylight: 1});
		expect(result.contextCoverage).toBe('daylight_and_night_observed');
		expect(result.timeOfDayCounts).toEqual({night: 1, afternoon: 1});
	});
	it('marks single-condition observations as limited instead of validating the full day', () => {
		expect(summarise().contextCoverage).toBe('limited_daylight_conditions');
		expect(summarise({sensor: []}).contextCoverage).toBe('unavailable');
	});
	it('handles DST repeated hours without merging distinct UTC bins', () => {
		const result = summarise({
			start: at('2026-10-25T00:00:00Z'),
			end: at('2026-10-26T00:00:00Z'),
			sensor: [lux('20', '2026-10-25T01:30:00+01:00'), lux('25', '2026-10-25T01:30:00+00:00')],
			lights: [[historical(lightId, 'off', '2026-10-24T23:00:00Z')]],
		});
		expect(result).toMatchObject({halfHourBins: 2, localDays: 1});
	});
});

describe('bounded history collection and practical default fallback', () => {
	it('uses restricted daily history requests and no logbook/model calls', async () => {
		const transport = client();
		await collectAmbientHistory({
			room: resolveThresholdRoom(auditData(), 'Example Room'),
			client: transport,
			days: 3,
			now: end,
			thresholdLux: 40,
		});
		expect(transport.history).toHaveBeenCalledTimes(3);
		for (const [input] of transport.history.mock.calls) {
			expect(input).toMatchObject({entityIds: ['sensor.example_illuminance', lightId]});
			expect(Date.parse(input.end) - Date.parse(input.start)).toBe(86_400_000);
		}

		expect(transport.logbook).not.toHaveBeenCalled();
	});
	it('keeps a labelled practical starting point on history failure', async () => {
		const transport = client();
		transport.history.mockRejectedValue(new Error('private error'));
		const room = resolveThresholdRoom(auditData(), 'Example Room');
		const report = await buildThresholdReport({
			room,
			mode: 'suggest',
			configuredLux: undefined,
			now: at('2026-10-10T20:00:00Z'),
			client: transport,
		});
		expect(report).toMatchObject({
			suggestedLux: 40,
			source: 'practical_starting_point_not_learned',
			evidence: {status: 'history_or_solar_context_unavailable'},
			runtimeEffect: 'none',
		});
	});
	it('does not request history with incomplete light coverage', async () => {
		const transport = client();
		const room = {
			...resolveThresholdRoom(auditData(), 'Example Room'),
			lightCoverageComplete: false,
		};
		const result = await collectAmbientHistory({
			room,
			client: transport,
			days: 3,
			now: end,
			thresholdLux: 40,
		});
		expect(result.evidence.status).toBe('incomplete_sensor_or_light_coverage');
		expect(transport.history).not.toHaveBeenCalled();
	});
	it('does not carry old light states across a missing daily series', async () => {
		const transport = client();
		transport.history.mockResolvedValueOnce([[off], [sensor[0]!]]);
		transport.history.mockResolvedValueOnce([sensor.slice(8)]);
		const result = await collectAmbientHistory({
			room: resolveThresholdRoom(auditData(), 'Example Room'),
			client: transport,
			days: 2,
			now: end,
			thresholdLux: 40,
		});
		expect(result.evidence).toMatchObject({
			status: 'history_or_solar_context_unavailable',
			halfHourBins: 0,
		});
	});
	it('does not silently alter an adjusted practical starting point', async () => {
		const room = resolveThresholdRoom(auditData(), 'Example Room');
		const report = await buildThresholdReport({
			room,
			mode: 'suggest',
			configuredLux: 70,
			startingLux: 50,
			now: at('2026-10-10T20:00:00Z'),
			client: client(),
		});
		expect(report).toMatchObject({
			suggestedLux: 50,
			configuredLux: 70,
			current: {thresholdLux: 50},
			source: 'practical_starting_point_not_learned',
		});
	});
});
