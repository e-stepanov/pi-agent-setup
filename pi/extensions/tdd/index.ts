/**
 * TDD Workflow Extension (with inlined TDD Guard enforcement)
 * -----------------------------------------------------------
 *
 * Three-phase TDD workflow:
 *   plan       -> read-only; agent drafts the structural design
 *   tests      -> read-only; agent enumerates the test cases
 *   implement  -> agent writes tests + implementation under TDD Guard supervision
 *                 (one failing test at a time, minimal impl, refactor only when green)
 *
 * The implement phase inlines the TDD Guard validator: every `edit` and `write`
 * call is intercepted, sent to a small validator model along with the most
 * recent test output, and blocked if it violates TDD discipline.
 *
 * The TDD-Guard validation prompts are ported from nizos/tdd-guard
 * (MIT, (c) Nizar Selander). See ./tdd-guard-prompts.ts.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	SYSTEM_PROMPT,
	RULES,
	FILE_TYPES,
	RESPONSE,
	EDIT,
	WRITE,
	OVERWRITE,
	TEST_OUTPUT,
} from "./tdd-guard-prompts.ts";

// --------------------------------------------------------------------------
// Phase model
// --------------------------------------------------------------------------

type TddPhase = "idle" | "draft" | "tests" | "implement";

const DRAFT_PHASE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const TESTS_PHASE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const IMPLEMENT_PHASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const IDLE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const PHASE_ORDER: TddPhase[] = ["idle", "draft", "tests", "implement"];

function nextPhase(p: TddPhase): TddPhase | null {
	const i = PHASE_ORDER.indexOf(p);
	if (i < 0 || i >= PHASE_ORDER.length - 1) return null;
	return PHASE_ORDER[i + 1];
}

interface TestItem {
	name: string;
	description: string;
	status: "pending" | "failing" | "passing";
}

interface TddPlan {
	description: string;
	draft: string;
	tests: TestItem[];
}

type AwaitingInput = "plan" | "tests" | "implement" | null;

interface TddState {
	phase: TddPhase;
	plan: TddPlan | null;
	testCommand: string;
	lastTestOutput: string;
	awaitingInput: AwaitingInput;
}

// --------------------------------------------------------------------------
// TDD Guard config (global, outside version control)
// --------------------------------------------------------------------------

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "tdd-config.json");
const DEFAULT_VALIDATOR_MODEL = "anthropic/claude-sonnet-4-6";

interface TddConfig {
	model?: string;
}

function loadConfig(): TddConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		}
	} catch {
		/* ignore malformed config */
	}
	return {};
}

function saveConfig(config: TddConfig): void {
	try {
		const dir = path.dirname(CONFIG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
	} catch {
		/* best-effort */
	}
}

let validatorModel: string;
{
	const config = loadConfig();
	validatorModel = config.model ?? process.env.TDD_GUARD_MODEL ?? DEFAULT_VALIDATOR_MODEL;
}

// --------------------------------------------------------------------------
// TDD Guard: file/command patterns and limits
// --------------------------------------------------------------------------

const TEST_COMMAND_PATTERNS: RegExp[] = [
	/\bnpm\s+(run\s+)?test\b/,
	/\b(pnpm|yarn|bun)\s+(run\s+)?test\b/,
	/\bnpx\s+(vitest|jest|mocha)\b/,
	/\bvitest\b/,
	/\bjest\b/,
	/\bpytest\b/,
	/\bpython\s+-m\s+pytest\b/,
	/\bgo\s+test\b/,
	/\bcargo\s+test\b/,
	/\bphpunit\b/,
	/\b(bundle\s+exec\s+)?rspec\b/,
	/\brake\s+test\b/,
	/\bmix\s+test\b/,
];

const IGNORE_PATTERNS: RegExp[] = [
	/\.md$/i,
	/\.txt$/i,
	/\.json$/,
	/\.ya?ml$/,
	/\.toml$/,
	/\.lock$/,
	/(^|\/)\.git\//,
	/(^|\/)node_modules\//,
	/(^|\/)dist\//,
	/(^|\/)build\//,
	/(^|\/)\.pi\//,
];

const MAX_TEST_OUTPUT_BYTES = 30 * 1024;
const MAX_FILE_BYTES = 30 * 1024;

function isIgnored(filePath: string): boolean {
	return IGNORE_PATTERNS.some((p) => p.test(filePath));
}

function looksLikeTestCommand(command: string): boolean {
	return TEST_COMMAND_PATTERNS.some((p) => p.test(command));
}

function codeBlock(content: string): string {
	return "```\n" + content + "\n```\n";
}

function section(title: string, content: string): string {
	return `\n### ${title}\n${codeBlock(content)}`;
}

function clip(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	return "...[truncated]...\n" + buf.subarray(buf.length - maxBytes).toString("utf8");
}

// --------------------------------------------------------------------------
// TDD Guard: spawn pi -p for verdict
// --------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface PendingChange {
	tool: "edit" | "write";
	filePath: string;
	oldString?: string;
	newString?: string;
	oldContent?: string;
	content?: string;
}

