import {describe, expect, it} from 'vitest';
import {estimateLightingPreference, quantile} from '../src/lighting-learning/estimator.js';
import {
	classifyDaylight,
	enrichEpisode,
	solarElevationAt,
} from '../src/lighting-learning/context.js';
import {at, episode, location, stableEpisodes} from './lighting-learning-fixture.js';

describe('deterministic advisory estimation', () => {
	it('estimates a stable distribution across six independent local days', () => {
		const result = estimateLightingPreference(stableEpisodes());
		expect(result).toMatchObject({
			assessment: 'suggestion_available',
			reliableEpisodes: 12,
			independentDays: 6,
			supportingSamples: 12,
			outlierSamples: 0,
		});
		expect(result.estimatedLux).toBeGreaterThanOrEqual(28);
		expect(result.estimatedLux).toBeLessThanOrEqual(32);
		expect(result).not.toHaveProperty('confidence');
		expect(result).not.toHaveProperty('activeThreshold');
	});
	it('returns an honest empty-history assessment', () => {
		expect(estimateLightingPreference([]).assessment).toBe('insufficient_history');
	});
	it.each([1, 2, 7])('rejects only %i independent samples', (count) => {
		expect(estimateLightingPreference(stableEpisodes().slice(0, count)).assessment).toBe(
			'insufficient_reliable_events',
		);
	});
	it('rejects many readings from a single evening', () => {
		const events = stableEpisodes().map((event) => ({
			...event,
			context: {...event.context, localDate: '2026-10-10'},
		}));
		expect(estimateLightingPreference(events)).toMatchObject({
			assessment: 'insufficient_reliable_events',
			reason: 'minimum_independent_days_not_met',
		});
	});
	it.each([
		'unknown_origin',
		'user_attributed_origin_unverified',
		'external_context_attributed',
		'automation_or_script_attributed',
	] as const)('never uses %s as primary preference evidence', (provenance) => {
		const result = estimateLightingPreference(
			stableEpisodes().map((event) => ({...event, provenance})),
		);
		expect(result.assessment).not.toBe('suggestion_available');
		expect(result.reliableEpisodes).toBe(0);
		expect(result.estimatedLux).toBeUndefined();
	});
	it('does not count simultaneous unverified decisions as independent', () => {
		expect(
			estimateLightingPreference(stableEpisodes().map((event) => ({...event, independent: false})))
				.assessment,
		).toBe('insufficient_reliable_events');
	});
	it('requires pre-event sensor coverage on enough episodes and days', () => {
		const events = stableEpisodes().map((event, index) => ({
			...event,
			lux: index < 7 ? event.lux : undefined,
		}));
		expect(estimateLightingPreference(events).assessment).toBe('insufficient_sensor_coverage');
	});
	it.each([NaN, Infinity, -1])('rejects nonfinite/negative estimator inputs %s', (lux) => {
		expect(
			estimateLightingPreference(stableEpisodes().map((event) => ({...event, lux}))).assessment,
		).toBe('insufficient_sensor_coverage');
	});
	it('resists one unusual reading while reporting its exclusion', () => {
		const events = stableEpisodes();
		events.push(episode('2026-10-16T20:00:00Z', 1000));
		const result = estimateLightingPreference(events);
		expect(result).toMatchObject({
			assessment: 'suggestion_available',
			outlierSamples: 1,
			supportingSamples: 12,
		});
		expect(result.estimatedLux).toBeLessThan(40);
	});
	it('rejects a wide/conflicting distribution', () => {
		const events = stableEpisodes().map((event, index) => ({
			...event,
			lux: index % 2 === 0 ? 10 : 150,
		}));
		expect(estimateLightingPreference(events).assessment).toBe('unstable_preference');
	});
	it('detects inconsistent days even if individual day readings are stable', () => {
		const events = stableEpisodes().map((event, index) => ({...event, lux: index < 6 ? 15 : 60}));
		expect(estimateLightingPreference(events).assessment).toBe('unstable_preference');
	});
	it('rejects materially different daylight patterns rather than reporting a pooled threshold', () => {
		const events = stableEpisodes().map((event, index) => ({
			...event,
			lux: index < 6 ? 10 : 70,
			context: {...event.context, daylight: index < 6 ? ('night' as const) : ('daylight' as const)},
		}));
		expect(estimateLightingPreference(events)).toMatchObject({
			assessment: 'unstable_preference',
			reason: 'contextual_patterns_differ',
		});
	});
	it('detects time-of-day differences with multiple days per group', () => {
		const events = stableEpisodes().map((event, index) => ({
			...event,
			lux: index < 6 ? 10 : 70,
			context: {
				...event.context,
				timeOfDay: index < 6 ? ('morning' as const) : ('evening' as const),
			},
		}));
		expect(estimateLightingPreference(events).reason).toBe('contextual_patterns_differ');
	});
	it('does not overfit sparse contextual groups or claim invented confidence', () => {
		const events = stableEpisodes().map((event, index) => ({
			...event,
			context: {
				...event.context,
				daylight: index === 0 ? ('daylight' as const) : ('night' as const),
				timeOfDay: index === 0 ? ('morning' as const) : ('evening' as const),
			},
		}));
		const result = estimateLightingPreference(events);
		expect(result).toMatchObject({
			assessment: 'suggestion_available',
			contextGrouping: 'insufficient_samples',
		});
		expect(result.estimatedLux).toBeDefined();
		expect(result.contextGroups).toContainEqual({
			dimension: 'daylight',
			category: 'daylight',
			episodes: 1,
			days: 1,
			medianLux: events[0]!.lux,
		});
		expect(result.contextGroups).toContainEqual({
			dimension: 'timeOfDay',
			category: 'morning',
			episodes: 1,
			days: 1,
			medianLux: events[0]!.lux,
		});
		expect(result).not.toHaveProperty('confidence');
	});
	it('does not fabricate weather or require it for otherwise valid evidence', () => {
		const result = estimateLightingPreference(stableEpisodes());
		expect(result.assessment).toBe('suggestion_available');
		expect(stableEpisodes().every((event) => event.context.weather === 'not_collected')).toBe(true);
	});
	it('balances days rather than allowing a busy day to dominate', () => {
		const events = stableEpisodes().map((event) => ({...event, lux: 30}));
		for (let index = 0; index < 20; index++) {
			events.push(episode('2026-10-10T22:00:00Z', 32));
		}

		expect(estimateLightingPreference(events).estimatedLux).toBe(30);
	});
	it('uses an explicit reproducible interpolated quantile', () => {
		expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
		expect(quantile([4, 1, 3, 2], 0.25)).toBe(1.75);
	});
});

