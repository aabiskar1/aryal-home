import {describe, expect, it} from 'vitest';
import {getHomeAssistantRegistries} from '../src/home-assistant/registry-client.js';

type MessageHandler = (event: {data: string}) => void;
type EventHandler = () => void;

class FakeSocket {
	private readonly messageHandlers: MessageHandler[] = [];
	private readonly errorHandlers: EventHandler[] = [];
	private readonly closeHandlers: EventHandler[] = [];
	readonly sent: Array<Record<string, unknown>> = [];
	closed = false;
	constructor(
		private readonly respond: (message: Record<string, unknown>, socket: FakeSocket) => void,
	) {
		queueMicrotask(() => {
			this.emit({type: 'auth_required'});
		});
	}

	addEventListener(name: string, handler: MessageHandler | EventHandler): void {
		switch (name) {
			case 'message': {
				this.messageHandlers.push(handler);
				break;
			}

			case 'error': {
				this.errorHandlers.push(handler as EventHandler);
				break;
			}

			case 'close': {
				this.closeHandlers.push(handler as EventHandler);
				break;
			}

			default: {
				throw new Error('Unexpected event');
			}
		}
	}

	send(data: string): void {
		const message = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(message);
		this.respond(message, this);
	}

	emit(message: unknown): void {
		const event = {data: JSON.stringify(message)};
		queueMicrotask(() => {
			for (const handler of this.messageHandlers) {
				handler(event);
			}
		});
	}

	error(): void {
		for (const handler of this.errorHandlers) {
			handler();
		}
	}

	close(): void {
		this.closed = true;
		for (const handler of this.closeHandlers) {
			handler();
		}
	}
}

const validResults: Record<string, unknown> = {
	'config/entity_registry/list': [
		{entity_id: 'light.example', device_id: null, area_id: null, labels: [], disabled_by: null},
	],
	'config/device_registry/list': [],
	'config/area_registry/list': [],
	'config/label_registry/list': [],
};

const standardResponse = (message: Record<string, unknown>, socket: FakeSocket): void => {
	if (message.type === 'auth') {
		socket.emit({type: 'auth_ok'});
		return;
	}

	socket.emit({
		type: 'result',
		id: message.id,
		success: true,
		result: validResults[String(message.type)],
	});
};

const run = async (
	respond = standardResponse,
	timeoutMs = 100,
): Promise<{
	result: Awaited<ReturnType<typeof getHomeAssistantRegistries>>;
	socket: FakeSocket;
	url: string;
}> => {
	let socket!: FakeSocket;
	let url = '';
	const result = await getHomeAssistantRegistries(
		'https://ha.example.test',
		'test-token',
		(address) => {
			url = address;
			socket = new FakeSocket(respond);
			return socket as unknown as WebSocket;
		},
		timeoutMs,
	);

	return {result, socket, url};
};

describe('Home Assistant registry client', () => {
	it('authenticates, uses distinct IDs, requests four read-only lists, and closes', async () => {
		const {result, socket, url} = await run();

		expect(url).toBe('wss://ha.example.test/api/websocket');
		expect(socket.sent).toEqual([
			{type: 'auth', access_token: 'test-token'},
			{id: 1, type: 'config/entity_registry/list'},
			{id: 2, type: 'config/device_registry/list'},
			{id: 3, type: 'config/area_registry/list'},
			{id: 4, type: 'config/label_registry/list'},
		]);
		expect(result.status).toBe('available');
		expect(socket.closed).toBe(true);
	});

	it.each(['auth_invalid', 'wrong id', 'error result', 'malformed', 'duplicate', 'timeout'])(
		'fails closed for %s',
		async (failure) => {
			const {result, socket} = await run((message, currentSocket) => {
				if (message.type === 'auth') {
					currentSocket.emit({type: failure === 'auth_invalid' ? 'auth_invalid' : 'auth_ok'});
					return;
				}

				if (failure === 'timeout') {
					return;
				}

				if (failure === 'wrong id') {
					currentSocket.emit({type: 'result', id: 99, success: true, result: []});
					return;
				}

				if (failure === 'error result') {
					currentSocket.emit({
						type: 'result',
						id: message.id,
						success: false,
						error: {code: 'unknown_command', message: 'Unavailable'},
					});
					return;
				}

				if (failure === 'malformed') {
					currentSocket.emit({type: 'result', id: message.id, success: true, result: [{}]});
					return;
				}

				const entry = validResults[String(message.type)];
				currentSocket.emit({
					type: 'result',
					id: message.id,
					success: true,
					result:
						failure === 'duplicate' && message.id === 1
							? [...(entry as unknown[]), ...(entry as unknown[])]
							: entry,
				});
			}, 20);

			expect(result).toEqual({status: 'unavailable'});
			expect(socket.closed).toBe(true);
		},
	);

	it('accepts unrelated additive fields', async () => {
		const {result} = await run((message, socket) => {
			if (message.type === 'auth') {
				socket.emit({type: 'auth_ok'});
				return;
			}

			const value =
				message.id === 1
					? [
							{
								...(
									validResults['config/entity_registry/list'] as Array<Record<string, unknown>>
								)[0],
								extra: true,
							},
						]
					: validResults[String(message.type)];
			socket.emit({type: 'result', id: message.id, success: true, result: value});
		});

		expect(result.status).toBe('available');
	});
});
