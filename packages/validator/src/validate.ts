// The provenance validator (ROADMAP.md S8, docs/adr/013): checks every node
// a batch creates and every field it changes against the words it cites,
// and holds back what those words don't support.
//
// Three checks, in order:
//   1. Structural: a created node cites words, or names an inference rule;
//      every span points into this utterance or an earlier one.
//   2. Inference: a node marked `inferred` fits its rule (the S4 registry).
//   3. Lexical: names, literals, operators and statement keywords have
//      supporting words in the cited spans (the cue lexicon).
//
// Held-back nodes are replaced by holes of the matching kind (statements
// are removed, which leaves a hole if their block empties); held-back field
// changes are dropped. The rest of the batch still applies. Nodes the
// lexicon has no check for (an index, an assignment's shape) are returned
// as claims for the optional second-opinion verifier.

import {
  apply,
  allNodes,
  children,
  fitsInferenceRule,
  indexTree,
  INFERENCE_RULES,
  nodeIdNumber,
  quoteSpan,
  TEMP_ID_PATTERN,
  walk,
  type EditBatch,
  type EditOp,
  type Expr,
  type IrDocument,
  type IrNode,
  type NodeId,
  type Position,
  type Span,
  type Stmt,
  type Utterance,
} from '@textscript/core';
import { render } from '@textscript/render-python';
import {
  ARITHMETIC_CUES,
  BOOL_CUES,
  CALLEE_CUES,
  COMPARE_CUES,
  EMPTY_COLLECTION_CUES,
  EMPTY_DICT_CUES,
  IMPLIED_ONE,
  INPUT_WORDS,
  LITERAL_CUES,
  MEMBERSHIP_CUES,
  NAME_SYNONYMS,
  NEGATION_CUES,
  NUMBER_CUES,
  REFERENCE_WORDS,
  STATEMENT_CUES,
  STRING_CUES,
  UNARY_CUES,
  UPDATE_CUES,
} from './lexicon';
import { namePositions, nameSaid, normalize, Words } from './words';

/** How far, in words, an operator may be from what it combines. */
const NEAR = 6;

const PRONOUNS: readonly string[] = ['it', 'its', "it's", 'that', 'this', 'them', 'they', 'itself'];

export const VALIDATION_CODES = {
  VAL001: { name: 'no-source', summary: 'Cites no words and names no inference rule' },
  VAL002: { name: 'bad-span', summary: 'Cites words outside this and earlier utterances' },
  VAL003: { name: 'unsupported', summary: "The cited words don't say it" },
  VAL004: { name: 'inference-misfit', summary: "Marked as inferred, but doesn't fit the rule" },
  VAL005: { name: 'second-opinion', summary: "A second opinion found the words don't say it" },
} as const satisfies Record<string, { name: string; summary: string }>;

export type ValidationCode = keyof typeof VALIDATION_CODES;

/** Something the batch proposed that the validator held back. Severity: info. */
export interface HeldBack {
  code: ValidationCode;
  /** The proposed code, or the proposed field change. */
  proposed: string;
  /**
   * A node of the unvalidated result that was replaced by a hole or
   * removed, or the index of an op that was dropped.
   */
  target: { node: NodeId } | { op: number };
  /** States what's missing, never what to say (ADR-009). */
  message: string;
  spans: Span[];
}

/** A node the lexicon can't judge: does `words` say `code`? */
export interface Claim {
  /** The node's ID in the unvalidated result. */
  node: NodeId;
  code: string;
  words: string;
  spans: Span[];
}

export interface ValidationInput {
  /** The document the batch applies to. */
  document: IrDocument;
  batch: EditBatch;
  /** The batch's utterance and every earlier one its spans may cite. */
  utterances: readonly Utterance[];
  /** Names the problem gives. */
  inputs?: readonly string[];
  /** Claims (by node) a second opinion rejected; see `checkBatch`. */
  rejected?: ReadonlySet<NodeId>;
}

export interface ValidationResult {
  /** The batch with unsupported parts held back; apply this one. */
  batch: EditBatch;
  heldBack: HeldBack[];
  /** Nodes and field changes checked. */
  checked: number;
  /** Nodes the lexicon couldn't judge, for the second-opinion verifier. */
  claims: Claim[];
}

/** The reason a held-back node's hole gives. */
export const HELD_BACK_REASON = 'held back: not stated in the words';

type Verdict = 'yes' | 'no' | 'unchecked';

const SETUP_CUES: readonly string[] = [
  'is',
  'are',
  'be',
  '=',
  'set',
  'start',
  'begin',
  'become',
  'initialize',
  'init',
  'equal',
  'assign',
  'make',
  'keep',
  'store',
  'hold',
  'called',
  'named',
  'create',
  'reset',
  'track',
];