describe('historical temporal and solar context', () => {
	it('uses different offsets for the two occurrences of a DST fall-back local time', () => {
		const before = enrichEpisode(at('2026-10-25T00:30:00Z'), location);
		const after = enrichEpisode(at('2026-10-25T01:30:00Z'), location);
		expect(before.localTime).toBe('01:30:00');
		expect(after.localTime).toBe('01:30:00');
		expect(before.utcOffset).toBe('GMT+01:00');
		expect(after.utcOffset).toMatch(/^GMT(?:\+00:00)?$/v);
		expect(before.localDate).toBe(after.localDate);
	});
	it('accounts for spring-forward and local midnight', () => {
		expect(enrichEpisode(at('2026-03-29T00:59:00Z'), location).localTime).toBe('00:59:00');
		expect(enrichEpisode(at('2026-03-29T01:00:00Z'), location).localTime).toBe('02:00:00');
		expect(enrichEpisode(at('2026-06-10T23:30:00Z'), location).localDate).toBe('2026-06-11');
	});
	it('treats equivalent offset timestamps identically', () => {
		expect(enrichEpisode(at('2026-10-10T21:00:00+01:00'), location)).toEqual(
			enrichEpisode(at('2026-10-10T20:00:00Z'), location),
		);
	});
	it.each([-7, -6, -5, -1, 0, 1])(
		'marks approximate solar boundary %s as uncertain',
		(elevation) => {
			expect(classifyDaylight(elevation)).toBe('boundary_uncertain');
		},
	);
	it.each([
		{elevation: 10, result: 'daylight'},
		{elevation: -3, result: 'civil_twilight'},
		{elevation: -10, result: 'night'},
	])('classifies $elevation degrees deterministically', ({elevation, result}) => {
		expect(classifyDaylight(elevation)).toBe(result);
	});
	it('calculates event-time solar position rather than current sun state', () => {
		const noon = at('2026-03-20T12:00:00Z');
		expect(solarElevationAt(noon, 0, 0)).toBeGreaterThan(85);
		expect(solarElevationAt(noon - 43_200_000, 0, 0)).toBeLessThan(-85);
		expect(enrichEpisode(noon, location).daylight).toBe('daylight');
	});
	it('handles sunrise and sunset on both sides without substituting today’s times', () => {
		for (const hour of [6, 18]) {
			const time = at(`2026-03-20T${String(hour).padStart(2, '0')}:00:00Z`);
			const before = solarElevationAt(time - 1_800_000, 0, 0);
			const after = solarElevationAt(time + 1_800_000, 0, 0);
			expect(hour === 6 ? before < after : before > after).toBe(true);
			expect(Math.sign(before)).not.toBe(Math.sign(after));
		}
	});
	it('handles leap years and polar coordinates without nonfinite results', () => {
		for (const latitude of [-90, 0, 90]) {
			const elevation = solarElevationAt(at('2028-02-29T12:00:00Z'), latitude, 180);
			expect(Number.isFinite(elevation)).toBe(true);
		}
	});
});
