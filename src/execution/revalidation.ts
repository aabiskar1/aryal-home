import {z} from 'zod';
import {loadEntityPolicy} from '../config/policy.js';
import {canonicalActions, resolveAction} from '../home-assistant/capabilities.js';
import {
	discoverEntities,
	getDomainFromEntityId,
	type DiscoveredEntity,
} from '../home-assistant/discovery.js';
import {
	getHomeAssistantRegistries,
	type RegistrySnapshot,
} from '../home-assistant/registry-client.js';
import {registrySchemas} from '../home-assistant/registry-schemas.js';
import {homeAssistantStatesSchema, type HomeAssistantState} from '../home-assistant/schemas.js';
import {normalizeState} from '../home-assistant/state-normalizer.js';
import {resolveEntityPolicy, type ResolvedEntityPolicy} from '../policy/resolver.js';
import {entityPolicySchema, type EntityPolicy} from '../policy/schemas.js';
import type {ExecutionReadyCommand} from './readiness.js';

// The brand is not authority: validate the exact incoming shape again, including nested targets.
const incomingCommandSchema = z.strictObject({
	domain: z.string().min(1),
	service: z.string().min(1),
	target: z.strictObject({entity_id: z.string().regex(/^[0-9_a-z]+\.[0-9_a-z]+$/v)}),
});

const canonicalActionSchema = z.enum(canonicalActions);

const dispatchAuthorizedCommandSchema = z
	.strictObject({
		domain: z.enum(['light', 'switch']),
		service: canonicalActionSchema,
		target: z
			.strictObject({entity_id: z.string().regex(/^(?:light|switch)\.[0-9_a-z]+$/v)})
			.readonly(),
	})
	.refine(({domain, target}) => getDomainFromEntityId(target.entity_id) === domain)
	.readonly()
	.brand<'DispatchAuthorizedCommand'>();

const freshRegistrySnapshotSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('available'),
		entities: registrySchemas['config/entity_registry/list'],
		devices: registrySchemas['config/device_registry/list'],
		areas: registrySchemas['config/area_registry/list'],
		labels: registrySchemas['config/label_registry/list'],
	}),
	z.object({status: z.literal('unavailable')}),
]);

// Valid for this fresh validation only; do not cache or treat it as permanent permission.
export type DispatchAuthorizedCommand = z.infer<typeof dispatchAuthorizedCommandSchema>;

export type PreDispatchRevalidationOutcome = 'authorized' | 'rejected' | 'no_commands';

export type RevalidationRejectionReason =
	| 'invalid_command'
	| 'snapshot_unavailable'
	| 'target_missing'
	| 'ambiguous_target'
	| 'ineligible_state'
	| 'denied'
	| 'not_allowed'
	| 'unsupported_action'
	| 'routing_mismatch'
	| 'fresh_no_op';

export type CommandRevalidationDecision =
	| {index: number; status: 'authorized'; command: DispatchAuthorizedCommand}
	| {index: number; status: 'rejected'; entityId?: string; reason: RevalidationRejectionReason};

export type PreDispatchRevalidationResult = {
	outcome: PreDispatchRevalidationOutcome;
	commands: DispatchAuthorizedCommand[];
	decisions: CommandRevalidationDecision[];
};

// Trusted read adapters; each must perform a new read per invocation, never serve a planning cache.
export type FreshSnapshotReaders = {
	getStates: () => Promise<HomeAssistantState[]>;
	getRegistries: () => Promise<RegistrySnapshot>;
	loadPolicy: () => Promise<EntityPolicy>;
};

type IncomingCommand = z.infer<typeof incomingCommandSchema>;
type FreshContext = {entities: Map<string, DiscoveredEntity[]>; policy: ResolvedEntityPolicy};

const defaultReaders = async (): Promise<FreshSnapshotReaders> => {
	// Delay credential-dependent imports until an independent nonempty batch is requested.
	const [{getHomeAssistantStates}, {env}] = await Promise.all([
		import('../home-assistant/client.js'),
		import('../config/env.js'),
	]);

	return {
		getStates: getHomeAssistantStates,
		getRegistries: async () => getHomeAssistantRegistries(env.HA_URL, env.HA_TOKEN),
		loadPolicy: loadEntityPolicy,
	};
};

