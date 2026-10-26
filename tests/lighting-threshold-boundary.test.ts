import {readFile, readdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {expect, it} from 'vitest';
import {evaluateDarkness} from '../src/lighting-thresholds/evaluation.js';
import {validateObservationConditions} from '../src/planning/observation-conditions.js';

it('restricts threshold dependencies to HA reads and the separate local preference writer', async () => {
	const visited = new Set<string>();
	const writers: string[] = [];
	const visit = async (path: string): Promise<void> => {
		if (visited.has(path)) {
			return;
		}

		visited.add(path);
		expect(path).not.toMatch(/\/(?:execution|ollama|fixes)\//v);
		expect(path).not.toMatch(/\/planning\/(?:pipeline|planner|policy|relevance)\.ts$/v);
		expect(path).not.toMatch(/\/config\/env\.ts$/v);
		const source = await readFile(path, 'utf8');
		expect(source).not.toMatch(/\.(?:post|put|patch|delete)\(/v);
		expect(source).not.toMatch(
			/\b(?:call_service|setInterval|executeReadyCommands|DispatchAuthorizedCommand)\b/v,
		);
		expect(source).not.toMatch(
			/config\/(?:entity|device|area|label)_registry\/(?:update|remove|create)/v,
		);
		expect(source).not.toMatch(/import\(/v);
		if (/\b(?:writeFile|rename|unlink)\b/v.test(source)) {
			writers.push(path);
		}

		const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
		const imports: string[] = [];
		for (const statement of ast.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
				continue;
			}

			const dependency = statement.moduleSpecifier.text;
			expect(dependency).not.toMatch(/mcp|child_process/v);
			if (dependency.startsWith('.')) {
				imports.push(resolve(dirname(path), dependency.replace(/\.js$/v, '.ts')));
			}
		}

		await Promise.all(imports.map(async (dependency) => visit(dependency)));
	};

	await visit(fileURLToPath(new URL('../src/lighting-threshold.ts', import.meta.url)));
	expect(writers).toEqual([
		fileURLToPath(new URL('../src/lighting-thresholds/preferences.ts', import.meta.url)),
	]);
	const preferenceSource = await readFile(writers[0]!, 'utf8');
	expect(preferenceSource).toContain("'config/lighting-thresholds.json'");
	expect(preferenceSource).not.toContain('entity-policy.json');
	const ignores = await readFile(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8');
	expect(ignores).toContain('config/lighting-thresholds.json');
});

it('does not connect preference storage or evaluation to planning or execution', async () => {
	await Promise.all(
		['planning', 'execution'].map(async (directory) => {
			const root = fileURLToPath(new URL(`../src/${directory}/`, import.meta.url));
			const files = await readdir(root);
			await Promise.all(
				files.map(async (name) => {
					const source = await readFile(resolve(root, name), 'utf8');
					expect(source).not.toMatch(
						/lighting-threshold|evaluateDarkness|readThresholdPreferences/v,
					);
				}),
			);
		}),
	);
});

it('retains the illuminance safety guard even when standalone evaluation says dark', () => {
	const measurement = {
		domain: 'sensor',
		deviceClass: 'illuminance',
		unit: 'lx',
		state: '28',
		measuredAt: '2026-10-10T19:59:00Z',
		updatedAt: '2026-10-10T19:59:00Z',
	};
	const assessment = evaluateDarkness({
		thresholdLux: 40,
		measurement,
		now: Date.parse('2026-10-10T20:00:00Z'),
	});
	const refusal = validateObservationConditions(
		{
			outcome: 'propose_actions',
			summary: 'Proposed plan: example',
			actions: [{entityId: 'light.example_lamp', action: 'turn_on', reason: 'Example request'}],
		},
		{
			states: [
				{
					entityId: 'light.example_lamp',
					domain: 'light',
					state: 'off',
					area: 'Example Room',
					name: 'Example Lamp',
					supportedActions: ['turn_on', 'turn_off'],
				},
			],
			observations: [
				{
					entityId: 'sensor.example_illuminance',
					state: '28',
					area: 'Example Room',
					name: 'Example Sensor',
					deviceClass: 'illuminance',
					unit: 'lx',
				},
			],
		},
	);
	expect(assessment.assessment).toBe('dark');
	expect(refusal.issue?.reason).toBe('unresolved_illuminance_threshold');
	expect(refusal.plan.actions).toEqual([]);
});
