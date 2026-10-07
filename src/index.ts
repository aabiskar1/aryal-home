import {loadEntityPolicy} from './config/policy.js';
import {env} from './config/env.js';
import {getHomeAssistantStates} from './home-assistant/client.js';
import {discoverEntities} from './home-assistant/discovery.js';
import {getHomeAssistantRegistries} from './home-assistant/registry-client.js';
import {requestOllamaChat} from './ollama/client.js';
import {runPlanningPipeline} from './planning/pipeline.js';
import {selectionDiagnostic} from './planning/relevance.js';
import {resolveEntityPolicy} from './policy/resolver.js';

const main = async (instruction: string): Promise<void> => {
	const [states, configuredPolicy, registries] = await Promise.all([
		getHomeAssistantStates(),
		loadEntityPolicy(),
		getHomeAssistantRegistries(env.HA_URL, env.HA_TOKEN),
	]);
	const discoveredEntities = discoverEntities(states, registries);
	const resolvedPolicy = resolveEntityPolicy(discoveredEntities, configuredPolicy);
	const result = await runPlanningPipeline(instruction, discoveredEntities, resolvedPolicy, {
		model: env.OLLAMA_MODEL,
		maxRequestBytes: env.PLANNING_REQUEST_MAX_BYTES,
		chat: requestOllamaChat,
	});
	const {validatedPlan, selection, executionReadiness} = result;

	console.log('Connected to Home Assistant.');
	console.log(`Received ${states.length} entities.`);
	console.log(`Discovered ${discoveredEntities.length} entities.`);
	console.log(`Resolved ${result.permittedCount} allowed entities.`);
	console.log('Selection diagnostics:', selectionDiagnostic(selection, result.permittedCount));
	console.log('Semantic set expansion diagnostics:');
	console.log(JSON.stringify(result.intentExpansion, undefined, 2));
	console.log(`Validated plan outcome: ${validatedPlan.outcome}.`);
	console.log('Deterministically validated proposals:');
	console.log(
		JSON.stringify(
			validatedPlan.actions.map(({entityId, action, domain, service}) => ({
				entityId,
				action,
				domain,
				service,
			})),
			undefined,
			2,
		),
	);
	console.log(`Rejected ${validatedPlan.rejectedActions.length} proposed actions.`);
	console.log(`Execution-readiness outcome: ${executionReadiness.outcome}.`);
	console.log('Execution-ready commands (prepared only):');
	console.log(JSON.stringify(executionReadiness.commands, undefined, 2));
	console.log('Execution-readiness rejections:');
	console.log(
		JSON.stringify(
			executionReadiness.rejectedActions.map(({action, reason}) => ({
				entityId: action.entityId,
				action: action.action,
				reason,
			})),
			undefined,
			2,
		),
	);
	console.log('No Home Assistant service calls were made.');
};

const instruction = process.argv.slice(2).join(' ').trim();

if (instruction.length === 0) {
	throw new Error('Provide a planning instruction as a command-line argument.');
}

await main(instruction);
