// Persistent across runs when the parent keeps this worker alive: values put
// on `exports` are visible to later runs as plain variables.
const exportsObj = Object.create(null);
let logs = [];
const fmt = (value) => {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};
const capture =
	(level, prefix) =>
	(...args) => {
		logs.push(prefix + args.map(fmt).join(' '));
	};
console.log = capture('log', '');
console.info = capture('info', '');
console.debug = capture('debug', '');
console.warn = capture('warn', 'warn: ');
console.error = capture('error', 'error: ');

// fs bridge: each call is a request to the parent page, which checks the
// user's permission and forwards it to the matching server tool.
let fsSeq = 0;
const fsPending = new Map();
const fsCall = (op, args) =>
	new Promise((resolve, reject) => {
		const id = ++fsSeq;
		fsPending.set(id, { reject, resolve });
		self.postMessage({ args, id, op, type: 'fs' });
	});
const fs = Object.freeze({
	grep: (pattern, path = '.', options = {}) => fsCall('grep', { ...options, path, pattern }),
	list: (path = '.', options = {}) => fsCall('list', { ...options, path }),
	readFile: (path, options = {}) => fsCall('readFile', { ...options, path }),
	writeFile: (path, content) => fsCall('writeFile', { content: String(content), path })
});

// `export const x = ...`, `export function f`, `export class C` and
// `export default expr` at the start of a line become assignments to `exports`.
const IDENT = '[A-Za-z_$][\\w$]*';
const rewriteExports = (code) =>
	code
		.replace(
			new RegExp(`^(\\s*)export\\s+((?:async\\s+)?function\\s*\\*?\\s*)(${IDENT})`, 'gm'),
			'$1exports.$3 = $3; $2$3'
		)
		.replace(
			new RegExp(`^(\\s*)export\\s+(const|let|var)\\s+(${IDENT})\\s*=`, 'gm'),
			'$1$2 $3 = exports.$3 ='
		)
		.replace(
			new RegExp(`^(\\s*)export\\s+class\\s+(${IDENT})`, 'gm'),
			'$1const $2 = exports.$2 = class $2'
		)
		.replace(/^(\s*)export\s+default\s+/gm, '$1exports.default = ');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

self.onmessage = async (event) => {
	const msg = event.data ?? {};

	if (msg.type === 'fs-result') {
		const pending = fsPending.get(msg.id);
		if (!pending) return;
		fsPending.delete(msg.id);
		if (msg.ok) pending.resolve(msg.value);
		else pending.reject(new Error(String(msg.error)));
		return;
	}

	if (msg.type !== 'run') return;

	logs = [];
	const reply = { exports: [], id: msg.id, logs, result: null, error: null, type: 'done' };
	try {
		// `with` puts earlier exports in scope as plain variables; the inner
		// async arrow keeps the model's own declarations in a fresh scope, so
		// redeclaring an exported name is not an error.
		const run = new AsyncFunction(
			'nerdamer',
			'fs',
			'exports',
			'__scope',
			`with (__scope) { return await (async () => {\n${rewriteExports(msg.code)}\n})(); }`
		);
		const noFs = new Proxy(
			{},
			{
				get() {
					throw new Error('fs is not available: enable "Sandbox file access" in settings');
				}
			}
		);
		// The prelude bundled ahead of this shim defines self.nerdamer.
		const value = await run(self.nerdamer, msg.fs ? fs : noFs, exportsObj, exportsObj);
		if (value !== undefined) reply.result = fmt(value);
	} catch (err) {
		reply.error = err instanceof Error ? err.stack || err.message : String(err);
	}
	reply.exports = Object.keys(exportsObj);
	self.postMessage(reply);
};
