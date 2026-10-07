// Structural alignment of two programs (docs/adr/011).
//
// Pairs each node of a gold program with at most one node of a produced
// program, keeping parent-child structure and statement order, so that as
// many pairs as possible are *equal*: same kind and same values, ignoring
// IDs, provenance, hole reasons and free text. Among alignments with the
// most equal pairs, it prefers the one with the most pairs, so a hole lines
// up with whatever the other side put in its place. A step said only in
// words (an intent) lines up the same way.
//
// Names bound by an allowed inference (a loop variable nobody named) are
// compared by position, not spelling: `for num in nums` and `for n in nums`
// are equal when the name was inferred.

import {
  CHILD_FIELDS,
  isIrNode,
  walk,
  type IrNode,
  type Note,
  type Program,
} from '@textscript/core';

export const HOLE_KINDS: ReadonlySet<string> = new Set([
  'BlockHole',
  'CondHole',
  'ExprHole',
  'NameHole',
  'RefHole',
]);

export function isHole(node: IrNode): boolean {
  return HOLE_KINDS.has(node.kind);
}

/**
 * A hole, a step said only in words, or a statement that is only a hole:
 * all stand for something not yet described.
 */
export function isPlaceholder(node: IrNode): boolean {
  return (
    isHole(node) || node.kind === 'IntentStmt' || (node.kind === 'ExprStmt' && isHole(node.expr))
  );
}

/** Fields that don't take part in comparison. */
const IGNORED_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'id',
  'provenance',
  'inferred',
  'label',
  'notes',
  // Free text and hole details: what matters is that there's a hole, or a step in words.
  'reason',
  'candidates',
  'text',
]);

/** A node's own values, without children, as a comparable string. */
export function scalarSignature(node: IrNode, names: NameNormalizer): string {
  const childFields: readonly string[] = CHILD_FIELDS[node.kind];
  const fields: [string, unknown][] = Object.entries(node);
  const values = fields
    .filter(([key]) => !IGNORED_FIELDS.has(key) && !childFields.includes(key))
    .map(([key, value]) => [
      key,
      key === 'name' && node.kind === 'Name' && typeof value === 'string' ? names(value) : value,
    ])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return `${node.kind}${JSON.stringify(values)}`;
}

export type NameNormalizer = (name: string) => string;

/** Names bound by an inference rule, in either program. */
export function inferredNames(...programs: Program[]): Set<string> {
  const names = new Set<string>();
  for (const program of programs) {
    walk(program, (node) => {
      if (node.kind === 'Name' && node.inferred !== undefined) names.add(node.name);
    });
  }
  return names;
}

/** Replaces each inferred name by its order of first appearance in `program`. */
export function nameNormalizer(program: Program, inferred: ReadonlySet<string>): NameNormalizer {
  const order = new Map<string, string>();
  walk(program, (node) => {
    if (node.kind === 'Name' && inferred.has(node.name) && !order.has(node.name)) {
      order.set(node.name, `~${String(order.size + 1)}`);
    }
  });
  return (name) => order.get(name) ?? name;
}

/** The value of each child field: a node, a list of nodes, or nothing. */
export function childFields(
  node: IrNode,
): { field: string; value: IrNode | IrNode[] | undefined }[] {
  const fields: readonly string[] = CHILD_FIELDS[node.kind];
  return fields.map((field) => {
    const value: unknown = Reflect.get(node, field);
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      return { field, value: items.filter(isIrNode) };
    }
    return { field, value: isIrNode(value) ? value : undefined };
  });
}

export interface NotePair {
  gold: Note;
  produced: Note;
}

export interface Alignment {
  /** Gold node → produced node. */
  pairs: Map<IrNode, IrNode>;
  /** Produced node → gold node. */
  reverse: Map<IrNode, IrNode>;
  /** Gold nodes whose pair is equal. */
  equal: Set<IrNode>;
  /** Notes on paired nodes, matched by tag. */
  notes: NotePair[];
  /** Gold nodes whose pair has the same label. */
  labels: Set<IrNode>;
}

interface Result {
  /** Equal pairs (nodes, notes and labels). */
  equal: number;
  /** All pairs. */
  paired: number;
  pairs: [IrNode, IrNode][];
}

const NONE: Result = { equal: 0, paired: 0, pairs: [] };

function better(a: Result, b: Result): boolean {
  return a.equal !== b.equal ? a.equal > b.equal : a.paired > b.paired;
}

