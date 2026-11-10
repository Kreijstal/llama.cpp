import {
	SANDBOX_TIMEOUT_MS_DEFAULT,
	SANDBOX_TIMEOUT_MS_MAX,
	SANDBOX_TOOL_NAME,
	type SandboxFsOp
} from '$lib/constants';
import { JsonSchemaType, ToolCallType } from '$lib/enums';
import type { OpenAIToolDefinition } from '$lib/types';

const NERDAMER_DESCRIPTION = `
Symbolic/numeric math via \`nerdamer\`
nerdamer(expr,subs?,opts?)/nerdamer.func(...)→Expression Format via .text(fmt?) (fmt: 'decimals'|'fractions'|'scientific') eval via .evaluate(subs?)
nerdamer(expr,{x:2}) substitutes numeric via opts 'numer' or .evaluate()
simplify/expand/factor(expr) div/gcd/lcm(...) coeffs/partfrac(expr,var)
diff/integrate(expr,var) defint(expr,lo,hi,var?) sum/product(expr,var,lo,hi) limit(expr,var,pt)
solve(expr,var) solveEquations([eq1,eq2],[var1,var2])
polarform/rectform/arg/realpart/imagpart(z)
set/get Var/Constant(name,val?) setFunction(name,[params],body)
IMPORTANT:Identifier 'nerdamer' has already been declared, use it directly`;
const BASE_DESCRIPTION =
	'Execute JS in a sandboxed browser worker (no DOM/page access). Top-level await ok; console.log for intermediates; top-level return is captured as result.';
const STATE_DESCRIPTION = `
State persists between calls: \`export const x = ...\`, \`export function f(){}\` or \`exports.x = ...\` keeps a value; later calls use it as a plain variable (\`x\`, \`f(...)\`). Pass reset:true to clear all state.`;
const FS_LINES: Record<SandboxFsOp, string> = {
	grep: "await fs.grep(regex, dir='.', {include:'*.js', ignore_case:true}) → matching lines as text",
	list: "await fs.list(dir='.', {include:'**/*.txt', type:'file'|'dir'|'all', max_depth:1}) → [{path, type}]",
	readFile: 'await fs.readFile(path, {start_line, end_line}) → file text',
	writeFile: 'await fs.writeFile(path, text) → {path, bytes}'
};

export interface SandboxToolOptions {
	/** Include nerdamer API documentation. */
	symbolicMath?: boolean;
	/** Describe the persistent `exports` state API. */
	persistent?: boolean;
	/** fs operations available in the sandbox; empty or absent hides `fs`. */
	fsOps?: readonly SandboxFsOp[];
}

/**
 * Build the sandbox tool definition. The description documents only the
 * features that are switched on, so small models are not told about APIs
 * they cannot use. A boolean argument is accepted for backward
 * compatibility and means `{ symbolicMath }`.
 */
export function buildSandboxToolDefinition(
	options: SandboxToolOptions | boolean = {}
): OpenAIToolDefinition {
	const {
		fsOps = [],
		persistent = false,
		symbolicMath = false
	} = typeof options === 'boolean' ? { symbolicMath: options } : options;

	let description = BASE_DESCRIPTION;

	if (persistent) description += STATE_DESCRIPTION;

	if (fsOps.length > 0) {
		description += `\nFiles on the server (paths relative to the working directory; the user may be asked to approve each call):\n${fsOps.map((op) => FS_LINES[op]).join('\n')}`;
	}

	if (symbolicMath) description += NERDAMER_DESCRIPTION;

	const properties: Record<string, { description: string; type: JsonSchemaType }> = {
		code: {
			description: 'JavaScript source to execute',
			type: JsonSchemaType.STRING
		},
		timeout_ms: {
			description: `Execution timeout in milliseconds, default ${SANDBOX_TIMEOUT_MS_DEFAULT}, max ${SANDBOX_TIMEOUT_MS_MAX}`,
			type: JsonSchemaType.NUMBER
		}
	};

	if (persistent) {
		properties.reset = {
			description: 'Clear all saved state before running code (code may then be omitted)',
			type: JsonSchemaType.BOOLEAN
		};
	}

	return {
		function: {
			description,
			name: SANDBOX_TOOL_NAME,
			parameters: {
				properties,
				required: persistent ? [] : ['code'],
				type: JsonSchemaType.OBJECT
			}
		},
		type: ToolCallType.FUNCTION
	};
}

/** @deprecated Use {@link buildSandboxToolDefinition} instead. Kept for backward compatibility. */
export const SANDBOX_TOOL_DEFINITION = buildSandboxToolDefinition({ symbolicMath: true });
