// Renders the IR to Python (docs/adr/007).
//
// Output is deterministic: the same program always gives the same bytes, and
// changing one node only changes the lines that node is on. Parentheses are
// added only where Python's precedence requires them.

import {
  walk,
  type Binding,
  type Block,
  type Expr,
  type IrNode,
  type Note,
  type Program,
  type Stmt,
  type Target,
  type UpdateOp,
} from '@textscript/core';
import type { RenderMode, RenderResult } from './output';
import { commentText, pythonName, pythonNumber, pythonString } from './python';
import { Writer } from './writer';

// Python operator precedence, lowest to highest.
const OR = 3;
const AND = 4;
const NOT = 5;
const COMPARE = 6;
/** Operands of a comparison must bind tighter, or Python would chain them. */
const ABOVE_COMPARE = 7;
const ADD = 11;
const MUL = 12;
const UNARY = 13;
const POWER = 14;
const POSTFIX = 16;
const ATOM = 17;
/** Forces parentheses whatever the child's precedence. */
const ALWAYS = ATOM + 1;

const BINARY_PRECEDENCE = {
  '+': ADD,
  '-': ADD,
  '*': MUL,
  '/': MUL,
  '//': MUL,
  '%': MUL,
  '**': POWER,
} as const;

const AUGMENTED: ReadonlySet<UpdateOp> = new Set(['+=', '-=', '*=', '/=', '//=', '%=']);

const NOTE_PREFIX = {
  general: '',
  'edge-case': 'Edge case: ',
  complexity: 'Complexity: ',
} as const;

function precedence(expr: Expr): number {
  switch (expr.kind) {
    case 'Literal':
      return typeof expr.value === 'number' && (expr.value < 0 || Object.is(expr.value, -0))
        ? UNARY
        : ATOM;
    case 'UnaryOp':
      return expr.op === 'not' ? NOT : UNARY;
    case 'BinOp':
      return BINARY_PRECEDENCE[expr.op];
    case 'Compare':
    case 'Membership':
      return COMPARE;
    case 'BoolOp':
      return expr.op === 'and' ? AND : OR;
    case 'Call':
    case 'Index':
    case 'Slice':
    case 'Attribute':
    case 'InfinityLiteral':
    case 'ExprHole':
    case 'CondHole':
    case 'NameHole':
    case 'RefHole':
      return POSTFIX;
    case 'Name':
    case 'CollectionLiteral':
    case 'DictLiteral':
      return ATOM;
  }
}

function isNone(expr: Expr): boolean {
  return expr.kind === 'Literal' && expr.value === null;
}

function startsWithMinus(expr: Expr): boolean {
  return (
    (expr.kind === 'UnaryOp' && expr.op === '-') ||
    (expr.kind === 'Literal' && typeof expr.value === 'number' && precedence(expr) === UNARY)
  );
}

/** Notes on a node and on everything rendered on its header line(s). */
function headerNotes(node: IrNode): Note[] {
  const notes: Note[] = [];
  walk(node, (child) => {
    if (child !== node && (child.kind === 'Block' || child.kind === 'Elif')) return false;
    notes.push(...(child.notes ?? []));
    return true;
  });
  return notes;
}

export interface RenderOptions {
  /** Defaults to `export`. */
  mode?: RenderMode;
  /**
   * `minimal` (the default) adds parentheses only where precedence needs
   * them. `all` wraps every compound expression; its structure is obvious,
   * so tests compare the two renderings' Python ASTs to verify precedence.
   */
  parentheses?: 'minimal' | 'all';
}