const OPERAND_KINDS: ReadonlySet<string> = new Set([
  'Name',
  'Literal',
  'InfinityLiteral',
  'UnaryOp',
  'BinOp',
  'Compare',
  'BoolOp',
  'Membership',
]);

const STATEMENT_SLOT_PARENTS: ReadonlySet<string> = new Set(['Program', 'Block']);

const BOOLEAN_KINDS: ReadonlySet<string> = new Set(['Compare', 'Membership', 'BoolOp']);

const NODE_CREATING: ReadonlySet<EditOp['op']> = new Set([
  'add_stmt',
  'fill_hole',
  'replace_node',
  'wrap_nodes',
  'insert_at',
  'swap_node',
]);

function isStatementSlot(position: Position | undefined): boolean {
  return position !== undefined && STATEMENT_SLOT_PARENTS.has(position.parent.kind);
}

/** Where a name is bound rather than used. */
function isBindingSlot(position: Position | undefined): boolean {
  if (position === undefined) return false;
  const { parent, field } = position;
  return (
    ((parent.kind === 'ForEach' || parent.kind === 'ForRange') && field === 'target') ||
    (parent.kind === 'FunctionDef' && (field === 'name' || field === 'params')) ||
    (parent.kind === 'Assign' && field === 'target')
  );
}

function isCondSlot(position: Position | undefined): boolean {
  if (position === undefined) return false;
  const { parent, field } = position;
  return (
    ((parent.kind === 'If' || parent.kind === 'Elif' || parent.kind === 'While') &&
      field === 'cond') ||
    parent.kind === 'BoolOp' ||
    (parent.kind === 'UnaryOp' && parent.op === 'not')
  );
}

function firstLine(body: Stmt[]): string {
  const text = render(
    { kind: 'Program', id: 'n0', provenance: [], body },
    { mode: 'ui' },
  ).text.trimEnd();
  const lines = text.split('\n');
  return lines.length > 1 ? `${lines[0] ?? ''} …` : text;
}

/** One line of code for a node, for messages and the verifier. */
export function codeOf(node: IrNode): string {
  switch (node.kind) {
    case 'Program':
      return '(program)';
    case 'Block':
      return 'else: …';
    case 'Elif':
      return firstLine([
        { kind: 'If', id: 'n0', provenance: [], cond: node.cond, body: node.body, elifs: [] },
      ]).replace(/^if/, 'elif');
    case 'DictEntry':
      return firstLine([
        {
          kind: 'ExprStmt',
          id: 'n0',
          provenance: [],
          expr: { kind: 'DictLiteral', id: 'n1', provenance: [], entries: [node] },
        },
      ]).replace(/^\{(.*)\}$/, '$1');
    case 'FunctionDef':
    case 'ForEach':
    case 'ForRange':
    case 'While':
    case 'If':
    case 'Assign':
    case 'Update':
    case 'Return':
    case 'Break':
    case 'Continue':
    case 'ExprStmt':
    case 'IntentStmt':
    case 'BlockHole':
      return firstLine([node]);
    default:
      return firstLine([{ kind: 'ExprStmt', id: 'n0', provenance: [], expr: node }]);
  }
}

/** The cues for an operator, if `op` is one the table knows. */
function cuesFor(
  table: Readonly<Record<string, readonly string[]>>,
  op: string,
): readonly string[] | undefined {
  return Object.entries(table).find(([key]) => key === op)?.[1];
}

class Checker {
  readonly #utterances: readonly Utterance[];
  readonly #current: number;
  /** Names set up before the batch, or given by the problem. */
  readonly #before: ReadonlySet<string>;
  /** Those, and the names the batch binds. */
  readonly #known: ReadonlySet<string>;
  readonly #inputs: ReadonlySet<string>;
  /** Shapes of the code the batch removes: rebuilding it needs no new words. */
  readonly #existing: ReadonlySet<string>;
  /** Functions the program defines: called by name, not by "it" or "that". */
  readonly #functions: ReadonlySet<string>;

  constructor(
    input: ValidationInput,
    before: ReadonlySet<string>,
    known: ReadonlySet<string>,
    existing: ReadonlySet<string>,
  ) {
    this.#existing = existing;
    const functions = new Set<string>();
    walk(input.document.program, (node) => {
      if (node.kind === 'FunctionDef' && node.name.kind === 'Name') functions.add(node.name.name);
    });
    this.#functions = functions;
    this.#utterances = input.utterances;
    this.#current = input.utterances.findIndex((u) => u.id === input.batch.utteranceId);
    this.#before = before;
    this.#known = known;
    this.#inputs = new Set(input.inputs ?? []);
  }

