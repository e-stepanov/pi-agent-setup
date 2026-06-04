import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Minimal plan-mode shim that stops Claude's "exit plan mode?" loop without
// installing the full @narumitw/pi-plan-mode package. Four tricks:
//   1. Inject a system prompt telling the model how to "submit" a plan
//      (emit one <proposed_plan>…</proposed_plan> block, then stop).
//   2. Detect that block on agent_end and notify the user instead of letting
//      the model self-loop asking for approval.
//   3. Strip prior <proposed_plan> blocks from history so the model never
//      sees its own old plan and re-emits it.
//   4. On message_end, rewrite the finalized assistant message so the raw
//      <proposed_plan> tags don't show in the rendered/persisted output —
//      replace the block with a clean "## 📋 Proposed Plan" heading.

const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PROPOSED_PLAN_BLOCK_PATTERN = /<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/gi;

const PLAN_PROMPT = `# Planning Behavior

You are running inside pi. There is **no** \`ExitPlanMode\` tool, no plan-mode
toggle, no approval gate. Do not call any plan-mode tool — it does not exist.

When the user asks for a plan (not implementation):

- Explore with read-only tools first if useful.
- Then output the plan **once**, wrapped in a single block exactly like:

  <proposed_plan>
  # Title

  ## Summary
  ...

  ## Key Changes
  ...

  ## Test Plan
  ...
  </proposed_plan>

- After emitting the block, **stop**. Do not ask "shall I proceed?", do not
  ask to "exit plan mode", do not repeat the plan. Wait for the user's next
  message. The user will say "go" / "implement" / refinements.

When the user asks for implementation, just implement it with your normal
tools. No mode switch is needed.`;

export default function planMode(pi: ExtensionAPI) {
	pi.registerCommand("plan", {
		description: "Ask for a plan (read-only) without editing files",
		handler: (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify(
					"Usage: /plan <what to plan>. The model will explore, emit one <proposed_plan> block, and stop. Reply 'go' to implement.",
					"info",
				);
				return;
			}
			const wrapped = `[PLAN ONLY — do not edit, write, or run mutating commands this turn. Explore with read-only tools, then output exactly one <proposed_plan>…</proposed_plan> block and stop.]\n\n${prompt}`;
			const opts = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
			pi.sendUserMessage(wrapped, opts);
		},
	});

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_PROMPT}` };
	});

	pi.on("agent_end", (event, ctx) => {
		const text = latestAssistantText(event.messages);
		const plan = PROPOSED_PLAN_PATTERN.exec(text)?.[1]?.trim();
		if (plan) {
			ctx.ui.notify("Plan ready. Reply 'go' to implement, or send refinements.", "info");
		}
	});

	pi.on("context", (event) => {
		return {
			messages: event.messages.map((m) => rewriteProposedPlanInMessage(m, () => "")),
		};
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const rewritten = rewriteProposedPlanInMessage(event.message, prettyPlanBlock);
		if (rewritten === event.message) return;
		return { message: rewritten as typeof event.message };
	});
}

const PLAN_HEADER = "## 📋 Proposed Plan";

function prettyPlanBlock(_match: string, body: string): string {
	return `${PLAN_HEADER}\n\n${body.trim()}`;
}

function latestAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (const entry of [...messages].reverse()) {
		const msg = (entry as { message?: { role?: string; content?: unknown } })?.message
			?? (entry as { role?: string; content?: unknown });
		if (msg?.role !== "assistant") continue;
		const text = contentText(msg.content);
		if (text) return text;
	}
	return "";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = block as { type?: string; text?: string };
			return b.type === "text" && typeof b.text === "string" ? b.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

type PlanReplacer = (match: string, body: string) => string;

function rewriteProposedPlanInMessage<T>(message: T, replacer: PlanReplacer): T {
	const entry = message as { message?: { role?: string; content?: unknown } };
	const inner = entry.message ?? (message as { role?: string; content?: unknown });
	if (inner?.role !== "assistant") return message;

	const newContent = rewriteContent(inner.content, replacer);
	if (newContent === inner.content) return message;

	if (entry.message) return { ...entry, message: { ...inner, content: newContent } } as T;
	return { ...inner, content: newContent } as T;
}

function applyReplacer(text: string, replacer: PlanReplacer): string {
	return text.replace(PROPOSED_PLAN_BLOCK_PATTERN, (match) => {
		const body = PROPOSED_PLAN_PATTERN.exec(match)?.[1] ?? "";
		return replacer(match, body);
	});
}

function rewriteContent(content: unknown, replacer: PlanReplacer): unknown {
	if (typeof content === "string") {
		const out = applyReplacer(content, replacer);
		return out === content ? content : out;
	}
	if (!Array.isArray(content)) return content;

	let changed = false;
	const next = content.map((block) => {
		const b = block as { type?: string; text?: string };
		if (b.type !== "text" || typeof b.text !== "string") return block;
		const rewritten = applyReplacer(b.text, replacer);
		if (rewritten === b.text) return block;
		changed = true;
		return { ...b, text: rewritten };
	});
	return changed ? next : content;
}
