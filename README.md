# agentic-coding

Shared pi extensions and agent skills, installed via [dotbot](https://github.com/anishathalye/dotbot).

## Contents

- `pi/extensions/` — pi agent extensions (`notify.ts`, `plan-mode/`, `tdd/`)
- `skills/` — agent skills (`tdd/`), shared by both pi and Claude Code

## Installation

```bash
git clone --recurse-submodules https://github.com/e-stepanov/agentic-coding.git
cd agentic-coding
./install
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
./install
```

`./install` is idempotent — re-run it any time to refresh links after pulling.

## What gets linked

| Source               | Target                        |
| -------------------- | ----------------------------- |
| `pi/extensions/*`    | `~/.pi/agent/extensions/`     |
| `skills/*`           | `~/.agents/skills/` (pi)      |
| `skills/*`           | `~/.claude/skills/` (Claude)  |

Each direct child of the source directory is symlinked individually (via
dotbot's `glob`), so these repo-managed items coexist with any other
extensions/skills you install manually into the same directories.

The same `skills/` sources feed both `~/.agents/skills/` and `~/.claude/skills/`
so skills stay in sync across pi and Claude Code.

> Note: dotbot's glob does not match dotfile-prefixed entries (names starting
> with `.`). None currently exist in this repo.

## Requirements

- Python 3 (used by dotbot; standard on macOS/Linux)
- git
