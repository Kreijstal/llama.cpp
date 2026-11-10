import { SANDBOX_TOOL_NAME } from '$lib/constants';
import { type SandboxFsHandler, SandboxService } from '$lib/services/sandbox.service';
import { beforeEach, describe, expect, it } from 'vitest';

const run = (code: string, timeoutMs?: number) =>
	SandboxService.executeTool(SANDBOX_TOOL_NAME, {
		code,
		...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {})
	});

describe('sandbox service', () => {
	beforeEach(async () => {
		const { settingsStore } = await import('$lib/stores/settings/index.svelte');

		settingsStore.config = {
			...settingsStore.config,
			symbolicMathEnabled: true
		};
	});

	it('executes plain JavaScript', async () => {
		const reply = await run('return 1 + 1;');

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> 2');
	});

	it('exposes nerdamer for symbolic computation', async () => {
		const reply = await run("return nerdamer.diff('sin(x)/x', 'x').toString();");

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('cos(x)');
	});

	it('computes exact rational arithmetic', async () => {
		const reply = await run("return nerdamer('1/3 + 1/6').toString();");

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> 1/2');
	});

	it('proves a polynomial identity symbolically', async () => {
		const reply = await run(
			"return nerdamer('expand((1+x*y)^3 - (1 + 3*x*y + 3*x^2*y^2 + x^3*y^3))').toString();"
		);

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> 0');
	});

	it('blocks network egress in the worker via CSP', async () => {
		const reply = await run(
			"try { await fetch('https://example.com/'); return 'leaked'; } catch { return 'blocked'; }"
		);

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> blocked');
	});

	it('enforces the timeout on runaway code', async () => {
		const reply = await run('while (true) {}', 500);

		expect(reply.isError).toBe(true);
		expect(reply.content).toContain('timed out');
	});
});

describe('sandbox persistence and fs bridge', () => {
	const runIn = (
		sessionKey: string,
		params: Record<string, unknown>,
		fsHandler?: SandboxFsHandler
	) => SandboxService.executeTool(SANDBOX_TOOL_NAME, params, undefined, { fsHandler, sessionKey });

	beforeEach(async () => {
		const { settingsStore } = await import('$lib/stores/settings/index.svelte');

		settingsStore.config = {
			...settingsStore.config,
			jsSandboxPersistent: true,
			symbolicMathEnabled: false
		};
		SandboxService.resetAll();
	});

	it('keeps exports across calls as plain variables', async () => {
		const first = await runIn('a', {
			code: 'export const base = 40;\nexport function add(x) { return base + x; }\nreturn "ok";'
		});

		expect(first.isError).toBe(false);
		expect(first.content).toContain('[exports: base, add]');

		const second = await runIn('a', { code: 'return add(2);' });

		expect(second.content).toContain('=> 42');
	});

	it('allows redeclaring an exported name', async () => {
		await runIn('a', { code: 'export const n = 1;' });
		const reply = await runIn('a', { code: 'const n = 5; exports.n = n * 2; return n;' });

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> 5');
		expect((await runIn('a', { code: 'return n;' })).content).toContain('=> 10');
	});

	it('isolates sessions and supports reset', async () => {
		await runIn('a', { code: 'exports.secret = 7;' });

		expect((await runIn('b', { code: 'return typeof secret;' })).content).toContain('=> undefined');

		const reset = await runIn('a', { code: 'return typeof secret;', reset: true });

		expect(reset.content).toContain('[sandbox state reset]');
		expect(reset.content).toContain('=> undefined');
	});

	it('clears state when a call times out', async () => {
		await runIn('a', { code: 'exports.kept = 1;' });
		const timeout = await runIn('a', { code: 'while (true) {}', timeout_ms: 300 });

		expect(timeout.isError).toBe(true);
		expect(timeout.content).toContain('state was reset');
		expect((await runIn('a', { code: 'return typeof kept;' })).content).toContain('=> undefined');
	});

	it('routes fs calls to the handler and returns its values', async () => {
		const calls: Array<[string, Record<string, unknown>]> = [];
		const reply = await runIn(
			'a',
			{
				code: 'const files = await fs.list("docs"); const text = await fs.readFile(files[0].path); return text.toUpperCase();'
			},
			async (op, args) => {
				calls.push([op, args]);

				return op === 'list' ? [{ path: 'docs/a.txt', type: 'file' }] : 'hello';
			}
		);

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> HELLO');
		expect(calls).toEqual([
			['list', { path: 'docs' }],
			['readFile', { path: 'docs/a.txt' }]
		]);
	});

	it('surfaces a denied fs call as a catchable error', async () => {
		const reply = await runIn(
			'a',
			{ code: 'try { await fs.readFile("x"); } catch (e) { return "caught: " + e.message; }' },
			async () => {
				throw new Error('fs.readFile was denied by the user');
			}
		);

		expect(reply.content).toContain('=> caught: fs.readFile was denied by the user');
	});

	it('does not count time spent waiting for fs approval against the timeout', async () => {
		const reply = await runIn(
			'a',
			{ code: 'return await fs.readFile("slow");', timeout_ms: 300 },
			() => new Promise((resolve) => setTimeout(() => resolve('approved late'), 800))
		);

		expect(reply.isError).toBe(false);
		expect(reply.content).toContain('=> approved late');
	});

	it('reports fs as unavailable without a handler', async () => {
		const reply = await runIn('a', { code: 'return await fs.readFile("x");' });

		expect(reply.isError).toBe(true);
		expect(reply.content).toContain('fs is not available');
	});
});
