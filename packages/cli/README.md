# @textscript/cli

The developer console: drive the TextScript engine by hand, with no language
model. You type what someone said, then the edits that capture it, and the
console shows the code, the gaps and the history after every step. Uses
Node.js APIs. Design notes are in
[ADR-010](../../docs/adr/010-developer-console.md).

```sh
pnpm textscript                      # interactive console
pnpm textscript --inputs nums        # ...where the problem gives `nums`
pnpm textscript run packages/cli/scenarios/*.scenario   # run scenario scripts
pnpm textscript --help
```

(`pnpm textscript` runs from the repository root, so give scenario paths
from there: `packages/cli/scenarios/two-sum.scenario`.)

## A first session

This is the worked example from ROADMAP §3.6, typed into the console. The
problem gives `nums` as its input, so tell the console that first:

```
ts> :inputs nums
inputs: nums
```

**1. "Loop through the list of numbers."** Start an utterance with `say`.
The console numbers its words so you can point at them later:

```
ts> say Loop through the list of numbers.
u1: 0:Loop 1:through 2:the 3:list 4:of 5:numbers 6:.
```

Now add what was said to the program. `root` is the top level, and code is
written in a small Python subset. A line ending in `:` keeps reading until
a blank line. `...` is a block nobody described yet, and `~loopvar` marks the
name `num` as an allowed inference (nobody said "num"):

```
ts> add root: for num~loopvar in nums:
...     ...
...
✓ add_stmt → u1 (pending, 1 ops)
n2 │ for num in nums:
n6 │     ⟨body not described⟩
──
GAP002  h1  n6   Nothing is described inside the loop over `nums`.  "Loop through the list of numbers."
(1 inferred: n3; :diag all shows them)
```

The left column is each statement's ID. Under the line are the gaps: the
code, the hole number (`h1`), the node, what's missing, and the words it
came from.

**2. "If we've already seen the number, return true."** Fill the hole:

```
ts> say If we've already seen the number, return true.
ts> fill h1:
...     if num in seen:
...         return True
...
 n2 │ for num in nums:
 n7 │     if num in seen:
n12 │         return True
──
GAP003      n1   The solution doesn't say what it returns when it reaches the end.
GAP001      n10  `seen` is used but never set up.  "If we've already seen the number, return true."
(1 inferred: n3; :diag all shows them)
```

**3. "Oh, we keep a set called seen, empty at the start."**

```
ts> say Oh, we keep a set called seen, empty at the start.
ts> add root start: seen = set()
```

**4. "Otherwise add it to the set."** Set the `if`'s `orelse` field. "Add it
to the set" maps to `seen.add(num)` by the synonym rule, marked in a trailing
comment:

```
ts> say Otherwise add it to the set.
ts> set n7.orelse = seen.add(num)  # ~synonym
n14 │ seen = set()
 n2 │ for num in nums:
 n7 │     if num in seen:
n12 │         return True
    │     else:
n18 │         seen.add(num)
──
GAP003      n1   The solution doesn't say what it returns when it reaches the end.
(2 inferred: n3 n18; :diag all shows them)
```

Nobody said "return False", so GAP003 stays. That's the point of the tool.

Now look around: `:log` lists what was said and the edits it made, `:undo`
takes back the last utterance, `:ir n7` prints a node as JSON, `:coverage`
shows the practice checklist, and `:export dup.py` writes the code.

## Commands

Type `:help` in the console for the short version.

### Utterances and edits

