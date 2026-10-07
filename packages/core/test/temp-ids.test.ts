import { describe, expect, it } from 'vitest';
import { createIdAllocator } from '../src';
import { resolveTempIds } from '../src/ops/temp-ids';

describe('resolveTempIds', () => {
  it('rewrites node IDs and every kind of reference to them', () => {
    const batch = {
      utteranceId: 'u1',
      ops: [
        {
          op: 'add_stmt',
          parent: 'n1',
          position: { before: 'n2' },
          stmt: {
            kind: 'ExprStmt',
            id: 't1',
            expr: {
              kind: 'RefHole',
              id: 't2',
              reason: 'which?',
              candidates: ['n3', 't1'],
              provenance: [],
            },
            provenance: [],
          },
        },
        { op: 'set_label', node: 't2', label: 'x' },
        {
          op: 'wrap_nodes',
          nodes: ['t1', 'n2'],
          wrapper: { kind: 'Break', id: 't3', provenance: [] },
        },
        {
          op: 'add_stmt',
          parent: 'n1',
          position: { after: 't1' },
          stmt: { kind: 'Break', id: 't4', provenance: [] },
        },
      ],
    };
    const result = resolveTempIds(batch, createIdAllocator(10));
    expect(result).toEqual({
      ok: true,
      value: {
        utteranceId: 'u1',
        ops: [
          {
            op: 'add_stmt',
            parent: 'n1',
            position: { before: 'n2' },
            stmt: {
              kind: 'ExprStmt',
              id: 'n10',
              expr: {
                kind: 'RefHole',
                id: 'n11',
                reason: 'which?',
                candidates: ['n3', 'n10'],
                provenance: [],
              },
              provenance: [],
            },
          },
          { op: 'set_label', node: 'n11', label: 'x' },
          {
            op: 'wrap_nodes',
            nodes: ['n10', 'n2'],
            wrapper: { kind: 'Break', id: 'n12', provenance: [] },
          },
          {
            op: 'add_stmt',
            parent: 'n1',
            position: { after: 'n10' },
            stmt: { kind: 'Break', id: 'n13', provenance: [] },
          },
        ],
      },
    });
  });

  it('leaves text that merely looks like a temporary ID alone', () => {
    const batch = {
      ops: [
        {
          op: 'add_stmt',
          stmt: {
            kind: 'Assign',
            id: 't1',
            target: { kind: 'Name', id: 't2', name: 't1' },
            value: { kind: 'Literal', id: 't3', value: 't2' },
          },
        },
        { op: 'set_label', node: 'n4', label: 't1' },
        { op: 'add_note', node: 'n4', text: 't3' },
      ],
    };
    const result = resolveTempIds(batch, createIdAllocator(5));
    expect(result).toEqual({
      ok: true,
      value: {
        ops: [
          {
            op: 'add_stmt',
            stmt: {
              kind: 'Assign',
              id: 'n5',
              target: { kind: 'Name', id: 'n6', name: 't1' },
              value: { kind: 'Literal', id: 'n7', value: 't2' },
            },
          },
          { op: 'set_label', node: 'n4', label: 't1' },
          { op: 'add_note', node: 'n4', text: 't3' },
        ],
      },
    });
  });

  it('rejects a temporary ID used for two nodes', () => {
    const batch = { ops: [{ stmt: { id: 't1' } }, { stmt: { id: 't1' } }] };
    expect(resolveTempIds(batch, createIdAllocator())).toEqual({
      ok: false,
      message: 'Temporary ID t1 is given to more than one node',
    });
  });

  it('rejects a reference to a temporary ID no node has', () => {
    expect(resolveTempIds({ ops: [{ node: 't9' }] }, createIdAllocator())).toEqual({
      ok: false,
      message: 'Temporary ID t9 is referenced but not given to any node before it',
    });
  });

  it('leaves batches without temporary IDs unchanged', () => {
    const batch = { utteranceId: 'u1', ops: [{ op: 'remove_node', node: 'n3' }] };
    expect(resolveTempIds(batch, createIdAllocator())).toEqual({ ok: true, value: batch });
  });
});
