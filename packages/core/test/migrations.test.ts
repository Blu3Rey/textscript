import { describe, expect, it } from 'vitest';
import { IR_SCHEMA_VERSION, MIGRATIONS, migrate, type Migration } from '../src';

describe('migrate', () => {
  it('passes a current document through unchanged', () => {
    const doc = { schemaVersion: IR_SCHEMA_VERSION, nextId: 1 };
    expect(migrate(doc)).toEqual({ ok: true, document: doc });
  });

  it('has no migrations while the schema is at version 1', () => {
    expect(IR_SCHEMA_VERSION).toBe(1);
    expect(MIGRATIONS.size).toBe(0);
  });

  it.each([null, [], 'doc', 42])('rejects a non-object: %j', (raw) => {
    expect(migrate(raw)).toEqual({ ok: false, issue: 'Document must be a JSON object' });
  });

  it.each([{}, { schemaVersion: '1' }, { schemaVersion: 0 }, { schemaVersion: 1.5 }])(
    'rejects an invalid version: %j',
    (raw) => {
      expect(migrate(raw)).toEqual({ ok: false, issue: 'Document has no valid schemaVersion' });
    },
  );

  it('rejects documents from a newer version', () => {
    expect(migrate({ schemaVersion: 2 }, { target: 1 })).toEqual({
      ok: false,
      issue: 'Document has schemaVersion 2, newer than the supported 1',
    });
  });

  describe('with registered migrations', () => {
    // A pretend history: v1 renamed `stmts` to `body`, then v2 added `nextId`.
    const migrations = new Map<number, Migration>([
      [1, ({ stmts, ...rest }) => ({ ...rest, body: stmts })],
      [2, (doc) => ({ ...doc, nextId: 1 })],
    ]);

    it('applies each step in order and sets the version', () => {
      expect(migrate({ schemaVersion: 1, stmts: [] }, { migrations, target: 3 })).toEqual({
        ok: true,
        document: { schemaVersion: 3, body: [], nextId: 1 },
      });
    });

    it('starts from the document version', () => {
      expect(migrate({ schemaVersion: 2, body: [] }, { migrations, target: 3 })).toEqual({
        ok: true,
        document: { schemaVersion: 3, body: [], nextId: 1 },
      });
    });

    it('does not mutate the input', () => {
      const raw = { schemaVersion: 1, stmts: [] };
      migrate(raw, { migrations, target: 3 });
      expect(raw).toEqual({ schemaVersion: 1, stmts: [] });
    });

    it('reports a missing step', () => {
      expect(migrate({ schemaVersion: 1 }, { migrations: new Map(), target: 2 })).toEqual({
        ok: false,
        issue: 'No migration from schemaVersion 1',
      });
    });
  });
});
