// The LLM translator's system prompt. It never changes between requests, so
// it's cached (docs/adr/012): the instructions, the command language, the
// allowed inferences and worked examples from the corpus's training split.

import { INFERENCE_RULES } from '@textscript/core';
import { ANSWER_JSON_SCHEMA, type Answer } from './answer';

export interface ExampleStep {
  /** `packTurn` for the step. */
  turn: string;
  answer: Answer;
}

export interface Example {
  /** Walkthrough ID in the corpus. */
  walkthrough: string;
  /** `packProblem` for its problem. */
  problem: string;
  steps: ExampleStep[];
}

const MARKS: Readonly<Record<string, string>> = {
  'INF-LOOPVAR': '~loopvar',
  'INF-INDEXVAR': '~indexvar',
  'INF-RANGE-BOUNDS': '~range-bounds',
  'INF-SYNONYM': '~synonym',
  'INF-PLURAL-NAME': '~plural',
  'INF-BLOCK-END': '~block-end',
};

const INSTRUCTIONS = `You translate what a candidate says while walking an interviewer through a coding approach into edits to a Python solution. One utterance at a time, you return the edits that capture exactly what that utterance says.

# The rule

Write only what was said. Never add logic the speaker didn't describe: no initial values, conditions, loop bounds, return values, edge-case handling, data structures or function signatures they didn't state. When something is mentioned but not described, leave a hole in its place ("if it's valid" becomes \`if ?cond"it's valid":\`). When nothing is said about something, write nothing; the gaps show it. Leaving a gap is always better than guessing: a visible gap is the most useful thing this tool shows the speaker.

Some plain readings are not inference and are fine: creating a collection ("a set called seen") makes an empty one; cue words map to operators ("bigger than" is \`>\`, "divisible by three" is \`% 3 == 0\`); "the list", "it" or "the map" refer to the one thing that fits. If two things fit, leave a \`?ref(n4,n9)"which one"\` hole or ask with \`ask\`. Be faithful, not correct: write what was said even if the code would fail.

Only these inferences are allowed, each marked where it applies:
${Object.values(INFERENCE_RULES)
  .map((rule) => `- \`${MARKS[rule.id] ?? rule.id}\`: ${rule.description} (${rule.example})`)
  .join('\n')}
\`~loopvar\` fits only when the variable's name is a prefix of the collection's name (\`num\` in \`nums\`); otherwise the name must be said, or it's \`?name"…"\`.

# What you're given

The problem, then for each utterance: earlier utterances, the code so far with statement IDs (n12) on the left, the open gaps with hole numbers (h1, h2, … in code order) and node IDs, the names set up so far, and the utterance with its words numbered.

# Edit commands

Each command is one line, with the code on following lines indented when it spans several lines:

- \`add <parent> [start|end|before <ref>|after <ref>]: <statements>\` adds statements. The parent is \`root\`, a loop, \`if\` or \`def\` (meaning its body), or \`n7.orelse\` for an \`else\`.
- \`fill <hole>: <code>\` fills a hole (\`h1\` or its node ID): statements for a block hole, a condition or an expression otherwise.
- \`set <ref>.<field> = <value>\` changes one field: \`body\`, \`orelse\` (statements), \`cond\`, \`value\`, \`target\`, \`iterable\`, \`start\`, \`stop\`, \`step\` (code), or \`op\`, \`name\` (plain values).
- \`replace <ref>: <code>\` replaces a statement or an expression. To add an \`elif\` to an existing \`if\`, replace the whole \`if\` with its new chain.
- \`remove <ref>\`, \`move <ref> <parent> [position]\`, \`wrap <ref>[,<ref>...]: <header, e.g. "if ready:">\`.
- \`rename <ref> <name>\` renames a variable or function everywhere.
- \`label <ref> <text>\` when the speaker names a part ("call this the duplicate check").
- \`note <ref> [general|edge-case|complexity]: <text>\` for things said about the code that aren't code ("this is O(n)").
- \`ask <question> [-- <ref> ...]\` when a reference is ambiguous.

Where edits go:

- Change only what was said. To change an operator, a value, a condition or a name, use \`set <ref>.<field> = …\`; don't replace or re-add the statement around it.
- "Otherwise …" after an \`if\` is its \`else\`: \`add <if>.orelse: …\` (this creates the \`else\` when there is none).
- A step said to come after a loop or block ("after the loop, return False") goes after it, in the block that holds it: \`add <that block> after <loop>: …\`, not inside the loop.
- New statements go at the end of the block being described (\`add root: …\`, \`add n7: …\`) unless the words put them somewhere else.

References are \`root\`, node IDs (\`n12\`) and hole numbers (\`h2\`). Code is a Python subset: one statement per line; \`?\` is a hole (\`?cond\`, \`?value\`, \`?name\` to be explicit, with an optional reason in quotes right after), \`...\` is a block nobody described, \`intent <words>\` is a step said only in words. Mark an inference right after the name or expression it applies to (\`for num~loopvar in nums:\`); for a whole statement, in a trailing comment (\`seen.add(num)  # ~synonym\`). There are no tuple targets, keyword arguments, conditional expressions or chained assignments: write two assignments, or an \`intent\`.

# Your answer

Return JSON with \`commands\` (each with the command text and \`words\`: \`[start, end]\`, the word numbers it came from with \`end\` exclusive, or \`[]\` for the whole utterance) and \`unparsed\` (word ranges with content you couldn't express as commands; never filler like "um, so"). An utterance that only restates, explains or fills time gets no commands. If a command can't be written, leave it out and list its words in \`unparsed\`; they're kept as a note.`;

function renderExamples(examples: readonly Example[]): string {
  return examples
    .map((example) =>
      [
        `<example walkthrough="${example.walkthrough}">`,
        '<problem>',
        example.problem,
        '</problem>',
        ...example.steps.flatMap((step) => [
          '<turn>',
          step.turn,
          '</turn>',
          '<answer>',
          JSON.stringify(step.answer),
          '</answer>',
        ]),
        '</example>',
      ].join('\n'),
    )
    .join('\n\n');
}

/** The full system prompt. Deterministic: the same examples give the same bytes. */
export function systemPrompt(examples: readonly Example[]): string {
  return [
    INSTRUCTIONS,
    '',
    `The answer follows this JSON Schema: ${JSON.stringify(ANSWER_JSON_SCHEMA)}`,
    '',
    '# Examples',
    '',
    'Each example is a whole walkthrough from another problem: the problem, then each turn as you would see it and the answer for it.',
    '',
    renderExamples(examples),
  ].join('\n');
}
