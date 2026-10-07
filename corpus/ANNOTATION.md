# Annotation guide

How to write walkthroughs and gold annotations for the corpus. Read
[README.md](README.md) for the file formats first. The rules here decide
what a gold answer contains. Where they leave room for judgment, write
more than one acceptable answer.

## The one rule

**Gold is what a perfectly faithful translator would produce: everything
that was said, and nothing that wasn't.** When the walkthrough doesn't say
something, the gold answer leaves it open. It uses a hole, a step in words,
or nothing at all, so the analyzer reports the gap. A gold answer that
quietly fills a gap teaches the translator to fill gaps. That's the failure
this whole project exists to prevent (ADR-004).

When in doubt, leave it open, and add the filled version as an `or`
alternative only if a careful listener would agree it was actually said.

## Writing walkthroughs

A walkthrough is what a candidate says while explaining their approach,
typed one utterance per line. Write in your own words. Never paste a
reference solution or a problem's official text.

Each walkthrough has one style:

| Style | What it sounds like | What it tests |
|---|---|---|
| `terse` | "Hash map from value to index. One pass over nums." Short, dense, little filler. | Packing many edits into one utterance; reading shorthand. |
| `rambling` | "Um, so basically, okay, what I'd do is, I think, go through the numbers…" Filler, restarts, repeated ideas. | Ignoring filler without dropping content; not adding things twice. |
| `corrective` | Says something, then changes it: "start at one, no wait, zero", or a later "actually, use a set instead of a list". | Updating the right node instead of adding a new one. |
| `incomplete` | Describes most of the approach but leaves something out: the return at the end, an edge case, an initial value, a condition. | **Faithfulness.** Gold must keep each omission open. |

Guidelines for all styles:

- 3–7 utterances. One utterance is roughly one sentence, or one breath.
- Mix vocabulary: "loop through", "go over", "for each", "walk the array".
  Refer back with "it", "that", "the map", "the loop", as people do.
- Say names when a real candidate would ("a set called seen") and leave
  them out when a real candidate would ("keep track of what we've seen").
- An `incomplete` walkthrough must leave out at least one thing the
  solution needs. Say in a comment at the top of its gold file what was
  left out.
- A `corrective` walkthrough must correct at least one earlier statement
  in a later utterance, so its gold changes code an earlier step wrote
  (`set`, `replace`, `remove`, `move` or `rename`). Corrections within one
  utterance ("start at one, no, zero") are welcome too, but don't count.
- A `rambling` walkthrough should still describe a complete approach.
  Filler is noise, not omission.

## Writing gold

Gold steps are developer-console commands (see
[packages/cli/README.md](../packages/cli/README.md)). Each `step` holds the
edits for one utterance. An `or` line starts another acceptable answer for
the same step. The first answer is canonical: later steps build on it.

Check as you go:

```sh
pnpm eval check                    # everything compiles; counts
pnpm eval gold two-sum.terse       # each step's code, node IDs and gaps
```

Commands refer to nodes by ID (`add n5: …`, `set n19.orelse = …`, `fill n12: …`)
or by hole number (`fill h1: …`). Hole numbers follow the code's order and
change as holes are filled, so with several holes open, prefer the ID. `pnpm eval gold` shows each statement's ID in
the left column after every step. It also shows the steps before the first
failing one, so write a step, look up the IDs it created, then write the
next. Use `add <loop or if>:` to add to its body, and `add n7.orelse:` for
its `else`.

End each step with `expect gaps …` whenever the gaps are part of the point,
and always in `incomplete` walkthroughs. That pins down exactly what must
stay open, and `check` fails if the annotation drifts.

### What was said, and what stays open