/** Renders a program to Python source with a source map. */
export function render(program: Program, options: RenderOptions = {}): RenderResult {
  const mode = options.mode ?? 'export';
  const parenthesizeAll = options.parentheses === 'all';
  const w = new Writer();

  const punct = (text: string) => {
    w.token('punctuation', text);
  };
  const space = () => {
    w.token('space', ' ');
  };
  const keyword = (text: string) => {
    w.token('keyword', text);
  };

  const comment = (note: Note) => {
    w.open(note.id, true);
    w.token('comment', `# ${NOTE_PREFIX[note.tag]}${commentText(note.text)}`);
    w.close();
    w.newline();
  };

  const uiHole = (text: string) => {
    w.token('hole', `⟨${commentText(text)}⟩`);
  };

  // Expressions --------------------------------------------------------------

  const list = (items: readonly Expr[]) => {
    items.forEach((item, i) => {
      if (i > 0) {
        punct(',');
        space();
      }
      expr(item, 0);
    });
  };

  /** Renders `e`, parenthesized if it binds looser than `minPrecedence`. */
  const expr = (e: Expr, minPrecedence: number) => {
    const parens = precedence(e) < minPrecedence || (parenthesizeAll && precedence(e) < ATOM);
    if (parens) punct('(');
    w.node(e.id, () => {
      exprBody(e);
    });
    if (parens) punct(')');
  };

  const exprBody = (e: Expr) => {
    switch (e.kind) {
      case 'Name':
        w.token('name', pythonName(e.name));
        return;
      case 'Literal':
        if (typeof e.value === 'string') w.token('string', pythonString(e.value));
        else if (typeof e.value === 'number') w.token('number', pythonNumber(e.value));
        else if (typeof e.value === 'boolean') w.token('constant', e.value ? 'True' : 'False');
        else w.token('constant', 'None');
        return;
      case 'InfinityLiteral':
        w.token('name', 'float');
        punct('(');
        w.token('string', e.negative ? '"-inf"' : '"inf"');
        punct(')');
        return;
      case 'UnaryOp':
        if (e.op === 'not') {
          keyword('not');
          space();
          expr(e.operand, NOT);
        } else {
          w.token('operator', '-');
          // `--x` reads like a decrement, so a nested minus gets parentheses.
          expr(e.operand, startsWithMinus(e.operand) ? ALWAYS : UNARY);
        }
        return;
      case 'BinOp': {
        const own = BINARY_PRECEDENCE[e.op];
        // `**` is right-associative and its right side may be unary (`2 ** -x`).
        const [leftMin, rightMin] = e.op === '**' ? [POWER + 1, UNARY] : [own, own + 1];
        expr(e.left, leftMin);
        space();
        w.token('operator', e.op);
        space();
        expr(e.right, rightMin);
        return;
      }
      case 'Compare':
        expr(e.left, ABOVE_COMPARE);
        space();
        if ((e.op === '==' || e.op === '!=') && (isNone(e.left) || isNone(e.right))) {
          // Python's idiom for the same comparison (PEP 8): `x is None`.
          keyword('is');
          if (e.op === '!=') {
            space();
            keyword('not');
          }
        } else {
          w.token('operator', e.op);
        }
        space();
        expr(e.right, ABOVE_COMPARE);
        return;
      case 'Membership':
        expr(e.element, ABOVE_COMPARE);
        space();
        if (e.negated) {
          keyword('not');
          space();
        }
        keyword('in');
        space();
        expr(e.container, ABOVE_COMPARE);
        return;
      case 'BoolOp':
        e.operands.forEach((operand, i) => {
          if (i > 0) {
            space();
            keyword(e.op);
            space();
          }
          // Nested BoolOps keep their parentheses, so the tree stays visible.
          expr(operand, e.op === 'and' ? NOT : AND);
        });
        return;
      case 'Call':
        expr(e.callee, POSTFIX);
        punct('(');
        list(e.args);
        punct(')');
        return;
      case 'Index':
        expr(e.object, POSTFIX);
        punct('[');
        expr(e.index, 0);
        punct(']');
        return;
      case 'Slice':
        expr(e.object, POSTFIX);
        punct('[');
        if (e.start !== undefined) expr(e.start, 0);
        punct(':');
        if (e.stop !== undefined) expr(e.stop, 0);
        if (e.step !== undefined) {
          punct(':');
          expr(e.step, 0);
        }
        punct(']');
        return;
      case 'Attribute':
        // `1.real` is a syntax error; `(1).real` is not.
        expr(
          e.object,
          e.object.kind === 'Literal' && typeof e.object.value === 'number' ? ALWAYS : POSTFIX,
        );
        punct('.');
        w.token('name', pythonName(e.name));
        return;
      case 'CollectionLiteral':
        if (e.collection === 'set' && e.elements.length === 0) {
          w.token('name', 'set');
          punct('(');
          punct(')');
          return;
        }
        punct(e.collection === 'list' ? '[' : e.collection === 'set' ? '{' : '(');
        list(e.elements);
        if (e.collection === 'tuple' && e.elements.length === 1) punct(',');
        punct(e.collection === 'list' ? ']' : e.collection === 'set' ? '}' : ')');
        return;
      case 'DictLiteral':
        punct('{');
        e.entries.forEach((entry, i) => {
          if (i > 0) {
            punct(',');
            space();
          }
          w.node(entry.id, () => {
            expr(entry.key, 0);
            punct(':');
            space();
            expr(entry.value, 0);
          });
        });
        punct('}');
        return;
      case 'ExprHole':
      case 'CondHole':
      case 'NameHole':
      case 'RefHole':
        if (mode === 'ui') uiHole(e.reason);
        else w.token('hole', `__hole__(${pythonString(e.reason)})`);
        return;
    }
  };

  /**
   * Renders a name being bound or assigned. A hole here can't be a call
   * (`__hole__("x") = 1` doesn't parse), so it becomes a placeholder name
   * with a TODO comment at the end of the line.
   */
  const binding = (target: Binding | Target) => {
    if (target.kind !== 'NameHole') {
      expr(target, 0);
      return;
    }
    w.node(target.id, () => {
      if (mode === 'ui') {
        uiHole(target.reason);
      } else {
        w.token('hole', `__hole_${target.id}__`);
        w.todo(commentText(target.reason));
      }
    });
  };

  // Statements ---------------------------------------------------------------

  /** Blank lines between two statements: PEP 8 spacing around functions. */
  const blankLinesBetween = (previous: Stmt, next: Stmt) =>
    previous.kind === 'FunctionDef' || next.kind === 'FunctionDef' ? (w.depth === 0 ? 2 : 1) : 0;

  const statements = (stmts: readonly Stmt[]) => {
    stmts.forEach((s, i) => {
      const previous = stmts[i - 1];
      if (previous !== undefined) {
        for (let n = blankLinesBetween(previous, s); n > 0; n -= 1) w.blankLine();
      }
      stmt(s);
    });
  };

  const block = (b: Block) => {
    w.indent();
    w.node(b.id, () => {
      for (const note of b.notes ?? []) comment(note);
      statements(b.stmts);
    });
    w.dedent();
  };

  /** Ends a compound statement's header line and renders its block. */
  const suite = (body: Block) => {
    punct(':');
    w.newline();
    block(body);
  };

  const stmt = (s: Stmt) => {
    for (const note of headerNotes(s)) comment(note);
    w.node(s.id, () => {
      stmtBody(s);
    });
  };

  const stmtBody = (s: Stmt) => {
    switch (s.kind) {
      case 'FunctionDef':
        keyword('def');
        space();
        binding(s.name);
        punct('(');
        s.params.forEach((param, i) => {
          if (i > 0) {
            punct(',');
            space();
          }
          binding(param);
        });
        punct(')');
        suite(s.body);
        return;
      case 'ForEach':
        keyword('for');
        space();
        binding(s.target);
        space();
        keyword('in');
        space();
        expr(s.iterable, 0);
        suite(s.body);
        return;
      case 'ForRange':
        keyword('for');
        space();
        binding(s.target);
        space();
        keyword('in');
        space();
        w.token('name', 'range');
        punct('(');
        if (s.start !== undefined || s.step !== undefined) {
          // range() needs a start before a step; 0 is Python's own default,
          // not something the user left out.
          if (s.start === undefined) w.token('number', '0');
          else expr(s.start, 0);
          punct(',');
          space();
        }
        expr(s.stop, 0);
        if (s.step !== undefined) {
          punct(',');
          space();
          expr(s.step, 0);
        }
        punct(')');
        suite(s.body);
        return;
      case 'While':
        keyword('while');
        space();
        expr(s.cond, 0);
        suite(s.body);
        return;
      case 'If':
        keyword('if');
        space();
        expr(s.cond, 0);
        suite(s.body);
        for (const elif of s.elifs) {
          for (const note of headerNotes(elif)) comment(note);
          w.node(elif.id, () => {
            keyword('elif');
            space();
            expr(elif.cond, 0);
            suite(elif.body);
          });
        }
        if (s.orelse !== undefined) {
          keyword('else');
          suite(s.orelse);
        }
        return;
      case 'Assign':
        binding(s.target);
        space();
        w.token('operator', '=');
        space();
        expr(s.value, 0);
        w.newline();
        return;
      case 'Update':
        binding(s.target);
        if (AUGMENTED.has(s.op)) {
          space();
          w.token('operator', s.op);
          space();
          expr(s.value, 0);
        } else {
          punct('.');
          w.token('name', s.op);
          punct('(');
          expr(s.value, 0);
          punct(')');
        }
        w.newline();
        return;
      case 'Return':
        keyword('return');
        if (s.value !== undefined) {
          space();
          expr(s.value, 0);
        }
        w.newline();
        return;
      case 'Break':
      case 'Continue':
        keyword(s.kind === 'Break' ? 'break' : 'continue');
        w.newline();
        return;
      case 'ExprStmt':
        expr(s.expr, 0);
        w.newline();
        return;
      case 'IntentStmt':
        if (mode === 'ui') {
          uiHole(s.text);
        } else {
          w.token('comment', `# ${commentText(s.text)}`);
          w.newline();
          w.token('hole', '...');
        }
        w.newline();
        return;
      case 'BlockHole':
        if (mode === 'ui') {
          uiHole(s.reason);
        } else {
          w.token('hole', '...');
          w.todo(commentText(s.reason));
        }
        w.newline();
        return;
    }
  };

  w.open(program.id);
  for (const note of program.notes ?? []) comment(note);
  statements(program.body);
  w.close();

  const text = w.text();
  const nodes = new Map(w.nodeRanges);
  // The program spans the whole text, including leading comments and blank lines.
  nodes.set(program.id, {
    start: { line: 0, column: 0, offset: 0 },
    end: { line: w.lines.length, column: 0, offset: text.length },
  });
  return { mode, text, lines: w.lines, sourceMap: { nodes, notes: w.noteRanges } };
}
