import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {homeAssistantStateSchema} from '../src/home-assistant/schemas.js';
import {createHomeAssistantStateReader} from '../src/home-assistant/state-reader.js';

const http = vi.hoisted(() => ({json: vi.fn(), post: vi.fn(), get: vi.fn()}));
vi.mock('got', () => ({default: {extend: () => ({get: http.get, post: http.post})}}));
const now = Date.parse('2026-10-10T20:00:00Z');
const state = () => ({
	entity_id: 'sensor.example_temperature',
	state: '20',
	attributes: {},
	last_changed: '2026-10-09T15:00:00Z',
	last_updated: '2026-10-10T19:30:00Z',
});
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.clearAllMocks();
	http.get.mockReturnValue({json: http.json});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('strict optional Home Assistant reporting timestamps', () => {
	it('preserves change/update fields and does not invent an absent last_reported', () => {
		const parsed = homeAssistantStateSchema.parse(state());
		expect(parsed).toEqual(state());
		expect(Object.hasOwn(parsed, 'last_reported')).toBe(false);
	});
	it('retains an explicitly provided report and accepts equivalent timezone offsets', () => {
		const raw = {...state(), last_reported: '2026-10-10T20:59:00+01:00'};
		expect(homeAssistantStateSchema.parse(raw)).toEqual(raw);
	});
	it.each(['not-a-timestamp', '2026-10-10T19:59:00', '', null, '2026-10-10T20:00:00.001Z'])(
		'rejects malformed/null/future last_reported %s',
		(last_reported) => {
			expect(homeAssistantStateSchema.safeParse({...state(), last_reported}).success).toBe(false);
		},
	);
	it.each([
		{last_changed: 'bad'},
		{last_updated: '2026-10-10'},
		{last_changed: '2026-10-10T19:31:00Z'},
		{last_reported: '2026-10-10T19:29:59Z'},
		{last_updated: '2026-10-10T20:00:00.001Z'},
		{last_changed: '2026-10-10T20:00:00.001Z', last_updated: '2026-10-10T20:00:00.001Z'},
	])('rejects invalid ordering, malformed and future change/update timestamps %#', (fields) => {
		expect(homeAssistantStateSchema.safeParse({...state(), ...fields}).success).toBe(false);
	});
	it.each(['true', 'false'])(
		'only GETs states and validates last_reported with DRY_RUN=%s',
		async (dryRun) => {
			vi.stubEnv('DRY_RUN', dryRun);
			const raw = {...state(), last_reported: '2026-10-10T19:59:00Z'};
			http.json.mockResolvedValue([raw]);
			const read = createHomeAssistantStateReader('https://ha.example.test', 'example-test-token');
			expect(await read()).toEqual([raw]);
			expect(http.get).toHaveBeenCalledExactlyOnceWith('states');
			expect(http.post).not.toHaveBeenCalled();
			http.json.mockResolvedValue([{...raw, last_reported: '2026-10-10T20:01:00Z'}]);
			await expect(read()).rejects.toThrow();
			expect(http.post).not.toHaveBeenCalled();
		},
	);
});
