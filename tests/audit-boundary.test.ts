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
