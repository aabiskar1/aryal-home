import {describe, expect, it} from 'vitest';
import {
	canonicalSamples,
	classifyEventOrigin,
	identifyLightingEpisodes,
	type HistorySample,
} from '../src/lighting-learning/events.js';
import type {HistoricalLogEntry} from '../src/home-assistant/history-schemas.js';
import {estimateLightingPreference} from '../src/lighting-learning/estimator.js';
import {at, historical, lightId, location, lux, transition} from './lighting-learning-fixture.js';

const analyse = (
	lights = transition(),
	sensor: HistorySample[] = [lux()],
	extra: Partial<Parameters<typeof identifyLightingEpisodes>[0]> = {},
) =>
	identifyLightingEpisodes({
		lights: new Map([[lightId, lights]]),
		sensor,
		aggregateIds: new Set(),
		logbook: [],
		start: at('2026-10-10T00:00:00Z'),
		end: at('2026-10-11T00:00:00Z'),
		location,
		...extra,
	});

const reordered = <T>(rows: T[]): T[] =>
	Array.from(rows, (_row, index) => rows[rows.length - 1 - index]!);

describe('historical lighting transitions', () => {
	it('identifies off-to-on and uses only the last strictly earlier lux', () => {
		const result = analyse(transition(), [
			lux('30'),
			lux('400', '2026-10-10T20:00:00Z'),
			lux('500', '2026-10-10T20:00:01Z'),
		]);
		expect(result.episodes).toHaveLength(1);
		expect(result.episodes[0]).toMatchObject({
			lux: 30,
			luxAgeMs: 60_000,
			provenance: 'unknown_origin',
			independent: true,
		});
	});
	it.each(
		[
			[historical(lightId, 'on')],
			transition().map((row) => ({...row, initialSnapshot: true})),
			[
				historical(lightId, 'on', '2026-10-10T19:00:00Z'),
				{...historical(lightId, 'on'), last_changed: '2026-10-10T19:00:00Z'},
			],
			[historical(lightId, 'unknown', '2026-10-10T19:00:00Z'), historical(lightId, 'on')],
			[historical(lightId, 'unavailable', '2026-10-10T19:00:00Z'), historical(lightId, 'on')],
			transition().map((row) => ({...row, attributes: {restored: true}})),
			[transition()[0]!, {...transition()[1]!, last_changed: '2026-10-10T19:00:00Z'}],
		].map((rows) => ({rows})),
	)('does not count initial, attribute-only, unavailable or restored updates (%j)', ({rows}) => {
		expect(analyse(rows).episodes).toHaveLength(0);
	});
	it('counts a later real transition after a snapshot without counting the snapshot', () => {
		const rows = [
			{...historical(lightId, 'on', '2026-10-10T18:00:00Z'), initialSnapshot: true},
			...transition(),
		];
		expect(analyse(rows).episodes).toHaveLength(1);
	});
	it('ignores light-off transitions for estimating darkness', () => {
		const rows = transition().map((row) => ({...row, state: row.state === 'on' ? 'off' : 'on'}));
		expect(analyse(rows).episodes).toHaveLength(0);
	});
	it('sorts and deduplicates reordered samples and events deterministically', () => {
		const rows = reordered([...transition(), ...transition()]);
		expect(analyse(rows, [lux(), lux()]).episodes).toEqual(analyse().episodes);
	});
	it('treats conflicting duplicate timestamps as unusable barriers', () => {
		const rows = [...transition(), {...transition()[1]!, state: 'off'}];
		expect(analyse(rows).episodes).toHaveLength(0);
		expect(analyse(transition(), [lux('30'), lux('80')]).episodes[0]?.luxIssue).toBe(
			'invalid_pre_event_lux',
		);
	});
	it('retains the real event when a daily initial snapshot duplicates it', () => {
		const rows = [...transition(), {...transition()[1]!, initialSnapshot: true}];
		expect(analyse(rows).episodes).toHaveLength(1);
	});
	it('excludes known aggregate transitions, even when membership cannot be reconstructed historically', () => {
		const result = analyse(transition(), [lux()], {aggregateIds: new Set([lightId])});
		expect(result.episodes).toHaveLength(0);
		expect(result.excluded.aggregate_entity_transition).toBe(1);
	});
	it('collapses changes sharing an actual context ID as one episode', () => {
		const other = 'light.example_second';
		const context = {id: 'example-shared-context', parent_id: null, user_id: null};
		const lights = new Map(
			[lightId, other].map((id) => [
				id,
				transition(undefined, id).map((row) => ({...row, context})),
			]),
		);
		const result = analyse(transition(), [lux()], {lights});
		expect(result.episodes).toHaveLength(1);
		expect(result.episodes[0]?.entityIds).toHaveLength(2);
		expect(result.excluded.shared_context_collapsed).toBe(1);
	});
	it('does not infer one decision or multiple independent decisions merely from simultaneity', () => {
		const lights = new Map(
			[lightId, 'light.example_second'].map((id) => [id, transition(undefined, id)]),
		);
		const result = analyse(transition(), [lux()], {lights});
		expect(result.episodes).toHaveLength(2);
		expect(result.episodes.every((event) => !event.independent)).toBe(true);
	});
	it('does not collapse different contexts', () => {
		const lights = new Map(
			[lightId, 'light.example_second'].map((id) => [
				id,
				transition(undefined, id).map((row) => ({
					...row,
					context: {id, parent_id: null, user_id: null},
				})),
			]),
		);
		expect(analyse(transition(), [lux()], {lights}).episodes).toHaveLength(2);
	});
	it('enforces a 30-minute independence separation', () => {
		const rows = [...transition(), ...transition('2026-10-10T20:20:00Z')];
		expect(analyse(rows).episodes.map((event) => event.independent)).toEqual([true, false]);
	});
	it.each([
		{times: ['20:00', '20:20', '20:40'], expected: [true, false, false], exclusions: 2},
		{times: ['20:00', '20:20', '20:51'], expected: [true, false, true], exclusions: 1},
		{times: ['20:00', '20:30', '21:00'], expected: [true, true, true], exclusions: 0},
	])(
		'measures spacing from the immediately preceding episode: $times',
		({times, expected, exclusions}) => {
			const rows = times.flatMap((time) => transition(`2026-10-10T${time}:00Z`));
			const result = analyse(reordered(rows));
			expect(result.episodes.map((event) => event.timestamp)).toEqual(
				times.map((time) => at(`2026-10-10T${time}:00Z`)),
			);
			expect(result.episodes.map((event) => event.independent)).toEqual(expected);
			expect(result.excluded.independence_unestablished ?? 0).toBe(exclusions);
		},
	);
	it('uses a collapsed shared-context episode as the next spacing baseline even when non-independent', () => {
		const sharedContext = {id: 'example-shared', parent_id: null, user_id: null};
		const middle = '2026-10-10T20:20:00Z';
		const shared = (id: string) =>
			transition(middle, id).map((row) => ({...row, context: sharedContext}));
		const rows = [...transition(), ...shared(lightId), ...transition('2026-10-10T20:40:00Z')];
		const lights = new Map([
			[lightId, rows],
			['light.example_second', shared('light.example_second')],
		]);
		const result = analyse(rows, [lux()], {lights});
		expect(result.episodes.map((event) => event.independent)).toEqual([true, false, false]);
		expect(result.episodes[1]?.entityIds).toHaveLength(2);
		expect(result.excluded.shared_context_collapsed).toBe(1);
		expect(result.excluded.independence_unestablished).toBe(2);
	});
	it('advances the baseline for simultaneous episodes already marked non-independent', () => {
		const rows = [
			...transition(),
			...transition('2026-10-10T20:20:00Z'),
			...transition('2026-10-10T20:51:00Z'),
		];
		const lights = new Map([
			[lightId, rows],
			['light.example_second', transition(undefined, 'light.example_second')],
		]);
		const result = analyse(rows, [lux()], {lights});
		expect(result.episodes.map((event) => event.independent)).toEqual([false, false, false, true]);
		expect(result.excluded.independence_unestablished).toBe(3);
	});
	it('does not restore independence to simultaneous changes even after a long gap', () => {
		const later = '2026-10-10T21:00:00Z';
		const rows = [...transition(), ...transition(later)];
		const lights = new Map([
			[lightId, rows],
			['light.example_second', transition(later, 'light.example_second')],
		]);
		const result = analyse(rows, [lux()], {lights});
		expect(result.episodes.map((event) => event.independent)).toEqual([true, false, false]);
		expect(result.excluded.independence_unestablished).toBe(2);
	});
	it.each([
		{userId: null, provenance: 'unknown_origin'},
		{userId: 'example-user', provenance: 'user_attributed_origin_unverified'},
	])('does not promote $provenance when spacing is sufficient', ({userId, provenance}) => {
		const rows = ['20:00', '20:31', '21:02'].flatMap((time) =>
			transition(`2026-10-10T${time}:00Z`).map((row) => ({
				...row,
				context: {id: `example-${time}`, parent_id: null, user_id: userId},
			})),
		);
		const result = analyse(rows);
		expect(result.episodes.map((event) => event.independent)).toEqual([true, true, true]);
		expect(result.episodes.map((event) => event.provenance)).toEqual([
			provenance,
			provenance,
			provenance,
		]);
		expect(estimateLightingPreference(result.episodes)).toMatchObject({
			assessment: 'ambiguous_event_provenance',
			reliableEpisodes: 0,
		});
	});
	it.each(['NaN', 'Infinity', '-1', '0x20', '', 'unknown', 'unavailable', 'a lot'])(
		'rejects unusable lux %s',
		(value) => {
			expect(analyse(transition(), [lux(value)]).episodes[0]?.luxIssue).toBe(
				'invalid_pre_event_lux',
			);
		},
	);
	it.each(['lm', 'lux', '%', ''])('rejects incompatible or noncanonical lux units %s', (unit) => {
		expect(
			analyse(transition(), [
				{...lux(), attributes: {device_class: 'illuminance', unit_of_measurement: unit}},
			]).episodes[0]?.lux,
		).toBeUndefined();
	});
	it.each(['brightness', 'temperature', ''])(
		'requires exact illuminance classification: %s',
		(device_class) => {
			expect(
				analyse(transition(), [{...lux(), attributes: {device_class, unit_of_measurement: 'lx'}}])
					.episodes[0]?.lux,
			).toBeUndefined();
		},
	);
	it('rejects stale measurements and accepts the documented five-minute boundary', () => {
		expect(analyse(transition(), [lux('30', '2026-10-10T19:54:59Z')]).episodes[0]?.luxIssue).toBe(
			'stale_pre_event_lux',
		);
		expect(analyse(transition(), [lux('30', '2026-10-10T19:55:00Z')]).episodes[0]?.lux).toBe(30);
	});
	it('does not search past invalid latest samples', () => {
		expect(
			analyse(transition(), [lux('30', '2026-10-10T19:58:00Z'), lux('unknown')]).episodes[0]?.lux,
		).toBeUndefined();
	});
	it('does not let an attribute-only update make an old measurement fresh', () => {
		const reading = {...lux(), last_changed: '2026-10-10T18:00:00Z'};
		expect(analyse(transition(), [reading]).episodes[0]?.luxIssue).toBe('stale_pre_event_lux');
	});
	it('uses an initial sensor snapshot as a barrier rather than falling back to a prior reading', () => {
		const result = analyse(transition(), [
			lux('30', '2026-10-10T19:58:00Z'),
			{...lux('unknown'), initialSnapshot: true},
		]);
		expect(result.episodes[0]?.lux).toBeUndefined();
	});
	it('rejects sensor snapshots and post-event-only evidence', () => {
		expect(analyse(transition(), [{...lux(), initialSnapshot: true}]).episodes[0]?.luxIssue).toBe(
			'missing_pre_event_lux',
		);
		expect(analyse(transition(), [lux('500', '2026-10-10T20:01:00Z')]).episodes[0]?.luxIssue).toBe(
			'missing_pre_event_lux',
		);
	});
	it('handles irregular sampling by selecting the latest actual earlier reading', () => {
		expect(
			analyse(transition(), [lux('20', '2026-10-10T19:50:00Z'), lux('31', '2026-10-10T19:59:57Z')])
				.episodes[0],
		).toMatchObject({lux: 31, luxAgeMs: 3000});
	});
	it('enriches historical episodes, independently of current wall time', () => {
		expect(analyse().episodes[0]?.context).toMatchObject({
			localDate: '2026-10-10',
			localTime: '21:00:00',
			utcOffset: 'GMT+01:00',
			weather: 'not_collected',
		});
	});
});

