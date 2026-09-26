import {z} from 'zod';
import {
	registrySchemas,
	type AreaRegistryEntry,
	type DeviceRegistryEntry,
	type EntityRegistryEntry,
	type LabelRegistryEntry,
} from './registry-schemas.js';

export type RegistrySnapshot =
	| {status: 'unavailable'}
	| {
			status: 'available';
			entities: EntityRegistryEntry[];
			devices: DeviceRegistryEntry[];
			areas: AreaRegistryEntry[];
			labels: LabelRegistryEntry[];
	  };

const authenticationMessageSchema = z.object({
	type: z.enum(['auth_required', 'auth_ok', 'auth_invalid']),
});

const messageIdSchema = z.number().int();
const errorSchema = z.object({code: z.string(), message: z.string()});

const resultMessageSchema = z.discriminatedUnion('success', [
	z.object({
		type: z.literal('result'),
		id: messageIdSchema,
		success: z.literal(true),
		result: z.unknown(),
	}),
	z.object({
		type: z.literal('result'),
		id: messageIdSchema,
		success: z.literal(false),
		error: errorSchema,
	}),
]);

const webSocketUrl = (homeAssistantUrl: string): string => {
	const url = new URL('/api/websocket', homeAssistantUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.href;
};

export const getHomeAssistantRegistries = async (
	homeAssistantUrl: string,
	token: string,
	createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
	timeoutMs = 10_000,
): Promise<RegistrySnapshot> => {
	let socket: WebSocket | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;

	try {
		socket = createSocket(webSocketUrl(homeAssistantUrl));
		const messages: unknown[] = [];
		let pending: {resolve: (message: unknown) => void; reject: (error: Error) => void} | undefined;
		let failure: Error | undefined;

		const fail = (): void => {
			failure = new Error('Home Assistant registry connection failed.');
			pending?.reject(failure);
			pending = undefined;
		};

		socket.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') {
				fail();
				return;
			}

			try {
				const message: unknown = JSON.parse(event.data);

				if (pending === undefined) {
					messages.push(message);
				} else {
					pending.resolve(message);
					pending = undefined;
				}
			} catch {
				fail();
			}
		});
		socket.addEventListener('error', fail);
		socket.addEventListener('close', fail);
		timeout = setTimeout(fail, timeoutMs);

		const receive = async (): Promise<unknown> => {
			if (failure !== undefined) {
				throw failure;
			}

			if (messages.length > 0) {
				return messages.shift();
			}

			return new Promise<unknown>((resolve, reject) => {
				pending = {resolve, reject};
			});
		};

		const greeting = authenticationMessageSchema.parse(await receive());

		if (greeting.type !== 'auth_required') {
			throw new Error('Unexpected Home Assistant authentication greeting.');
		}

		socket.send(JSON.stringify({type: 'auth', access_token: token}));
		const authentication = authenticationMessageSchema.parse(await receive());

		if (authentication.type !== 'auth_ok') {
			throw new Error('Home Assistant registry authentication failed.');
		}

		let nextId = 1;
		const request = async (type: keyof typeof registrySchemas): Promise<unknown> => {
			const id = nextId++;
			socket!.send(JSON.stringify({id, type}));
			const response = resultMessageSchema.parse(await receive());

			if (response.id !== id || !response.success) {
				throw new Error('Home Assistant registry request failed.');
			}

			return response.result;
		};

		const entities = registrySchemas['config/entity_registry/list'].parse(
			await request('config/entity_registry/list'),
		);
		const devices = registrySchemas['config/device_registry/list'].parse(
			await request('config/device_registry/list'),
		);
		const areas = registrySchemas['config/area_registry/list'].parse(
			await request('config/area_registry/list'),
		);
		const labels = registrySchemas['config/label_registry/list'].parse(
			await request('config/label_registry/list'),
		);

		return {status: 'available', entities, devices, areas, labels};
	} catch {
		return {status: 'unavailable'};
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}

		socket?.close();
	}
};