| The walkthrough says | Gold | Not |
|---|---|---|
| "a set called seen" / "an empty list" / "a dictionary" | `seen = set()` / `[]` / `{}`: creating a collection is stating it | |
| "keep a counter" (no starting value) | `count = ?value"starting value"` | `count = 0` |
| "start the max at the first element" | `best = nums[0]` | |
| "if it's valid, …" | `if ?cond"it's valid":` | an invented condition |
| "if the number is bigger than the max" | `if num > best:` (cue words map to operators) | |
| "return the answer" with no answer named | `return ?value"the answer"` | |
| nothing about what happens at the end | no return. GAP003 shows it. | `return False` |
| "loop through the numbers" | `for num~loopvar in nums:` | |
| "loop over the indices" | `for i~indexvar in range(len(nums)~range-bounds):` | |
| "go through the list" when the problem has one list input | refer to that input by its name (`nums`) | a `?name` hole |
| "the map", "it", "that" when only one thing fits | the thing it refers to | |
| "it" when two things fit | `?ref(n4,n9)"which list"`, or `ask Which list? -- n4 n9` | a guess |
| "add it to the set" / "put it in the set" | `seen.add(num)  # ~synonym` | |
| "then sort them by start time" (how isn't said) | `intent sort the intervals by start` | `intervals.sort(key=…)` |
| "this is O(n) time" | `note root complexity: O(n) time` | |
| "watch out for an empty list" | `note root edge-case: the list may be empty` | an `if not nums:` check |
| "if the list is empty, return zero" | `if not nums:` / `return 0` | |
| "um, so, okay" | nothing (an empty step) | |
| "call this the duplicate check" | `label n7 duplicate check` | |
| a function: "write a function two_sum taking nums and target" | `def two_sum(nums, target):` | a `def` nobody described |

More rules:

- **Data structures.** Only the one named. "Store them" without saying
  where is `?value"where they're stored"` or an intent, not a list.
- **Initial values.** Only stated ones, with one exception: creating a
  collection ("a set", "a new list") creates an empty one.
- **Conditions and loop bounds.** Only stated ones. "Loop until we're done"
  is `while ?cond"we're done":`.
- **Returns.** Only stated ones. A return that's never mentioned is not a
  node. If something else returns a value, the missing return is a GAP003
  that the gold must keep. If nothing returns at all, the analyzer reports
  no gap (the code may work in place, ADR-009). Faithfulness still catches
  an invented return, but an `incomplete` walkthrough should also leave
  something visible open.
- **Edge cases.** Only stated ones. Mentioning one without saying what to
  do is a note tagged `edge-case`, not code.
- **Function signatures.** Only if described. Many walkthroughs never
  mention a function. Then the gold is top-level code, and the problem's
  inputs (its `inputs:` header) are the names in scope.
- **Names.** Use the walkthrough's names. Unnamed things may be named only
  by an allowed inference (ROADMAP.md §3.5), marked with `~loopvar`,
  `~indexvar`, `~plural` or `~range-bounds`. Anything else is
  `?name"…"`.
- **Corrections.** Model the fix as the edit a listener would make:
  `set n5.start = 0`, `replace …`, `remove …`. A correction inside one
  utterance ("start at one, no, zero") is just the corrected code.
- **Filler and repetition.** An utterance that only restates earlier
  content gets an empty step. If it adds a detail, the step adds only that.
- **Remarks.** Naming the approach ("binary search"), restating the
  problem, or explaining why ("the shorter line limits the area") gets an
  empty step, with a `note … general:` as an acceptable `or`. A remark about
  complexity is a `complexity` note; one about an input that may need
  handling is an `edge-case` note.
- **Amounts and formulas.** Only stated ones. "Move left up" with no amount
  is `left += ?value"how far"`. "Find the middle index" with no formula is
  `mid = ?value"the middle index"`.
- **Faithful, not correct.** Gold encodes what was said, even if the code
  would fail ("add one to its count" on a dictionary with no default is
  `counts[c] += 1`). Judging correctness is out of scope (ROADMAP.md §9).

### Canonical forms

When the same words could be written two ways, use the first as canonical
and add the second as an `or`:

| Words | Canonical | Also accept |
|---|---|---|
| "is empty" / "isn't empty" | `not x` / `x` | `len(x) == 0` / `len(x) > 0` |
| "otherwise, if …" | `elif` | a separate `if`, when the branch before returns |
| "otherwise …" after a branch that returns | `else:` | the statement after the `if` |
| "goes up by one" | `x += 1` | `x = x + 1` (only when said in words, not when "+=" was said) |
| "sort nums" | `nums.sort()` | `nums = sorted(nums)` |

- "Up to n" is exclusive, as in Python's `range`. "Through n", "up to and
  including n" and "inclusive" mean `n + 1` as the bound.
- Direct translations of plain words need no mark: "bigger than" → `>`,
  "divisible by three" → `% 3 == 0`, "isn't alphanumeric" →
  `not c.isalnum()`, "the bigger of" → `max`. Mark `~synonym` when the
  words name a different operation than the code: "put it in the set",
  "push it onto the stack", "add it to the end of the list" (→ `append`).
- `~loopvar` only fits when the variable's name is a prefix of the
  collection's (`num` in `nums`). For `for c in s`, the name must be said,
  or it's `?name`.

### When to write more than one answer

Add an `or` alternative when two encodings are equally faithful, for
example:

- `x += 1` and `x = x + 1`
- an `else:` branch, or a separate statement after an `if` that returns
- `note` or `intent` for a remark that could be either a step or a comment
- the order of two independent setup statements said in one breath

Alternatives are compared by the code they produce, so two ways of
writing the same code (`set n6.start = 0` and replacing the literal) are
one answer, not two. Don't add alternatives for things that weren't said. If one reading fills
a gap, it isn't acceptable, however likely it is.

### Things the IR can't say yet

Some Python can't be written as IR, so gold can't contain it. Use the
nearest faithful form, and keep a list below so the IR can grow (S13 and
later):

| Said | IR can't express | Gold uses |
|---|---|---|
| "loop with index i and value num" | `for i, num in enumerate(nums)` | `for i in range(len(nums)):` and `num = nums[i]` (both were said) |
| "swap a and b" | `a, b = b, a` | `intent swap a and b` |
| "left and right both start at zero" | `left = right = 0` | two assignments |
| "sort by start" | keyword arguments (`key=…`) | `intent sort … by …` |
| "x if cond else y" | conditional expressions | an `if`/`else` statement, if that's how it was said; otherwise an intent |
| "use a deque", "heapq.heappush" | imports | the call as said, with or without the module as said. The analyzer reports `deque`/`heapq`/`heapify` as GAP001; keep it in `expect gaps`. Names the problem provides (`ListNode`) are reported the same way. |
| "if slow is fast" | identity comparison (`is`) | `slow == fast`. The IR has no `is` except `is None`. |
| "otherwise if" added to an existing `if` | adding an `elif` | `replace` the whole `if` with its new chain. Unchanged parts count as unchanged. |

## Second annotations

To measure how consistently this guide is applied, a second annotator
writes gold for a sample of walkthroughs without looking at the first
annotation, into `corpus/agreement/<walkthrough>.gold`. Preview it as you go with
`pnpm eval gold <walkthrough> --file corpus/agreement/<walkthrough>.gold`.
Then:

```sh
pnpm eval agree
```

compares each step's resulting code: the share of steps that are
identical, node-level F1, and how many holes both put in the same place.
Low agreement on a kind of utterance means this guide needs a rule for it.
