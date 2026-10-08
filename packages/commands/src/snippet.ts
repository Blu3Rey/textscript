// Snippets: a small Python subset that describes IR nodes, so the console
// (and later the corpus) can write code the way it reads (docs/adr/010).
//
//   for num~loopvar in nums@2:6~plural:   # @0:6
//       if num in seen: return True
//       ...                                (a block hole)
//   x = ?"the starting total"               (a hole; its kind comes from position)
//   seen.add(num)  # ~synonym               (statement annotations go in the comment)
//   intent process the element here        (a step in words only)
//
// It also reads everything the export renderer writes (`x is None`, `set()`,
// `float("inf")`, `range(...)` loops, `__hole__("…")`, `__hole_n7__` with its
// TODO comment), so `render → parse → render` is a fixpoint.

import {
  HOLE_REASONS,
  type ArithmeticOp,
  type Binding,
  type Block,
  type CompareOp,
  type DictEntry,
  type Elif,
  type Expr,
  type InferenceRuleId,
  type IrNode,
  type Span,
  type Stmt,
  type Target,
  type UpdateOp,
} from '@textscript/core';
import { SnippetError, splitComment, tokenize, type Token } from './lexer';

export { SnippetError };

export interface SnippetOptions {
  /** Makes a new temporary ID (`t1`, `t2`, …) for each node. */
  nextId: () => string;
  /** Provenance for nodes without an `@` span. Holes and blocks get none. */
  provenance?: Span[];
  /** The utterance `@start:end` spans refer to. */
  utteranceId?: string;
}

export const INFERENCE_NAMES: Readonly<Record<string, InferenceRuleId>> = {
  loopvar: 'INF-LOOPVAR',
  indexvar: 'INF-INDEXVAR',
  'range-bounds': 'INF-RANGE-BOUNDS',
  synonym: 'INF-SYNONYM',
  plural: 'INF-PLURAL-NAME',
  'block-end': 'INF-BLOCK-END',
};

const UPDATE_OPS: readonly UpdateOp[] = [
  'append',
  'extend',
  'add',
  'remove',
  'discard',
  '+=',
  '-=',
  '*=',
  '/=',
  '//=',
  '%=',
];
const COMPARE_OPS: readonly CompareOp[] = ['==', '!=', '<', '<=', '>', '>='];
const ARITHMETIC_OPS: readonly ArithmeticOp[] = ['+', '-', '*', '/', '//', '%', '**'];

const updateOps: ReadonlySet<string> = new Set(UPDATE_OPS);
const compareOps: ReadonlySet<string> = new Set(COMPARE_OPS);
const arithmeticOps: ReadonlySet<string> = new Set(ARITHMETIC_OPS);

function isUpdateOp(text: string): text is UpdateOp {
  return updateOps.has(text);
}

function isCompareOp(text: string): text is CompareOp {
  return compareOps.has(text);
}

function isArithmeticOp(text: string): text is ArithmeticOp {
  return arithmeticOps.has(text);
}

/** Updates written as a method call: `items.append(x)`. */
function isMethodUpdate(text: string): text is UpdateOp {
  return isUpdateOp(text) && /^[a-z]+$/.test(text);
}
const PLACEHOLDER_NAME = /^__hole_n\d+__$/;
const TODO_PREFIX = 'TODO(textscript):';

interface Line {
  /** 1-based line number within the snippet, for errors. */
  number: number;
  indent: number;
  code: string;
  tokens: Token[];
  /** `~rule` and `@a:b` words from the comment: annotations for the statement. */
  annotations: string[];
  /** Reasons from a `# TODO(textscript): a; b` comment, in order. */
  todos: string[];
}

function lineError(line: Line, message: string, column = 0): SnippetError {
  return new SnippetError(`Line ${String(line.number)}: ${message}`, column);
}

