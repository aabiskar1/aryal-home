import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {expect, it} from 'vitest';
import {classifyEventOrigin} from '../src/lighting-learning/events.js';
import {validateObservationConditions} from '../src/planning/observation-conditions.js';
import {historical, lightId} from './lighting-learning-fixture.js';

it('keeps every learning dependency free of execution, model, scheduling and write paths', async () => {
	const visited = new Set<string>();
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
			/\b(?:writeFile|appendFile|unlink|rename|call_service|setInterval|executeReadyCommands|DispatchAuthorizedCommand)\b/v,
		);
		expect(source).not.toMatch(/import\(/v);
		expect(source).not.toMatch(
			/config\/(?:entity|device|area|label)_registry\/(?:update|remove|create)/v,
		);
		const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
		const imports: string[] = [];
		for (const statement of ast.statements) {
			if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
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

	await visit(fileURLToPath(new URL('../src/learn-lighting.ts', import.meta.url)));
	expect([...visited].some((path) => path.endsWith('/history-client.ts'))).toBe(true);
	expect([...visited].some((path) => path.endsWith('/policy/resolver.ts'))).toBe(true);
});

it('does not upgrade any supported REST account/context attribution into interaction-supported evidence', () => {
	const state = historical(lightId, 'on');
	for (const user_id of [null, 'example-user']) {
		for (const parent_id of [null, 'example-parent']) {
			const result = classifyEventOrigin(
				{...state, context: {id: 'example-context', user_id, parent_id}},
				[],
			);
			expect(result).not.toBe('interaction_supported');
		}
	}
});

it('retains PR #14 refusal even if advisory statistical fixtures could estimate a value', () => {
	const result = validateObservationConditions(
		{
			outcome: 'propose_actions',
			summary: 'Proposed plan: example',
			actions: [{entityId: lightId, action: 'turn_on', reason: 'Example request'}],
		},
		{
			states: [
				{
					entityId: lightId,
					domain: 'light',
					name: 'Example Lamp',
					area: 'Example Room',
					state: 'off',
					supportedActions: ['turn_on', 'turn_off'],
				},
			],
			observations: [
				{
					entityId: 'sensor.example_illuminance',
					name: 'Example Sensor',
					area: 'Example Room',
					state: '30',
					deviceClass: 'illuminance',
					unit: 'lx',
				},
			],
		},
	);
	expect(result.issue?.reason).toBe('unresolved_illuminance_threshold');
	expect(result.plan.actions).toEqual([]);
	expect(result.plan.outcome).toBe('insufficient_context');
});