function formatOperation(change: PendingChange): string {
	if (change.tool === "edit") {
		return (
			EDIT +
			section("File Path", change.filePath) +
			section("Old Content", change.oldString ?? "") +
			section("New Content", change.newString ?? "")
		);
	}
	if (change.oldContent !== undefined && change.oldContent !== "") {
		return (
			OVERWRITE +
			section("File Path", change.filePath) +
			section("Old File Content", change.oldContent) +
			section("New File Content", change.content ?? "")
		);
	}
	return (
		WRITE +
		section("File Path", change.filePath) +
		section("New File Content", change.content ?? "")
	);
}

function buildValidationPrompt(change: PendingChange, testOutput: string | undefined): string {
	const testSection = testOutput
		? TEST_OUTPUT + codeBlock(clip(testOutput, MAX_TEST_OUTPUT_BYTES))
		: TEST_OUTPUT +
		  codeBlock("No test output available. Tests must be run before implementing.");

	return [SYSTEM_PROMPT, RULES, FILE_TYPES, formatOperation(change), testSection, RESPONSE]
		.filter(Boolean)
		.join("\n");
}

interface Verdict {
	decision: "block" | null;
	reason: string;
}

async function runValidator(
	prompt: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<Verdict> {
	const args = [
		"-p",
		"--no-session",
		"--no-extensions", // don't recursively load this extension in the validator
		"--no-builtin-tools",
		"--model",
		validatorModel,
		prompt,
	];

	const { command, args: spawnArgs } = getPiInvocation(args);

	const output = await new Promise<string>((resolve, reject) => {
		const proc = spawn(command, spawnArgs, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("close", (code) => {
			if (code === 0 || stdout.trim()) resolve(stdout);
			else reject(new Error(stderr || `validator exited with code ${code}`));
		});
		proc.on("error", reject);

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	return parseVerdict(output);
}

function parseVerdict(raw: string): Verdict {
	const text = raw.trim();
	const candidates: string[] = [];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) candidates.push(fence[1].trim());
	const brace = text.match(/\{[\s\S]*\}/);
	if (brace) candidates.push(brace[0]);
	candidates.push(text);

	for (const c of candidates) {
		try {
			const parsed = JSON.parse(c);
			if (parsed && "decision" in parsed) {
				const decision = parsed.decision === "block" ? "block" : null;
				return {
					decision,
					reason: typeof parsed.reason === "string" ? parsed.reason : "",
				};
			}
		} catch {
			/* next candidate */
		}
	}
	return { decision: null, reason: "" };
}

function toPendingChange(
	tool: string,
	filePath: string,
	input: Record<string, unknown>,
): PendingChange | null {
	if (tool === "edit") {
		const edits = input.edits as Array<{ oldText?: string; newText?: string }> | undefined;
		if (Array.isArray(edits) && edits.length > 0) {
			const oldString = edits.map((e) => e.oldText ?? "").join("\n---\n");
			const newString = edits.map((e) => e.newText ?? "").join("\n---\n");
			return { tool: "edit", filePath, oldString, newString };
		}
		return {
			tool: "edit",
			filePath,
			oldString: String(input.oldText ?? input.old_string ?? ""),
			newString: String(input.newText ?? input.new_string ?? ""),
		};
	}

	if (tool === "write") {
		let oldContent: string | undefined;
		try {
			if (fs.existsSync(filePath)) {
				oldContent = fs.readFileSync(filePath, "utf8");
				oldContent = clip(oldContent, MAX_FILE_BYTES);
			}
		} catch {
			/* ignore */
		}
		return {
			tool: "write",
			filePath,
			content: String(input.content ?? ""),
			oldContent,
		};
	}

	return null;
}

// --------------------------------------------------------------------------
// Existing TDD helpers (draft/test extraction)
// --------------------------------------------------------------------------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractDraft(text: string): string | null {
	const lines = text.split("\n");
	let inDraft = false;
	const collected: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (
			/^(draft|draft implementation|approach|sketch|design|implementation plan):/i.test(trimmed)
		) {
			inDraft = true;
			continue;
		}
		if (inDraft && /^(tests?|test plan|notes?|conclusion):/i.test(trimmed)) break;
		if (inDraft) collected.push(line);
	}
	const draft = collected.join("\n").trim();
	return draft.length > 0 ? draft : null;
}

function extractTestPlan(text: string): TestItem[] | null {
	const tests: TestItem[] = [];
	const lines = text.split("\n");
	let inTestSection = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (/^(tests?|test plan|planned tests|test cases?):/i.test(trimmed)) {
			inTestSection = true;
			continue;
		}
		if (inTestSection && /^(implementation|code|draft|notes?|conclusion):/i.test(trimmed)) break;
		if (!inTestSection) continue;
		const match = trimmed.match(/^(?:\d+[\.\)]\s*|\*\s*|-\s*)(.+?)(?:\s*[-:]\s*(.+))?$/);
		if (match && match[1]) {
			const name = match[1].trim();
			const description = match[2]?.trim() || "";
			if (name.length > 0 && name.length < 200) {
				tests.push({ name, description, status: "pending" });
			}
		}
	}
	return tests.length > 0 ? tests : null;
}

