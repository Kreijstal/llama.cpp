/**
 * SandboxService - Runs untrusted code in a sandboxed worker
 *
 * Executes model-generated code inside a CSP-restricted, opaque-origin
 * iframe worker with output and timeout limits. With persistence enabled,
 * one iframe (and its worker) is kept per session so `exports` survive
 * between calls; otherwise every call gets a disposable iframe. File access
 * is not handled here: the caller passes an `fsHandler` that decides
 * (permission, routing to server tools) and the service relays to it.
 * No reactive state; consumed by toolsStore/agenticStore.
 */

import { buildSandboxHarness } from './sandbox-harness';
import {
	NEWLINE,
	SANDBOX_DEFAULT_SESSION,
	SANDBOX_EMPTY_OUTPUT,
	SANDBOX_FS_OPS,
	SANDBOX_OUTPUT_MAX_CHARS,
	SANDBOX_TIMEOUT_MS_DEFAULT,
	SANDBOX_TIMEOUT_MS_MAX,
	SANDBOX_TOOL_NAME,
	SANDBOX_TRUNCATION_NOTICE,
	type SandboxFsOp
} from '$lib/constants';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type { ToolExecutionResult } from '$lib/types';

/** Cached harnesses keyed by whether nerdamer is included. */
const harnessCache: Record<string, string> = {};

/**
 * Build the sandbox harness. When symbolic math is enabled, loads the
 * nerdamer prelude lazily; otherwise builds a plain harness with an empty
 * prelude. Cached per variant so toggling the setting is instant.
 */
async function getHarness(): Promise<{ key: string; html: string }> {
	const enabled = !!settingsStore.config.symbolicMathEnabled;
	const key = enabled ? 'nerdamer' : 'plain';

	if (!harnessCache[key]) {
		if (enabled) {
			const { default: nerdamerJs } = await import('virtual:nerdamer');

			harnessCache[key] = buildSandboxHarness(nerdamerJs);
		} else {
			harnessCache[key] = buildSandboxHarness('');
		}
	}

	return { html: harnessCache[key], key };
}

interface SandboxReply {
	type?: string;
	id?: number;
	logs?: unknown;
	result?: unknown;
	error?: unknown;
	exports?: unknown;
	op?: unknown;
	args?: unknown;
}

/**
 * Handles one fs request from sandboxed code. Resolves with the value handed
 * back to the code, rejects to make the code's `await fs.x()` throw.
 */
export type SandboxFsHandler = (
	op: SandboxFsOp,
	args: Record<string, unknown>,
	signal?: AbortSignal
) => Promise<unknown>;

export interface SandboxExecuteContext {
	/** State is kept per session key (the conversation id) when persistence is on. */
	sessionKey?: string;
	/** Present only when sandbox file access is enabled. */
	fsHandler?: SandboxFsHandler;
}

function formatReply(reply: SandboxReply, notices: string[] = []): ToolExecutionResult {
	const lines: string[] = [...notices];

	if (Array.isArray(reply.logs)) {
		for (const line of reply.logs) lines.push(String(line));
	}

	if (reply.error != null) {
		lines.push(`Error: ${String(reply.error)}`);
	} else if (reply.result != null) {
		lines.push(`=> ${String(reply.result)}`);
	}

	let content = lines.join(NEWLINE);

	if (!content) content = SANDBOX_EMPTY_OUTPUT;

	if (content.length > SANDBOX_OUTPUT_MAX_CHARS) {
		content = `${content.slice(0, SANDBOX_OUTPUT_MAX_CHARS)}${NEWLINE}${SANDBOX_TRUNCATION_NOTICE}`;
	}

	if (Array.isArray(reply.exports) && reply.exports.length > 0) {
		content += `${NEWLINE}[exports: ${reply.exports.map(String).join(', ')}]`;
	}

	return { content, isError: reply.error != null };
}

/** One live iframe + worker, possibly reused across calls. */
class SandboxSession {
	readonly iframe: HTMLIFrameElement;
	readonly ready: Promise<void>;
	private listeners = new Set<(data: SandboxReply) => void>();
	private onWindowMessage = (event: MessageEvent) => {
		if (event.source !== this.iframe.contentWindow) return;

		const data = (event.data ?? {}) as SandboxReply;

		for (const listener of this.listeners) listener(data);
	};

	constructor(
		readonly harnessKey: string,
		harness: string
	) {
		this.iframe = document.createElement('iframe');
		this.iframe.setAttribute('sandbox', 'allow-scripts');
		this.iframe.style.display = 'none';
		this.iframe.srcdoc = harness;
		window.addEventListener('message', this.onWindowMessage);
		this.ready = new Promise((resolve) => {
			this.iframe.onload = () => resolve();
		});
		document.body.appendChild(this.iframe);
	}

	destroy(): void {
		window.removeEventListener('message', this.onWindowMessage);
		this.listeners.clear();
		// removing the iframe terminates its worker at the browser level
		this.iframe.remove();
	}

	listen(listener: (data: SandboxReply) => void): () => void {
		this.listeners.add(listener);

		return () => this.listeners.delete(listener);
	}

	post(message: unknown): void {
		this.iframe.contentWindow?.postMessage(message, '*');
	}
}

const sessions = new Map<string, SandboxSession>();
/** Serializes calls per session so concurrent runs cannot interleave. */
const queues = new Map<string, Promise<unknown>>();

let runSeq = 0;

