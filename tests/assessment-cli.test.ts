import {mkdtemp, readFile, readdir, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runAssessmentCli, type AssessmentDependencies} from '../src/cli/assess-home.js';
import {readThresholdPreferences} from '../src/lighting-thresholds/preferences.js';
import {assessmentData, now, preferences, proposal} from './assessment-fixture.js';
import {location} from './lighting-learning-fixture.js';

let directory: string;
let path: string;
let deps: AssessmentDependencies;
const args = ['--area', 'Example Room'];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'aryal-assessment-'));
	path = join(directory, 'preferences.json');
	deps = {
		collect: vi.fn(async () => assessmentData()),
		read: vi.fn(async () => readThresholdPreferences(path)),
		location: vi.fn(async () => location),
		chat: vi.fn(async () => JSON.stringify(proposal())),
		config: () => ({model: 'example-model', maxRequestBytes: 24_576}),
		now: () => now,
	};
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(directory, {recursive: true, force: true});
});

describe('explicit advisory assessment CLI', () => {
	it('provides help without collecting data, reading preferences or invoking a model', async () => {
		const result = await runAssessmentCli(['--help'], deps);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('lighting_comfort');
		expect(deps.collect).not.toHaveBeenCalled();
		expect(deps.read).not.toHaveBeenCalled();
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it.each(
		[
			[],
			['--area'],
			['--area', ''],
			['--area', '--suggest'],
			['--area', 'Example Room', '--set', '40'],
			['Turn on the lights'],
			['--area', 'x'.repeat(121)],
			['--goal', 'lighting_comfort'],
		].map((input) => ({input})),
	)('rejects invalid/instruction input %# before reads', async ({input}) => {
		const result = await runAssessmentCli(input, deps);
		expect(result.exitCode).toBe(2);
		expect(deps.collect).not.toHaveBeenCalled();
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it('reports the missing preference without saving 40 lx, creating files or pretending approval', async () => {
		vi.mocked(deps.chat).mockResolvedValue(JSON.stringify(proposal('insufficient_context')));
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			context: {preference: {status: 'missing'}},
			decision: {
				outcome: 'insufficient_context',
				model: 'structured_response',
				validation: 'accepted',
				issues: ['missing_threshold'],
				executionAuthority: 'none',
			},
		});
		expect(await readdir(directory)).toEqual([]);
	});
	it.each(['true', 'false'])(
		'remains advisory with DRY_RUN=%s and leaves preferences unchanged',
		async (dryRun) => {
			vi.stubEnv('DRY_RUN', dryRun);
			const text = JSON.stringify(preferences);
			await writeFile(path, text, {mode: 0o600});
			const before = await stat(path);
			const result = await runAssessmentCli(args, deps);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				decision: {outcome: 'suggest_action', validation: 'accepted', executionAuthority: 'none'},
			});
			expect(await readFile(path, 'utf8')).toBe(text);
			const after = await stat(path);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(await readdir(directory)).toEqual(['preferences.json']);
			expect(deps.chat).toHaveBeenCalledTimes(1);
		},
	);
	it('reports malformed preference storage without a model call or modification', async () => {
		await writeFile(path, 'broken');
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('context_unavailable_or_invalid');
		expect(await readFile(path, 'utf8')).toBe('broken');
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it('marks optional config unavailable and still reasons from approved direct evidence', async () => {
		await writeFile(path, JSON.stringify(preferences));
		vi.mocked(deps.location).mockRejectedValue(new Error('private-test-token'));
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({
			context: {clock: {status: 'unavailable'}},
			decision: {validation: 'accepted'},
		});
		expect(result.output).not.toContain('private-test-token');
	});
	it('returns no_action as success but never insufficient context as success', async () => {
		await writeFile(path, JSON.stringify(preferences));
		vi.mocked(deps.chat).mockResolvedValue(JSON.stringify(proposal('no_action')));
		const noAction = await runAssessmentCli(args, deps);
		expect(noAction.exitCode).toBe(0);
		vi.mocked(deps.chat).mockResolvedValue(JSON.stringify(proposal('insufficient_context')));
		const insufficient = await runAssessmentCli(args, deps);
		expect(insufficient.exitCode).toBe(1);
	});
	it.each(['invalid_output', 'unavailable', 'rejected'])(
		'labels model %s without exposing prose or raw errors',
		async (condition) => {
			await writeFile(path, JSON.stringify(preferences));
			if (condition === 'unavailable') {
				vi.mocked(deps.chat).mockRejectedValue(new Error('private-test-token'));
			} else if (condition === 'invalid_output') {
				vi.mocked(deps.chat).mockResolvedValue('private-test-token');
			} else {
				vi.mocked(deps.chat).mockResolvedValue(
					JSON.stringify({...proposal(), presence: 'clear', rationale: 'private-test-token'}),
				);
			}

			const result = await runAssessmentCli(args, deps);
			expect(result.exitCode).toBe(1);
			expect(result.output).not.toContain('private-test-token');
			expect(JSON.parse(result.output)).toMatchObject({decision: {recommendations: []}});
		},
	);
	it('reports ambiguous area/unreliable collection without calling Ollama or exposing private errors', async () => {
		vi.mocked(deps.collect).mockRejectedValue(
			new Error('private-test-token https://ha.example.test'),
		);
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).not.toContain('private-test-token');
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it('fails closed before a model call when the request budget cannot hold complete context', async () => {
		deps.config = () => ({model: 'example-model', maxRequestBytes: 1});
		const result = await runAssessmentCli(args, deps);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			decision: {model: 'not_called', issues: ['context_over_budget']},
		});
		expect(deps.chat).not.toHaveBeenCalled();
	});
	it('dates the state snapshot at collection completion, before slower optional context reads', async () => {
		await writeFile(path, JSON.stringify(preferences));
		let time = now;
		deps.now = () => time;
		vi.mocked(deps.location).mockImplementation(async () => {
			time += 301_000;
			return location;
		});
		const result = await runAssessmentCli(args, deps);
		expect(JSON.parse(result.output)).toMatchObject({
			context: {capturedAt: new Date(now).toISOString()},
			decision: {recommendations: []},
		});
		const parsed = JSON.parse(result.output) as {decision: {issues: string[]}};
		expect(parsed.decision.issues).toContain('stale_snapshot');
	});
});