function readLines(text: string): Line[] {
  const lines: Line[] = [];
  text.split('\n').forEach((raw, index) => {
    const { code, comment } = splitComment(raw);
    if (code.trim() === '') return; // blank and comment-only lines carry nothing
    const indent = code.length - code.trimStart().length;
    if (code.slice(0, indent).includes('\t')) {
      throw new SnippetError(`Line ${String(index + 1)}: indent with spaces, not tabs`, 0);
    }
    const annotations: string[] = [];
    let todos: string[] = [];
    if (comment?.startsWith(TODO_PREFIX)) {
      todos = comment
        .slice(TODO_PREFIX.length)
        .split('; ')
        .map((r) => r.trim());
    } else if (comment !== undefined) {
      for (const word of comment.split(/\s+/)) {
        if (word.startsWith('~') || word.startsWith('@')) annotations.push(word);
      }
    }
    const line: Line = { number: index + 1, indent, code, tokens: [], annotations, todos };
    try {
      line.tokens = tokenize(code);
    } catch (error) {
      if (error instanceof SnippetError) throw lineError(line, error.message, error.column);
      throw error;
    }
    lines.push(line);
  });
  return lines;
}

class Parser {
  readonly options: SnippetOptions;
  /** Holes written as plain `?`, whose kind depends on where they end up. */
  readonly contextual = new WeakSet<IrNode>();
  /** Holes whose reason was not given, so a kind change can pick the default. */
  readonly defaultReason = new WeakSet<IrNode>();
  /** Nodes that already have an explicit `@` span. */

  constructor(options: SnippetOptions) {
    this.options = options;
  }

  base(): { id: string; provenance: Span[] } {
    return { id: this.options.nextId(), provenance: [...(this.options.provenance ?? [])] };
  }

  holeBase(): { id: string; provenance: Span[] } {
    return { id: this.options.nextId(), provenance: [] };
  }

  /** Applies `~rule` and `@a:b` annotations to a node. */
  annotate(node: IrNode, word: string, line: Line, column: number): void {
    if (word.startsWith('~')) {
      const rule = INFERENCE_NAMES[word.slice(1)];
      if (rule === undefined) {
        throw lineError(
          line,
          `Unknown inference "${word}"; use one of ${Object.keys(INFERENCE_NAMES)
            .map((n) => `~${n}`)
            .join(' ')}`,
          column,
        );
      }
      node.inferred = rule;
      return;
    }
    const match = /^@(\d+):(\d+)$/.exec(word);
    if (match === null) throw lineError(line, `Bad span "${word}"; write @start:end`, column);
    const utteranceId = this.options.utteranceId;
    if (utteranceId === undefined)
      throw lineError(line, 'Spans need an utterance; start one with `say`', column);
    const span = { utteranceId, start: Number(match[1]), end: Number(match[2]) };
    // The first explicit span replaces the default provenance.
    node.provenance = this.explicit.has(node) ? [...node.provenance, span] : [span];
    this.explicit.add(node);
  }

  readonly explicit = new WeakSet<IrNode>();

  /** Turns a plain `?` into the hole kind its position needs. */
  retype(expr: Expr, kind: 'CondHole' | 'NameHole'): Expr {
    if (!this.contextual.has(expr) || expr.kind !== 'ExprHole') return expr;
    const reason = this.defaultReason.has(expr)
      ? kind === 'CondHole'
        ? HOLE_REASONS.condition
        : HOLE_REASONS.name
      : expr.reason;
    return { ...expr, kind, reason };
  }

  asCondition(expr: Expr): Expr {
    return this.retype(expr, 'CondHole');
  }

  asBinding(expr: Expr, line: Line): Binding {
    const node = this.retype(expr, 'NameHole');
    if (node.kind === 'Name' || node.kind === 'NameHole') return node;
    throw lineError(line, `Expected a name here, not a ${node.kind}`);
  }

  asTarget(expr: Expr, line: Line): Target {
    const node = this.retype(expr, 'NameHole');
    if (
      node.kind === 'Name' ||
      node.kind === 'NameHole' ||
      node.kind === 'Index' ||
      node.kind === 'Attribute'
    ) {
      return node;
    }
    throw lineError(line, `Can't assign to a ${node.kind}`);
  }

  // Statements ---------------------------------------------------------------

