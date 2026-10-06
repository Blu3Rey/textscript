// Golden cases: small programs that each exercise one rendering rule.
// Each case is rendered in both modes to test/golden/<name>.py (export) and
// test/golden/<name>.ui.txt (ui). Every case is also a valid IR document.

import { createBuilder, type Builder, type Expr, type Program, type Stmt } from '@textscript/core';
import { kitchenSink, said, workedExample } from '@textscript/core/testing';

export interface GoldenCase {
  name: string;
  build: (b: Builder) => Program;
}

const S = said(0);

/** Short constructors for writing cases compactly. */
function helpers(b: Builder) {
  return {
    n: (name: string) => b.name(name, S),
    lit: (value: string | number | boolean | null) => b.literal(value, S),
    blk: (...stmts: Stmt[]) => b.block(stmts),
    assign: (name: string, value: Expr) => b.assign({ target: b.name(name, S), value }, S),
    bin: (op: '+' | '-' | '*' | '/' | '//' | '%' | '**', left: Expr, right: Expr) =>
      b.binOp({ op, left, right }, S),
    show: (value: Expr) => b.exprStmt(value, S),
  };
}

function program(
  build: (b: Builder, h: ReturnType<typeof helpers>) => Stmt[],
): GoldenCase['build'] {
  return (b) => b.program(build(b, helpers(b)));
}

