# TDD Workflow Extension (with TDD Guard)

Test-Driven Development workflow in **three phases**:

1. **plan** — agent drafts the structural design (read-only)
2. **tests** — agent enumerates the test cases (read-only)
3. **implement** — agent writes tests + implementation, **supervised by TDD Guard**

The implement phase inlines the [TDD Guard](https://github.com/nizos/tdd-guard)
validator: every `edit` and `write` is intercepted, sent to a small validator
model with the latest test output, and **blocked if it violates Red-Green-Refactor
discipline** (premature implementation, multiple new tests at once,
over-implementation, refactoring with red tests, etc.).

## Commands

| Command | What it does |
|---|---|
| `/tdd` | Interactive menu (resumes / advances / configures) |
| `/tdd plan [task]` | Start a new session in the plan phase |
| `/tdd tests` | Move to tests phase |
| `/tdd implement` | Move to implement phase (TDD Guard activates) |
| `/tdd done` | Finish the session |
| `/tdd reset` | Cancel the current session |
| `/tdd cmd <command>` | Set the test command (default: `pytest`) |
| `/tdd model [provider/id]` | Pick the TDD Guard validator model |

## Widget

When a session is active, a single-line widget shows the phase progression with
the current phase **bold** and the others dimmed:

```
plan -> tests -> implement
```

No icons. No status footer entry. The widget disappears when the session ends.

## Validator model

The TDD Guard validator is invoked as a separate `pi -p` subprocess. The model
choice is persisted globally to `~/.pi/agent/tdd-config.json` (outside any
version-controlled directory):

```json
{ "model": "anthropic/claude-haiku-4-5" }
```

Resolution priority:

1. `~/.pi/agent/tdd-config.json` — set via `/tdd model`
2. `TDD_GUARD_MODEL` environment variable
3. Built-in default (`anthropic/claude-sonnet-4-6`)

`/tdd model` (no args) opens a prompt for a filter substring, then shows the
filtered list of models you have API keys for. `/tdd model provider/id` sets
directly.

## Workflow

### plan (read-only)

Start with `/tdd plan "implement Fibonacci"`. The agent explores the codebase
and produces a minimal structural draft under a `Draft:` header — class names,
signatures, `NotImplementedError` stubs only.

### tests (read-only)

`/tdd tests`. The agent enumerates concrete test cases under a `Tests:` header:

```
Tests:
1. fib(0) returns 0 - base case
2. fib(1) returns 1 - base case
3. fib(10) returns 55 - recursive case
4. fib(-1) raises ValueError - error case
```

### implement (TDD Guard active)

`/tdd implement`. From here on, every edit/write is gated by the validator.
The enforced cycle:

1. **Red**: add one failing test, run `pytest`
2. **Green**: write the minimal code needed to satisfy that test, run `pytest`
3. **Refactor**: only with green tests, improve structure (no new behavior)

Typical block messages:

- *"Multiple test addition violation — adding 2 new tests simultaneously. Write and run only ONE test at a time."*
- *"Over-implementation violation. Test output shows the symbol is unresolved but the implementation adds both class AND method. Create only an empty stub first."*
- *"Premature implementation — adding new behavior without a failing test. Write the test first, run it, then implement only what's needed."*

The block goes back to the agent, which then retries with the correct minimal
step.

## Fail-open

If the validator subprocess errors (no API key, network down, Esc pressed) the
edit is **allowed** with a warning notification. TDD Guard will never deadlock
your session.

## Notes

- File patterns ignored by the validator (docs, configs, lockfiles, etc.) are
  in `IGNORE_PATTERNS` at the top of `index.ts`.
- Test-command detection patterns are in `TEST_COMMAND_PATTERNS`.
- Validation prompts (`tdd-guard-prompts.ts`) are ported verbatim from
  [nizos/tdd-guard](https://github.com/nizos/tdd-guard) (MIT, © Nizar Selander).
- Sessions resumed from before the merge with phases `red`/`green` are migrated
  to `implement` automatically.