  /** Statements at exactly `indent`, starting at `lines[start]`. */
  block(lines: Line[], start: number, indent: number): { stmts: Stmt[]; next: number } {
    const stmts: Stmt[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || line.indent < indent) break;
      if (line.indent > indent) throw lineError(line, 'Unexpected indent');
      const result = this.statement(lines, i);
      stmts.push(result.stmt);
      i = result.next;
    }
    return { stmts, next: i };
  }

  /** The body after a compound header: inline, an indented block, or a hole. */
  suite(lines: Line[], index: number, inline: Token[]): { body: Block; next: number } {
    const line = lines[index];
    if (line === undefined) throw new SnippetError('Missing line', 0);
    const following = lines[index + 1];
    const hasBlock = following !== undefined && following.indent > line.indent;
    let stmts: Stmt[];
    let next = index + 1;
    if (inline.length > 0) {
      if (hasBlock)
        throw lineError(following, 'A body can be on the same line or indented below, not both');
      stmts = [this.simple(inline, line)];
    } else if (hasBlock) {
      const result = this.block(lines, index + 1, following.indent);
      stmts = result.stmts;
      next = result.next;
    } else {
      stmts = [{ kind: 'BlockHole', ...this.holeBase(), reason: HOLE_REASONS.block }];
    }
    return { body: { kind: 'Block', id: this.options.nextId(), stmts, provenance: [] }, next };
  }

  statement(lines: Line[], index: number): { stmt: Stmt; next: number } {
    const line = lines[index];
    if (line === undefined) throw new SnippetError('Missing line', 0);
    const first = line.tokens[0];
    const keyword = first?.kind === 'name' ? first.text : undefined;
    let result: { stmt: Stmt; next: number };

    if (keyword === 'for' || keyword === 'while' || keyword === 'if' || keyword === 'def') {
      result = this.compound(lines, index, keyword);
    } else if (keyword === 'elif' || keyword === 'else') {
      throw lineError(line, `"${keyword}" needs an "if" right before it`);
    } else {
      result = { stmt: this.simple(line.tokens, line), next: index + 1 };
    }
    for (const word of line.annotations) this.annotate(result.stmt, word, line, 0);
    return result;
  }

  /** Splits a compound header at its colon. */
  header(line: Line): { head: Token[]; inline: Token[] } {
    let depth = 0;
    for (const [i, token] of line.tokens.entries()) {
      if (token.kind !== 'op') continue;
      if ('([{'.includes(token.text)) depth += 1;
      else if (')]}'.includes(token.text)) depth -= 1;
      else if (token.text === ':' && depth === 0) {
        return { head: line.tokens.slice(1, i), inline: line.tokens.slice(i + 1) };
      }
    }
    throw lineError(line, 'Expected ":" at the end of the header');
  }

  compound(
    lines: Line[],
    index: number,
    keyword: 'for' | 'while' | 'if' | 'def',
  ): { stmt: Stmt; next: number } {
    const line = lines[index];
    if (line === undefined) throw new SnippetError('Missing line', 0);
    const { head, inline } = this.header(line);
    const exprs = new ExprParser(this, head, line);

    if (keyword === 'while') {
      const cond = this.asCondition(exprs.all());
      const { body, next } = this.suite(lines, index, inline);
      return { stmt: { kind: 'While', ...this.base(), cond, body }, next };
    }

    if (keyword === 'for') {
      const inAt = exprs.findTopLevel((t) => t.kind === 'name' && t.text === 'in');
      if (inAt === -1) throw lineError(line, 'Expected "for <name> in <collection>:"');
      const target = this.asBinding(new ExprParser(this, head.slice(0, inAt), line).all(), line);
      const iterable = new ExprParser(this, head.slice(inAt + 1), line).all();
      const { body, next } = this.suite(lines, index, inline);
      const [a, b, c] = iterable.kind === 'Call' ? iterable.args : [];
      const isRange =
        iterable.kind === 'Call' &&
        iterable.callee.kind === 'Name' &&
        iterable.callee.name === 'range' &&
        iterable.args.length <= 3;
      if (isRange && a !== undefined) {
        // The call itself disappears into the loop, so marks on it would be lost.
        if (iterable.inferred !== undefined || this.explicit.has(iterable)) {
          throw lineError(
            line,
            'Mark a bound inside range(...), such as range(len(nums)~range-bounds)',
          );
        }
        const bounds =
          b === undefined
            ? { stop: a }
            : { start: a, stop: b, ...(c === undefined ? {} : { step: c }) };
        return { stmt: { kind: 'ForRange', ...this.base(), target, ...bounds, body }, next };
      }
      return { stmt: { kind: 'ForEach', ...this.base(), target, iterable, body }, next };
    }

    if (keyword === 'def') {
      const name = this.asBinding(exprs.atom(), line);
      exprs.expect('op', '(');
      const params: Binding[] = [];
      while (!exprs.at('op', ')')) {
        params.push(this.asBinding(exprs.expression(), line));
        if (!exprs.at('op', ')')) exprs.expect('op', ',');
      }
      exprs.expect('op', ')');
      exprs.end();
      const { body, next } = this.suite(lines, index, inline);
      return { stmt: { kind: 'FunctionDef', ...this.base(), name, params, body }, next };
    }

    // if / elif / else
    const cond = this.asCondition(exprs.all());
    const first = this.suite(lines, index, inline);
    const stmt: Stmt & { kind: 'If' } = {
      kind: 'If',
      ...this.base(),
      cond,
      body: first.body,
      elifs: [],
    };
    let next = first.next;
    for (;;) {
      const clause = lines[next];
      const word = clause?.tokens[0];
      if (clause?.indent !== line.indent || word?.kind !== 'name') break;
      if (word.text === 'elif') {
        const parts = this.header(clause);
        const elifCond = this.asCondition(new ExprParser(this, parts.head, clause).all());
        const { body, next: after } = this.suite(lines, next, parts.inline);
        const elif: Elif = { kind: 'Elif', ...this.base(), cond: elifCond, body };
        for (const w of clause.annotations) this.annotate(elif, w, clause, 0);
        stmt.elifs.push(elif);
        next = after;
      } else if (word.text === 'else') {
        const parts = this.header(clause);
        if (parts.head.length > 0) throw lineError(clause, 'Expected "else:"');
        const { body, next: after } = this.suite(lines, next, parts.inline);
        stmt.orelse = body;
        next = after;
        break;
      } else {
        break;
      }
    }
    return { stmt, next };
  }

  /** A statement that fits on one line. */
  simple(tokens: Token[], line: Line): Stmt {
    const [first, second] = tokens;
    if (first === undefined) throw lineError(line, 'Expected a statement');
    if (first.kind === 'name') {
      switch (first.text) {
        case 'return': {
          const rest = tokens.slice(1);
          return rest.length === 0
            ? { kind: 'Return', ...this.base() }
            : { kind: 'Return', ...this.base(), value: new ExprParser(this, rest, line).all() };
        }
        case 'break':
        case 'continue':
          if (tokens.length > 1)
            throw lineError(line, `Nothing can follow "${first.text}"`, second?.column);
          return { kind: first.text === 'break' ? 'Break' : 'Continue', ...this.base() };
        case 'intent': {
          // `intent <words>`; a variable called `intent` is followed by an
          // operator or nothing.
          if (second === undefined || second.kind === 'op') break;
          const text = line.code.slice(line.code.indexOf('intent') + 'intent'.length).trim();
          if (text === '') throw lineError(line, 'Write the step after "intent"');
          return { kind: 'IntentStmt', ...this.base(), text };
        }
        case 'pass':
          throw lineError(line, 'Use "..." for a body that is not described yet');
        default:
          break;
      }
    }
    if (first.kind === 'ellipsis') {
      if (tokens.length > 1) throw lineError(line, 'Nothing can follow "..."', second?.column);
      return {
        kind: 'BlockHole',
        ...this.holeBase(),
        reason: line.todos.shift() ?? HOLE_REASONS.block,
      };
    }

    const exprs = new ExprParser(this, tokens, line);
    const assignAt = exprs.findTopLevel(
      (t) => t.kind === 'op' && (t.text === '=' || isUpdateOp(t.text)),
    );
    if (assignAt !== -1) {
      const op = tokens[assignAt]?.text ?? '=';
      const comma = tokens.slice(0, assignAt).findIndex((t) => t.text === ',');
      if (
        comma !== -1 &&
        new ExprParser(this, tokens.slice(0, assignAt), line).findTopLevel(
          (t) => t.text === ',',
        ) !== -1
      ) {
        throw lineError(
          line,
          'Tuple assignments ("a, b = x, y") aren\'t supported: write one assignment per line, in the order the speaker described',
          tokens[comma]?.column,
        );
      }
      const target = this.asTarget(
        new ExprParser(this, tokens.slice(0, assignAt), line).all(),
        line,
      );
      const value = new ExprParser(this, tokens.slice(assignAt + 1), line).all();
      if (isUpdateOp(op)) return { kind: 'Update', ...this.base(), target, op, value };
      return { kind: 'Assign', ...this.base(), target, value };
    }

    const expr = exprs.all();
    // `items.append(x)` is the language-neutral Update, not a method call.
    const method =
      expr.kind === 'Call' && expr.callee.kind === 'Attribute' ? expr.callee : undefined;
    if (
      expr.kind === 'Call' &&
      method !== undefined &&
      isMethodUpdate(method.name) &&
      expr.args.length === 1
    ) {
      const [value] = expr.args;
      const object = this.retype(method.object, 'NameHole');
      if (
        value !== undefined &&
        (object.kind === 'Name' ||
          object.kind === 'NameHole' ||
          object.kind === 'Index' ||
          object.kind === 'Attribute')
      ) {
        const update: Stmt = {
          kind: 'Update',
          ...this.base(),
          target: object,
          op: method.name,
          value,
        };
        if (method.inferred !== undefined) update.inferred = method.inferred;
        return update;
      }
    }
    return { kind: 'ExprStmt', ...this.base(), expr };
  }
}

