import {loadEntityPolicy} from './config/policy.js';
import {env} from './config/env.js';
import {getHomeAssistantStates} from './home-assistant/client.js';
import {discoverEntities} from './home-assistant/discovery.js';
import {getHomeAssistantRegistries} from './home-assistant/registry-client.js';
import {normalizeStates} from './home-assistant/state-normalizer.js';
import {requestOllamaChat} from './ollama/client.js';
import {createPlan} from './planning/planner.js';
import {validatePlan} from './planning/policy.js';
import {resolveEntityPolicy, selectAllowedEntities} from './policy/resolver.js';

const main = async (instruction: string): Promise<void> => {
	const [states, configuredPolicy, registries] = await Promise.all([
		getHomeAssistantStates(),
		loadEntityPolicy(),
		getHomeAssistantRegistries(env.HA_URL, env.HA_TOKEN),
	]);
	const discoveredEntities = discoverEntities(states, registries);
	const resolvedPolicy = resolveEntityPolicy(discoveredEntities, configuredPolicy);
	const allowedEntities = selectAllowedEntities(discoveredEntities, resolvedPolicy);
	const normalizedStates = normalizeStates(allowedEntities);
	const plan = await createPlan({instruction, states: normalizedStates}, requestOllamaChat);
	const validatedPlan = validatePlan(plan, resolvedPolicy);

	console.log('Connected to Home Assistant.');
	console.log(`Received ${states.length} entities.`);
	console.log(`Discovered ${discoveredEntities.length} entities.`);
	console.log(`Resolved ${resolvedPolicy.allowedEntityIds.size} allowed entities.`);
	console.log(`Normalized ${normalizedStates.length} entities.`);
	console.log(`Model plan outcome: ${validatedPlan.outcome}.`);
	console.log('Model plan summary (untrusted descriptive text):');
	console.log(validatedPlan.summary);
	console.log('Deterministically validated proposals:');
	console.log(JSON.stringify(validatedPlan.actions, undefined, 2));
	console.log(`Rejected ${validatedPlan.rejectedActions.length} proposed actions.`);
	console.log('No Home Assistant service calls were made.');
};

const instruction = process.argv.slice(2).join(' ').trim();

if (instruction.length === 0) {
	throw new Error('Provide a planning instruction as a command-line argument.');
}

await main(instruction);
