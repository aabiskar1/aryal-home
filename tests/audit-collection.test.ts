import {readFile, writeFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {collectAuditData} from '../src/audit/collection.js';
import {runHaAuditCli} from '../src/cli/ha-audit.js';
import {getHomeAssistantRegistries} from '../src/home-assistant/registry-client.js';
import {createHomeAssistantStateReader} from '../src/home-assistant/state-reader.js';

const http = vi.hoisted(() => {
	const json = vi.fn();
	const get = vi.fn(() => ({json}));
	const post = vi.fn();
	return {json, get, post, extend: vi.fn(() => ({get, post}))};
});
vi.mock('got', () => ({default: {extend: http.extend}}));
vi.mock('node:fs/promises', () => ({readFile: vi.fn(), writeFile: vi.fn()}));
vi.mock('../src/home-assistant/registry-client.js', () => ({getHomeAssistantRegistries: vi.fn()}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv('HA_URL', 'https://ha.example.test');
	vi.stubEnv('HA_TOKEN', 'test-audit-token');
	vi.stubEnv('OLLAMA_URL', 'invalid-but-unused');
	vi.stubEnv('PLANNING_REQUEST_MAX_BYTES', 'invalid-but-unused');
	http.json.mockResolvedValue([
		{
			entity_id: 'light.example_lamp',
			state: 'on',
			attributes: {friendly_name: 'Example Lamp'},
			last_changed: '',
			last_updated: '',
		},
	]);
	vi.mocked(readFile).mockResolvedValue(
		JSON.stringify({version: 1, allow: [{domain: 'light'}], deny: []}),
	);
	vi.mocked(getHomeAssistantRegistries).mockResolvedValue({
		status: 'available',
		entities: [],
		devices: [],
		areas: [],
		labels: [],
	});
});
afterEach(() => vi.unstubAllEnvs());

describe('production read-only audit collection', () => {
	it('only GETs states, lists registries, and reads policy, with no service or policy writes', async () => {
		const result = await runHaAuditCli(['--json']);
		expect(result.exitCode).toBe(0);
		expect(http.get).toHaveBeenCalledExactlyOnceWith('states');
		expect(http.post).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		expect(readFile).toHaveBeenCalledExactlyOnceWith('config/entity-policy.json', 'utf8');
		expect(getHomeAssistantRegistries).toHaveBeenCalledExactlyOnceWith(
			'https://ha.example.test',
			'test-audit-token',
		);
		expect(result.output).not.toContain('test-audit-token');
		expect(result.output).not.toContain('ha.example.test');
	});

	it('preserves the shared state reader transport, retries, and response validation', async () => {
		const readStates = createHomeAssistantStateReader(
			'https://ha.example.test',
			'test-audit-token',
		);
		expect(http.extend).toHaveBeenCalledExactlyOnceWith({
			prefixUrl: 'https://ha.example.test/api',
			headers: {authorization: 'Bearer test-audit-token'},
			timeout: {request: 10_000},
			retry: {limit: 2},
		});
		expect(await readStates()).toHaveLength(1);
		http.json.mockResolvedValue({untrusted: 'not-an-array'});
		await expect(readStates()).rejects.toThrow();
	});

	it('treats missing policy as default-deny without creating it', async () => {
		vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('not found'), {code: 'ENOENT'}));
		const result = await runHaAuditCli(['--json']);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('policy_not_configured');
		expect(writeFile).not.toHaveBeenCalled();
	});

	it.each(['bad JSON', JSON.stringify({version: 5}), 'permission failure'])(
		'returns exit 1 for invalid/unreadable policy: %s',
		async (input) => {
			if (input === 'permission failure') {
				vi.mocked(readFile).mockRejectedValue(
					Object.assign(new Error('private path'), {code: 'EACCES'}),
				);
			} else {
				vi.mocked(readFile).mockResolvedValue(input);
			}

			const result = await runHaAuditCli([]);
			expect(result.exitCode).toBe(1);
			expect(writeFile).not.toHaveBeenCalled();
		},
	);

	it('returns exit 1 when REST access fails without exposing the transport exception', async () => {
		http.json.mockRejectedValue(new Error('test-audit-token https://ha.example.test'));
		const result = await runHaAuditCli(['--json']);
		expect(result.exitCode).toBe(1);
		expect(result.output).not.toContain('test-audit-token');
		expect(http.post).not.toHaveBeenCalled();
	});

	it('requires registry availability instead of runtime REST-only fallback', async () => {
		vi.mocked(getHomeAssistantRegistries).mockResolvedValue({status: 'unavailable'});
		await expect(collectAuditData()).rejects.toThrow('Audit requires available');
		const result = await runHaAuditCli([]);
		expect(result.exitCode).toBe(1);
	});

	it('handles absent or invalid HA configuration with exit 1 and no reads', async () => {
		vi.stubEnv('HA_URL', 'invalid');
		const result = await runHaAuditCli([]);
		expect(result.exitCode).toBe(1);
		expect(http.get).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});

	it('does not depend on Ollama configuration, DRY_RUN, or execution', async () => {
		vi.stubEnv('DRY_RUN', 'invalid-but-unused');
		const result = await runHaAuditCli([]);
		expect(result.exitCode).toBe(0);
		expect(http.post).not.toHaveBeenCalled();
	});
});
