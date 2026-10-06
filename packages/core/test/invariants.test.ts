import { describe, expect, it } from 'vitest';
import { checkInvariants, createBuilder, type IrDocument, type Stmt } from '../src';
import { at, kitchenSink, said, workedExample } from './fixtures';

function docWith(build: (b: ReturnType<typeof createBuilder>) => Stmt[]): IrDocument {
  const b = createBuilder();
  return b.document(b.program(build(b)));
}

function codes(doc: IrDocument): string[] {
  return checkInvariants(doc).map((issue) => issue.code);
}

describe('checkInvariants', () => {
  it('accepts valid documents', () => {
    expect(checkInvariants(kitchenSink())).toEqual([]);
    expect(checkInvariants(workedExample())).toEqual([]);
  });

  it('accepts an empty program', () => {
    expect(codes(docWith(() => []))).toEqual([]);
  });

  describe('duplicate-id', () => {
    it('reports a node ID used twice', () => {
      const doc = docWith((b) => {
        const stmt = b.break(said(0));
        return [stmt, { ...b.continue(said(1)), id: stmt.id }];
      });
      expect(checkInvariants(doc)).toEqual([
        { code: 'duplicate-id', nodeId: 'n1', message: 'ID n1 is used more than once' },
      ]);
    });

    it('reports a note sharing a node ID', () => {
      const doc = docWith((b) => {
        const stmt = b.break(said(0));
        return [{ ...stmt, notes: [{ ...b.note('x', 'general', [at(0)]), id: stmt.id }] }];
      });
      expect(codes(doc)).toEqual(['duplicate-id']);
    });
  });

  it('id-not-below-next: reports IDs the allocator could hand out again', () => {
    const doc = docWith((b) => [b.break(said(0))]);
    expect(codes({ ...doc, nextId: 2 })).toEqual(['id-not-below-next']);
    expect(codes({ ...doc, nextId: 3 })).toEqual([]);
  });

  describe('missing-provenance', () => {
    it('reports a sourced node with no provenance or inference rule', () => {
      const doc = docWith((b) => [b.break()]);
      expect(checkInvariants(doc)[0]).toMatchObject({ code: 'missing-provenance', nodeId: 'n1' });
    });

    it('accepts an inference rule instead of provenance', () => {
      expect(codes(docWith((b) => [b.break({ inferred: 'INF-BLOCK-END' })]))).toEqual([]);
    });

    it('exempts holes and structural nodes', () => {
      const doc = docWith((b) => [
        b.while(
          { cond: b.condHole('unstated'), body: b.block([b.blockHole('not described')]) },
          said(0),
        ),
        b.assign({ target: b.nameHole('unnamed'), value: b.exprHole('vague') }, said(1)),
      ]);
      expect(codes(doc)).toEqual([]);
    });
  });

  it('note-missing-provenance: notes always come from the user', () => {
    const doc = docWith((b) => [b.break({ ...said(0), notes: [b.note('x', 'general', [])] })]);
    expect(codes(doc)).toEqual(['note-missing-provenance']);
  });

  it('invalid-span: start must be before end, for nodes and notes', () => {
    const doc = docWith((b) => [
      b.break({ provenance: [at(3, 3)] }),
      b.continue({ ...said(0), notes: [b.note('x', 'general', [at(5, 2)])] }),
    ]);
    expect(codes(doc)).toEqual(['invalid-span', 'invalid-span']);
  });

  it('block-hole-not-alone: a BlockHole must be the only statement', () => {
    const doc = docWith((b) => [
      b.while(
        { cond: b.name('x', said(1)), body: b.block([b.break(said(2)), b.blockHole('rest')]) },
        said(0),
      ),
    ]);
    expect(codes(doc)).toEqual(['block-hole-not-alone']);
  });

  it('block-hole-outside-block: no BlockHole in the program body', () => {
    expect(codes(docWith((b) => [b.blockHole('nothing yet')]))).toEqual([
      'block-hole-outside-block',
    ]);
  });

  it('unknown-candidate: RefHole candidates must be nodes in the document', () => {
    const doc = docWith((b) => {
      const known = b.name('nums', said(0));
      const assign = b.assign({ target: known, value: b.literal(null, said(1)) }, said(0, 2));
      return [assign, b.exprStmt(b.refHole('which?', [known.id, 'n99']), said(3))];
    });
    expect(checkInvariants(doc)).toEqual([
      {
        code: 'unknown-candidate',
        nodeId: 'n4',
        message: 'RefHole n4 lists candidate n99, which is not a node',
      },
    ]);
  });
});
