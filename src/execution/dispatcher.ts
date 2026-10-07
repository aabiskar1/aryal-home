/* eslint-disable no-await-in-loop -- Fresh authorization, dispatch, and confirmation must stay sequential. */
import {setTimeout as delay} from 'node:timers/promises';
import got from 'got';
import {z} from 'zod';
import {env} from '../config/env.js';
import {resolveAction} from '../home-assistant/capabilities.js';
import {getDomainFromEntityId} from '../home-assistant/discovery.js';
import {
	homeAssistantStateSchema,
	homeAssistantStatesSchema,
	type HomeAssistantState,
} from '../home-assistant/schemas.js';
import type {ExecutionReadyCommand} from './readiness.js';
import {
	revalidateForDispatch,
	type DispatchAuthorizedCommand,
	type RevalidationRejectionReason,
} from './revalidation.js';

export type ConfirmationFailureReason =
	'confirmation_read_failed' | 'target_missing' | 'ineligible_state' | 'state_mismatch';

export type CommandExecutionResult =
	| {index: number; outcome: 'execution_disabled'; reason: 'dry_run'}
	| {index: number; outcome: 'confirmed'; command: DispatchAuthorizedCommand}
	| {
			index: number;
			outcome: 'dispatch_failed';
			command: DispatchAuthorizedCommand;
			reason: 'service_request_failed';
	  }
	| {
			index: number;
			outcome: 'confirmation_failed';
			command: DispatchAuthorizedCommand;
			reason: ConfirmationFailureReason;
	  }
	| {
			index: number;
			outcome: 'skipped_not_authorized';
			entityId?: string;
			reason: RevalidationRejectionReason;
	  };

export type ExecutionOutcome =
	| 'all_confirmed'
	| 'partial_success'
	| 'all_failed'
	| 'no_authorized_commands'
	| 'execution_disabled';

export type ExecutionResult = {outcome: ExecutionOutcome; results: CommandExecutionResult[]};

const commandSchema = z
	.strictObject({
		domain: z.enum(['light', 'switch']),
		service: z.enum(['turn_on', 'turn_off']),
		target: z.strictObject({entity_id: z.string().regex(/^(?:light|switch)\.[0-9_a-z]+$/v)}),
	})
	.refine(({domain, target}) => getDomainFromEntityId(target.entity_id) === domain);

const serviceClient = got.extend({
	prefixUrl: `${env.HA_URL}/api`,
	headers: {authorization: `Bearer ${env.HA_TOKEN}`},
	timeout: {request: 5000},
	retry: {limit: 0},
	followRedirect: false,
	throwHttpErrors: false,
});

const checkResponse = (statusCode: number): void => {
	if (statusCode < 200 || statusCode >= 300) {
		throw new Error('Home Assistant request failed.');
	}
};

// Private transport: no module export can bypass the execution gate and fresh revalidation.
const callHomeAssistantService = async (command: DispatchAuthorizedCommand): Promise<void> => {
	if (env.DRY_RUN) {
		throw new Error('Execution is disabled.');
	}

	const parsed = commandSchema.parse(command);
	// Re-derive routing using the fixed application catalogue, never interpolate unchecked input.
	const resolved = resolveAction(getDomainFromEntityId(parsed.target.entity_id), parsed.service);
	if (resolved?.domain !== parsed.domain || resolved.service !== parsed.service) {
		throw new Error('Unsupported Home Assistant routing.');
	}

	const response = await serviceClient.post(`services/${resolved.domain}/${resolved.service}`, {
		json: {entity_id: parsed.target.entity_id},
		responseType: 'json',
	});
	checkResponse(response.statusCode);
	// These power services return a changed-state list; it is not execution confirmation.
	homeAssistantStatesSchema.parse(response.body);
};