export class SandboxService {
	/**
	 * Execute a browser sandbox tool call and return its output.
	 * Removing the iframe terminates the worker at the browser level, so
	 * runaway code cannot outlive a timeout or abort; the session's state is
	 * lost in that case and the result says so.
	 */
	static async executeTool(
		toolName: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		context: SandboxExecuteContext = {}
	): Promise<ToolExecutionResult> {
		if (toolName !== SANDBOX_TOOL_NAME) {
			return { content: `Unknown browser tool: ${toolName}`, isError: true };
		}

		const code = typeof params.code === 'string' ? params.code : '';
		const reset = params.reset === true || params.reset === 'true';

		if (!code && !reset) {
			return { content: 'Missing required parameter: code', isError: true };
		}

		const persistent = !!settingsStore.config.jsSandboxPersistent;
		const sessionKey = context.sessionKey || SANDBOX_DEFAULT_SESSION;

		if (!persistent) {
			return SandboxService.runInSession(null, code, params, signal, context, []);
		}

		const previous = queues.get(sessionKey) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(async () => {
				const notices: string[] = [];

				if (reset) {
					SandboxService.resetSession(sessionKey);
					notices.push('[sandbox state reset]');

					if (!code) return { content: notices.join(NEWLINE), isError: false };
				}

				return SandboxService.runInSession(sessionKey, code, params, signal, context, notices);
			});

		queues.set(sessionKey, next);

		return next;
	}

	/** Drop every session, e.g. when persistence is turned off. */
	static resetAll(): void {
		for (const key of [...sessions.keys()]) SandboxService.resetSession(key);
	}

	/** Drop a session's state (its iframe and worker). */
	static resetSession(sessionKey: string = SANDBOX_DEFAULT_SESSION): void {
		sessions.get(sessionKey)?.destroy();
		sessions.delete(sessionKey);
	}

	private static async runInSession(
		sessionKey: string | null,
		code: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		context: SandboxExecuteContext,
		notices: string[]
	): Promise<ToolExecutionResult> {
		const harness = await getHarness();
		const requested = Number(params.timeout_ms);
		const timeoutMs =
			Number.isFinite(requested) && requested > 0
				? Math.min(requested, SANDBOX_TIMEOUT_MS_MAX)
				: SANDBOX_TIMEOUT_MS_DEFAULT;

		let session = sessionKey ? sessions.get(sessionKey) : undefined;

		if (session && session.harnessKey !== harness.key) {
			// symbolic math was toggled: the prelude differs, start over
			SandboxService.resetSession(sessionKey!);
			session = undefined;
			notices.push('[sandbox restarted, previous state cleared]');
		}

		if (!session) {
			session = new SandboxSession(harness.key, harness.html);

			if (sessionKey) sessions.set(sessionKey, session);
		}

		const live = session;
		const discard = () => {
			if (sessionKey) {
				if (sessions.get(sessionKey) === live) sessions.delete(sessionKey);
			}

			live.destroy();
		};

		await live.ready;

		const id = ++runSeq;
		const fsHandler = context.fsHandler;

		return new Promise<ToolExecutionResult>((resolve, reject) => {
			let settled = false;
			let remaining = timeoutMs;
			let startedAt = performance.now();
			let timer: ReturnType<typeof setTimeout> | null = null;
			let pausedFs = 0;

			const arm = () => {
				startedAt = performance.now();
				timer = setTimeout(onTimeout, remaining);
			};
			// the clock stops while fs requests are pending, which includes the
			// user deciding on a permission prompt
			const pause = () => {
				if (pausedFs++ === 0 && timer) {
					clearTimeout(timer);
					timer = null;
					remaining = Math.max(0, remaining - (performance.now() - startedAt));
				}
			};
			const resume = () => {
				if (--pausedFs === 0 && !settled) arm();
			};
			const cleanup = (keep: boolean) => {
				settled = true;

				if (timer) clearTimeout(timer);

				unlisten();
				signal?.removeEventListener('abort', onAbort);

				if (!keep || !sessionKey) discard();
			};
			const finish = (result: ToolExecutionResult, keep: boolean) => {
				if (settled) return;

				cleanup(keep);
				resolve(result);
			};
			const lostState = sessionKey ? ' Sandbox state was reset.' : '';
			const onTimeout = () =>
				finish(
					{ content: `Execution timed out after ${timeoutMs} ms.${lostState}`, isError: true },
					false
				);
			const onAbort = () => {
				if (settled) return;

				cleanup(false);
				reject(new DOMException('Sandbox execution aborted', 'AbortError'));
			};
			const handleFs = async (data: SandboxReply) => {
				const op = String(data.op) as SandboxFsOp;
				const args = (data.args ?? {}) as Record<string, unknown>;

				pause();
				try {
					if (!fsHandler) throw new Error('fs is not available in this sandbox');

					if (!(op in SANDBOX_FS_OPS)) throw new Error(`Unknown fs operation: ${op}`);

					const value = await fsHandler(op, args, signal);

					if (!settled) live.post({ id: data.id, ok: true, type: 'fs-result', value });
				} catch (error) {
					if (!settled) {
						live.post({
							error: error instanceof Error ? error.message : String(error),
							id: data.id,
							ok: false,
							type: 'fs-result'
						});
					}
				} finally {
					resume();
				}
			};
			const unlisten = live.listen((data) => {
				if (data.type === 'fs') {
					void handleFs(data);
				} else if (data.type === 'done' && data.id === id) {
					finish(formatReply(data, notices), true);
				} else if (data.type === 'crash') {
					finish({ content: `Error: ${String(data.error)}${lostState}`, isError: true }, false);
				}
			});

			signal?.addEventListener('abort', onAbort);
			arm();
			live.post({ code, fs: !!fsHandler, id, type: 'run' });
		});
	}
}
