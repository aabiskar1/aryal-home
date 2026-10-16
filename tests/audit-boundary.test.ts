import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {expect, it} from 'vitest';

const dependencies = (path: string, source: string): string[] => {
	const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
	const paths: string[] = [];
	for (const statement of parsed.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}

		const dependency = statement.moduleSpecifier.text;
		expect(dependency).not.toBe('node:child_process');
		if (dependency.startsWith('.')) {
			paths.push(resolve(dirname(path), dependency.replace(/\.js$/v, '.ts')));
		}
	}

	return paths;
};

it('keeps all repository dependencies reachable from the audit free of model, execution, and mutation paths', async () => {
	const visited = new Set<string>();
	const visit = async (path: string): Promise<void> => {
		if (visited.has(path)) {
			return;
		}

		visited.add(path);
		expect(path).not.toMatch(/\/(?:execution|ollama)\//v);
		expect(path).not.toMatch(/\/config\/env\.ts$/v);
		const source = await readFile(path, 'utf8');
		if (path.endsWith('/cli/ha-audit.ts')) {
			expect(source.match(/import\(/gv)).toHaveLength(1);
			expect(source).toContain("if (args[0] === '--fix')");
			expect(source).toContain("await import('./ha-audit-fix.js')");
		} else {
			expect(source).not.toMatch(/import\(/v);
		}

		expect(source).not.toMatch(/\.(?:post|put|patch|delete)\(/v);
		expect(source).not.toMatch(/\b(?:writeFile|appendFile|unlink|call_service)\b/v);
		expect(source).not.toMatch(
			/config\/(?:entity|device|area|label)_registry\/(?:update|remove|create)/v,
		);
		await Promise.all(dependencies(path, source).map(async (dependency) => visit(dependency)));
	};

	await visit(fileURLToPath(new URL('../src/ha-audit.ts', import.meta.url)));
	const stateReader = fileURLToPath(
		new URL('../src/home-assistant/state-reader.ts', import.meta.url),
	);
	const registryReader = fileURLToPath(
		new URL('../src/home-assistant/registry-client.ts', import.meta.url),
	);
	expect(visited.has(stateReader)).toBe(true);
	expect(visited.has(registryReader)).toBe(true);
});

it('bounds remediation dependencies to entity-disable and exact-deny metadata writes, with no runtime/model/service path', async () => {
	const visited = new Set<string>();
	const mutations: string[] = [];
	const visit = async (path: string): Promise<void> => {
		if (visited.has(path)) {
			return;
		}

		visited.add(path);
		expect(path).not.toMatch(/\/(?:execution|ollama)\//v);
		expect(path).not.toMatch(/\/planning\/(?:planner|pipeline|policy)\.ts$/v);
		const source = await readFile(path, 'utf8');
		expect(source).not.toMatch(/\.(?:post|put|patch|delete)\(/v);
		if (!path.endsWith('/cli/ha-audit.ts')) {
			expect(source).not.toMatch(/import\(/v);
		}

		expect(source).not.toMatch(
			/\b(?:call_service|ExecutionReadyCommand|DispatchAuthorizedCommand|executeReadyCommands|generatePlan)\b/v,
		);
		expect(source).not.toMatch(/config\/(?:entity|device|area|label)_registry\/(?:remove|create)/v);
		if (source.includes('config/entity_registry/update')) {
			mutations.push(path);
		}

		if (!path.endsWith('/audit/fixes/policy.ts')) {
			expect(source).not.toMatch(/\b(?:writeFile|appendFile|unlink|rename)\b/v);
		}

		await Promise.all(dependencies(path, source).map(async (dependency) => visit(dependency)));
	};

	await visit(fileURLToPath(new URL('../src/cli/ha-audit-fix.ts', import.meta.url)));
	expect(new Set(mutations.map((path) => path.split('/').slice(-2).join('/')))).toEqual(
		new Set(['fixes/presentation.ts', 'fixes/registry.ts']),
	);
	const transport = await readFile(
		fileURLToPath(new URL('../src/audit/fixes/registry.ts', import.meta.url)),
		'utf8',
	);
	expect(transport).toContain("disabled_by: 'user'");
	expect(transport).not.toMatch(/\b(?:new_entity_id|area_id|name|labels|hidden_by):/v);
	expect(transport).not.toMatch(/export (?:const|type) (?:Request|RegistryCommand|withRegistry)/v);
	const ignores = await readFile(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8');
	expect(ignores).toContain('config/entity-policy.json.audit-fix-*.tmp');
});
