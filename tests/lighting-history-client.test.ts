import {Buffer} from 'node:buffer';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createHistoryClient, HISTORY_LIMITS} from '../src/home-assistant/history-client.js';
import {
	historyResponseSchema,
	historyTimestampSchema,
	learningConfigSchema,
} from '../src/home-assistant/history-schemas.js';
import {historical, lightId, location, lux, sensorId} from './lighting-learning-fixture.js';

const http = vi.hoisted(() => ({get: vi.fn(), extend: vi.fn(), post: vi.fn()}));
vi.mock('got', () => ({default: {extend: http.extend}}));
const request = {
	entityIds: [lightId, sensorId],
	start: '2026-10-10T00:00:00Z',
	end: '2026-10-11T00:00:00Z',
};
const respond = (value: unknown) =>
	http.get.mockImplementation(() => Readable.from([Buffer.from(JSON.stringify(value))]));
beforeEach(() => {
	vi.clearAllMocks();
	http.extend.mockReturnValue({stream: {get: http.get}, post: http.post});
	respond([[historical(lightId, 'off')], [lux()]]);
});

describe('bounded read-only historical transport', () => {
	it('requests only explicit entities and end, preserves evidence metadata, and bounds transport', async () => {
		const client = createHistoryClient('https://ha.example.test', 'private-test-token');
		expect(await client.history(request)).toHaveLength(2);
		expect(http.extend).toHaveBeenCalledWith({
			prefixUrl: 'https://ha.example.test/api',
			headers: {authorization: 'Bearer private-test-token'},
			timeout: {request: 15_000},
			retry: {limit: 0},
			followRedirect: false,
		});
		expect(http.get).toHaveBeenCalledWith('history/period/2026-10-10T00%3A00%3A00Z', {
			searchParams: {
				filter_entity_id: `${lightId},${sensorId}`,
				end_time: request.end,
				significant_changes_only: '0',
			},
		});
		expect(http.post).not.toHaveBeenCalled();
	});
	it.each([
		{...request, entityIds: []},
		{...request, entityIds: [lightId, lightId]},
		{...request, entityIds: ['weather.example']},
		{...request, start: ''},
		{...request, start: '2026-10-10T00:00:00'},
		{...request, end: request.start},
		{...request, end: '2026-12-11T00:00:00Z'},
		{...request, entityIds: Array.from({length: 18}, (_, i) => `light.example_${i}`)},
	])('rejects unbounded or invalid requests before transport (%j)', async (input) => {
		await expect(
			createHistoryClient('https://ha.example.test', 'test').history(input),
		).rejects.toThrow();
		expect(http.get).not.toHaveBeenCalled();
	});
	it.each([[], [[]]].map((response) => ({response})))(
		'accepts empty/missing Recorder history without fabricating data (%j)',
		async ({response}) => {
			respond(response);
			expect(await createHistoryClient('https://ha.example.test', 'test').history(request)).toEqual(
				response,
			);
		},
	);
	it.each(
		[
			{},
			[null],
			[[{state: 'on'}]],
			[[historical('light.unrequested', 'off')]],
			[[historical(lightId, 'off'), historical(sensorId, '12')]],
			[[historical(lightId, 'off')], [historical(lightId, 'off')]],
			[[historical(lightId, 'off', '2027-01-01T00:00:00Z')]],
			[[{...historical(lightId, 'off'), last_changed: '2026-10-10T21:00:00Z'}]],
		].map((response) => ({response})),
	)('rejects malformed, unsolicited or inconsistent history (%j)', async ({response}) => {
		respond(response);
		await expect(
			createHistoryClient('https://ha.example.test', 'test').history(request),
		).rejects.toThrow();
	});
	it('destroys an oversized response before parsing the complete body', async () => {
		const stream = Readable.from([Buffer.alloc(HISTORY_LIMITS.maxResponseBytes), Buffer.from('x')]);
		http.get.mockReturnValue(stream);
		await expect(
			createHistoryClient('https://ha.example.test', 'test').history(request),
		).rejects.toThrow('byte budget');
		expect(stream.destroyed).toBe(true);
	});
	it.each(['HTTPError', 'TimeoutError'])(
		'propagates %s for sanitized CLI failure handling without retrying',
		async (name) => {
			http.get.mockImplementation(() =>
				Readable.from(
					(async function* () {
						throw new Error(name);
						yield '';
					})(),
				),
			);
			await expect(
				createHistoryClient('https://ha.example.test', 'test').history(request),
			).rejects.toThrow(name);
			expect(http.get).toHaveBeenCalledTimes(1);
		},
	);
	it('rejects non-JSON bodies', async () => {
		http.get.mockReturnValue(Readable.from(['not JSON']));
		await expect(
			createHistoryClient('https://ha.example.test', 'test').history(request),
		).rejects.toThrow();
	});
	it('validates HA timezone and coordinates while discarding other configuration', async () => {
		respond({...location, unexpected: 'private'});
		expect(await createHistoryClient('https://ha.example.test', 'test').config()).toEqual(location);
	});
	it('filters logbook to requested lights and interval, stripping names/messages', async () => {
		respond([
			{
				entity_id: lightId,
				state: 'on',
				when: '2026-10-10T20:00:00Z',
				name: 'private',
				message: 'private',
				context_user_id: 'example-user',
			},
			{entity_id: 'light.other', when: '2026-10-10T20:00:00Z'},
			{entity_id: lightId, when: '2026-10-11T00:00:00Z'},
		]);
		const entries = await createHistoryClient('https://ha.example.test', 'test').logbook({
			...request,
			entityIds: [lightId],
		});
		expect(entries).toEqual([
			{
				entity_id: lightId,
				state: 'on',
				when: '2026-10-10T20:00:00Z',
				context_user_id: 'example-user',
			},
		]);
		expect(http.get).toHaveBeenCalledWith(expect.stringContaining('logbook/'), {
			searchParams: {entity: lightId, end_time: request.end},
		});
	});
	it('does not send sensor or unrestricted logbook queries', async () => {
		await expect(
			createHistoryClient('https://ha.example.test', 'test').logbook(request),
		).rejects.toThrow();
		expect(http.get).not.toHaveBeenCalled();
	});
});

describe('historical external schemas', () => {
	it.each([
		'2026-10-25T01:15:00+01:00',
		'2026-10-25T01:15:00+00:00',
		'2026-10-10T20:00:00.123456Z',
	])('accepts explicit offsets and HA microseconds: %s', (value) => {
		expect(historyTimestampSchema.safeParse(value).success).toBe(true);
	});
	it.each(['yesterday', '2026-02-30T00:00:00Z', '2026-10-10', '2026-10-10T12:00:00'])(
		'rejects invalid timestamps: %s',
		(value) => {
			expect(historyTimestampSchema.safeParse(value).success).toBe(false);
		},
	);
	it.each(['Not/AZone', ''])('rejects invalid HA timezones: %s', (time_zone) => {
		expect(learningConfigSchema.safeParse({...location, time_zone}).success).toBe(false);
	});
	it('does not assume context exists in REST history', () => {
		expect(historyResponseSchema.parse([[lux()]])[0]?.[0]?.context).toBeUndefined();
	});
});