export const CASES: GoldenCase[] = [
  { name: 'empty-program', build: program(() => []) },

  {
    name: 'literals',
    build: program((_, h) => [
      h.assign('count', h.lit(0)),
      h.assign('ratio', h.lit(2.5)),
      h.assign('offset', h.lit(-3)),
      h.assign('greeting', h.lit('hi')),
      h.assign('found', h.lit(true)),
      h.assign('missing', h.lit(false)),
      h.assign('nothing', h.lit(null)),
    ]),
  },

  {
    name: 'numbers',
    build: program((_, h) => [
      h.assign('big', h.lit(123456789012)),
      h.assign('huge', h.lit(1e21)),
      h.assign('tiny', h.lit(1e-7)),
      h.assign('third', h.lit(1 / 3)),
    ]),
  },

  {
    name: 'string-escapes',
    build: program((_, h) => [
      h.assign('quote', h.lit('say "hi"')),
      h.assign('slash', h.lit('C:\\path')),
      h.assign('lines', h.lit('a\nb\r\tc')),
      h.assign('control', h.lit('nul\u0000bell\u0007del\u007f')),
      h.assign('unicode', h.lit('héllo ✓ 😀')),
      h.assign('lone', h.lit('half\ud800pair')),
    ]),
  },

  {
    name: 'keyword-names',
    build: program((b, h) => [
      h.assign('class', h.n('lambda')),
      h.show(b.attribute({ object: h.n('obj'), name: 'import' }, S)),
      h.assign('match', h.n('type')),
    ]),
  },

  {
    name: 'infinity',
    build: program((b, h) => [
      h.assign('best', b.infinity(false, S)),
      h.assign('worst', b.infinity(true, S)),
      h.assign('flipped', b.unaryOp({ op: '-', operand: b.infinity(false, S) }, S)),
    ]),
  },

  {
    name: 'collections',
    build: program((b, h) => [
      h.assign('empty_list', b.collection({ collection: 'list', elements: [] }, S)),
      h.assign(
        'pair_list',
        b.collection({ collection: 'list', elements: [h.lit(1), h.lit(2)] }, S),
      ),
      h.assign('empty_set', b.collection({ collection: 'set', elements: [] }, S)),
      h.assign('some_set', b.collection({ collection: 'set', elements: [h.n('a'), h.n('b')] }, S)),
      h.assign('empty_tuple', b.collection({ collection: 'tuple', elements: [] }, S)),
      h.assign('single', b.collection({ collection: 'tuple', elements: [h.n('a')] }, S)),
      h.assign('pair', b.collection({ collection: 'tuple', elements: [h.n('a'), h.n('b')] }, S)),
      h.assign('empty_dict', b.dict([], S)),
      h.assign(
        'mapping',
        b.dict(
          [
            b.dictEntry({ key: h.lit('a'), value: h.lit(1) }, S),
            b.dictEntry(
              { key: h.n('k'), value: b.collection({ collection: 'list', elements: [] }, S) },
              S,
            ),
          ],
          S,
        ),
      ),
    ]),
  },

  {
    name: 'precedence-arithmetic',
    build: program((_, h) => [
      h.show(h.bin('*', h.bin('+', h.n('a'), h.n('b')), h.n('c'))),
      h.show(h.bin('+', h.n('a'), h.bin('*', h.n('b'), h.n('c')))),
      h.show(h.bin('-', h.n('a'), h.bin('-', h.n('b'), h.n('c')))),
      h.show(h.bin('-', h.bin('-', h.n('a'), h.n('b')), h.n('c'))),
      h.show(h.bin('/', h.n('a'), h.bin('*', h.n('b'), h.n('c')))),
      h.show(h.bin('//', h.bin('%', h.n('a'), h.n('b')), h.n('c'))),
    ]),
  },

  {
    name: 'precedence-power',
    build: program((b, h) => [
      h.show(h.bin('**', h.lit(-2), h.lit(2))),
      h.show(h.bin('**', h.lit(2), b.unaryOp({ op: '-', operand: h.n('x') }, S))),
      h.show(h.bin('**', h.n('a'), h.bin('**', h.n('b'), h.n('c')))),
      h.show(h.bin('**', h.bin('**', h.n('a'), h.n('b')), h.n('c'))),
      h.show(b.unaryOp({ op: '-', operand: h.bin('**', h.n('x'), h.lit(2)) }, S)),
      h.show(h.bin('**', b.unaryOp({ op: '-', operand: h.n('x') }, S), h.lit(2))),
    ]),
  },

  {
    name: 'precedence-unary',
    build: program((b, h) => [
      h.show(b.unaryOp({ op: '-', operand: h.bin('+', h.n('a'), h.n('b')) }, S)),
      h.show(b.unaryOp({ op: '-', operand: b.unaryOp({ op: '-', operand: h.n('x') }, S) }, S)),
      h.show(b.unaryOp({ op: '-', operand: h.lit(-5) }, S)),
      h.show(
        b.unaryOp(
          { op: 'not', operand: b.boolOp({ op: 'and', operands: [h.n('a'), h.n('b')] }, S) },
          S,
        ),
      ),
      h.show(
        b.unaryOp(
          { op: 'not', operand: b.compare({ op: '==', left: h.n('a'), right: h.n('b') }, S) },
          S,
        ),
      ),
      h.show(
        b.compare(
          { op: '==', left: h.n('a'), right: b.unaryOp({ op: 'not', operand: h.n('b') }, S) },
          S,
        ),
      ),
    ]),
  },

  {
    name: 'precedence-boolean',
    build: program((b, h) => {
      const and = (...operands: Expr[]) => b.boolOp({ op: 'and', operands }, S);
      const or = (...operands: Expr[]) => b.boolOp({ op: 'or', operands }, S);
      return [
        h.show(or(and(h.n('a'), h.n('b')), h.n('c'))),
        h.show(and(h.n('a'), or(h.n('b'), h.n('c')))),
        h.show(and(and(h.n('a'), h.n('b')), h.n('c'))),
        h.show(or(b.unaryOp({ op: 'not', operand: h.n('a') }, S), h.n('b'))),
        h.show(and(h.n('a'), h.n('b'), h.n('c'))),
      ];
    }),
  },

  {
    name: 'comparisons',
    build: program((b, h) => {
      const cmp = (op: '<' | '==' | '>=', left: Expr, right: Expr) =>
        b.compare({ op, left, right }, S);
      return [
        h.show(cmp('<', cmp('<', h.n('a'), h.n('b')), h.n('c'))),
        h.show(
          b.boolOp(
            { op: 'and', operands: [cmp('<', h.n('a'), h.n('b')), cmp('<', h.n('b'), h.n('c'))] },
            S,
          ),
        ),
        h.show(cmp('>=', h.bin('+', h.n('a'), h.n('b')), h.lit(0))),
        h.show(cmp('==', h.n('x'), h.lit(null))),
        h.show(b.compare({ op: '!=', left: h.lit(null), right: h.n('y') }, S)),
        h.show(b.membership({ element: h.n('x'), container: h.n('seen'), negated: true }, S)),
        h.show(
          b.membership(
            {
              element: h.n('x'),
              container: b.boolOp({ op: 'or', operands: [h.n('a'), h.n('b')] }, S),
            },
            S,
          ),
        ),
        h.show(cmp('==', b.membership({ element: h.n('x'), container: h.n('s') }, S), h.lit(true))),
      ];
    }),
  },

  {
    name: 'postfix',
    build: program((b, h) => [
      h.show(b.index({ object: h.bin('+', h.n('a'), h.n('b')), index: h.lit(0) }, S)),
      h.show(
        b.call({ callee: b.call({ callee: h.n('f'), args: [h.n('x')] }, S), args: [h.n('y')] }, S),
      ),
      h.show(
        b.attribute(
          { object: b.boolOp({ op: 'or', operands: [h.n('a'), h.n('b')] }, S), name: 'items' },
          S,
        ),
      ),
      h.show(b.attribute({ object: h.lit(1), name: 'real' }, S)),
      h.show(b.attribute({ object: h.lit(-1.5), name: 'real' }, S)),
      h.show(
        b.call(
          { callee: b.attribute({ object: h.lit(''), name: 'join' }, S), args: [h.n('parts')] },
          S,
        ),
      ),
      h.show(
        b.index(
          {
            object: h.n('grid'),
            index: b.collection({ collection: 'tuple', elements: [h.n('r'), h.n('c')] }, S),
          },
          S,
        ),
      ),
    ]),
  },

  {
    name: 'slices',
    build: program((b, h) => {
      const s = h.n('s');
      return [
        h.show(b.slice({ object: s, start: h.lit(1) }, S)),
        h.show(b.slice({ object: h.n('s'), stop: h.lit(-1) }, S)),
        h.show(b.slice({ object: h.n('s'), step: h.lit(2) }, S)),
        h.show(b.slice({ object: h.n('s') }, S)),
        h.show(
          b.slice({ object: h.n('s'), start: h.n('i'), stop: h.bin('+', h.n('j'), h.lit(1)) }, S),
        ),
        h.show(b.slice({ object: h.n('s'), step: h.lit(-1) }, S)),
      ];
    }),
  },

  {
    name: 'calls',
    build: program((b, h) => [
      h.show(b.call({ callee: h.n('print'), args: [] }, S)),
      h.show(
        b.call(
          { callee: h.n('max'), args: [h.n('best'), h.bin('-', h.n('price'), h.n('low'))] },
          S,
        ),
      ),
      h.show(
        b.call(
          { callee: b.attribute({ object: h.n('line'), name: 'split' }, S), args: [h.lit(',')] },
          S,
        ),
      ),
    ]),
  },

  {
    name: 'assign-targets',
    build: program((b, h) => [
      b.assign(
        { target: b.index({ object: h.n('counts'), index: h.n('key') }, S), value: h.lit(0) },
        S,
      ),
      b.assign(
        { target: b.attribute({ object: h.n('node'), name: 'next' }, S), value: h.lit(null) },
        S,
      ),
      b.assign(
        {
          target: b.index(
            { object: b.index({ object: h.n('grid'), index: h.n('r') }, S), index: h.n('c') },
            S,
          ),
          value: h.lit('#'),
        },
        S,
      ),
    ]),
  },

  {
    name: 'update-augmented',
    build: program((b, h) =>
      (['+=', '-=', '*=', '/=', '//=', '%='] as const).map((op) =>
        b.update({ target: h.n('total'), op, value: h.n('x') }, S),
      ),
    ),
  },

  {
    name: 'update-methods',
    build: program((b, h) =>
      (['append', 'extend', 'add', 'remove', 'discard'] as const).map((op) =>
        b.update({ target: h.n('items'), op, value: h.n('x') }, S),
      ),
    ),
  },

  {
    name: 'update-targets',
    build: program((b, h) => [
      b.update(
        {
          target: b.index({ object: h.n('counts'), index: h.n('key') }, S),
          op: '+=',
          value: h.lit(1),
        },
        S,
      ),
      b.update(
        {
          target: b.attribute({ object: h.n('self'), name: 'total' }, S),
          op: '-=',
          value: h.n('x'),
        },
        S,
      ),
      b.update(
        {
          target: b.index({ object: h.n('graph'), index: h.n('u') }, S),
          op: 'append',
          value: h.n('v'),
        },
        S,
      ),
    ]),
  },

  {
    name: 'return-forms',
    build: program((b, h) => [
      b.functionDef(
        {
          name: h.n('f'),
          params: [h.n('a'), h.n('b')],
          body: h.blk(
            b.if({ cond: h.n('a'), body: h.blk(b.return(undefined, S)) }, S),
            b.if({ cond: h.n('b'), body: h.blk(b.return(h.n('a'), S)) }, S),
            b.return(b.collection({ collection: 'tuple', elements: [h.n('a'), h.n('b')] }, S), S),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'for-each',
    build: program((b, h) => [
      b.forEach(
        {
          target: h.n('num'),
          iterable: h.n('nums'),
          body: h.blk(b.update({ target: h.n('total'), op: '+=', value: h.n('num') }, S)),
        },
        S,
      ),
    ]),
  },

  {
    name: 'for-range-stop',
    build: program((b, h) => [
      b.forRange({ target: h.n('i'), stop: h.n('n'), body: h.blk(h.show(h.n('i'))) }, S),
    ]),
  },

  {
    name: 'for-range-start-stop',
    build: program((b, h) => [
      b.forRange(
        { target: h.n('i'), start: h.lit(1), stop: h.n('n'), body: h.blk(h.show(h.n('i'))) },
        S,
      ),
    ]),
  },

  {
    name: 'for-range-step-without-start',
    build: program((b, h) => [
      b.forRange(
        { target: h.n('i'), stop: h.n('n'), step: h.lit(2), body: h.blk(h.show(h.n('i'))) },
        S,
      ),
    ]),
  },

  {
    name: 'for-range-backwards',
    build: program((b, h) => [
      b.forRange(
        {
          target: h.n('i'),
          start: h.bin('-', b.call({ callee: h.n('len'), args: [h.n('nums')] }, S), h.lit(1)),
          stop: h.lit(-1),
          step: h.lit(-1),
          body: h.blk(h.show(b.index({ object: h.n('nums'), index: h.n('i') }, S))),
        },
        S,
      ),
    ]),
  },

  {
    name: 'while-break-continue',
    build: program((b, h) => [
      b.while(
        {
          cond: b.compare({ op: '<', left: h.n('lo'), right: h.n('hi') }, S),
          body: h.blk(
            b.if({ cond: h.n('done'), body: h.blk(b.break(S)) }, S),
            b.if({ cond: h.n('skip'), body: h.blk(b.continue(S)) }, S),
            b.update({ target: h.n('lo'), op: '+=', value: h.lit(1) }, S),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'if-elif-else',
    build: program((b, h) => [
      b.if(
        {
          cond: b.compare({ op: '<', left: h.n('x'), right: h.lit(0) }, S),
          body: h.blk(h.assign('sign', h.lit(-1))),
          elifs: [
            b.elif(
              {
                cond: b.compare({ op: '==', left: h.n('x'), right: h.lit(0) }, S),
                body: h.blk(h.assign('sign', h.lit(0))),
              },
              S,
            ),
            b.elif({ cond: h.n('tiny'), body: h.blk(h.assign('sign', h.lit(0))) }, S),
          ],
          orelse: h.blk(h.assign('sign', h.lit(1))),
        },
        S,
      ),
    ]),
  },

  {
    name: 'if-only',
    build: program((b, h) => [
      b.if(
        { cond: h.n('ready'), body: h.blk(h.show(b.call({ callee: h.n('go'), args: [] }, S))) },
        S,
      ),
    ]),
  },

  {
    name: 'function-spacing-top-level',
    build: program((b, h) => [
      h.assign('limit', h.lit(10)),
      b.functionDef({ name: h.n('first'), params: [], body: h.blk(b.return(h.n('limit'), S)) }, S),
      b.functionDef(
        { name: h.n('second'), params: [h.n('x')], body: h.blk(b.return(h.n('x'), S)) },
        S,
      ),
      h.show(
        b.call({ callee: h.n('second'), args: [b.call({ callee: h.n('first'), args: [] }, S)] }, S),
      ),
    ]),
  },

  {
    name: 'function-spacing-nested',
    build: program((b, h) => [
      b.functionDef(
        {
          name: h.n('outer'),
          params: [],
          body: h.blk(
            h.assign('count', h.lit(0)),
            b.functionDef(
              { name: h.n('inner'), params: [], body: h.blk(b.return(h.n('count'), S)) },
              S,
            ),
            b.return(h.n('inner'), S),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'expression-statements',
    build: program((b, h) => [
      h.show(b.call({ callee: h.n('helper'), args: [h.n('a'), h.n('b')] }, S)),
      h.show(h.n('x')),
      h.show(b.exprHole('something happens here')),
    ]),
  },

  {
    name: 'holes-in-expressions',
    build: program((b, h) => [
      h.assign('total', b.exprHole('the starting total')),
      b.if(
        {
          cond: b.condHole('the number is valid'),
          body: h.blk(h.show(b.call({ callee: h.n('use'), args: [b.nameHole('which list?')] }, S))),
        },
        S,
      ),
      h.show(b.refHole('nums or seen?', ['n1', 'n2'])),
      h.show(h.bin('+', b.exprHole('a value'), h.lit(1))),
      h.show(b.attribute({ object: b.nameHole('the map'), name: 'keys' }, S)),
    ]),
  },

  {
    name: 'holes-in-bindings',
    build: program((b, h) => [
      b.functionDef(
        {
          name: b.nameHole('function name not given'),
          params: [h.n('nums'), b.nameHole('second input not named')],
          body: h.blk(
            b.forEach(
              {
                target: b.nameHole('loop variable not named'),
                iterable: h.n('nums'),
                body: h.blk(b.blockHole('loop body not described')),
              },
              S,
            ),
            b.assign({ target: b.nameHole('where the result goes'), value: h.lit(0) }, S),
            b.update({ target: b.nameHole('which counter?'), op: '+=', value: h.lit(1) }, S),
            b.update(
              { target: b.nameHole('which list?'), op: 'append', value: b.exprHole('what to add') },
              S,
            ),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'block-holes',
    build: program((b, h) => [
      b.while({ cond: h.n('running'), body: h.blk(b.blockHole('loop body not described')) }, S),
      b.if(
        {
          cond: h.n('x'),
          body: h.blk(h.show(h.n('x'))),
          orelse: h.blk(b.blockHole('else branch not described')),
        },
        S,
      ),
    ]),
  },

  {
    name: 'intent-statements',
    build: program((b, h) => [
      b.forEach(
        {
          target: h.n('item'),
          iterable: h.n('items'),
          body: h.blk(
            b.intent('process the element here', S),
            b.intent('then update the running best', S),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'hole-text-escaping',
    build: program((b, h) => [
      h.assign('x', b.exprHole('the "right" value\\maybe')),
      b.while({ cond: h.n('x'), body: h.blk(b.blockHole('multi\nline\u0000reason')) }, S),
      b.assign({ target: b.nameHole('name # with hash'), value: h.lit(1) }, S),
    ]),
  },

  {
    name: 'notes-on-statements',
    build: program((b, h) => [
      h.assign('seen', b.collection({ collection: 'set', elements: [] }, S)),
      b.forEach(
        { target: h.n('num'), iterable: h.n('nums'), body: h.blk(h.show(h.n('num'))) },
        {
          ...S,
          notes: [
            b.note('one pass over the input', 'general', S.provenance ?? []),
            b.note('this is O(n)', 'complexity', S.provenance ?? []),
            b.note('an empty list never enters the loop', 'edge-case', S.provenance ?? []),
          ],
        },
      ),
    ]),
  },

  {
    name: 'notes-hoisted',
    build: program((b, h) => {
      const note = (text: string) => [b.note(text, 'general', S.provenance ?? [])];
      return [
        h.assign(
          'total',
          h.bin('+', h.n('a'), b.literal(1, { ...S, notes: note('plus one for the header') })),
        ),
        b.if(
          {
            cond: b.name('ready', { ...S, notes: note('ready means all inputs arrived') }),
            body: b.block([h.show(h.n('go'))], { notes: note('the happy path') }),
            elifs: [
              b.elif(
                { cond: h.n('retry'), body: h.blk(h.show(h.n('wait'))) },
                { ...S, notes: note('second chance') },
              ),
            ],
            orelse: b.block([h.show(h.n('stop'))], { notes: note('give up') }),
          },
          S,
        ),
      ];
    }),
  },

  {
    name: 'notes-on-program',
    build: (b) => {
      const h = helpers(b);
      return b.program([h.assign('x', h.lit(1))], {
        notes: [
          b.note('overall this is linear', 'complexity', S.provenance ?? []),
          b.note('assumes the input is sorted', 'edge-case', S.provenance ?? []),
        ],
      });
    },
  },

  {
    name: 'notes-sanitized',
    build: program((b, h) => [
      b.return(h.n('x'), {
        ...S,
        notes: [b.note('first line\nsecond\u0000line\ttab', 'general', S.provenance ?? [])],
      }),
    ]),
  },

  {
    name: 'two-sum',
    build: program((b, h) => [
      b.functionDef(
        {
          name: h.n('two_sum'),
          params: [h.n('nums'), h.n('target')],
          body: h.blk(
            h.assign('seen', b.dict([], S)),
            b.forRange(
              {
                target: h.n('i'),
                stop: b.call({ callee: h.n('len'), args: [h.n('nums')] }, S),
                body: h.blk(
                  h.assign(
                    'complement',
                    h.bin('-', h.n('target'), b.index({ object: h.n('nums'), index: h.n('i') }, S)),
                  ),
                  b.if(
                    {
                      cond: b.membership({ element: h.n('complement'), container: h.n('seen') }, S),
                      body: h.blk(
                        b.return(
                          b.collection(
                            {
                              collection: 'list',
                              elements: [
                                b.index({ object: h.n('seen'), index: h.n('complement') }, S),
                                h.n('i'),
                              ],
                            },
                            S,
                          ),
                          S,
                        ),
                      ),
                    },
                    S,
                  ),
                  b.assign(
                    {
                      target: b.index(
                        {
                          object: h.n('seen'),
                          index: b.index({ object: h.n('nums'), index: h.n('i') }, S),
                        },
                        S,
                      ),
                      value: h.n('i'),
                    },
                    S,
                  ),
                ),
              },
              S,
            ),
            b.return(b.exprHole('what to return when no pair exists'), S),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'nested-blocks',
    build: program((b, h) => [
      b.functionDef(
        {
          name: h.n('contains_duplicate'),
          params: [h.n('nums')],
          body: h.blk(
            h.assign('seen', b.collection({ collection: 'set', elements: [] }, S)),
            b.forEach(
              {
                target: h.n('num'),
                iterable: h.n('nums'),
                body: h.blk(
                  b.if(
                    {
                      cond: b.membership({ element: h.n('num'), container: h.n('seen') }, S),
                      body: h.blk(b.return(h.lit(true), S)),
                    },
                    S,
                  ),
                  b.update({ target: h.n('seen'), op: 'add', value: h.n('num') }, S),
                ),
              },
              S,
            ),
            b.return(h.lit(false), S),
          ),
        },
        S,
      ),
    ]),
  },

  {
    name: 'labels-and-inference-not-rendered',
    build: program((b, h) => [
      b.forEach(
        {
          target: b.name('num', { inferred: 'INF-LOOPVAR' }),
          iterable: h.n('nums'),
          body: h.blk(
            b.update(
              { target: h.n('seen'), op: 'add', value: h.n('num') },
              { ...S, inferred: 'INF-SYNONYM' },
            ),
          ),
        },
        { ...S, label: 'main loop' },
      ),
    ]),
  },

  { name: 'worked-example', build: (b) => workedExample(b).program },

  { name: 'kitchen-sink', build: (b) => kitchenSink(b).program },
];

/** Builds a case with a fresh builder, as the golden tests do. */
export function buildCase(c: GoldenCase): Program {
  return c.build(createBuilder());
}