const readFreshContext = async (readers: FreshSnapshotReaders): Promise<FreshContext> => {
	const [rawStates, rawRegistries, rawPolicy] = await Promise.all([
		readers.getStates(),
		readers.getRegistries(),
		readers.loadPolicy(),
	]);
	const registries = freshRegistrySnapshotSchema.parse(rawRegistries);
	if (registries.status !== 'available') {
		throw new Error('Fresh registry metadata is unavailable.');
	}

	const states = homeAssistantStatesSchema.parse(rawStates);
	const policy = entityPolicySchema.parse(rawPolicy);
	const discovered = discoverEntities(states, registries);
	const entities = new Map<string, DiscoveredEntity[]>();
	for (const entity of discovered) {
		const group = entities.get(entity.entityId) ?? [];
		group.push(entity);
		entities.set(entity.entityId, group);
	}

	return {entities, policy: resolveEntityPolicy(discovered, policy)};
};

const reject = (
	index: number,
	reason: RevalidationRejectionReason,
	entityId?: string,
): CommandRevalidationDecision => ({
	index,
	status: 'rejected',
	reason,
	...(entityId !== undefined && {entityId}),
});

const revalidateCommand = (
	command: IncomingCommand,
	index: number,
	context: FreshContext,
): CommandRevalidationDecision => {
	const entityId = command.target.entity_id;
	const matches = context.entities.get(entityId) ?? [];
	if (matches.length === 0) {
		return reject(index, 'target_missing', entityId);
	}

	if (matches.length !== 1) {
		return reject(index, 'ambiguous_target', entityId);
	}

	const entity = matches[0]!;
	const state = normalizeState(entity);
	if (
		entity.metadata.status !== 'available' ||
		entity.metadata.disabled ||
		(state.state !== 'on' && state.state !== 'off')
	) {
		return reject(index, 'ineligible_state', entityId);
	}

	if (context.policy.deniedEntityIds.has(entityId)) {
		return reject(index, 'denied', entityId);
	}

	if (!context.policy.allowedEntityIds.has(entityId)) {
		return reject(index, 'not_allowed', entityId);
	}

	// Only these two canonical power actions can be represented by the current service catalogue.
	const action = canonicalActionSchema.safeParse(command.service);
	if (!action.success) {
		return reject(index, 'routing_mismatch', entityId);
	}

	const domain = getDomainFromEntityId(entity.entityId);
	const resolved = resolveAction(domain, action.data);
	if (resolved === undefined || !state.supportedActions.includes(action.data)) {
		return reject(index, 'unsupported_action', entityId);
	}

	if (
		command.domain !== domain ||
		resolved.domain !== domain ||
		command.service !== resolved.service
	) {
		return reject(index, 'routing_mismatch', entityId);
	}

	if (state.state === (action.data === 'turn_on' ? 'on' : 'off')) {
		return reject(index, 'fresh_no_op', entityId);
	}

	const authorized = dispatchAuthorizedCommandSchema.safeParse({
		domain,
		service: resolved.service,
		target: {entity_id: entity.entityId},
	});
	return authorized.success
		? {index, status: 'authorized', command: authorized.data}
		: reject(index, 'unsupported_action', entityId);
};

/** Read-only future dispatch boundary. Re-fetch and authorize once per batch, then STOP. */
export const revalidateForDispatch = async (
	commands: readonly ExecutionReadyCommand[],
	readers?: FreshSnapshotReaders,
): Promise<PreDispatchRevalidationResult> => {
	if (commands.length === 0) {
		return {outcome: 'no_commands', commands: [], decisions: []};
	}

	// Capture validated copies before awaiting fresh reads; caller mutations cannot change this batch.
	const parsed = commands.map((command) => incomingCommandSchema.safeParse(command));
	const targets = new Map<string, number>();
	for (const entry of parsed) {
		if (!entry.success) {
			continue;
		}

		const entityId = entry.data.target.entity_id;
		targets.set(entityId, (targets.get(entityId) ?? 0) + 1);
	}

	let context: FreshContext | undefined;
	try {
		context = await readFreshContext(readers ?? (await defaultReaders()));
	} catch {
		// Fail closed without returning transport errors, credentials, paths, or raw snapshot data.
	}

	const decisions = parsed.map((entry, index): CommandRevalidationDecision => {
		if (!entry.success) {
			return reject(index, 'invalid_command');
		}

		const entityId = entry.data.target.entity_id;
		if (context === undefined) {
			return reject(index, 'snapshot_unavailable', entityId);
		}

		if (targets.get(entityId)! > 1) {
			return reject(index, 'ambiguous_target', entityId);
		}

		return revalidateCommand(entry.data, index, context);
	});
	const authorized = decisions.flatMap((decision) =>
		decision.status === 'authorized' ? [decision.command] : [],
	);

	return {
		outcome: authorized.length > 0 ? 'authorized' : 'rejected',
		commands: authorized,
		decisions,
	};
};
