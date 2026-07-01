# Plan Mode Extension

Minimal plan-mode shim for pi. Stops the model's "exit plan mode?" loop
without installing the full `@narumitw/pi-plan-mode` package.

## What it does

1. **Injects a system prompt** telling the model how to "submit" a plan:
   emit one `<proposed_plan>…</proposed_plan>` block, then **stop**.
   No `ExitPlanMode` tool exists in pi, so the model is told explicitly
   not to call one or ask for approval.
2. **Detects the plan block** on `agent_end` and notifies the user
   ("Plan ready. Reply 'go' to implement, or send refinements.") instead
   of letting the model self-loop.
3. **Strips prior `<proposed_plan>` blocks** from history on `context`
   so the model never sees its own old plan and re-emits it.
4. **Hides the raw tags from rendered output** on `message_end` by
   rewriting the finalized assistant message: the `<proposed_plan>…</proposed_plan>`
   block is replaced with a clean `## 📋 Proposed Plan` heading followed
   by the plan body. This affects what pi displays *and* what gets
   persisted to the session.

## Display

Because pi's `message_update` events cannot replace streamed content,
the raw `<proposed_plan>` opening tag may flash briefly during streaming.
Once the turn finishes (`message_end` fires), the message is rewritten
in place and the tags disappear from both the TUI and the saved session.

## Command

| Command | What it does |
|---|---|
| `/plan <task>` | Wraps your request with a "PLAN ONLY — read-only, output one `<proposed_plan>` block and stop" preamble and sends it to the model. Reply `go` (or send refinements) afterward. |

Running `/plan` with no argument prints usage.

## Install

Symlinked from this repo into `~/.pi/agent/extensions/plan-mode`. pi
loads extension directories via their `index.ts` entry point (same shape
as the `tdd` extension).

```sh
ln -s "$PWD/extensions/plan-mode" ~/.pi/agent/extensions/plan-mode
```

## Files

- `index.ts` — extension entry point (command + hooks)
