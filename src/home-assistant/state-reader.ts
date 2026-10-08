import got from 'got';
import {homeAssistantStatesSchema, type HomeAssistantState} from './schemas.js';

/** Read-only transport shared by runtime discovery and maintenance tools. */
export const createHomeAssistantStateReader = (
	homeAssistantUrl: string,
	token: string,
): (() => Promise<HomeAssistantState[]>) => {
	const client = got.extend({
		prefixUrl: `${homeAssistantUrl}/api`,
		headers: {authorization: `Bearer ${token}`},
		timeout: {request: 10_000},
		retry: {limit: 2},
	});

	return async () => {
		const data: unknown = await client.get('states').json();
		return homeAssistantStatesSchema.parse(data);
	};
};
