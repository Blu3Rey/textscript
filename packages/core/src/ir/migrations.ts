// Upgrades serialized documents from older schema versions.
//
// When IR_SCHEMA_VERSION goes from N to N+1, add an entry for N here that
// turns a version-N document into a version-N+1 one, with tests using a real
// version-N document. Migrations work on plain JSON, never on IR types,
// because the types only describe the current version.

import { IR_SCHEMA_VERSION } from './version';

export type JsonObject = Record<string, unknown>;

/** Turns a document of version N into one of version N+1. Must not mutate its input. */
export type Migration = (doc: JsonObject) => JsonObject;

/** Migrations keyed by the version they upgrade from. Empty until version 2. */
export const MIGRATIONS: ReadonlyMap<number, Migration> = new Map();

export type MigrateResult = { ok: true; document: JsonObject } | { ok: false; issue: string };

export interface MigrateOptions {
  migrations?: ReadonlyMap<number, Migration>;
  /** The version to upgrade to. Defaults to the current schema version. */
  target?: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Upgrades `raw` to the target version, one migration at a time. */
export function migrate(raw: unknown, options: MigrateOptions = {}): MigrateResult {
  const { migrations = MIGRATIONS, target = IR_SCHEMA_VERSION } = options;
  if (!isJsonObject(raw)) {
    return { ok: false, issue: 'Document must be a JSON object' };
  }
  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, issue: 'Document has no valid schemaVersion' };
  }
  if (version > target) {
    return {
      ok: false,
      issue: `Document has schemaVersion ${String(version)}, newer than the supported ${String(target)}`,
    };
  }

  let document = raw;
  for (let from = version; from < target; from += 1) {
    const step = migrations.get(from);
    if (step === undefined) {
      return { ok: false, issue: `No migration from schemaVersion ${String(from)}` };
    }
    document = { ...step(document), schemaVersion: from + 1 };
  }
  return { ok: true, document };
}
