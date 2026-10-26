import {describe, expect, it} from 'vitest';
import {
	evaluateDarkness,
	PRACTICAL_DARKNESS_LUX,
	thresholdLuxSchema,
} from '../src/lighting-thresholds/evaluation.js';

const now = Date.parse('2026-10-11T20:00:00Z');
const measurement = {
	domain: 'sensor',
	deviceClass: 'illuminance',
	unit: 'lx',
	state: '28',
	measuredAt: '2026-10-11T19:59:00Z',
	updatedAt: '2026-10-11T19:59:00Z',
};
const assess = (fields: Record<string, unknown> = {}, thresholdLux: unknown = 40) =>
	evaluateDarkness({thresholdLux, now, measurement: {...measurement, ...fields}});

describe('standalone deterministic darkness evaluation', () => {
	it('exposes 40 lx as a practical heuristic, not an inferred preference', () => {
		expect(PRACTICAL_DARKNESS_LUX).toBe(40);
	});
	it.each([
		{state: '0', assessment: 'dark'},
		{state: '28', assessment: 'dark'},
		{state: '39.99', assessment: 'dark'},
		{state: '40', assessment: 'not_dark'},
		{state: '41', assessment: 'not_dark'},
	])('compares $state lx with the configured threshold', ({state, assessment}) => {
		expect(assess({state}).assessment).toBe(assessment);
	});
	it('uses a supplied threshold without modifying the practical default', () => {
		expect(assess({state: '50'}, 60).assessment).toBe('dark');
		expect(assess({state: '50'}).assessment).toBe('not_dark');
	});
	it.each([0, -1, 1001, NaN, Infinity, '40', null])(
		'rejects invalid thresholds %s',
		(thresholdLux) => {
			expect(assess({}, thresholdLux)).toEqual({
				assessment: 'insufficient_context',
				reason: 'invalid_threshold',
			});
			expect(thresholdLuxSchema.safeParse(thresholdLux).success).toBe(false);
		},
	);
	it.each(['NaN', 'Infinity', '-1', 'unknown', 'unavailable', '0x20', '', 'twenty'])(
		'rejects invalid lux %s',
		(state) => {
			expect(assess({state}).assessment).toBe('insufficient_context');
		},
	);
	it.each([
		{unit: 'lux'},
		{unit: '%'},
		{deviceClass: 'brightness'},
		{deviceClass: 'temperature'},
		{domain: 'light'},
		{measuredAt: ''},
		{measuredAt: '2026-10-11T19:59:00'},
		{updatedAt: undefined},
	])('rejects missing or incompatible evidence %j', (fields) => {
		expect(assess(fields).assessment).toBe('insufficient_context');
	});
	it('rejects stale readings even when attributes updated recently', () => {
		expect(assess({measuredAt: '2026-10-11T19:00:00Z'})).toEqual({
			assessment: 'insufficient_context',
			reason: 'stale_measurement',
		});
	});
	it('accepts exactly five minutes but rejects older evidence', () => {
		expect(assess({measuredAt: '2026-10-11T19:55:00Z'}).assessment).toBe('dark');
		expect(assess({measuredAt: '2026-10-11T19:54:59Z'}).assessment).toBe('insufficient_context');
	});
	it.each([
		{updatedAt: '2026-10-11T20:00:01Z'},
		{measuredAt: '2026-10-11T20:00:01Z'},
		{measuredAt: '2026-10-11T19:59:30Z'},
	])('rejects future or inconsistent timestamps %j', (fields) => {
		expect(assess(fields)).toEqual({
			assessment: 'insufficient_context',
			reason: 'invalid_measurement_time',
		});
	});
	it('normalizes explicit timezone offsets', () => {
		expect(
			assess({measuredAt: '2026-10-11T20:59:00+01:00', updatedAt: '2026-10-11T20:59:00+01:00'})
				.assessment,
		).toBe('dark');
	});
	it.each([undefined, null, {state: '28'}])(
		'does not infer brightness without a measurement %j',
		(value) => {
			expect(evaluateDarkness({thresholdLux: 40, measurement: value, now}).assessment).toBe(
				'insufficient_context',
			);
		},
	);
});