// --------------------------------------------------------------------------
// Extension entry
// --------------------------------------------------------------------------

export default function tddExtension(pi: ExtensionAPI): void {
	let state: TddState = {
		phase: "idle",
		plan: null,
		testCommand: "pytest",
		lastTestOutput: "",
		awaitingInput: null,
	};

	const phaseLabels: Record<Exclude<TddPhase, "idle">, string> = {
		draft: "plan",
		tests: "tests",
		implement: "implement",
	};

	function updateStatus(ctx: ExtensionContext): void {
		if (state.phase === "idle") {
			ctx.ui.setStatus("tdd", undefined);
			ctx.ui.setWidget("tdd", undefined);
			return;
		}

		ctx.ui.setStatus("tdd", undefined);

		// Phase progression with current phase bolded, no icons/colors.
		const phases = (PHASE_ORDER.slice(1) as Exclude<TddPhase, "idle">[]).map((p) => {
			const label = phaseLabels[p];
			return p === state.phase ? ctx.ui.theme.bold(label) : ctx.ui.theme.fg("dim", label);
		});

		const lines: string[] = [phases.join(" -> ")];

		if (state.phase === "implement") {
			lines.push(
				ctx.ui.theme.fg("dim", "guard: ") + ctx.ui.theme.fg("muted", validatorModel),
			);
		}

		ctx.ui.setWidget("tdd", lines);
	}

	function setPhase(phase: TddPhase, ctx: ExtensionContext): void {
		state.phase = phase;
		switch (phase) {
			case "draft":
				pi.setActiveTools(DRAFT_PHASE_TOOLS);
				break;
			case "tests":
				pi.setActiveTools(TESTS_PHASE_TOOLS);
				break;
			case "implement":
				pi.setActiveTools(IMPLEMENT_PHASE_TOOLS);
				break;
			default:
				pi.setActiveTools(IDLE_TOOLS);
		}
		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry("tdd-state", {
			phase: state.phase,
			plan: state.plan,
			testCommand: state.testCommand,
		});
	}

	function resetState(ctx: ExtensionContext): void {
		state = {
			phase: "idle",
			plan: null,
			testCommand: state.testCommand,
			lastTestOutput: "",
			awaitingInput: null,
		};
		ctx.ui.setWidget("tdd-prompt", undefined);
		setPhase("idle", ctx);
	}

	function showInputWidget(ctx: ExtensionContext, title: string, prompt: string): void {
		ctx.ui.setWidget("tdd-prompt", [
			ctx.ui.theme.fg("accent", ctx.ui.theme.bold(title)),
			ctx.ui.theme.fg("muted", prompt),
		]);
	}

	async function startDraft(ctx: ExtensionContext, instructions?: string): Promise<void> {
		if (state.phase !== "idle") {
			const ok = await ctx.ui.confirm(
				"Reset TDD?",
				`Currently in ${state.phase} phase. Start over?`,
			);
			if (!ok) return;
		}

		if (instructions) {
			state.plan = { description: instructions, draft: "", tests: [] };
			setPhase("draft", ctx);
			pi.sendUserMessage(`Task: ${instructions}`, { deliverAs: "followUp" });
			return;
		}

		state.awaitingInput = "plan";
		showInputWidget(ctx, "TDD Plan", "Describe the feature/task below and press Enter:");
	}

	async function moveToTests(ctx: ExtensionContext, instructions?: string): Promise<void> {
		if (state.phase !== "draft") {
			ctx.ui.notify(`Cannot move to tests phase from ${state.phase}.`, "warning");
			return;
		}
		if (!state.plan) return;

		if (!state.plan.draft) {
			const entries = ctx.sessionManager.getBranch();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry) {
					const msg = entry.message as AgentMessage;
					if (isAssistantMessage(msg)) {
						const draft = extractDraft(getTextContent(msg));
						if (draft) {
							state.plan.draft = draft;
							break;
						}
					}
				}
			}
		}

		if (instructions) {
			setPhase("tests", ctx);
			ctx.ui.notify("TDD Tests phase started. Define the list of tests.", "info");
			pi.sendUserMessage(instructions, { deliverAs: "followUp" });
			return;
		}

		state.awaitingInput = "tests";
		showInputWidget(ctx, "TDD Tests", "Describe what to test below and press Enter:");
	}

	async function moveToImplement(ctx: ExtensionContext, instructions?: string): Promise<void> {
		if (state.phase !== "tests") {
			ctx.ui.notify(
				`Cannot move to implement phase from ${state.phase}. Define tests first.`,
				"warning",
			);
			return;
		}
		if (!state.plan) return;

		if (!state.plan.tests.length) {
			const entries = ctx.sessionManager.getBranch();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry) {
					const msg = entry.message as AgentMessage;
					if (isAssistantMessage(msg)) {
						const tests = extractTestPlan(getTextContent(msg));
						if (tests) {
							state.plan.tests = tests;
							break;
						}
					}
				}
			}
		}

		if (instructions) {
			setPhase("implement", ctx);
			ctx.ui.notify(
				"TDD Implement phase started. Red-Green-Refactor enforced by TDD Guard.",
				"info",
			);
			pi.sendUserMessage(instructions, { deliverAs: "followUp" });
			return;
		}

		state.awaitingInput = "implement";
		showInputWidget(
			ctx,
			"TDD Implement",
			"Describe how to start implementing (one test at a time):",
		);
	}

	// ----- Commands -----

	pi.registerCommand("tdd", {
		description: "Start or manage TDD workflow (plan -> tests -> implement)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().split(/\s+/)[0]?.toLowerCase();
			const rest = args?.trim().replace(/^\S+\s*/, "").trim() || undefined;

			switch (subcommand) {
				case "plan":
				case "draft":
				case "start":
					await startDraft(ctx, rest);
					break;

				case "tests":
					await moveToTests(ctx, rest);
					break;

				case "implement":
				case "impl":
					await moveToImplement(ctx, rest);
					break;

				case "done":
				case "finish": {
					if (state.phase === "idle") {
						ctx.ui.notify("No TDD session active", "info");
						return;
					}
					const allPassing = state.plan?.tests.every((t) => t.status === "passing");
					if (state.phase === "implement" && allPassing) {
						ctx.ui.notify("🎉 TDD complete! All tests passing.", "success");
					} else {
						ctx.ui.notify("TDD session ended.", "info");
					}
					resetState(ctx);
					break;
				}

				case "test":
				case "cmd": {
					const newCmd = args?.replace(/^(test|cmd)\s*/i, "").trim();
					if (newCmd) {
						state.testCommand = newCmd;
						persistState();
						ctx.ui.notify(`Test command set to: ${newCmd}`, "info");
					} else {
						const cmd = await ctx.ui.input("Test command:", state.testCommand);
						if (cmd) {
							state.testCommand = cmd;
							persistState();
							ctx.ui.notify(`Test command set to: ${cmd}`, "info");
						}
					}
					break;
				}

				case "model": {
					const direct = args?.replace(/^model\s*/i, "").trim();
					if (direct) {
						validatorModel = direct;
						saveConfig({ ...loadConfig(), model: validatorModel });
						updateStatus(ctx);
						ctx.ui.notify(`TDD Guard model set to: ${validatorModel}`, "info");
						return;
					}
					if (!ctx.hasUI) return;
					const allModels = ctx.modelRegistry.getAvailable();
					const allOptions = allModels.map((m: any) => `${m.provider}/${m.id}`);
					const filter = await ctx.ui.input(
						`Filter models (current: ${validatorModel}):`,
						"e.g. haiku, sonnet, gpt, gemini (blank = show all)",
					);
					if (filter === undefined) return;
					const needle = filter.toLowerCase();
					const options = needle
						? allOptions.filter((o) => o.toLowerCase().includes(needle))
						: allOptions;
					if (options.length === 0) {
						ctx.ui.notify(`No models matching "${filter}"`, "warning");
						return;
					}
					const choice = await ctx.ui.select("TDD Guard validator model:", options);
					if (!choice) return;
					validatorModel = choice;
					saveConfig({ ...loadConfig(), model: validatorModel });
					updateStatus(ctx);
					ctx.ui.notify(`TDD Guard model set to: ${validatorModel}`, "info");
					break;
				}

				case "reset": {
					resetState(ctx);
					ctx.ui.notify("TDD session reset", "info");
					break;
				}

				default: {
					if (state.phase === "idle") {
						await startDraft(ctx);
						break;
					}
					const np = nextPhase(state.phase);
					const choices: string[] = [];
					choices.push(`Continue ${state.phase} phase`);
					if (np) choices.push(`-> Move to ${phaseLabels[np as Exclude<TddPhase, "idle">]} phase`);
					if (state.phase === "implement") choices.push("Finish TDD session");
					choices.push(`⚙ Set test command (${state.testCommand})`);
					choices.push(`⚙ Set validator model (${validatorModel})`);
					choices.push("Reset/Cancel");

					const choice = await ctx.ui.select("TDD Workflow", choices);
					if (!choice) return;

					if (choice.includes("Move to")) {
						if (np === "tests") await moveToTests(ctx);
						else if (np === "implement") await moveToImplement(ctx);
					} else if (choice.includes("Finish")) {
						resetState(ctx);
						ctx.ui.notify("TDD session ended.", "info");
					} else if (choice.includes("test command")) {
						const cmd = await ctx.ui.input("Test command:", state.testCommand);
						if (cmd) {
							state.testCommand = cmd;
							persistState();
							ctx.ui.notify(`Test command set to: ${cmd}`, "info");
						}
					} else if (choice.includes("validator model")) {
						// Re-dispatch into the model branch via interactive flow.
						if (!ctx.hasUI) return;
						const allModels = ctx.modelRegistry.getAvailable();
						const allOptions = allModels.map((m: any) => `${m.provider}/${m.id}`);
						const filter = await ctx.ui.input(
							`Filter models (current: ${validatorModel}):`,
							"e.g. haiku, sonnet, gpt, gemini (blank = show all)",
						);
						if (filter === undefined) return;
						const needle = filter.toLowerCase();
						const options = needle
							? allOptions.filter((o) => o.toLowerCase().includes(needle))
							: allOptions;
						if (options.length === 0) {
							ctx.ui.notify(`No models matching "${filter}"`, "warning");
							return;
						}
						const pick = await ctx.ui.select("TDD Guard validator model:", options);
						if (!pick) return;
						validatorModel = pick;
						saveConfig({ ...loadConfig(), model: validatorModel });
						updateStatus(ctx);
						ctx.ui.notify(`TDD Guard model set to: ${validatorModel}`, "info");
					} else if (choice.includes("Reset")) {
						resetState(ctx);
						ctx.ui.notify("TDD session reset", "info");
					}
					break;
				}
			}
		},
	});

	// ----- Input capture for awaiting prompts -----

	pi.on("input", async (event, ctx) => {
		if (!state.awaitingInput) return;

		const text = event.text?.trim();
		const awaiting = state.awaitingInput;
		state.awaitingInput = null;
		ctx.ui.setWidget("tdd-prompt", undefined);

		switch (awaiting) {
			case "plan": {
				if (!text) {
					ctx.ui.notify("TDD cancelled", "info");
					return { action: "handled" as const };
				}
				state.plan = { description: text, draft: "", tests: [] };
				setPhase("draft", ctx);
				return { action: "transform" as const, text: `Task: ${text}` };
			}
			case "tests": {
				if (!text) {
					ctx.ui.notify("TDD tests phase cancelled", "info");
					return { action: "handled" as const };
				}
				setPhase("tests", ctx);
				ctx.ui.notify("TDD Tests phase started. Define the list of tests.", "info");
				return { action: "transform" as const, text };
			}
			case "implement": {
				if (!text) {
					ctx.ui.notify("TDD implement phase cancelled", "info");
					return { action: "handled" as const };
				}
				setPhase("implement", ctx);
				ctx.ui.notify(
					"TDD Implement phase started. Red-Green-Refactor enforced by TDD Guard.",
					"info",
				);
				return { action: "transform" as const, text };
			}
		}
	});

	// ----- Per-turn system context injection -----

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (state.phase === "idle") return;

		let contextMsg = `[TDD ${phaseLabels[state.phase as Exclude<TddPhase, "idle">].toUpperCase()} PHASE]\n\n`;

		switch (state.phase) {
			case "draft":
				contextMsg += `You are in TDD PLAN phase (read-only).
- Explore the codebase to understand the problem
- Create a MINIMAL structural draft under a "Draft:" header
- Include ONLY: class names, properties, function signatures
- New method bodies must raise NotImplementedError (or equivalent)
- Existing method bodies should show ... to indicate they're already implemented
- Do NOT add any comments to the code
- Do NOT write any working implementation code
- Do NOT suggest or list any tests - focus only on implementation design
- Do NOT edit or write any files`;
				break;

			case "tests":
				contextMsg += `You are in TDD TESTS phase (read-only).
- Based on the draft, define the list of tests
- Use format: "Tests:" header followed by numbered list
- Each test: "1. <name> - <what it verifies>"
- Cover happy path, edge cases, errors
- Do NOT write actual test code yet`;
				break;

			case "implement":
				contextMsg += `You are in TDD IMPLEMENT phase, supervised by TDD Guard.

Strict Red-Green-Refactor discipline is enforced on every edit/write:

1. RED: Add ONE failing test, then run \`${state.testCommand}\` to see it fail
2. GREEN: Write the MINIMAL code to make that one test pass, then re-run tests
3. REFACTOR: Only when tests are green, improve structure (no new behavior)

Rules enforced by the validator:
- Only ONE new test at a time
- No implementation without a matching failing test that has been RUN
- Implementation must match the test's failure type:
  * Symbol unresolved -> empty stub only
  * Signature mismatch -> adjust signature with minimal body
  * Assertion failure -> minimal logic to satisfy the assertion
- No refactoring while tests are red
- No comments in code

Test command: ${state.testCommand}`;
				break;
		}

		if (state.plan?.description) {
			contextMsg += `\n\nTask: ${state.plan.description}`;
		}
		if (
			state.plan?.draft &&
			(state.phase === "tests" || state.phase === "implement")
		) {
			contextMsg += `\n\nDraft implementation:\n${state.plan.draft}`;
		}
		if (state.plan?.tests?.length) {
			contextMsg += `\n\nTest Plan (${state.plan.tests.length} tests):`;
			for (const test of state.plan.tests) {
				const icon =
					test.status === "passing" ? "✓" : test.status === "failing" ? "✗" : "○";
				contextMsg += `\n${icon} ${test.name}`;
			}
		}

		return {
			message: {
				customType: "tdd-context",
				content: contextMsg,
				display: false,
			},
		};
	});

	// ----- TDD Guard gate: validate edits/writes during implement phase -----

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (state.phase !== "implement") return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

		const input = event.input as Record<string, unknown>;
		const filePath = String(input.path ?? "");
		if (!filePath || isIgnored(filePath)) return undefined;

		const change = toPendingChange(event.toolName, filePath, input);
		if (!change) return undefined;

		let verdict: Verdict;
		try {
			const prompt = buildValidationPrompt(change, state.lastTestOutput || undefined);
			verdict = await runValidator(prompt, ctx.cwd, ctx.signal);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`TDD Guard validator error (allowing): ${(err as Error).message}`,
					"warning",
				);
			}
			return undefined;
		}

		if (verdict.decision === "block") {
			if (ctx.hasUI) ctx.ui.notify(`TDD Guard blocked edit to ${filePath}`, "warning");
			const reason = verdict.reason
				? `TDD Guard: ${verdict.reason}`
				: "TDD Guard blocked this change for violating TDD discipline.";
			return { block: true, reason };
		}

		return undefined;
	});

	// ----- Capture test output for both status tracking and validator context -----

	pi.on("tool_result", async (event, ctx) => {
		if (state.phase === "idle" || event.toolName !== "bash") return;

		const content = event.content;
		const text = Array.isArray(content)
			? content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n")
			: String(content);

		const command = (event.input as { command?: string })?.command ?? "";
		const isTestRun = looksLikeTestCommand(command);

		const looksLikeTestOutput =
			isTestRun ||
			(/(?:pass|fail|error|test|assert|expect|✓|✗|PASS|FAIL)/i.test(text) && text.length > 50);

		if (!looksLikeTestOutput) return;

		// Capture for validator (used during implement phase).
		// Ignore event.isError on purpose: failing tests ARE the red signal.
		if (text && text !== state.lastTestOutput) {
			state.lastTestOutput = text;
		}

		if (!state.plan?.tests?.length) return;

		for (const test of state.plan.tests) {
			const testNamePattern = new RegExp(
				test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				"i",
			);
			const lines = text.split("\n");
			for (const line of lines) {
				if (testNamePattern.test(line)) {
					if (/(?:✓|pass|passed|ok\b)/i.test(line)) test.status = "passing";
					else if (/(?:✗|✕|fail|failed|error)/i.test(line)) test.status = "failing";
					break;
				}
			}
		}

		const allTestsPass =
			/all tests? pass/i.test(text) || /\d+ pass(?:ing|ed)?,?\s*0 fail/i.test(text);
		const allTestsFail =
			/0 pass(?:ing|ed)?/i.test(text) && /\d+ fail/i.test(text);
		if (allTestsPass) {
			for (const test of state.plan.tests) test.status = "passing";
		} else if (allTestsFail) {
			for (const test of state.plan.tests) {
				if (test.status === "pending") test.status = "failing";
			}
		}

		updateStatus(ctx);
		persistState();

		if (state.phase === "implement") {
			const allPassing = state.plan.tests.every((t) => t.status === "passing");
			if (allPassing) {
				ctx.ui.notify("🎉 All tests passing! Use /tdd done to finish.", "info");
			}
		}
	});

	// ----- Extract draft/tests from assistant output -----

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase === "idle" || !ctx.hasUI) return;
		if (!state.plan) return;

		if (state.phase === "draft") {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const draft = extractDraft(getTextContent(lastAssistant));
				if (draft) {
					state.plan.draft = draft;
					updateStatus(ctx);
					persistState();
				}
			}
		}

		if (state.phase === "tests" || state.phase === "implement") {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const tests = extractTestPlan(getTextContent(lastAssistant));
				if (tests && tests.length > 0) {
					if (state.phase !== "tests") {
						for (const test of tests) {
							const existing = state.plan.tests.find((t) => t.name === test.name);
							if (existing) test.status = existing.status;
						}
					}
					state.plan.tests = tests;
					updateStatus(ctx);
					persistState();
				}
			}
		}
	});

	// ----- Session lifecycle -----

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		const tddEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "tdd-state",
			)
			.pop() as { data?: Partial<TddState> } | undefined;

		if (tddEntry?.data) {
			// Migration: old sessions may have phase "red" or "green"; map to "implement".
			const restored = tddEntry.data.phase ?? "idle";
			state.phase =
				restored === "red" || restored === "green" ? "implement" : (restored as TddPhase);
			state.plan = tddEntry.data.plan ?? null;
			state.testCommand = tddEntry.data.testCommand ?? "pytest";
		}

		if (state.phase !== "idle") {
			setPhase(state.phase, ctx);
			ctx.ui.notify(`Restored TDD ${state.phase} phase`, "info");
		}
	});

	pi.on("session_shutdown", async () => {});
}