/** Parses the expressions on one line. */
class ExprParser {
  readonly parser: Parser;
  readonly tokens: Token[];
  readonly line: Line;
  pos = 0;

  constructor(parser: Parser, tokens: Token[], line: Line) {
    this.parser = parser;
    this.tokens = tokens;
    this.line = line;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  at(kind: Token['kind'], text?: string): boolean {
    const token = this.peek();
    return token?.kind === kind && (text === undefined || token.text === text);
  }

  next(): Token {
    const token = this.peek();
    if (token === undefined)
      throw lineError(this.line, 'Unexpected end of line', this.line.code.length);
    this.pos += 1;
    return token;
  }

  expect(kind: Token['kind'], text?: string): Token {
    if (!this.at(kind, text)) {
      const found = this.peek();
      throw lineError(
        this.line,
        `Expected ${text === undefined ? kind : `"${text}"`}, found ${found === undefined ? 'end of line' : `"${found.text}"`}`,
        found?.column ?? this.line.code.length,
      );
    }
    return this.next();
  }

  end(): void {
    const extra = this.peek();
    if (extra !== undefined) throw lineError(this.line, `Unexpected "${extra.text}"`, extra.column);
  }

  /** Index of the first top-level token matching `test`, or -1. */
  findTopLevel(test: (token: Token) => boolean): number {
    let depth = 0;
    for (const [i, token] of this.tokens.entries()) {
      if (token.kind === 'op' && '([{'.includes(token.text)) depth += 1;
      else if (token.kind === 'op' && ')]}'.includes(token.text)) depth -= 1;
      else if (depth === 0 && test(token)) return i;
    }
    return -1;
  }

  /** One expression that must use up every token. */
  all(): Expr {
    if (this.tokens.length === 0)
      throw lineError(this.line, 'Expected an expression', this.line.code.length);
    const expr = this.expression();
    this.end();
    return expr;
  }

  expression(): Expr {
    return this.or();
  }

  or(): Expr {
    const first = this.and();
    const operands = [first];
    while (this.at('name', 'or')) {
      this.next();
      operands.push(this.and());
    }
    return operands.length === 1
      ? first
      : { kind: 'BoolOp', ...this.parser.base(), op: 'or', operands };
  }

  and(): Expr {
    const first = this.not();
    const operands = [first];
    while (this.at('name', 'and')) {
      this.next();
      operands.push(this.not());
    }
    return operands.length === 1
      ? first
      : { kind: 'BoolOp', ...this.parser.base(), op: 'and', operands };
  }

  not(): Expr {
    if (this.at('name', 'not')) {
      this.next();
      return { kind: 'UnaryOp', ...this.parser.base(), op: 'not', operand: this.not() };
    }
    return this.comparison();
  }

  /** The comparison operator at the cursor, without consuming it. */
  comparisonOp(): { op: string; width: number } | undefined {
    const token = this.peek();
    const after = this.peek(1);
    if (token?.kind === 'op' && isCompareOp(token.text)) return { op: token.text, width: 1 };
    if (token?.kind !== 'name') return undefined;
    if (token.text === 'in') return { op: 'in', width: 1 };
    if (token.text === 'not' && after?.kind === 'name' && after.text === 'in')
      return { op: 'not in', width: 2 };
    if (token.text === 'is') {
      return after?.kind === 'name' && after.text === 'not'
        ? { op: '!=', width: 2 }
        : { op: '==', width: 1 };
    }
    return undefined;
  }

  /**
   * A comparison, or a chain of them: \`0 <= i < n\` is \`0 <= i and i < n\`,
   * the IR's form for chains. The shared operand is parsed twice so each
   * comparison has its own nodes.
   */
  comparison(): Expr {
    let left = this.arithmetic();
    const parts: Expr[] = [];
    for (;;) {
      const found = this.comparisonOp();
      if (found === undefined) break;
      this.pos += found.width;
      const rightStart = this.pos;
      const right = this.arithmetic();
      parts.push(this.compare(found.op, left, right));
      if (this.comparisonOp() === undefined) break;
      left = new ExprParser(this.parser, this.tokens.slice(rightStart, this.pos), this.line).all();
    }
    const [only] = parts;
    if (only === undefined) return left;
    if (parts.length === 1) return only;
    return { kind: 'BoolOp', ...this.parser.base(), op: 'and', operands: parts };
  }

  compare(op: string, left: Expr, right: Expr): Expr {
    if (op === 'in' || op === 'not in') {
      return {
        kind: 'Membership',
        ...this.parser.base(),
        negated: op === 'not in',
        element: left,
        container: right,
      };
    }
    if (!isCompareOp(op)) throw lineError(this.line, `Unknown comparison "${op}"`);
    return { kind: 'Compare', ...this.parser.base(), op, left, right };
  }

  binary(operators: readonly ArithmeticOp[], operand: () => Expr): Expr {
    let left = operand();
    for (;;) {
      const token = this.peek();
      const op =
        token?.kind === 'op' && isArithmeticOp(token.text) && operators.includes(token.text)
          ? token.text
          : undefined;
      if (op === undefined) return left;
      this.next();
      left = { kind: 'BinOp', ...this.parser.base(), op, left, right: operand() };
    }
  }

  arithmetic(): Expr {
    return this.binary(['+', '-'], () => this.term());
  }

  term(): Expr {
    return this.binary(['*', '/', '//', '%'], () => this.factor());
  }

  factor(): Expr {
    if (!this.at('op', '-')) return this.power();
    this.next();
    const number = this.peek();
    // `-5` is a negative literal, unless something binds tighter to the 5:
    // `-5 ** 2` is -(5 ** 2) in Python, and `-5()` is -(5()).
    const after = this.peek(1);
    const bindsTighter = after?.kind === 'op' && ['**', '(', '[', '.'].includes(after.text);
    if (number?.kind === 'number' && !bindsTighter) {
      this.next();
      return this.annotations({
        kind: 'Literal',
        ...this.parser.base(),
        value: -Number(number.value),
      });
    }
    return { kind: 'UnaryOp', ...this.parser.base(), op: '-', operand: this.factor() };
  }

  power(): Expr {
    const base = this.postfix();
    if (!this.at('op', '**')) return base;
    this.next();
    return { kind: 'BinOp', ...this.parser.base(), op: '**', left: base, right: this.factor() };
  }

  /** Applies any `~rule` and `@a:b` annotations that follow. */
  annotations(node: Expr): Expr {
    while (this.at('infer') || this.at('span')) {
      const token = this.next();
      this.parser.annotate(
        node,
        token.kind === 'infer' ? `~${token.text}` : token.text,
        this.line,
        token.column,
      );
    }
    return node;
  }

  postfix(): Expr {
    let node = this.annotations(this.atom());
    for (;;) {
      if (this.at('op', '(')) {
        this.next();
        const args = this.list(')');
        node = this.call(node, args);
      } else if (this.at('op', '[')) {
        this.next();
        node = this.subscript(node);
      } else if (this.at('op', '.')) {
        this.next();
        const name = this.expect('name').text;
        node = { kind: 'Attribute', ...this.parser.base(), object: node, name };
      } else {
        return node;
      }
      node = this.annotations(node);
    }
  }

  /** Comma-separated expressions up to `close`, which is consumed. */
  list(close: string): Expr[] {
    const items: Expr[] = [];
    while (!this.at('op', close)) {
      items.push(this.expression());
      if (!this.at('op', close)) this.expect('op', ',');
    }
    this.next();
    return items;
  }

  /** A call, recognizing the forms the renderer writes for special nodes. */
  call(callee: Expr, args: Expr[]): Expr {
    const [arg] = args;
    if (callee.kind === 'Name' && args.length === 1 && arg?.kind === 'Literal') {
      if (callee.name === 'float' && (arg.value === 'inf' || arg.value === '-inf')) {
        return { kind: 'InfinityLiteral', ...this.parser.base(), negative: arg.value === '-inf' };
      }
      if (callee.name === '__hole__' && typeof arg.value === 'string') {
        return this.hole('', arg.value);
      }
    }
    if (callee.kind === 'Name' && callee.name === 'set' && args.length === 0) {
      return { kind: 'CollectionLiteral', ...this.parser.base(), collection: 'set', elements: [] };
    }
    return { kind: 'Call', ...this.parser.base(), callee, args };
  }

  subscript(object: Expr): Expr {
    const part = (): Expr | undefined =>
      this.at('op', ':') || this.at('op', ']') ? undefined : this.expression();
    const start = part();
    if (!this.at('op', ':')) {
      this.expect('op', ']');
      if (start === undefined) throw lineError(this.line, 'Expected an index');
      return { kind: 'Index', ...this.parser.base(), object, index: start };
    }
    this.next();
    const stop = part();
    let step: Expr | undefined;
    if (this.at('op', ':')) {
      this.next();
      step = part();
    }
    this.expect('op', ']');
    return {
      kind: 'Slice',
      ...this.parser.base(),
      object,
      ...(start === undefined ? {} : { start }),
      ...(stop === undefined ? {} : { stop }),
      ...(step === undefined ? {} : { step }),
    };
  }

  hole(kind: string, reason?: string, candidates: string[] = []): Expr {
    const base = this.parser.holeBase();
    const given = reason !== undefined;
    let node: Expr;
    switch (kind) {
      case 'cond':
        node = { kind: 'CondHole', ...base, reason: reason ?? HOLE_REASONS.condition };
        break;
      case 'name':
        node = { kind: 'NameHole', ...base, reason: reason ?? HOLE_REASONS.name };
        break;
      case 'ref':
        node = { kind: 'RefHole', ...base, reason: reason ?? 'which one is meant?', candidates };
        break;
      default:
        node = { kind: 'ExprHole', ...base, reason: reason ?? HOLE_REASONS.value };
        if (kind === '') this.parser.contextual.add(node);
        if (kind === '' && !given) this.parser.defaultReason.add(node);
    }
    return node;
  }

  atom(): Expr {
    const token = this.next();
    switch (token.kind) {
      case 'number':
        return { kind: 'Literal', ...this.parser.base(), value: Number(token.value) };
      case 'string':
        return { kind: 'Literal', ...this.parser.base(), value: String(token.value) };
      case 'hole': {
        const candidates: string[] = [];
        if (token.text === 'ref') {
          this.expect('op', '(');
          while (!this.at('op', ')')) {
            candidates.push(this.expect('name').text);
            if (!this.at('op', ')')) this.expect('op', ',');
          }
          this.next();
        }
        const reason = this.at('string') ? String(this.next().value) : undefined;
        return this.hole(token.text, reason, candidates);
      }
      case 'name':
        return this.name(token);
      case 'op':
        return this.bracketed(token);
      default:
        throw lineError(this.line, `Unexpected "${token.text}"`, token.column);
    }
  }

  name(token: Token): Expr {
    switch (token.text) {
      case 'True':
      case 'False':
        return { kind: 'Literal', ...this.parser.base(), value: token.text === 'True' };
      case 'None':
        return { kind: 'Literal', ...this.parser.base(), value: null };
      default:
        if (PLACEHOLDER_NAME.test(token.text)) {
          // A placeholder name from exported code; its reason is in the TODO comment.
          return {
            kind: 'NameHole',
            ...this.parser.holeBase(),
            reason: this.line.todos.shift() ?? HOLE_REASONS.name,
          };
        }
        return { kind: 'Name', ...this.parser.base(), name: token.text };
    }
  }

  bracketed(token: Token): Expr {
    if (token.text === '(') {
      if (this.at('op', ')')) {
        this.next();
        return {
          kind: 'CollectionLiteral',
          ...this.parser.base(),
          collection: 'tuple',
          elements: [],
        };
      }
      const first = this.expression();
      if (this.at('op', ')')) {
        this.next();
        return first;
      }
      this.expect('op', ',');
      const rest = this.list(')');
      return {
        kind: 'CollectionLiteral',
        ...this.parser.base(),
        collection: 'tuple',
        elements: [first, ...rest],
      };
    }
    if (token.text === '[') {
      return {
        kind: 'CollectionLiteral',
        ...this.parser.base(),
        collection: 'list',
        elements: this.list(']'),
      };
    }
    if (token.text === '{') {
      if (this.at('op', '}')) {
        this.next();
        return { kind: 'DictLiteral', ...this.parser.base(), entries: [] };
      }
      const first = this.expression();
      if (this.at('op', ':')) {
        const entries = [this.entry(first)];
        while (this.at('op', ',')) {
          this.next();
          if (this.at('op', '}')) break;
          entries.push(this.entry(this.expression()));
        }
        this.expect('op', '}');
        return { kind: 'DictLiteral', ...this.parser.base(), entries };
      }
      const elements = [first];
      if (this.at('op', ',')) {
        this.next();
        elements.push(...this.list('}'));
      } else {
        this.expect('op', '}');
      }
      return { kind: 'CollectionLiteral', ...this.parser.base(), collection: 'set', elements };
    }
    throw lineError(this.line, `Unexpected "${token.text}"`, token.column);
  }

  entry(key: Expr): DictEntry {
    this.expect('op', ':');
    const value = this.expression();
    return { kind: 'DictEntry', ...this.parser.base(), key, value };
  }
}

/** Parses one or more statements, with Python indentation for blocks. */
export function parseStatements(text: string, options: SnippetOptions): Stmt[] {
  const lines = readLines(text);
  const first = lines[0];
  if (first === undefined) throw new SnippetError('Expected a statement', 0);
  const parser = new Parser(options);
  const { stmts, next } = parser.block(lines, 0, first.indent);
  const stray = lines[next];
  if (stray !== undefined) throw lineError(stray, 'Unexpected dedent');
  return stmts;
}

/** Parses a single expression. A plain `?` becomes an expression hole. */
export function parseExpression(text: string, options: SnippetOptions): Expr {
  const lines = readLines(text);
  const [line, extra] = lines;
  if (line === undefined || extra !== undefined)
    throw new SnippetError('Expected one line with an expression', 0);
  const parser = new Parser(options);
  const expr = new ExprParser(parser, line.tokens, line).all();
  for (const word of line.annotations) parser.annotate(expr, word, line, 0);
  return expr;
}

/** Parses an expression for a condition (`?` becomes a condition hole). */
export function parseCondition(text: string, options: SnippetOptions): Expr {
  const parser = new Parser(options);
  const lines = readLines(text);
  const [line] = lines;
  if (line === undefined || lines.length !== 1)
    throw new SnippetError('Expected one line with a condition', 0);
  return parser.asCondition(new ExprParser(parser, line.tokens, line).all());
}
