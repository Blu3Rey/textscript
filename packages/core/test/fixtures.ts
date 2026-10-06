import { createBuilder, type Builder, type IrDocument, type MetaInput, type Span } from '../src';

/** A span in utterance `u` covering tokens `start` to `end` (exclusive). */
export function at(start: number, end = start + 1, u = 'u1'): Span {
  return { utteranceId: u, start, end };
}

/** Metadata for a node that came from the given tokens. */
export function said(start: number, end = start + 1, u = 'u1'): MetaInput {
  return { provenance: [at(start, end, u)] };
}

/**
 * A valid document containing at least one node of every kind, plus labels,
 * notes and inference rules. Not meaningful code; it exists so per-kind tests
 * have a real node of each kind in a valid context.
 */
export function kitchenSink(b: Builder = createBuilder()): IrDocument {
  const numsParam = b.name('nums', said(4));
  const seenTarget = b.name('seen', said(6));

  const fn = b.functionDef(
    {
      name: b.name('contains_duplicate', said(1, 3)),
      params: [numsParam],
      body: b.block([
        b.assign(
          { target: seenTarget, value: b.collection({ collection: 'set', elements: [] }, said(5)) },
          said(5, 7),
        ),
        b.assign(
          { target: b.name('best', said(8)), value: b.infinity(true, said(9, 11)) },
          said(8, 11),
        ),
        b.assign(
          {
            target: b.name('counts', said(12)),
            value: b.dict(
              [
                b.dictEntry(
                  { key: b.literal('first', said(13)), value: b.literal(0, said(14)) },
                  said(13, 15),
                ),
              ],
              said(12, 15),
            ),
          },
          said(12, 15),
        ),
        b.forEach(
          {
            target: b.name('num', { inferred: 'INF-LOOPVAR' }),
            iterable: b.name('nums', said(0, 3, 'u2')),
            body: b.block([
              b.if(
                {
                  cond: b.boolOp(
                    {
                      op: 'and',
                      operands: [
                        b.membership(
                          {
                            element: b.name('num', said(3, 4, 'u3')),
                            container: b.name('seen', said(5, 6, 'u3')),
                          },
                          said(1, 6, 'u3'),
                        ),
                        b.unaryOp(
                          { op: 'not', operand: b.name('done', said(8, 9, 'u3')) },
                          said(7, 9, 'u3'),
                        ),
                      ],
                    },
                    said(1, 9, 'u3'),
                  ),
                  body: b.block([
                    b.return(b.literal(true, said(11, 12, 'u3')), said(10, 12, 'u3')),
                  ]),
                  elifs: [
                    b.elif(
                      {
                        cond: b.compare(
                          {
                            op: '==',
                            left: b.name('num', said(1, 2, 'u4')),
                            right: b.exprHole('the target value', said(3, 5, 'u4')),
                          },
                          said(1, 5, 'u4'),
                        ),
                        body: b.block([b.continue(said(6, 7, 'u4'))]),
                      },
                      said(0, 7, 'u4'),
                    ),
                  ],
                  orelse: b.block([
                    b.update(
                      {
                        target: b.name('seen', said(4, 6, 'u5')),
                        op: 'add',
                        value: b.name('num', said(2, 3, 'u5')),
                      },
                      { ...said(0, 6, 'u5'), inferred: 'INF-SYNONYM' },
                    ),
                  ]),
                },
                said(0, 12, 'u3'),
              ),
            ]),
          },
          {
            ...said(0, 6, 'u2'),
            label: 'main loop',
            notes: [b.note('this is O(n)', 'complexity', [at(0, 4, 'u6')])],
          },
        ),
        b.forRange(
          {
            target: b.name('i', { inferred: 'INF-INDEXVAR' }),
            start: b.literal(0, said(2, 3, 'u7')),
            stop: b.call(
              { callee: b.name('len', said(4, 5, 'u7')), args: [b.name('nums', said(6, 7, 'u7'))] },
              { ...said(4, 7, 'u7'), inferred: 'INF-RANGE-BOUNDS' },
            ),
            step: b.literal(1, said(8, 9, 'u7')),
            body: b.block([
              b.assign(
                {
                  target: b.name('total', said(0, 1, 'u8')),
                  value: b.binOp(
                    {
                      op: '+',
                      left: b.index(
                        {
                          object: b.name('nums', said(3, 4, 'u8')),
                          index: b.name('i', said(5, 6, 'u8')),
                        },
                        said(3, 6, 'u8'),
                      ),
                      right: b.attribute(
                        {
                          object: b.slice(
                            {
                              object: b.name('nums', said(8, 9, 'u8')),
                              start: b.literal(1, said(10, 11, 'u8')),
                              stop: b.name('i', said(12, 13, 'u8')),
                              step: b.literal(2, said(14, 15, 'u8')),
                            },
                            said(8, 15, 'u8'),
                          ),
                          name: 'size',
                        },
                        said(8, 16, 'u8'),
                      ),
                    },
                    said(2, 16, 'u8'),
                  ),
                },
                said(0, 16, 'u8'),
              ),
              b.intent('process the element here', said(0, 4, 'u9')),
            ]),
          },
          said(0, 9, 'u7'),
        ),
        b.while(
          {
            cond: b.condHole('while it is valid', said(1, 4, 'u10')),
            body: b.block([b.blockHole('loop body not described')]),
          },
          said(0, 4, 'u10'),
        ),
        b.update(
          {
            target: b.nameHole('which list?', said(2, 4, 'u11')),
            op: 'append',
            value: b.refHole('nums or seen?', [numsParam.id, seenTarget.id], said(5, 6, 'u11')),
          },
          said(0, 6, 'u11'),
        ),
        b.exprStmt(
          b.call(
            {
              callee: b.name('print', said(0, 1, 'u12')),
              args: [b.name('best', said(1, 2, 'u12'))],
            },
            said(0, 2, 'u12'),
          ),
          said(0, 2, 'u12'),
        ),
        b.break(said(0, 1, 'u13')),
      ]),
    },
    { ...said(0, 5), label: 'solution' },
  );

  return b.document(b.program([fn]));
}

