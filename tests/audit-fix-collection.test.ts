import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {collectAuditData} from '../src/audit/collection.js';
import {readFixPolicy, writeExactPolicyDeny} from '../src/audit/fixes/policy.js';
import {inspectDisableTargets, disableStaleRegistryEntity} from '../src/audit/fixes/registry.js';
import {createFixDependencies} from '../src/audit/fixes/execution.js';
import {fixFixture} from './audit-fix-fixture.js';

vi.mock('../src/audit/collection.js', () => ({collectAuditData: vi.fn()}));
vi.mock('../src/audit/fixes/policy.js', () => ({
	readFixPolicy: vi.fn(),
	writeExactPolicyDeny: vi.fn(),
}));
vi.mock('../src/audit/fixes/registry.js', () => ({
	inspectDisableTargets: vi.fn(),
	disableStaleRegistryEntity: vi.fn(),
}));
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv('HA_URL', 'https://ha.example.test');
	vi.stubEnv('HA_TOKEN', 'example-token');
	vi.stubEnv('OLLAMA_URL', 'invalid-unused');
	vi.stubEnv('DRY_RUN', 'invalid-unused');
	const fixture = fixFixture();
	vi.mocked(collectAuditData).mockResolvedValue(fixture.data);
	vi.mocked(readFixPolicy).mockResolvedValue({
		text: fixture.policyText!,
		policy: fixture.data.policy!,
		mode: 0o600,
	});
	vi.mocked(inspectDisableTargets).mockResolvedValue(fixture.registryEvidence);
});
afterEach(() => vi.unstubAllEnvs());

it('collects read-only baseline, matching policy bytes, and admin/registry identity evidence without writes', async () => {
	const snapshot = await createFixDependencies().collect();
	expect(snapshot.data).toEqual(fixFixture().data);
	expect(inspectDisableTargets).toHaveBeenCalledExactlyOnceWith(
		'https://ha.example.test',
		'example-token',
		['light.example_live', 'light.example_stale'],
	);
	expect(writeExactPolicyDeny).not.toHaveBeenCalled();
	expect(disableStaleRegistryEntity).not.toHaveBeenCalled();
});

it('fails closed if policy changes between audit and raw-document read', async () => {
	vi.mocked(readFixPolicy).mockResolvedValue({
		text: '{}',
		policy: {version: 1, allow: [], deny: []},
		mode: 0o600,
	});
	await expect(createFixDependencies().collect()).rejects.toThrow('Policy changed');
	expect(inspectDisableTargets).not.toHaveBeenCalled();
	expect(writeExactPolicyDeny).not.toHaveBeenCalled();
});

it('refuses malformed/unreadable policy and performs no writes', async () => {
	vi.mocked(readFixPolicy).mockRejectedValue(new Error('Invalid policy.'));
	await expect(createFixDependencies().collect()).rejects.toThrow();
	expect(writeExactPolicyDeny).not.toHaveBeenCalled();
	expect(disableStaleRegistryEntity).not.toHaveBeenCalled();
});

it('supports absent policy only as existing default-deny evidence, without creating a file', async () => {
	const fixture = fixFixture();
	fixture.data.policy = undefined;
	vi.mocked(collectAuditData).mockResolvedValue(fixture.data);
	const snapshot = await createFixDependencies().collect();
	expect(snapshot.policyText).toBeUndefined();
	expect(readFixPolicy).not.toHaveBeenCalled();
	expect(writeExactPolicyDeny).not.toHaveBeenCalled();
});

it('requires valid HA configuration while remaining independent of model/execution config', () => {
	vi.stubEnv('HA_URL', 'invalid');
	expect(() => createFixDependencies()).toThrow();
});
