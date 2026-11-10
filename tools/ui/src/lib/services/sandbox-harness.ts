/**
 * Sandbox harness - builds the srcdoc document for the sandboxed iframe
 *
 * Produces the HTML/CSP/worker shim that runs untrusted model code in an
 * opaque origin. Consumed by sandbox.service.
 */

import WORKER_SHIM from './sandbox-worker.js?raw';
import { NEWLINE } from '$lib/constants';

/**
 * CSP for the harness document, inherited by the blob worker. connect-src
 * falls back to default-src, removing network egress for model and vendored
 * code. 'unsafe-eval' is required by the worker's AsyncFunction constructor,
 * 'unsafe-inline' by the inline script below, worker-src by the blob worker.
 */
const HARNESS_CSP = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:`;

/**
 * Harness loaded as srcdoc into a sandboxed iframe (allow-scripts only).
 * The opaque origin is the security boundary: no access to the app origin,
 * its storage or its API. The harness spawns one worker at load and relays
 * messages both ways, so model code never runs on a main thread and the
 * parent timeout stays enforceable by removing the iframe. The worker lives
 * as long as the iframe, which lets the parent keep state across runs. The
 * prelude runs in the worker before the shim, exposing globals such as
 * `nerdamer` to model code.
 */
export function buildSandboxHarness(preludeJs: string): string {
	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HARNESS_CSP}"><script>
const SHIM = ${JSON.stringify(preludeJs + NEWLINE + WORKER_SHIM)};
const respond = (payload) => parent.postMessage(payload, '*');
let worker = null;
try {
	worker = new Worker(URL.createObjectURL(new Blob([SHIM], { type: 'text/javascript' })));
	worker.onmessage = (msg) => respond(msg.data);
	worker.onerror = (err) => respond({ type: 'crash', error: String(err.message || err) });
} catch (err) {
	addEventListener('load', () => respond({ type: 'crash', error: 'Worker creation failed: ' + err }));
}
addEventListener('message', (event) => {
	if (event.source !== parent) return;
	if (worker) worker.postMessage(event.data);
	else respond({ type: 'crash', error: 'Worker unavailable' });
});
</script>`;
}