/**
 * The worked example from ROADMAP.md §3.6 after its four utterances:
 *
 *   u1 "Loop through the list of numbers."
 *   u2 "If we've already seen the number, return true."
 *   u3 "Oh, we keep a set called seen, empty at the start."
 *   u4 "Otherwise add it to the set."
 */
export function workedExample(b: Builder = createBuilder()): IrDocument {
  return b.document(
    b.program([
      b.assign(
        {
          target: b.name('seen', said(5, 7, 'u3')),
          value: b.collection(
            { collection: 'set', elements: [] },
            { provenance: [at(3, 5, 'u3'), at(7, 8, 'u3')] },
          ),
        },
        said(1, 11, 'u3'),
      ),
      b.forEach(
        {
          target: b.name('num', { inferred: 'INF-LOOPVAR' }),
          iterable: b.name('nums', { ...said(2, 6, 'u1'), inferred: 'INF-PLURAL-NAME' }),
          body: b.block([
            b.if(
              {
                cond: b.membership(
                  {
                    element: b.name('num', said(4, 6, 'u2')),
                    container: b.name('seen', said(3, 4, 'u2')),
                  },
                  said(1, 6, 'u2'),
                ),
                body: b.block([b.return(b.literal(true, said(7, 8, 'u2')), said(6, 8, 'u2'))]),
                orelse: b.block(
                  [
                    b.update(
                      {
                        target: b.name('seen', said(4, 6, 'u4')),
                        op: 'add',
                        value: b.name('num', said(2, 3, 'u4')),
                      },
                      { ...said(1, 6, 'u4'), inferred: 'INF-SYNONYM' },
                    ),
                  ],
                  said(0, 1, 'u4'),
                ),
              },
              said(0, 8, 'u2'),
            ),
          ]),
        },
        said(0, 6, 'u1'),
      ),
    ]),
  );
}