/** Internal, uncached single-target read used only after a successful service response. */
const getHomeAssistantConfirmationState = async (
	command: DispatchAuthorizedCommand,
): Promise<HomeAssistantState | undefined> => {
	const parsed = commandSchema.parse(command);
	const response = await serviceClient.get(`states/${parsed.target.entity_id}`, {
		responseType: 'json',
		timeout: {request: 2000},
	});
	if (response.statusCode === 404) {
		return undefined;
	}

	checkResponse(response.statusCode);
	const state = homeAssistantStateSchema.parse(response.body);
	if (state.entity_id !== parsed.target.entity_id) {
		throw new Error('Unexpected Home Assistant confirmation target.');
	}

	return state;
};

const CONFIRMATION_MAX_READS = 5;
const CONFIRMATION_RETRY_DELAY_MS = 500;

const confirm = async (
	command: DispatchAuthorizedCommand,
): Promise<ConfirmationFailureReason | undefined> => {
	for (let attempt = 0; attempt < CONFIRMATION_MAX_READS; attempt++) {
		let state;
		try {
			state = await getHomeAssistantConfirmationState(command);
		} catch {
			return 'confirmation_read_failed';
		}

		if (state === undefined) {
			return 'target_missing';
		}

		if (state.state !== 'on' && state.state !== 'off') {
			return 'ineligible_state';
		}

		if (state.state === (command.service === 'turn_on' ? 'on' : 'off')) {
			return undefined;
		}

		if (attempt + 1 < CONFIRMATION_MAX_READS) {
			await delay(CONFIRMATION_RETRY_DELAY_MS);
		}
	}

	return 'state_mismatch';
};

// Private: production callers cannot dispatch cached authorization or bypass fresh revalidation.
const dispatchAuthorizedCommands = async (
	commands: readonly DispatchAuthorizedCommand[],
): Promise<
	Array<Exclude<CommandExecutionResult, {outcome: 'skipped_not_authorized' | 'execution_disabled'}>>
> => {
	const results: Array<
		Exclude<CommandExecutionResult, {outcome: 'skipped_not_authorized' | 'execution_disabled'}>
	> = [];
	for (const [index, command] of commands.entries()) {
		try {
			await callHomeAssistantService(command);
		} catch {
			results.push({index, outcome: 'dispatch_failed', command, reason: 'service_request_failed'});
			continue;
		}

		const reason = await confirm(command);
		results.push(
			reason === undefined
				? {index, outcome: 'confirmed', command}
				: {index, outcome: 'confirmation_failed', command, reason},
		);
	}

	return results;
};

/** Deliberate execution API. Freshly authorize, dispatch sequentially, and confirm; never queue. */
export const executeReadyCommands = async (
	commands: readonly ExecutionReadyCommand[],
): Promise<ExecutionResult> => {
	if (env.DRY_RUN) {
		return {
			outcome: 'execution_disabled',
			results: commands.map((_, index) => ({
				index,
				outcome: 'execution_disabled',
				reason: 'dry_run',
			})),
		};
	}

	const batch = [...commands];
	const validation = await revalidateForDispatch(batch);
	const results: CommandExecutionResult[] = [];
	let dispatched = 0;
	for (const initial of validation.decisions) {
		let decision = initial;
		if (initial.status === 'authorized' && dispatched > 0) {
			// Earlier dispatch/confirmation deferred this target: discard its old authorization.
			const refreshed = await revalidateForDispatch([batch[initial.index]!]);
			decision = refreshed.decisions[0]!;
		}

		if (decision.status === 'rejected') {
			results.push({
				index: initial.index,
				outcome: 'skipped_not_authorized',
				reason: decision.reason,
				...(decision.entityId !== undefined && {entityId: decision.entityId}),
			});
			continue;
		}

		// Single-command batches keep each POST adjacent to its fresh authorization.
		const [result] = await dispatchAuthorizedCommands([decision.command]);
		dispatched++;
		results.push({...result!, index: initial.index});
	}

	const confirmed = results.filter((result) => result.outcome === 'confirmed').length;
	let outcome: ExecutionOutcome = 'all_failed';
	if (dispatched === 0) {
		outcome = 'no_authorized_commands';
	} else if (confirmed === results.length) {
		outcome = 'all_confirmed';
	} else if (confirmed > 0) {
		outcome = 'partial_success';
	}

	return {outcome, results};
};
