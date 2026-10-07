// Replaces temporary IDs (`t1`, `t2`, …) with permanent ones.
//
// Every node or note whose `id` is temporary gets the next permanent ID, in
// the order they appear. References to them (`parent`, `node`, `before`, …,
// and RefHole `candidates`) are rewritten to match. Only those keys are
// touched, so a string literal that happens to read "t1" is safe.
//
// The applier resolves one op at a time, sharing `assigned` across the
// batch, so an op's IDs depend only on the ops before it.

import type { IdAllocator } from '../ir/ids';
import { TEMP_ID_PATTERN } from '../ir/schema';

const REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'parent',
  'node',
  'hole',
  'note',
  'before',
  'after',
]);
const REFERENCE_LIST_KEYS: ReadonlySet<string> = new Set(['nodes', 'candidates']);

export type TempIdResult = { ok: true; value: unknown } | { ok: false; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveTempIds(
  batch: unknown,
  ids: IdAllocator,
  assigned = new Map<string, string>(),
): TempIdResult {
  let problem: string | undefined;

  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value as readonly unknown[]) collect(item);
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'id' && typeof item === 'string' && TEMP_ID_PATTERN.test(item)) {
          if (assigned.has(item)) problem ??= `Temporary ID ${item} is given to more than one node`;
          else assigned.set(item, ids.allocate());
        } else {
          collect(item);
        }
      }
    }
  };

  const reference = (id: string): string => {
    if (!TEMP_ID_PATTERN.test(id)) return id;
    const permanent = assigned.get(id);
    if (permanent === undefined) {
      problem ??= `Temporary ID ${id} is referenced but not given to any node before it`;
      return id;
    }
    return permanent;
  };

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return (value as readonly unknown[]).map(rewrite);
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (key === 'id' || REFERENCE_KEYS.has(key))) {
        out[key] = reference(item);
      } else if (REFERENCE_LIST_KEYS.has(key) && Array.isArray(item)) {
        out[key] = (item as readonly unknown[]).map((entry) =>
          typeof entry === 'string' ? reference(entry) : rewrite(entry),
        );
      } else {
        out[key] = rewrite(item);
      }
    }
    return out;
  };

  collect(batch);
  const value = rewrite(batch);
  return problem === undefined ? { ok: true, value } : { ok: false, message: problem };
}
