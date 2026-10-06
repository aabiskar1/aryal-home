import got from 'got';
import {z} from 'zod';
import {env} from '../config/env.js';
import type {DispatchAuthorizedCommand} from '../execution/revalidation.js';
import {resolveAction} from './capabilities.js';
import {getDomainFromEntityId} from './discovery.js';
import {
	homeAssistantStateSchema,
	homeAssistantStatesSchema,
	type HomeAssistantState,
} from './schemas.js';

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

/** Internal transport, not an execution entry point. Use executeReadyCommands for fresh authorization. */
export const callHomeAssistantService = async (
	command: DispatchAuthorizedCommand,
): Promise<void> => {
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
export const getHomeAssistantConfirmationState = async (
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