| Command | What it does |
|---|---|
| `say <text>` | Starts an utterance. Edits after it belong to it until the next `say`. |
| `add <parent> [position]: <statements>` | Adds statements. Position: `start`, `end` (default), `before <ref>`, `after <ref>`. |
| `fill <hole>: <code>` | Fills a hole with statements, a condition or an expression, depending on the hole. |
| `set <ref>.<field> = <value>` | Changes one field: a block (`body`, `orelse`), a condition, an expression, or a plain value (`op`, `name`, a literal's `value`). |
| `replace <ref>: <code>` | Replaces a statement or an expression. |
| `remove <ref>` | Removes a node. The engine leaves a hole where something is still needed. |
| `move <ref> <parent> [position]` | Moves a statement. |
| `wrap <ref>[,<ref>...]: <header>` | Wraps statements in a new compound statement, such as `if ready:` or `def f(x):`. |
| `rename <ref> <name>` | Renames a variable or function everywhere it's used. |
| `label <ref> <text>`, `unlabel <ref>` | Gives a node a label you can refer to as `@text-with-dashes`. |
| `note <ref> [general\|edge-case\|complexity]: <text>` | Adds a note, shown as a comment. |
| `unnote <note-id>` | Removes a note (its ID is in the gutter). |
| `ask <question> [-- <ref> ...]` | Records an open question about the walkthrough. |
| `op <json>` | Runs any edit operation given as JSON ([ADR-008](../../docs/adr/008-edit-operations-and-sessions.md)). |

Edits are previewed as you type them and committed together when the next
utterance starts (or on `:commit`). A failed command changes nothing.

**References:** `root`, a node ID (`n12`), a hole by its number in the code
(`h2`; numbers shift as holes are filled), or a label (`@vowel-check`).
Where a block is expected, a loop, `if` or function means its body;
`n7.orelse` means its `else` block.

### Snippets

Code is a Python subset, with marks for what Python can't say:

| Write | Means |
|---|---|
| `?` | A hole; its kind comes from where it is |
| `?cond`, `?value`, `?name`, `?ref(n4,n9)` | A hole of that kind (`?ref` lists what it might refer to) |
| `?value"the start of each interval"` | A hole with a reason |
| `...` | A block nobody described |
| `intent sort the intervals` | A step said only in words |
| `num~loopvar` | An allowed inference: `~loopvar`, `~indexvar`, `~range-bounds`, `~synonym`, `~plural`, `~block-end` |
| `nums@3:6` | This node came from words 3 to 5 of the utterance |
| `x = 1  # ~synonym @2:4` | Marks for a whole statement |

`~range-bounds` goes on the bound: `range(len(nums)~range-bounds)`.

### Looking around

| Command | What it shows |
|---|---|
| `show` | The code and its gaps |
| `:diag [all]` | Gaps and warnings; `all` also lists inferences |
| `:coverage` | The practice checklist |
| `:log` | Every utterance and what it did, including undo, redo and revert |
| `:ir [ref]` | A node (or the whole program) as JSON |
| `:inputs [a,b]` | Shows or sets the names the problem gives as inputs |

### History and files

| Command | What it does |
|---|---|
| `:commit` | Commits the pending edits now |
| `:undo`, `:redo` | Undoes or redoes the last utterance |
| `:revert <utterance-id>` | Undoes one earlier utterance and keeps the ones after it (refused if later edits depend on it) |
| `:export <file.py>` | Writes the code |
| `:save <file.json>`, `:load <file.json>` | Writes or replays the session log |
| `:help`, `:quit` | |

## Scenario scripts

A scenario is a file of console commands that CI runs as an end-to-end test.
The ones in [`scenarios/`](scenarios/) are also the best examples of what
the console can do. Start with
[`worked-example.scenario`](scenarios/worked-example.scenario).

```
# Lines starting with # are comments.
:inputs nums

say Loop through the list of numbers.
add root: for num~loopvar in nums:
    ...
expect gaps GAP002

remove n42
expect error bad-ref
expect code:
    for num in nums:
        ...  # TODO(textscript): body not described
```

- A command starts at the beginning of a line; indented lines continue it.
- `expect code:` checks the exported code (the indented lines below it).
- `expect gaps <codes>` checks the gap and warning codes, in any order;
  `expect gaps none` checks there are none.
- `expect error <code>` checks that the command before it failed with that
  code. Any other command error fails the scenario.

To add a scenario, write `scenarios/<name>.scenario`, check it with
`pnpm textscript run packages/cli/scenarios/<name>.scenario`, then run
`pnpm test -u` to write its transcript to `test/golden/<name>.out` and
review that file. CI fails if a scenario's expectations fail or its
transcript changes.