describe('precise, conservative provenance', () => {
	const on = transition()[1]!;
	const entry = (fields: Partial<HistoricalLogEntry>): HistoricalLogEntry => ({
		entity_id: lightId,
		state: 'on',
		when: on.last_changed,
		...fields,
	});
	it('does not promote context user ID with null parent to manual evidence', () => {
		expect(
			classifyEventOrigin(
				{...on, context: {id: 'example', parent_id: null, user_id: 'example-user'}},
				[],
			),
		).toBe('user_attributed_origin_unverified');
	});
	it('does not promote logbook user attribution to manual evidence', () => {
		expect(classifyEventOrigin(on, [entry({context_user_id: 'example-user'})])).toBe(
			'user_attributed_origin_unverified',
		);
	});
	it.each(['automation.example', 'script.example'])(
		'recognizes %s attribution even with a user ID',
		(context_entity_id) => {
			expect(
				classifyEventOrigin(on, [entry({context_entity_id, context_user_id: 'example-user'})]),
			).toBe('automation_or_script_attributed');
		},
	);
	it('does not call parent context proof of automation or manual interaction', () => {
		expect(
			classifyEventOrigin(
				{...on, context: {id: 'example', parent_id: 'example-parent', user_id: null}},
				[],
			),
		).toBe('external_context_attributed');
	});
	it.each([{when: '2026-10-10T20:00:01Z'}, {entity_id: 'light.other'}, {state: 'off'}])(
		'never joins unrelated logbook evidence (%j)',
		(fields) => {
			expect(classifyEventOrigin(on, [entry({context_user_id: 'example-user', ...fields})])).toBe(
				'unknown_origin',
			);
		},
	);
	it('normalizes timestamp offsets during attribution matching', () => {
		expect(
			classifyEventOrigin(on, [
				entry({when: '2026-10-10T21:00:00+01:00', context_domain: 'automation'}),
			]),
		).toBe('automation_or_script_attributed');
	});
	it('canonicalizes equivalent timestamp offsets', () => {
		expect(
			canonicalSamples([
				on,
				{
					...on,
					last_changed: '2026-10-10T21:00:00+01:00',
					last_updated: '2026-10-10T21:00:00+01:00',
				},
			]),
		).toHaveLength(1);
	});
});
