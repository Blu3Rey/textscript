import { describe, expect, it } from 'vitest';
import {
  IrValidationError,
  NODE_KINDS,
  allNodes,
  createBuilder,
  deserialize,
  findNode,
  parseDocument,
  serialize,
  type IrDocument,
} from '../src';
import { kitchenSink, said, workedExample } from './fixtures';

function roundTrip(doc: IrDocument): IrDocument {
  const result = deserialize(serialize(doc));
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.document;
}

/** Recreates a JSON value with every object's keys in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
}

describe('round trip', () => {
  const original = kitchenSink();
  const restored = roundTrip(original);

  it('preserves a whole document', () => {
    expect(restored).toEqual(original);
  });

  it.each(NODE_KINDS)('preserves every %s node', (kind) => {
    const nodes = allNodes(original.program).filter((node) => node.kind === kind);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(findNode(restored.program, node.id)).toEqual(node);
    }
  });

  it('preserves nextId, so IDs are never reused after reloading', () => {
    expect(restored.nextId).toBe(original.nextId);
  });
});

describe('serialize', () => {
  it('writes canonical JSON regardless of key order', () => {
    const doc = workedExample();
    const shuffled = reverseKeys(doc);
    const parsed = parseDocument(shuffled);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serialize(parsed.document)).toBe(serialize(doc));
  });

  it('matches the golden file for the worked example', async () => {
    await expect(serialize(workedExample(), { pretty: true }) + '\n').toMatchFileSnapshot(
      './golden/worked-example.json',
    );
  });

  it('is compact by default', () => {
    expect(serialize(workedExample())).not.toContain('\n');
  });

  it('refuses to write an invalid document', () => {
    const b = createBuilder();
    const doc = b.document(b.program([b.break()]));
    expect(() => serialize(doc)).toThrow(IrValidationError);
    try {
      serialize(doc);
    } catch (error) {
      expect(error).toMatchObject({
        stage: 'invariants',
        issues: [expect.stringMatching(/^missing-provenance/)],
      });
    }
  });
});

describe('deserialize', () => {
  const valid = serialize(workedExample());

  it('reports malformed JSON', () => {
    expect(deserialize('{"schemaVersion":')).toMatchObject({ ok: false, stage: 'json' });
  });

  it('reports a missing or unsupported version', () => {
    expect(deserialize('{}')).toEqual({
      ok: false,
      stage: 'version',
      issues: ['Document has no valid schemaVersion'],
    });
    expect(deserialize(valid.replace('"schemaVersion":1', '"schemaVersion":9'))).toMatchObject({
      ok: false,
      stage: 'version',
      issues: [expect.stringContaining('newer')],
    });
  });

  it('reports shape errors with a path', () => {
    const broken = valid.replace('"name":"seen"', '"name":"2seen"');
    const result = deserialize(broken);
    expect(result).toMatchObject({ ok: false, stage: 'shape' });
    if (!result.ok) expect(result.issues[0]).toMatch(/^program\.body\[0\]\.target\.name: /);
  });

  it('reports shape errors at the document root without a path', () => {
    const result = deserialize(valid.replace('{', '{"extra":1,'));
    expect(result).toEqual({ ok: false, stage: 'shape', issues: ['Unrecognized key: "extra"'] });
  });

  it('reports invariant violations', () => {
    const doc = workedExample();
    const result = deserialize(JSON.stringify({ ...doc, nextId: 1 }));
    expect(result).toMatchObject({ ok: false, stage: 'invariants' });
  });

  it('accepts what serialize wrote', () => {
    expect(deserialize(valid)).toEqual({ ok: true, document: workedExample() });
  });

  it('keeps empty programs valid', () => {
    const b = createBuilder();
    expect(roundTrip(b.document(b.program([], said(0))))).toMatchObject({ program: { body: [] } });
  });
});
