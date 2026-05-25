# TDD Workflow Extension

Test-Driven Development workflow with **four phases**:

1. **Draft** ✏️ - Plan task + sketch a draft implementation (read-only)
2. **Tests** 📋 - Define the list of tests based on the draft (read-only)
3. **Red** 🔴 - Implement tests and verify they all FAIL
4. **Green** 🟢 - Write real code and verify all tests PASS

## Commands

- `/tdd` - Open interactive menu
- `/tdd start` (or `/tdd draft`) - Start new TDD session in draft phase
- `/tdd tests` - Move to tests planning phase
- `/tdd red` - Move to red phase (implement failing tests)
- `/tdd green` - Move to green phase (write implementation)
- `/tdd next` - Move to the next phase
- `/tdd status` - Show current TDD state
- `/tdd done` - Complete TDD session
- `/tdd cmd <command>` - Set test command (default: `npm test`)
- `/tdd reset` - Cancel/reset TDD session
- `Ctrl+Alt+T` - Open TDD menu (shortcut)

## Workflow

### 1. Draft Phase ✏️ (read-only)

Start with `/tdd start`. Describe the feature/task.

The agent will:
- Explore the codebase
- Create a **minimal structural draft** under a `Draft:` header

The draft contains ONLY structure - no working code:
- Class names and inheritance
- Property/field declarations  
- Function/method signatures
- All method bodies raise `NotImplementedError`
- Brief comments explaining intent

Expected output format:
```python
Draft:
class Fibonacci:
    """Calculate Fibonacci numbers."""
    
    def __init__(self, cache: bool = True):
        """Initialize with optional memoization."""
        raise NotImplementedError
    
    def calculate(self, n: int) -> int:
        """Return nth Fibonacci number. Raises ValueError if n < 0."""
        raise NotImplementedError
```

### 2. Tests Phase 📋 (read-only)

Move with `/tdd tests`. The agent defines the list of tests based on the draft.

Expected output format:
```
Tests:
1. fibonacci(0) returns 0 - base case
2. fibonacci(1) returns 1 - base case
3. fibonacci(10) returns 55 - recursive case
4. fibonacci throws for negative input - error case
```

### 3. Red Phase 🔴

Move with `/tdd red`. The agent writes test code and runs them. All tests must FAIL.

Status widget shows:
```
TDD: 🔴 RED phase
✗ fibonacci(0) returns 0
✗ fibonacci(1) returns 1
✗ fibonacci(10) returns 55
✗ fibonacci throws for negative input
```

### 4. Green Phase 🟢

Move with `/tdd green`. The agent uses the draft as a guide to write minimal implementation, then runs tests until they all PASS.

```
TDD: 🟢 GREEN phase
✓ fibonacci(0) returns 0
✓ fibonacci(1) returns 1
✓ fibonacci(10) returns 55
✓ fibonacci throws for negative input
```

## Configuration

Set test command:
```
/tdd cmd npm test
/tdd cmd pytest
/tdd cmd cargo test
/tdd cmd go test ./...
```

## Features

- **Phase progress widget**: `✏️ → 📋 → 🔴 → 🟢` showing current position
- **Draft preview** in widget during draft/tests phases
- **Live test status** updated from bash test output
- **Session persistence**: TDD state survives session resume
- **Auto-prompts** when ready to advance phases
- **Tool restrictions**: draft & tests phases are read-only

## Rules

1. **No docstrings** - Do not add docstrings to code
2. **Skip typing in tests** - Test files should not include type annotations

## Tips

1. The draft is a **structural contract** - signatures and interfaces only
2. `NotImplementedError` stubs make it clear what needs implementation
3. Tests are derived from the draft's signatures and docstrings
4. In green phase, the draft structure is filled in with working code
5. Use `/tdd next` to advance to whichever phase comes next
6. Use `/tdd status` anytime to inspect draft + tests state
