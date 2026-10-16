import {describe, expect, it, vi} from 'vitest';
import {inspectDisableTargets, disableStaleRegistryEntity} from '../src/audit/fixes/registry.js';
import {fingerprint} from '../src/audit/fixes/fingerprint.js';

type Message = Record<string, unknown>;
class RegistrySocket {
	readonly sent: Message[] = [];
	readonly handlers = new Map<string, Array<(event: {data: string}) => void>>();
	isClosed = false;
	constructor(private readonly reply: (message: Message, socket: RegistrySocket) => void) {
		queueMicrotask(() => {
			this.emit({type: 'auth_required'});
		});
	}

	addEventListener(name: string, handler: (event: {data: string}) => void): void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
	}

	send(text: string): void {
		const message = JSON.parse(text) as Message;
		this.sent.push(message);
		this.reply(message, this);
	}

	emit(message: unknown): void {
		queueMicrotask(() => {
			for (const handler of this.handlers.get('message') ?? []) {
				handler({data: JSON.stringify(message)});
			}
		});
	}

	close(): void {
		this.isClosed = true;
	}
}

const entry = {
	entity_id: 'light.example_stale',
	device_id: 'example_device',
	area_id: null,
	labels: [],
	disabled_by: null,
	unique_id: 'example-unique',
	original_name: 'Example Lamp',
	platform: 'example_integration',
};
type Failure =
	| 'auth'
	| 'non-admin'
	| 'unsupported'
	| 'wrong id'
	| 'malformed'
	| 'timeout'
	| 'changed'
	| 'refused'
	| 'not disabled'
	| 'wrong entity'
	| 'identity swap';
const readOverrides: Partial<Record<Failure, unknown>> = {
	malformed: {entity_id: 3},
	changed: {...entry, original_name: 'Changed'},
	'wrong entity': {...entry, entity_id: 'light.example_other'},
};

const harness = (failure?: Failure) => {
	let current: Record<string, unknown> = {...entry};
	let socket!: RegistrySocket;
	const options = {
		timeoutMs: 100,
		createSocket(url: string) {
			expect(url).toBe('wss://ha.example.test/api/websocket');
			socket = new RegistrySocket((message, respondingSocket) => {
				if (message.type === 'auth') {
					respondingSocket.emit({type: failure === 'auth' ? 'auth_invalid' : 'auth_ok'});
					return;
				}

				if (failure === 'timeout') {
					return;
				}

				let result: unknown = current;
				let isSuccess = true;
				switch (message.type) {
					case 'auth/current_user': {
						result = {is_admin: failure !== 'non-admin'};

						break;
					}

					case 'config/entity_registry/get': {
						if (failure === 'unsupported') {
							isSuccess = false;
						} else if (failure !== undefined && Object.hasOwn(readOverrides, failure)) {
							result = readOverrides[failure];
						}

						break;
					}

					case 'config/entity_registry/update': {
						if (failure === 'refused') {
							isSuccess = false;
						} else if (failure !== 'not disabled') {
							current = {
								...current,
								disabled_by: 'user',
								unique_id: failure === 'identity swap' ? 'replacement-identity' : current.unique_id,
							};
						}

						result = {entity_entry: current};

						break;
					}
					// No default
				}

				respondingSocket.emit({
					type: 'result',
					id: failure === 'wrong id' ? 1000 : message.id,
					success: isSuccess,
					result,
				});
			});
			return socket as unknown as WebSocket;
		},
	};
	return {options, getSocket: () => socket};
};