function combine(...results: Result[]): Result {
  return {
    equal: results.reduce((sum, r) => sum + r.equal, 0),
    paired: results.reduce((sum, r) => sum + r.paired, 0),
    pairs: results.flatMap((r) => r.pairs),
  };
}

function normalizedLabel(label: string | undefined): string | undefined {
  return label?.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

function notesMatched(gold: readonly Note[], produced: readonly Note[]): NotePair[] {
  const left = [...produced];
  const pairs: NotePair[] = [];
  for (const note of gold) {
    const index = left.findIndex((other) => other.tag === note.tag);
    const match = left[index];
    if (match === undefined) continue;
    pairs.push({ gold: note, produced: match });
    left.splice(index, 1);
  }
  return pairs;
}

/** Aligns `produced` against `gold`. */
export function align(gold: Program, produced: Program): Alignment {
  const inferred = inferredNames(gold, produced);
  const goldNames = nameNormalizer(gold, inferred);
  const producedNames = nameNormalizer(produced, inferred);
  const memo = new Map<IrNode, Map<IrNode, Result>>();

  const canPair = (g: IrNode, p: IrNode) =>
    g.kind === p.kind || isPlaceholder(g) || isPlaceholder(p);
  const isEqual = (g: IrNode, p: IrNode) =>
    (isHole(g) && isHole(p)) || scalarSignature(g, goldNames) === scalarSignature(p, producedNames);

  const sequence = (gs: readonly IrNode[], ps: readonly IrNode[]): Result => {
    // Longest-common-subsequence style alignment, scored by `node`.
    const rows = gs.length + 1;
    const cols = ps.length + 1;
    const table: Result[][] = Array.from({ length: rows }, () => Array<Result>(cols).fill(NONE));
    const at = (i: number, j: number): Result => table[i]?.[j] ?? NONE;
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        let best = better(at(i - 1, j), at(i, j - 1)) ? at(i - 1, j) : at(i, j - 1);
        const g = gs[i - 1];
        const p = ps[j - 1];
        if (g !== undefined && p !== undefined && canPair(g, p)) {
          const diagonal = combine(at(i - 1, j - 1), node(g, p));
          if (better(diagonal, best)) best = diagonal;
        }
        const row = table[i];
        if (row) row[j] = best;
      }
    }
    return at(rows - 1, cols - 1);
  };

  const node = (g: IrNode, p: IrNode): Result => {
    const cached = memo.get(g)?.get(p);
    if (cached) return cached;
    const own: Result = { equal: isEqual(g, p) ? 1 : 0, paired: 1, pairs: [[g, p]] };
    const parts = [own];
    if (g.kind === p.kind) {
      const label = normalizedLabel(g.label);
      if (label !== undefined && label === normalizedLabel(p.label))
        parts.push({ equal: 1, paired: 0, pairs: [] });
      const notes = notesMatched(g.notes ?? [], p.notes ?? []).length;
      if (notes > 0) parts.push({ equal: notes, paired: 0, pairs: [] });
      const pChildren = childFields(p);
      for (const [index, { value: gValue }] of childFields(g).entries()) {
        const pValue = pChildren[index]?.value;
        if (Array.isArray(gValue) && Array.isArray(pValue)) {
          parts.push(sequence(gValue, pValue));
        } else if (
          gValue &&
          pValue &&
          !Array.isArray(gValue) &&
          !Array.isArray(pValue) &&
          canPair(gValue, pValue)
        ) {
          parts.push(node(gValue, pValue));
        }
      }
    }
    const result = combine(...parts);
    let row = memo.get(g);
    if (row === undefined) {
      row = new Map();
      memo.set(g, row);
    }
    row.set(p, result);
    return result;
  };

  const result = node(gold, produced);
  const pairs = new Map(result.pairs);
  const alignment: Alignment = {
    pairs,
    reverse: new Map(result.pairs.map(([g, p]) => [p, g])),
    equal: new Set(result.pairs.filter(([g, p]) => isEqual(g, p)).map(([g]) => g)),
    notes: [],
    labels: new Set(),
  };
  for (const [g, p] of pairs) {
    if (g.kind !== p.kind) continue;
    alignment.notes.push(...notesMatched(g.notes ?? [], p.notes ?? []));
    const label = normalizedLabel(g.label);
    if (label !== undefined && label === normalizedLabel(p.label)) alignment.labels.add(g);
  }
  return alignment;
}
