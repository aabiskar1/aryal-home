import {readFile, readdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {expect, it} from 'vitest';

it('keeps assessment dependencies free of HA mutation, execution, scheduling and preference changes', async () => {
	const visited = new Set<string>();
	const visit = async (path: string): Promise<void> => {
		if (visited.has(path)) {
			return;
		}

		visited.add(path);
		expect(path).not.toMatch(/\/(?:execution|fixes)\//v);
		expect(path).not.toMatch(/\/planning\/(?:pipeline|planner|policy|relevance|intents)\.ts$/v);
		const source = await readFile(path, 'utf8');
		expect(source).not.toMatch(
			/\b(?:setInterval|executeReadyCommands|DispatchAuthorizedCommand|call_service)\b/v,
		);
		expect(source).not.toMatch(/\.(?:put|patch|delete)\(/v);
		if (!path.endsWith('/ollama/client.ts')) {
			expect(source).not.toMatch(/\.post\(/v);
		}

		if (!path.endsWith('/lighting-thresholds/preferences.ts')) {
			expect(source).not.toMatch(/\b(?:changeThresholdPreference|writeFile|rename|unlink)\b/v);
		}

		const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
		const dependencies: string[] = [];
		for (const statement of ast.statements) {
			if (
				!ts.isImportDeclaration(statement) ||
				!ts.isStringLiteral(statement.moduleSpecifier) ||
				statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
			) {
				continue;
			}

			const dependency = statement.moduleSpecifier.text;
			expect(dependency).not.toMatch(/child_process/v);
			if (dependency.startsWith('.')) {
				dependencies.push(resolve(dirname(path), dependency.replace(/\.js$/v, '.ts')));
			}
		}

		const dynamicImports: string[] = [];
		const inspect = (node: ts.Node) => {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const argument = node.arguments[0];
				expect(argument && ts.isStringLiteral(argument)).toBe(true);
				if (argument && ts.isStringLiteral(argument)) {
					dynamicImports.push(argument.text);
				}
			}

			ts.forEachChild(node, inspect);
		};

		inspect(ast);
		for (const dependency of dynamicImports) {
			expect(path).toBe(fileURLToPath(new URL('../src/cli/assess-home.ts', import.meta.url)));
			expect(dependency).toBe('../ollama/client.js');
			dependencies.push(resolve(dirname(path), dependency.replace(/\.js$/v, '.ts')));
		}

		await Promise.all(dependencies.map(async (dependency) => visit(dependency)));
	};

	await visit(fileURLToPath(new URL('../src/assess-home.ts', import.meta.url)));
	expect([...visited].some((path) => path.endsWith('/ollama/client.ts'))).toBe(true);
});

it('keeps instruction planning and execution independent of the advisory assessment', async () => {
	await Promise.all(
		['planning', 'execution'].map(async (directory) => {
			const root = fileURLToPath(new URL(`../src/${directory}/`, import.meta.url));
			const files = await readdir(root);
			await Promise.all(
				files.map(async (name) => {
					const source = await readFile(resolve(root, name), 'utf8');
					expect(source).not.toMatch(/assessment|assessContext|validateAssessment/v);
				}),
			);
		}),
	);
});