describe('narrow entity registry disable transport', () => {
	it('reads admin and exact identity evidence without any mutation', async () => {
		const {options, getSocket} = harness();
		const result = await inspectDisableTargets(
			'https://ha.example.test',
			'example-token',
			['light.example_stale'],
			options,
		);
		expect(result['light.example_stale']?.digest).toBe(fingerprint(entry));
		expect(getSocket().sent.map(({type}) => type)).toEqual([
			'auth',
			'auth/current_user',
			'config/entity_registry/get',
		]);
		expect(getSocket().isClosed).toBe(true);
	});

	it.each([
		'auth',
		'non-admin',
		'unsupported',
		'wrong id',
		'malformed',
		'timeout',
		'wrong entity',
	] as const)('cannot prove supported disable capability on %s', async (failure) => {
		const {options, getSocket} = harness(failure);
		expect(
			await inspectDisableTargets(
				'https://ha.example.test',
				'example-token',
				['light.example_stale'],
				options,
			),
		).toEqual({});
		expect(getSocket().sent.some(({type}) => type === 'config/entity_registry/update')).toBe(false);
		expect(getSocket().isClosed).toBe(true);
	});

	it('sends only the exact disable payload, then re-reads and verifies disabled_by', async () => {
		const {options, getSocket} = harness();
		const beforeWrite = vi.fn(async () => true);
		const result = await disableStaleRegistryEntity(
			{url: 'https://ha.example.test', token: 'example-token'},
			{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
			beforeWrite,
			{signal: new AbortController().signal, ...options},
		);
		expect(result).toBe('verified');
		expect(beforeWrite).toHaveBeenCalledOnce();
		expect(getSocket().sent).toEqual([
			{type: 'auth', access_token: 'example-token'},
			{id: 1, type: 'auth/current_user'},
			{id: 2, type: 'config/entity_registry/get', entity_id: 'light.example_stale'},
			{
				id: 3,
				type: 'config/entity_registry/update',
				entity_id: 'light.example_stale',
				disabled_by: 'user',
			},
			{id: 4, type: 'config/entity_registry/get', entity_id: 'light.example_stale'},
		]);
		expect(getSocket().isClosed).toBe(true);
	});

	it.each(['changed', 'non-admin'] as const)('does not write when %s', async (failure) => {
		const {options, getSocket} = harness(failure);
		expect(
			await disableStaleRegistryEntity(
				{url: 'https://ha.example.test', token: 'example-token'},
				{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
				async () => true,
				{signal: new AbortController().signal, ...options},
			),
		).toBe('changed');
		expect(getSocket().sent.some(({type}) => type === 'config/entity_registry/update')).toBe(false);
	});

	it.each([
		'refused',
		'not disabled',
		'wrong id',
		'malformed',
		'timeout',
		'identity swap',
	] as const)('never claims success on %s', async (failure) => {
		const {options} = harness(failure);
		expect(
			await disableStaleRegistryEntity(
				{url: 'https://ha.example.test', token: 'example-token'},
				{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
				async () => true,
				{signal: new AbortController().signal, ...options},
			),
		).toBe('failed');
	});

	it('does not write if fresh production revalidation refuses', async () => {
		const {options, getSocket} = harness();
		expect(
			await disableStaleRegistryEntity(
				{url: 'https://ha.example.test', token: 'example-token'},
				{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
				async () => false,
				{signal: new AbortController().signal, ...options},
			),
		).toBe('changed');
		expect(getSocket().sent.some(({type}) => type === 'config/entity_registry/update')).toBe(false);
	});

	it('does not send a delayed write after the connection deadline expires during fresh reads', async () => {
		const {options, getSocket} = harness();
		options.timeoutMs = 5;
		const beforeWrite = async () =>
			new Promise<boolean>((resolve) => {
				setTimeout(() => {
					resolve(true);
				}, 15);
			});
		expect(
			await disableStaleRegistryEntity(
				{url: 'https://ha.example.test', token: 'example-token'},
				{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
				beforeWrite,
				{signal: new AbortController().signal, ...options},
			),
		).toBe('failed');
		expect(getSocket().sent.some(({type}) => type === 'config/entity_registry/update')).toBe(false);
	});

	it('Ctrl+C during fresh reads prevents mutation', async () => {
		const {options, getSocket} = harness();
		const controller = new AbortController();
		const beforeWrite = async () => {
			controller.abort();
			return true;
		};

		expect(
			await disableStaleRegistryEntity(
				{url: 'https://ha.example.test', token: 'example-token'},
				{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
				beforeWrite,
				{signal: controller.signal, ...options},
			),
		).toBe('changed');
		expect(getSocket().sent.some(({type}) => type === 'config/entity_registry/update')).toBe(false);
	});

	it('finishes verification if interrupted after the disable was dispatched', async () => {
		const base = harness();
		const controller = new AbortController();
		const options = {
			...base.options,
			createSocket(url: string) {
				const socket = base.options.createSocket(url);
				const send = socket.send.bind(socket);
				socket.send = (text) => {
					send(text);
					if (typeof text === 'string' && text.includes('config/entity_registry/update')) {
						controller.abort();
					}
				};

				return socket;
			},
		};
		expect(
			await disableStaleRegistryEntity(
				{url: 'https://ha.example.test', token: 'example-token'},
				{entityId: 'light.example_stale', expectedDigest: fingerprint(entry)},
				async () => true,
				{signal: controller.signal, ...options},
			),
		).toBe('verified');
	});

	it.each(['lock.example_lock', 'light.*', 'light.bad id'])(
		'rejects unsupported target %s before opening a connection',
		async (id) => {
			const createSocket = vi.fn();
			expect(
				await disableStaleRegistryEntity(
					{url: 'https://ha.example.test', token: 'example-token'},
					{entityId: id, expectedDigest: fingerprint(entry)},
					async () => true,
					{signal: new AbortController().signal, createSocket},
				),
			).toBe('failed');
			expect(createSocket).not.toHaveBeenCalled();
		},
	);
});
