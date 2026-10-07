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
	it.each([
		{dryRun: true, isSet: false},
		{dryRun: false, isSet: false},
		{dryRun: true, isSet: true},
		{dryRun: false, isSet: true},
	])(
		'does not import or invoke execution with DRY_RUN=$dryRun and isSet=$isSet',
		async ({dryRun, isSet}) => {
			vi.resetModules();
			vi.clearAllMocks();
			fixture.env.DRY_RUN = dryRun;
			const entityIds = isSet
				? ['light.example_target', 'light.example_second']
				: ['light.example_target'];
			fixture.states.mockResolvedValue(
				entityIds.map((entityId) => ({
					entity_id: entityId,
					state: 'off',
					attributes: {friendly_name: 'Example Lamp'},
					last_changed: '2026-10-07T00:00:00+00:00',
					last_updated: '2026-10-07T00:00:00+00:00',
				})),
			);
			fixture.registries.mockResolvedValue({
				status: 'available',
				entities: entityIds.map((entityId) => ({
					entity_id: entityId,
					device_id: null,
					area_id: 'example_area',
					labels: [],
					disabled_by: null,
				})),
				devices: [],
				areas: [{area_id: 'example_area', name: 'Example Area', aliases: [], labels: []}],
				labels: [],
			});
			fixture.policy.mockResolvedValue({version: 1, allow: [{domain: 'light'}], deny: []});
			fixture.chat.mockResolvedValue(
				JSON.stringify({
					outcome: 'propose_actions',
					summary: 'Proposed plan: RAW_MODEL_SUMMARY.',
					actions: isSet
						? [
								{
									type: 'set_action',
									action: 'turn_on',
									scope: {area: 'Example Area', domain: 'light'},
									reason: 'RAW_MODEL_REASON',
								},
							]
						: [{entityId: 'light.example_target', action: 'turn_on', reason: 'RAW_MODEL_REASON'}],
				}),
			);
			const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const previousArgv = process.argv;
			process.argv = [
				'node',
				'index.js',
				isSet ? 'Turn on all Example Area lights' : 'Turn on Example Lamp',
			];
			try {
				await import('../src/index.js');
			} finally {
				process.argv = previousArgv;
			}

			expect(fixture.states).toHaveBeenCalledTimes(1);
			expect(fixture.chat).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith('Execution-ready commands (prepared only):');
			expect(log).toHaveBeenCalledWith('Semantic set expansion diagnostics:');
			expect(JSON.stringify(log.mock.calls)).not.toContain('RAW_MODEL_SUMMARY');
			expect(JSON.stringify(log.mock.calls)).not.toContain('RAW_MODEL_REASON');
			if (isSet) {
				expect(JSON.stringify(log.mock.calls)).toContain('matchedCount');
				expect(JSON.stringify(log.mock.calls)).toContain('set_action');
			}

			expect(log).toHaveBeenLastCalledWith('No Home Assistant service calls were made.');
		},
		20_000,
	);
});
