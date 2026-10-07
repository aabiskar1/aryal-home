import {afterEach, describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({
	env: {
		HA_URL: 'https://ha.example.test',
		HA_TOKEN: 'test-token',
		OLLAMA_MODEL: 'example-model',
		PLANNING_REQUEST_MAX_BYTES: 100_000,
		DRY_RUN: true,
	},
	states: vi.fn(),
	registries: vi.fn(),
	policy: vi.fn(),
	chat: vi.fn(),
}));
vi.mock('../src/config/env.js', () => ({env: fixture.env}));
vi.mock('../src/config/policy.js', () => ({loadEntityPolicy: fixture.policy}));
vi.mock('../src/home-assistant/client.js', () => ({getHomeAssistantStates: fixture.states}));
vi.mock('../src/home-assistant/registry-client.js', () => ({
	getHomeAssistantRegistries: fixture.registries,
}));
vi.mock('../src/ollama/client.js', () => ({requestOllamaChat: fixture.chat}));
vi.mock('../src/execution/dispatcher.js', () => {
	throw new Error('The planning CLI must never import execution.');
});
afterEach(() => vi.restoreAllMocks());

describe('planning-only CLI boundary', () => {
	it.each([true, false])(
		'does not import or invoke execution with DRY_RUN=%s',
		async (dryRun) => {
			vi.resetModules();
			vi.clearAllMocks();
			fixture.env.DRY_RUN = dryRun;
			fixture.states.mockResolvedValue([
				{
					entity_id: 'light.example_target',
					state: 'off',
					attributes: {friendly_name: 'Example Lamp'},
					last_changed: '2026-10-07T00:00:00+00:00',
					last_updated: '2026-10-07T00:00:00+00:00',
				},
			]);
			fixture.registries.mockResolvedValue({
				status: 'available',
				entities: [
					{
						entity_id: 'light.example_target',
						device_id: null,
						area_id: null,
						labels: [],
						disabled_by: null,
					},
				],
				devices: [],
				areas: [],
				labels: [],
			});
			fixture.policy.mockResolvedValue({version: 1, allow: [{domain: 'light'}], deny: []});
			fixture.chat.mockResolvedValue(
				JSON.stringify({
					outcome: 'propose_actions',
					summary: 'Proposed plan: Turn on the example lamp.',
					actions: [
						{entityId: 'light.example_target', action: 'turn_on', reason: 'Example request.'},
					],
				}),
			);
			const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const previousArgv = process.argv;
			process.argv = ['node', 'index.js', 'Turn on Example Lamp'];
			try {
				await import('../src/index.js');
			} finally {
				process.argv = previousArgv;
			}

			expect(fixture.states).toHaveBeenCalledTimes(1);
			expect(fixture.chat).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith('Execution-ready commands (prepared only):');
			expect(log).toHaveBeenLastCalledWith('No Home Assistant service calls were made.');
		},
		20_000,
	);
});
