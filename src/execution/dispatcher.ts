/* eslint-disable no-await-in-loop -- Fresh authorization, dispatch, and confirmation must stay sequential. */
import {setTimeout as delay} from 'node:timers/promises';
import {
	callHomeAssistantService,
	getHomeAssistantConfirmationState,
} from '../home-assistant/service-client.js';
import type {ExecutionReadyCommand} from './readiness.js';
import {
	revalidateForDispatch,
	type DispatchAuthorizedCommand,
	type RevalidationRejectionReason,
} from './revalidation.js';

export type ConfirmationFailureReason =
	'confirmation_read_failed' | 'target_missing' | 'ineligible_state' | 'state_mismatch';

export type CommandExecutionResult =
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
	'all_confirmed' | 'partial_success' | 'all_failed' | 'no_authorized_commands';

export type ExecutionResult = {outcome: ExecutionOutcome; results: CommandExecutionResult[]};

const confirmationAttempts = 3;
const confirmationDelayMs = 250;

const confirm = async (
	command: DispatchAuthorizedCommand,
): Promise<ConfirmationFailureReason | undefined> => {
	for (let attempt = 0; attempt < confirmationAttempts; attempt++) {
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

		if (attempt + 1 < confirmationAttempts) {
			await delay(confirmationDelayMs);
		}
	}

	return 'state_mismatch';
};

// Private: production callers cannot dispatch cached authorization or bypass fresh revalidation.
const dispatchAuthorizedCommands = async (
	commands: readonly DispatchAuthorizedCommand[],
): Promise<Array<Exclude<CommandExecutionResult, {outcome: 'skipped_not_authorized'}>>> => {
	const results: Array<Exclude<CommandExecutionResult, {outcome: 'skipped_not_authorized'}>> = [];
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
