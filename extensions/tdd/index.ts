import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type TddPhase = "idle" | "draft" | "tests" | "red" | "green";

const DRAFT_PHASE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const TESTS_PHASE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const RED_PHASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const GREEN_PHASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const IDLE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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

type AwaitingInput = "plan" | "tests" | "red" | "green" | null;

interface TddState {
  phase: TddPhase;
  plan: TddPlan | null;
  testCommand: string;
  lastTestOutput: string;
  awaitingInput: AwaitingInput;
}

const PHASE_ORDER: TddPhase[] = ["idle", "draft", "tests", "red", "green"];

function nextPhase(p: TddPhase): TddPhase | null {
  const i = PHASE_ORDER.indexOf(p);
  if (i < 0 || i >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[i + 1];
}

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

    if (/^(draft|draft implementation|approach|sketch|design|implementation plan):/i.test(trimmed)) {
      inDraft = true;
      continue;
    }

    if (inDraft && /^(tests?|test plan|notes?|conclusion):/i.test(trimmed)) {
      break;
    }

    if (inDraft) {
      collected.push(line);
    }
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

    if (inTestSection && /^(implementation|code|draft|notes?|conclusion):/i.test(trimmed)) {
      break;
    }

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

export default function tddExtension(pi: ExtensionAPI): void {
  let state: TddState = {
    phase: "idle",
    plan: null,
    testCommand: "pytest",
    lastTestOutput: "",
    awaitingInput: null,
  };

  const phaseInfo: Record<TddPhase, { label: string; color: "warning" | "error" | "success" | "muted" | "accent" }> = {
    idle: { label: "idle", color: "muted" },
    draft: { label: "plan", color: "accent" },
    tests: { label: "tests", color: "warning" },
    red: { label: "red", color: "error" },
    green: { label: "green", color: "success" },
  };

  function updateStatus(ctx: ExtensionContext): void {
    if (state.phase === "idle") {
      ctx.ui.setStatus("tdd", undefined);
      ctx.ui.setWidget("tdd", undefined);
      return;
    }

    ctx.ui.setStatus("tdd", undefined);

    const lines: string[] = [];

    const phaseLabels = PHASE_ORDER.slice(1).map((p) => {
      const isCurrent = p === state.phase;
      const isDone = PHASE_ORDER.indexOf(p) < PHASE_ORDER.indexOf(state.phase);
      const label = phaseInfo[p].label;
      if (isCurrent) return ctx.ui.theme.bold(label);
      if (isDone) return ctx.ui.theme.fg("success", label);
      return ctx.ui.theme.fg("dim", label);
    });
    lines.push(phaseLabels.join(" -> "));

    if (state.plan?.tests?.length && (state.phase === "red" || state.phase === "green")) {
      lines.push("");
      for (const test of state.plan.tests) {
        let icon: string;
        let style: "muted" | "error" | "success";

        switch (test.status) {
          case "failing":
            icon = "✗";
            style = "error";
            break;
          case "passing":
            icon = "✓";
            style = "success";
            break;
          default:
            icon = "○";
            style = "muted";
        }

        lines.push(ctx.ui.theme.fg(style, `${icon} ${test.name}`));
      }
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
      case "red":
        pi.setActiveTools(RED_PHASE_TOOLS);
        break;
      case "green":
        pi.setActiveTools(GREEN_PHASE_TOOLS);
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
        `Currently in ${state.phase} phase. Start over?`
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

  async function moveToRed(ctx: ExtensionContext, instructions?: string): Promise<void> {
    if (state.phase !== "tests") {
      ctx.ui.notify(`Cannot move to red phase from ${state.phase}. Define tests first.`, "warning");
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
      setPhase("red", ctx);
      ctx.ui.notify("TDD Red phase started. Implement tests - they should all FAIL.", "info");
      pi.sendUserMessage(instructions, { deliverAs: "followUp" });
      return;
    }

    state.awaitingInput = "red";
    showInputWidget(ctx, "TDD Red", "Describe how to implement tests below and press Enter:");
  }

  async function moveToGreen(ctx: ExtensionContext, instructions?: string): Promise<void> {
    if (state.phase !== "red") {
      ctx.ui.notify(`Cannot move to green phase from ${state.phase}. Complete red phase first.`, "warning");
      return;
    }

    if (instructions) {
      setPhase("green", ctx);
      ctx.ui.notify("TDD Green phase started. Write implementation to make tests PASS.", "info");
      pi.sendUserMessage(instructions, { deliverAs: "followUp" });
      return;
    }

    state.awaitingInput = "green";
    showInputWidget(ctx, "TDD Green", "Describe what to implement below and press Enter:");
  }

  pi.registerCommand("tdd", {
    description: "Start or manage TDD workflow (plan -> tests -> red -> green)",
    handler: async (args, ctx) => {
      const subcommand = args?.trim().split(/\s+/)[0]?.toLowerCase();
      const rest = args?.trim().replace(/^\S+\s*/, "").trim() || undefined;

      switch (subcommand) {
        case "plan":
          await startDraft(ctx, rest);
          break;

        case "tests":
          await moveToTests(ctx, rest);
          break;

        case "red":
          await moveToRed(ctx, rest);
          break;

        case "green":
          await moveToGreen(ctx, rest);
          break;

        case "done":
        case "finish": {
          if (state.phase === "idle") {
            ctx.ui.notify("No TDD session active", "info");
            return;
          }

          const allPassing = state.plan?.tests.every((t) => t.status === "passing");
          if (state.phase === "green" && allPassing) {
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
            if (np) {
              const npLabel = phaseInfo[np].label.toUpperCase();
              choices.push(`-> Move to ${npLabel} phase`);
            }
            if (state.phase === "green") {
              choices.push("Finish TDD session");
            }

          choices.push(`⚙ Set test command (${state.testCommand})`);
          choices.push("Reset/Cancel");

          const choice = await ctx.ui.select("TDD Workflow", choices);
          if (!choice) return;

          if (choice.includes("Move to")) {
            if (np === "tests") await moveToTests(ctx);
            else if (np === "red") await moveToRed(ctx);
            else if (np === "green") await moveToGreen(ctx);
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
          } else if (choice.includes("Reset")) {
            resetState(ctx);
            ctx.ui.notify("TDD session reset", "info");
          }
          break;
        }
      }
    },
  });

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

        state.plan = {
          description: text,
          draft: "",
          tests: [],
        };

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

      case "red": {
        if (!text) {
          ctx.ui.notify("TDD red phase cancelled", "info");
          return { action: "handled" as const };
        }

        setPhase("red", ctx);
        ctx.ui.notify("TDD Red phase started. Implement tests - they should all FAIL.", "info");
        return { action: "transform" as const, text };
      }

      case "green": {
        if (!text) {
          ctx.ui.notify("TDD green phase cancelled", "info");
          return { action: "handled" as const };
        }

        setPhase("green", ctx);
        ctx.ui.notify("TDD Green phase started. Write implementation to make tests PASS.", "info");
        return { action: "transform" as const, text };
      }
    }
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (state.phase === "idle") return;

    const info = phaseInfo[state.phase];
    let contextMsg = `[TDD ${info.label.toUpperCase()} PHASE]\n\n`;

    switch (state.phase) {
      case "draft":
        contextMsg += `You are in TDD DRAFT phase (read-only).
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

      case "red":
        contextMsg += `You are in TDD RED phase.
- Implement the test code for each planned test
- Tests MUST fail (no implementation exists yet)
- Do NOT add any comments to the code
- Run tests with: ${state.testCommand}
- Verify ALL tests fail before moving to GREEN`;
        break;

      case "green":
        contextMsg += `You are in TDD GREEN phase.
- Write MINIMAL code to make tests pass
- Do NOT add any comments to the code
- Refer to the draft from the planning phase
- Run tests with: ${state.testCommand}
- All tests must PASS`;
        break;
    }

    if (state.plan?.description) {
      contextMsg += `\n\nTask: ${state.plan.description}`;
    }

    if (state.plan?.draft && (state.phase === "tests" || state.phase === "red" || state.phase === "green")) {
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

  pi.on("tool_result", async (event, ctx) => {
    if (state.phase === "idle" || event.toolName !== "bash") return;
    if (!state.plan?.tests?.length) return;

    const content = event.content;
    const text = Array.isArray(content)
      ? content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n")
      : String(content);

    const looksLikeTestOutput =
      /(?:pass|fail|error|test|assert|expect|✓|✗|PASS|FAIL)/i.test(text) && text.length > 50;

    if (!looksLikeTestOutput) return;

    state.lastTestOutput = text;

    for (const test of state.plan.tests) {
      const testNamePattern = new RegExp(test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      const lines = text.split("\n");
      for (const line of lines) {
        if (testNamePattern.test(line)) {
          if (/(?:✓|pass|passed|ok\b)/i.test(line)) {
            test.status = "passing";
          } else if (/(?:✗|✕|fail|failed|error)/i.test(line)) {
            test.status = "failing";
          }
          break;
        }
      }
    }

    const allTestsPass =
      /all tests? pass/i.test(text) || /\d+ pass(?:ing|ed)?,?\s*0 fail/i.test(text);
    const allTestsFail =
      /0 pass(?:ing|ed)?/i.test(text) && /\d+ fail/i.test(text);

    if (allTestsPass) {
      for (const test of state.plan.tests) {
        test.status = "passing";
      }
    } else if (allTestsFail) {
      for (const test of state.plan.tests) {
        if (test.status === "pending") {
          test.status = "failing";
        }
      }
    }

    updateStatus(ctx);
    persistState();

    if (state.phase === "red") {
      const allFailing = state.plan.tests.every((t) => t.status === "failing");
      if (allFailing) {
        ctx.ui.notify("All tests failing - ready for GREEN phase! Use /tdd green", "info");
      }
    } else if (state.phase === "green") {
      const allPassing = state.plan.tests.every((t) => t.status === "passing");
      if (allPassing) {
        ctx.ui.notify("🎉 All tests passing! TDD cycle complete. Use /tdd done", "info");
      }
    }
  });

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

    if (state.phase === "tests" || state.phase === "red" || state.phase === "green") {
      const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
      if (lastAssistant) {
        const tests = extractTestPlan(getTextContent(lastAssistant));
        if (tests && tests.length > 0) {
          // Preserve status from existing tests when updating
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

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();

    const tddEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "tdd-state"
      )
      .pop() as { data?: Partial<TddState> } | undefined;

    if (tddEntry?.data) {
      state.phase = tddEntry.data.phase ?? "idle";
      state.plan = tddEntry.data.plan ?? null;
      state.testCommand = tddEntry.data.testCommand ?? "pytest";
    }

    if (state.phase !== "idle") {
      setPhase(state.phase, ctx);
      ctx.ui.notify(`Restored TDD ${state.phase} phase`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
  });
}