  /** A span points into the batch's utterance or an earlier one, inside its words. */
  spanValid(span: Span): boolean {
    const index = this.#utterances.findIndex((u) => u.id === span.utteranceId);
    const utterance = this.#utterances[index];
    return (
      utterance !== undefined &&
      (this.#current === -1 || index <= this.#current) &&
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= utterance.tokens.length
    );
  }

  words(spans: readonly Span[]): Words {
    return Words.of(spans, this.#utterances);
  }

  /**
   * The whole utterances some spans point into. Models cite narrower word
   * ranges than they should ("num is in seen" for `if num in seen`), and
   * the lexicon was tuned and measured on whole utterances (gold cites
   * nothing finer), so a node the cited words don't support is checked
   * again against its utterance before it's held back.
   */
  widen(spans: readonly Span[]): Span[] {
    const ids = [...new Set(spans.map((span) => span.utteranceId))];
    return ids.flatMap((utteranceId) => {
      const utterance = this.#utterances.find((u) => u.id === utteranceId);
      return utterance ? [{ utteranceId, start: 0, end: utterance.tokens.length }] : [];
    });
  }

  quote(spans: readonly Span[]): string {
    return spans.map((span) => quoteSpan(span, this.#utterances) ?? '').join(' … ');
  }

  /** "Return True if …": the literal returned under a condition, if the words say one. */
  conditionalReturn(words: Words): 'True' | 'False' | undefined {
    const { tokens } = words;
    for (let i = 0; i < tokens.length; i++) {
      const literal = tokens[i + 1];
      if (!(tokens[i] ?? '').startsWith('return') || (literal !== 'true' && literal !== 'false'))
        continue;
      const next = tokens.slice(i + 2, i + 4);
      if (next.some((word) => ['if', 'when', 'whenever', 'unless', 'once'].includes(word)))
        return literal === 'true' ? 'True' : 'False';
    }
    return undefined;
  }

  /** `refer`: whether "it" or "the list" can stand for a name already set up. */
  name(name: string, words: Words, binding: boolean, refer = true): boolean {
    if (nameSaid(name, words, NAME_SYNONYMS)) return true;
    const callee = CALLEE_CUES[name];
    if (callee !== undefined && words.hasAny(callee)) return true;
    if (binding || !refer || !this.#known.has(name)) return false;
    // A name already set up can be referred to without saying it.
    return words.hasAny(REFERENCE_WORDS) || (this.#inputs.has(name) && words.hasAny(INPUT_WORDS));
  }

  literal(value: string | number | boolean | null, words: Words): boolean {
    if (value === null) return words.hasAny(LITERAL_CUES.none);
    if (value === true) return words.hasAny(LITERAL_CUES.true);
    if (value === false) return words.hasAny(LITERAL_CUES.false);
    if (typeof value === 'number') {
      const magnitude = Math.abs(value);
      const said = words.numbers().has(magnitude) || words.hasAny(NUMBER_CUES[magnitude] ?? []);
      if (value >= 0) return said;
      return (
        (said && words.hasAny(['minus', 'negative', '-', 'below'])) ||
        (value === -1 &&
          words.hasAny(['last', 'end', 'not found', 'none', 'backwards', 'reverse', 'back', 'top']))
      );
    }
    if (value === '') return words.hasAny(LITERAL_CUES.emptyString);
    const text = normalize(value);
    const joined = words.tokens.join(' ');
    return (
      joined.includes(text) ||
      words.tokens.join('').includes(text.replaceAll(/\s+/g, '')) ||
      words.hasAny(STRING_CUES[value] ?? [])
    );
  }

  /** Whether a created node's words support it. */
  node(node: IrNode, position: Position | undefined, words: Words): Verdict {
    const yes = (ok: boolean): Verdict => (ok ? 'yes' : 'no');
    switch (node.kind) {
      case 'Name': {
        // A loop variable can't be named by its collection's name: in "each
        // amount in nums", `num` matches only "nums"; "amount" is the name said.
        const iterable =
          position?.parent.kind === 'ForEach' && position.field === 'target'
            ? position.parent.iterable
            : undefined;
        const said =
          iterable?.kind === 'Name'
            ? new Words(
                words.tokens.map((token) =>
                  token === iterable.name.toLowerCase() ? '\u0000' : token,
                ),
              )
            : words;
        // A new name must be said; one set up already can be referred to.
        return yes(
          this.name(node.name, said, isBindingSlot(position) && !this.#before.has(node.name)),
        );
      }
      case 'Literal':
        return yes(this.literal(node.value, words));
      case 'InfinityLiteral':
        return yes(
          words.hasAny([
            'infinity',
            'inf',
            'infinite',
            'huge',
            'large',
            'big',
            'max',
            'maximum',
            'largest',
            'biggest',
            'smallest',
            'minimum',
            'min',
            'float',
            'anything',
            'beat',
            'lowest',
            'highest',
          ]),
        );
      case 'UnaryOp':
        return yes(words.hasAny(UNARY_CUES[node.op]) && this.operandsSaid(node, words));
      case 'BinOp':
        if (this.impliedOne(node, words)) return 'yes';
        // `[0] * n` repeats a list: "n zeros" says it in any order.
        return yes(
          (node.op === '*' && node.left.kind === 'CollectionLiteral'
            ? words.hasAny(ARITHMETIC_CUES['*'])
            : this.combined(node, ARITHMETIC_CUES[node.op], words)) &&
            this.operandsSaid(node, words),
        );
      case 'Compare':
        return yes(
          this.combined(node, COMPARE_CUES[node.op], words) && this.operandsSaid(node, words),
        );
      case 'BoolOp':
        // Unsaid operands are held back one run at a time (see `validate`);
        // the whole `and`/`or` only if none of it was said.
        return yes(
          words.hasAny(BOOL_CUES[node.op]) &&
            node.operands.some((operand) => !this.operandUnsaid(operand, words)),
        );
      case 'Membership':
        return yes(
          words.hasAny(MEMBERSHIP_CUES) &&
            (!node.negated || words.hasAny(NEGATION_CUES)) &&
            this.operandsSaid(node, words),
        );
      case 'Call': {
        const { callee } = node;
        // "inside that" doesn't call `sink`: the speaker's own functions
        // are called by name.
        if (callee.kind === 'Name')
          return yes(this.name(callee.name, words, false, !this.#functions.has(callee.name)));
        if (callee.kind === 'Attribute')
          return yes(
            nameSaid(callee.name, words, NAME_SYNONYMS) ||
              words.hasAny(CALLEE_CUES[callee.name] ?? []),
          );
        return 'unchecked';
      }
      case 'Attribute':
        return yes(
          nameSaid(node.name, words, NAME_SYNONYMS) || words.hasAny(CALLEE_CUES[node.name] ?? []),
        );
      case 'CollectionLiteral':
        return node.elements.length === 0
          ? yes(words.hasAny(EMPTY_COLLECTION_CUES[node.collection]))
          : 'unchecked';
      case 'DictLiteral':
        return node.entries.length === 0 ? yes(words.hasAny(EMPTY_DICT_CUES)) : 'unchecked';
      case 'Return':
        return yes(words.hasAny(STATEMENT_CUES.Return));
      case 'Break':
        return yes(words.hasAny(STATEMENT_CUES.Break));
      case 'Continue':
        return yes(words.hasAny(STATEMENT_CUES.Continue));
      case 'If':
        return yes(words.hasAny(STATEMENT_CUES.If));
      case 'Elif':
        return yes(words.hasAny(STATEMENT_CUES.Elif));
      case 'While':
        return yes(words.hasAny(STATEMENT_CUES.While));
      case 'ForEach':
      case 'ForRange':
        return yes(words.hasAny(STATEMENT_CUES.Loop));
      case 'FunctionDef':
        return yes(words.hasAny(STATEMENT_CUES.FunctionDef));
      case 'Update':
        return yes(words.hasAny(UPDATE_CUES[node.op]));
      case 'Block':
        // A new `else` branch on an existing `if`.
        return position?.parent.kind === 'If' && position.field === 'orelse'
          ? yes(words.hasAny(STATEMENT_CUES.Else))
          : 'yes';
      case 'IntentStmt': {
        const content = node.text
          .toLowerCase()
          .split(/[^\p{L}\p{N}']+/u)
          .filter((w) => w.length > 2);
        const found = content.filter((w) => words.has(w)).length;
        return content.length === 0 || found * 2 >= content.length ? 'yes' : 'unchecked';
      }
      case 'Index':
      case 'Slice':
      case 'Assign':
        return 'unchecked';
      default:
        // Holes, expression statements, dict entries: nothing of their own to say.
        return 'yes';
    }
  }

  /**
   * Whether an operator is said near what it combines: in "prev plus curr,
   * from two to n inclusive", `+` is near `prev` but "inclusive" isn't, so
   * the words don't say `prev + 1`. Operands the words only refer to ("it")
   * have no position, and then nearness isn't checked.
   */
  combined(node: { left: Expr; right: Expr }, cues: readonly string[], words: Words): boolean {
    const at = words.positions(cues);
    if (at.length === 0) return false;
    const left = this.anchors(node.left, words);
    const right = this.anchors(node.right, words);
    if (left.length === 0 || right.length === 0) return true;
    const near = (from: readonly number[], p: number) => from.some((i) => words.near(i, p, NEAR));
    return at.some((p) => near(left, p) && near(right, p));
  }

  /** `i + 1` said as "the next index", `n + 1` as "n inclusive". */
  impliedOne(node: IrNode, words: Words): boolean {
    if (node.kind !== 'BinOp' || (node.op !== '+' && node.op !== '-')) return false;
    if (node.right.kind !== 'Literal' || node.right.value !== 1) return false;
    const left = this.anchors(node.left, words);
    // The cue must be its own word, not the value's name ("prev"), and not
    // a discourse marker opening a clause ("After that, …", "Next, …").
    const opensClause = (p: number) =>
      p === 0 || /^[^\p{L}\p{N}]*$/u.test(words.tokens[p - 1] ?? '');
    return words
      .positions(IMPLIED_ONE)
      .some((p) => !opensClause(p) && !left.includes(p) && left.some((i) => words.near(i, p, 2)));
  }

  /**
   * An operation on something unsaid isn't said either: for `best = total
   * + ?` the words would claim more than they do, so the whole expression
   * is held back. Only names, literals and further operations count here.
   */
  operandsSaid(node: IrNode, words: Words): boolean {
    return children(node).every(({ node: operand }) => !this.operandUnsaid(operand, words));
  }

  /** A name, literal or operation the words don't say (code being rebuilt aside). */
  operandUnsaid(operand: IrNode, words: Words): boolean {
    if (this.#existing.has(shapeOf(operand)) || !OPERAND_KINDS.has(operand.kind)) return false;
    return this.node(operand, undefined, words) === 'no';
  }

  /**
   * Whether the words set a name up ("count starts at", "set best to", "x
   * is"), not only use it ("add one to islands"): a setup word within a
   * few words of the name.
   */
  setupSaid(name: string, words: Words): boolean {
    const at = namePositions(name, words, NAME_SYNONYMS);
    const cues = words.positions(SETUP_CUES);
    return at.some((i) => cues.some((p) => words.near(i, p, 3)));
  }

  /** Where the words say something in an expression. */
  anchors(node: IrNode, words: Words): number[] {
    switch (node.kind) {
      case 'Name':
        return [
          ...namePositions(node.name, words, NAME_SYNONYMS),
          ...words.positions(CALLEE_CUES[node.name] ?? []),
          // "it", "that": a name set up already, referred to.
          ...(this.#known.has(node.name) ? words.positions(PRONOUNS) : []),
        ];
      case 'Literal': {
        const { value } = node;
        if (typeof value === 'number')
          return [
            ...words.numberPositions(Math.abs(value)),
            ...words.positions(NUMBER_CUES[Math.abs(value)] ?? []),
          ];
        if (value === true) return words.positions(LITERAL_CUES.true);
        if (value === false) return words.positions(LITERAL_CUES.false);
        if (value === null) return words.positions(LITERAL_CUES.none);
        return [];
      }
      case 'Call':
        return [
          ...(node.callee.kind === 'Name' || node.callee.kind === 'Attribute'
            ? words.positions(CALLEE_CUES[node.callee.name] ?? [])
            : []),
          ...[node.callee, ...node.args].flatMap((child) => this.anchors(child, words)),
        ];
      case 'Attribute':
        return [
          ...namePositions(node.name, words, NAME_SYNONYMS),
          ...this.anchors(node.object, words),
        ];
      default:
        return allNodes(node)
          .slice(1)
          .filter((child) => child.kind === 'Name' || child.kind === 'Literal')
          .flatMap((child) => this.anchors(child, words));
    }
  }

  /** Whether an `update_field` that sets a plain value is supported. */
  field(node: IrNode, field: string, value: unknown, words: Words): Verdict {
    if (field === 'op' && typeof value === 'string') {
      const table =
        node.kind === 'Compare'
          ? COMPARE_CUES
          : node.kind === 'BinOp'
            ? ARITHMETIC_CUES
            : node.kind === 'BoolOp'
              ? BOOL_CUES
              : node.kind === 'UnaryOp'
                ? UNARY_CUES
                : node.kind === 'Update'
                  ? UPDATE_CUES
                  : undefined;
      const cues = table === undefined ? undefined : cuesFor(table, value);
      return cues === undefined ? 'unchecked' : words.hasAny(cues) ? 'yes' : 'no';
    }
    if (field === 'name' && typeof value === 'string') {
      return nameSaid(value, words, NAME_SYNONYMS) ? 'yes' : 'no';
    }
    if (field === 'value' && node.kind === 'Literal') {
      return value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
        ? this.literal(value, words)
          ? 'yes'
          : 'no'
        : 'unchecked';
    }
    if (field === 'negated') return value === true && !words.hasAny(NEGATION_CUES) ? 'no' : 'yes';
    return 'unchecked';
  }
}

function highestTempId(batch: EditBatch): number {
  let highest = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value as readonly unknown[]) visit(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'id' && typeof item === 'string' && TEMP_ID_PATTERN.test(item))
          highest = Math.max(highest, Number(item.slice(1)));
        else visit(item);
      }
    }
  };
  visit(batch.ops);
  return highest;
}

const META_KEYS: ReadonlySet<string> = new Set(['id', 'provenance', 'inferred', 'label', 'notes']);

/** A node's code and structure, without IDs or metadata. */
function shapeOf(node: IrNode): string {
  return JSON.stringify(node, (key, value: unknown) => (META_KEYS.has(key) ? undefined : value));
}

function namesIn(document: IrDocument): Set<string> {
  const names = new Set<string>();
  walk(document.program, (node) => {
    if (node.kind === 'Name') names.add(node.name);
  });
  return names;
}

/** Validates a batch against the words it cites; see the file comment. */
export function validate(input: ValidationInput): ValidationResult {
  const { document, batch } = input;
  const result = apply(document, batch);
  // A batch the applier rejects is reported by the applier.
  if (!result.ok) return { batch, heldBack: [], checked: 0, claims: [] };

  const after = result.document.program;
  const isNew = (id: NodeId) => (nodeIdNumber(id) ?? 0) >= document.nextId;
  const before = namesIn(document);
  for (const name of input.inputs ?? []) before.add(name);
  // Names this batch binds can be referred to elsewhere in it.
  const known = new Set(before);
  walk(after, (node, { position }) => {
    if (node.kind === 'Name' && isNew(node.id) && isBindingSlot(position)) known.add(node.name);
  });
  // Code the batch takes out and rebuilds unchanged (restructuring an
  // if-chain, say) was supported when it was first said.
  const kept = new Set(allNodes(after).map((node) => node.id));
  const existing = new Set(
    allNodes(document.program)
      .filter((node) => !kept.has(node.id))
      .map(shapeOf),
  );
  const checker = new Checker(input, before, known, existing);

  const heldBack: HeldBack[] = [];
  const claims: Claim[] = [];
  const downgrades: EditOp[] = [];
  let checked = 0;
  let temp = highestTempId(batch);
  // Nodes judged as part of their parent: a callee, a rule's own parts.
  const covered = new Set<NodeId>();
  // Nodes already held back as part of their parent's check, with what's in them.
  const skipped = new Set<NodeId>();

  const holdBack = (
    node: IrNode,
    position: Position | undefined,
    code: ValidationCode,
    message: string,
    spans: Span[],
    proposed = codeOf(node),
  ) => {
    heldBack.push({ code, proposed, target: { node: node.id }, message, spans });
    const provenance = code === 'VAL001' || code === 'VAL002' ? [] : spans;
    const removable =
      isStatementSlot(position) ||
      node.kind === 'Elif' ||
      node.kind === 'DictEntry' ||
      node.kind === 'Block';
    if (removable) {
      downgrades.push({ op: 'remove_node', node: node.id, provenance });
      return;
    }
    const kind =
      node.kind === 'Name' || isBindingSlot(position)
        ? 'NameHole'
        : isCondSlot(position) ||
            BOOLEAN_KINDS.has(node.kind) ||
            (node.kind === 'UnaryOp' && node.op === 'not')
          ? 'CondHole'
          : 'ExprHole';
    downgrades.push({
      op: 'replace_node',
      node: node.id,
      replacement: { kind, id: `t${String(++temp)}`, reason: HELD_BACK_REASON, provenance },
      provenance,
    });
  };

  walk(after, (node, { position }) => {
    if (skipped.has(node.id)) return false;
    if (!isNew(node.id) || covered.has(node.id)) return;
    // Holes mark what wasn't said; blocks are containers, except a new `else`.
    if (node.kind.endsWith('Hole')) return;
    if (node.kind === 'Block' && !(position?.parent.kind === 'If' && position.field === 'orelse'))
      return;
    checked++;
    if (existing.has(shapeOf(node))) return false;
    const proposed = codeOf(node);
    const spans = node.provenance;
    if (!spans.every((span) => checker.spanValid(span))) {
      holdBack(
        node,
        position,
        'VAL002',
        `\`${proposed}\` cites words that aren't in this or an earlier utterance`,
        spans,
      );
      return false;
    }
    if (spans.length === 0 && node.inferred === undefined && node.kind !== 'Block') {
      holdBack(node, position, 'VAL001', `Nothing said supports \`${proposed}\``, spans);
      return false;
    }
    if (node.inferred !== undefined) {
      if (!fitsInferenceRule(node, position)) {
        holdBack(
          node,
          position,
          'VAL004',
          `\`${proposed}\` is marked ${node.inferred}, which doesn't cover it`,
          spans,
        );
        return false;
      }
      // The rule supplies what wasn't said; for `len(x)` that includes `len`.
      if (node.kind === 'Call' && node.callee.kind === 'Name') covered.add(node.callee.id);
      if (!INFERENCE_RULES[node.inferred].requiresProvenance || node.kind === 'Update') return;
    }
    if (node.kind === 'Call' && (node.callee.kind === 'Name' || node.callee.kind === 'Attribute'))
      covered.add(node.callee.id);
    // "append FizzBuzz": the verb refers to the collection being built.
    if (node.kind === 'Update' && node.target.kind === 'Name' && known.has(node.target.name))
      covered.add(node.target.id);
    if (spans.length === 0) return;
    const cited = checker.words(spans);
    const citedVerdict = checker.node(node, position, cited);
    const words = citedVerdict === 'no' ? checker.words(checker.widen(spans)) : cited;
    const verdict = citedVerdict === 'no' ? checker.node(node, position, words) : citedVerdict;
    if (verdict === 'no') {
      holdBack(
        node,
        position,
        'VAL003',
        `The words "${checker.quote(spans)}" don't say \`${proposed}\``,
        spans,
      );
      return false;
    }
    // The `1` of "the next index" is part of the idiom, not a separate claim.
    if (node.kind === 'BinOp' && checker.impliedOne(node, words)) covered.add(node.right.id);
    // "If nr, nc is in bounds and grid[nr][nc] is 1": each run of unsaid
    // operands becomes one hole, so `? and grid[nr][nc] == 1` is kept.
    if (node.kind === 'BoolOp') {
      const unsaid = node.operands.map((operand) => checker.operandUnsaid(operand, words));
      for (let i = 0; i < unsaid.length; i++) {
        if (unsaid[i] !== true) continue;
        let end = i;
        while (unsaid[end + 1] === true) end++;
        const run = node.operands.slice(i, end + 1);
        const [first, ...rest] = run;
        if (first !== undefined) {
          const text = run.map(codeOf).join(` ${node.op} `);
          holdBack(
            first,
            { parent: node, field: 'operands', index: i },
            'VAL003',
            `The words "${checker.quote(spans)}" don't say \`${text}\``,
            first.provenance,
            text,
          );
          for (const operand of rest)
            downgrades.push({ op: 'remove_node', node: operand.id, provenance: [] });
          for (const operand of run) skipped.add(operand.id);
        }
        i = end;
      }
    }
    // "Return True if the stack is empty" as `return not stack`: the words
    // say when it returns True, not what it returns otherwise.
    const value = node.kind === 'Return' ? node.value : undefined;
    const literal =
      value !== undefined &&
      (BOOLEAN_KINDS.has(value.kind) || (value.kind === 'UnaryOp' && value.op === 'not'))
        ? checker.conditionalReturn(words)
        : undefined;
    if (literal !== undefined) {
      holdBack(
        node,
        position,
        'VAL003',
        `The words "${checker.quote(spans)}" say when it returns ${literal}, not what it returns otherwise`,
        spans,
      );
      return false;
    }
    // `islands = 0` from "add one to islands": with the value held back, the
    // line would still claim a setup nobody described, so it goes too.
    if (
      node.kind === 'Assign' &&
      node.target.kind === 'Name' &&
      !before.has(node.target.name) &&
      checker.operandUnsaid(node.value, words) &&
      !checker.setupSaid(node.target.name, words)
    ) {
      holdBack(
        node,
        position,
        'VAL003',
        `The words "${checker.quote(spans)}" don't set up \`${node.target.name}\``,
        spans,
      );
      return false;
    }
    if (verdict === 'unchecked' && input.rejected?.has(node.id) === true) {
      holdBack(
        node,
        position,
        'VAL005',
        `A second opinion found the words "${checker.quote(spans)}" don't say \`${proposed}\``,
        spans,
      );
      return false;
    }
    if (verdict === 'unchecked')
      claims.push({
        node: node.id,
        code: proposed,
        // The second opinion sees the whole utterance, for the same reason.
        words: checker.words(checker.widen(spans)).text,
        spans,
      });
    return;
  });

  // Field changes and other ops that create nothing: dropped when unsupported.
  const index = indexTree(after);
  const dropped = new Set<number>();
  batch.ops.forEach((op, i) => {
    if (op.op === 'ask_clarification' || NODE_CREATING.has(op.op)) return;
    if (
      op.op === 'update_field' &&
      typeof op.value === 'object' &&
      op.value !== null &&
      !Array.isArray(op.value)
    )
      return;
    const spans = op.provenance ?? [];
    const drop = (code: ValidationCode, proposed: string, message: string) => {
      dropped.add(i);
      heldBack.push({ code, proposed, target: { op: i }, message, spans });
    };
    checked++;
    const proposed = describeOp(op);
    if (!spans.every((span) => checker.spanValid(span))) {
      drop(
        'VAL002',
        proposed,
        `${proposed} cites words that aren't in this or an earlier utterance`,
      );
      return;
    }
    if (spans.length === 0) {
      drop('VAL001', proposed, `Nothing said supports ${proposed}`);
      return;
    }
    const judge = (words: Words): Verdict => {
      if (op.op === 'update_field') {
        const target = index.get(op.node)?.node;
        return target === undefined ? 'yes' : checker.field(target, op.field, op.value, words);
      }
      if (op.op === 'rename_symbol') return nameSaid(op.name, words, NAME_SYNONYMS) ? 'yes' : 'no';
      if (op.op === 'set_label' && op.label !== undefined) {
        const content = op.label
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length > 2);
        return content.every((w) => words.has(w)) ? 'yes' : 'no';
      }
      return 'yes';
    };
    let verdict = judge(checker.words(spans));
    if (verdict === 'no') verdict = judge(checker.words(checker.widen(spans)));
    if (verdict === 'no')
      drop('VAL003', proposed, `The words "${checker.quote(spans)}" don't say ${proposed}`);
  });

  if (heldBack.length === 0) return { batch, heldBack, checked, claims };
  const remaining = (): EditBatch => ({
    utteranceId: batch.utteranceId,
    ops: [...batch.ops.filter((_, i) => !dropped.has(i)), ...downgrades],
  });
  // "Scan for that drop" as `for i in range(?): if ?: ...`: with the unsaid
  // parts held back, nothing said is left but a keyword, so it goes too.
  const tentative = apply(document, remaining());
  if (tentative.ok) {
    for (const { node, position } of shells(tentative.document.program, isNew)) {
      const original = index.get(node.id)?.node ?? node;
      // One notice for the statement, instead of one for each part of it.
      const inside = new Set(allNodes(original).map((n) => n.id));
      for (let i = heldBack.length - 1; i >= 0; i--) {
        const target = heldBack[i]?.target;
        if (target !== undefined && 'node' in target && inside.has(target.node))
          heldBack.splice(i, 1);
      }
      holdBack(
        node,
        position,
        'VAL003',
        `The words "${checker.quote(node.provenance)}" don't say any part of \`${codeOf(original)}\``,
        node.provenance,
        codeOf(original),
      );
    }
  }
  const validated = remaining();
  if (!apply(document, validated).ok) {
    // Shouldn't happen; if it does, nothing unchecked gets through.
    return { batch: { utteranceId: batch.utteranceId, ops: [] }, heldBack, checked, claims: [] };
  }
  // Claims inside held-back nodes no longer matter.
  const gone = new Set(
    heldBack.flatMap((h) => {
      const node = 'node' in h.target ? index.get(h.target.node)?.node : undefined;
      return node === undefined ? [] : allNodes(node).map((n) => n.id);
    }),
  );
  return {
    batch: validated,
    heldBack,
    checked,
    claims: claims.filter((claim) => !gone.has(claim.node)),
  };
}

/**
 * New statements with nothing said left in them: every expression held back
 * or inferred, at least one held back, and no statements kept in their
 * blocks. A `return` stays: "return" says it returns. Outermost first.
 */
function shells(
  program: IrNode,
  isNew: (id: NodeId) => boolean,
): { node: IrNode; position: Position | undefined }[] {
  const empty = (node: IrNode): boolean => {
    if (!isNew(node.id) || node.kind === 'Return') return false;
    let heldBack = false;
    for (const { node: child } of children(node)) {
      if (child.kind === 'BlockHole') continue;
      if (child.kind === 'Block') {
        if (child.stmts.every((stmt) => stmt.kind === 'BlockHole' || empty(stmt))) continue;
        return false;
      }
      if (child.kind === 'Elif') {
        if (empty(child)) continue;
        return false;
      }
      if ('reason' in child && child.reason === HELD_BACK_REASON) {
        heldBack = true;
        continue;
      }
      if (child.inferred === undefined) return false;
    }
    return heldBack;
  };
  const found: { node: IrNode; position: Position | undefined }[] = [];
  walk(program, (node, { position }) => {
    if (!isStatementSlot(position) || !empty(node)) return;
    found.push({ node, position });
    return false;
  });
  return found;
}

function describeOp(op: EditOp): string {
  switch (op.op) {
    case 'update_field':
      return `changing ${op.node}.${op.field} to ${JSON.stringify(op.value)}`;
    case 'rename_symbol':
      return `renaming ${op.node} to \`${op.name}\``;
    case 'set_label':
      return op.label === undefined ? `unlabeling ${op.node}` : `labeling ${op.node} "${op.label}"`;
    case 'remove_node':
      return `removing ${op.node}`;
    case 'move_node':
      return `moving ${op.node}`;
    case 'add_note':
      return `a note on ${op.node}`;
    case 'remove_note':
      return `removing note ${op.note}`;
    default:
      return op.op;
  }
}
