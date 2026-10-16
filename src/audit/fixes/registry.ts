import {z} from 'zod';
import {entityRegistryEntrySchema} from '../../home-assistant/registry-schemas.js';
import {fingerprint} from './fingerprint.js';

type SocketOptions = {createSocket?: (url: string) => WebSocket; timeoutMs?: number};
type RegistryCommand =
	| {type: 'auth/current_user'}
	| {type: 'config/entity_registry/get'; entity_id: string}
	| {type: 'config/entity_registry/update'; entity_id: string; disabled_by: 'user'};
type Request = (command: RegistryCommand) => Promise<unknown>;

const resultSchema = z.object({
	type: z.literal('result'),
	id: z.number().int(),
	success: z.boolean(),
	result: z.unknown().optional(),
});
const entrySchema = entityRegistryEntrySchema
	.extend({unique_id: z.string().min(1), platform: z.string().min(1)})
	.loose();
const entityIdSchema = z.string().regex(/^(?:light|switch)\.[0-9_a-z]+$/v);

// Separate from the runtime read-only registry client; no generic exported mutation API.
const withRegistry = async <T>(
	url: string,
	token: string,
	work: (request: Request) => Promise<T>,
	options: SocketOptions,
): Promise<T> => {
	const address = new URL('/api/websocket', url);
	address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
	const socket = (options.createSocket ?? ((socketUrl: string) => new WebSocket(socketUrl)))(
		address.href,
	);
	const queue: unknown[] = [];
	let pending: {resolve: (value: unknown) => void; reject: (error: Error) => void} | undefined;
	let hasFailed = false;
	const fail = (): void => {
		hasFailed = true;
		pending?.reject(new Error('Registry operation failed.'));
		pending = undefined;
	};

	socket.addEventListener('message', (event) => {
		try {
			if (typeof event.data !== 'string') {
				throw new TypeError('Invalid registry message.');
			}

			const value: unknown = JSON.parse(event.data);
			if (pending === undefined) {
				queue.push(value);
			} else {
				pending.resolve(value);
				pending = undefined;
			}
		} catch {
			fail();
		}
	});
	socket.addEventListener('error', fail);
	socket.addEventListener('close', fail);
	const timer = setTimeout(fail, options.timeoutMs ?? 10_000);
	const receive = async (): Promise<unknown> => {
		if (hasFailed) {
			throw new Error('Registry operation failed.');
		}

		if (queue.length > 0) {
			return queue.shift();
		}

		return new Promise((resolve, reject) => {
			pending = {resolve, reject};
		});
	};

	try {
		const authSchema = z.object({type: z.enum(['auth_required', 'auth_ok', 'auth_invalid'])});
		if (authSchema.parse(await receive()).type !== 'auth_required') {
			throw new Error('Registry authentication failed.');
		}

		socket.send(JSON.stringify({type: 'auth', access_token: token}));
		if (authSchema.parse(await receive()).type !== 'auth_ok') {
			throw new Error('Registry authentication failed.');
		}

		let id = 0;
		return await work(async (command) => {
			if (hasFailed) {
				throw new Error('Registry operation failed.');
			}

			id++;
			socket.send(JSON.stringify({id, ...command}));
			const response = resultSchema.parse(await receive());
			if (response.id !== id || !response.success) {
				throw new Error('Registry operation failed.');
			}

			return response.result;
		});
	} finally {
		clearTimeout(timer);
		socket.close();
	}
};

export type RegistryEvidence = {entry: z.infer<typeof entityRegistryEntrySchema>; digest: string};

/** Read-only capability/identity evidence. Admin access and supported get are mandatory. */
export const inspectDisableTargets = async (
	url: string,
	token: string,
	entityIds: readonly string[],
	options: SocketOptions = {},
): Promise<Record<string, RegistryEvidence>> => {
	if (entityIds.length === 0) {
		return {};
	}

	try {
		return await withRegistry(
			url,
			token,
			async (request) => {
				const user = z
					.object({is_admin: z.boolean()})
					.parse(await request({type: 'auth/current_user'}));
				if (!user.is_admin) {
					return {};
				}

				const evidence: Record<string, RegistryEvidence> = {};
				for (const entityId of entityIds) {
					entityIdSchema.parse(entityId);
					// Sequential requests on a single websocket are intentional.

					const entry = entrySchema.parse(
						// eslint-disable-next-line no-await-in-loop
						await request({type: 'config/entity_registry/get', entity_id: entityId}),
					);
					if (entry.entity_id !== entityId) {
						throw new Error('Registry identity mismatch.');
					}

					evidence[entityId] = {
						entry: entityRegistryEntrySchema.parse(entry),
						digest: fingerprint(entry),
					};
				}

				return evidence;
			},
			options,
		);
	} catch {
		return {};
	}
};

export type RegistryDisableResult = 'verified' | 'changed' | 'failed';

/** The only HA write: exact entity disable. Never accepts arbitrary metadata or services. */
export const disableStaleRegistryEntity = async (
	{url, token}: {url: string; token: string},
	{entityId, expectedDigest}: {entityId: string; expectedDigest: string},
	beforeWrite: () => Promise<boolean>,
	{signal, ...options}: SocketOptions & {signal: AbortSignal},
): Promise<RegistryDisableResult> => {
	try {
		entityIdSchema.parse(entityId);
		return await withRegistry(
			url,
			token,
			async (request) => {
				const user = z
					.object({is_admin: z.boolean()})
					.parse(await request({type: 'auth/current_user'}));
				if (!user.is_admin || signal.aborted || !(await beforeWrite())) {
					return 'changed';
				}

				const current = entrySchema.parse(
					await request({type: 'config/entity_registry/get', entity_id: entityId}),
				);
				if (
					current.entity_id !== entityId ||
					current.disabled_by !== null ||
					fingerprint(current) !== expectedDigest ||
					signal.aborted
				) {
					return 'changed';
				}

				await request({
					type: 'config/entity_registry/update',
					entity_id: entityId,
					disabled_by: 'user',
				});
				// Finish verification even if interrupted after dispatch; never report an unverified success.
				const verified = entrySchema.parse(
					await request({type: 'config/entity_registry/get', entity_id: entityId}),
				);
				return verified.entity_id === entityId &&
					verified.disabled_by === 'user' &&
					verified.unique_id === current.unique_id &&
					verified.platform === current.platform &&
					verified.device_id === current.device_id
					? 'verified'
					: 'failed';
			},
			options,
		);
	} catch {
		return 'failed';
	}
};
