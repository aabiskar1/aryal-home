import type {OllamaChatRequest} from './client.js';

export const createOllamaChatPayload = (request: OllamaChatRequest, model: string) => ({
	model,
	messages: request.messages,
	stream: false,
	think: false,
	keep_alive: '3m',
	...(request.format && {format: request.format}),
});
