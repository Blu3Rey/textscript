// Compares what a translator did with one utterance against the gold
// answers for it (docs/adr/011). Both start from the same gold state, so
// each step is scored on its own and mistakes don't compound.
//
// "Units" are what get counted: nodes (not blocks), notes and labels. A
// unit is *produced* by a step if it's new, or if its own values changed.

import {
  allNodes,
  analyze,
  walk,
  type Diagnostic,
  type EditBatch,
  type IrDocument,
  type IrNode,
  type NodeId,
  type Program,
} from '@textscript/core';
import { PYTHON_BUILTINS, render, type RenderResult } from '@textscript/render-python';
import { align, childFields, isPlaceholder, scalarSignature, type Alignment } from './align';

export interface NodeRef {
  id: NodeId;
  kind: string;
  /** How it renders (first line only). */
  text: string;
}

/** A gap the gold answer leaves open that the translator closed. */
export interface FilledGap {
  /** The gold diagnostic: GAP003, "The solution doesn't say what it returns…". */
  code: string;
  message: string;
  /** The node the gap is on, in the gold state. */
  node: NodeRef;
  /** For a hole or word-only step: what the translator put in its place. */
  filledWith?: NodeRef;
}

export interface StepComparison {
  /** Which gold alternative it was compared with (0 is canonical). */
  alternative: number;
  /** Units the gold answer produces, and how many of them the translator also produced. */
  goldUnits: number;
  covered: number;
  /** Gold units not produced, outermost first; children of a missing node are left out. */
  missing: NodeRef[];
  /** Units the translator produced, not counting holes, and how many the gold answer supports. */
  producedUnits: number;
  supported: number;
  unsupported: NodeRef[];
  /**
   * Gaps the analyzer reports in the gold state after the step (holes,
   * missing returns, names never set up, …), and those the translator closed.
   */
  gaps: number;
  filled: FilledGap[];
  /** Set when the gold answer changes existing code below the top level. */
  placement?: { expected: NodeId[]; actual: NodeId[]; correct: boolean };
  /** Whether the translator asked a question, and whether the gold answers do. */
  asked: { actual: boolean; expected: 'yes' | 'no' | 'either' };
  /** Lines of statements the gold answer leaves alone, and how many stayed byte-identical. */
  stability: { lines: number; kept: number; changed: NodeRef[] };
}

export interface GoldAnswer {
  batch: EditBatch;
  after: IrDocument;
}

const STRUCTURAL: ReadonlySet<string> = new Set(['Program', 'Block']);

function asks(batch: EditBatch): boolean {
  return batch.ops.some((op) => op.op === 'ask_clarification');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    return `{${entries
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const identity = (name: string) => name;

/** A node's values, its children's IDs, its label and its notes. */
function shallow(node: IrNode): string {
  const children = childFields(node).map(({ value }) =>
    Array.isArray(value) ? value.map((child) => child.id) : value?.id,
  );
  const notes = (node.notes ?? []).map((note) => [note.id, note.tag, note.text]);
  return stableStringify([scalarSignature(node, identity), children, node.label, notes]);
}

/** IDs of nodes in `before` that are gone or changed (values, children, label or notes) in `after`. */
export function changedNodes(before: Program, after: Program): Set<NodeId> {
  const now = new Map(allNodes(after).map((node) => [node.id, node]));
  const changed = new Set<NodeId>();
  for (const node of allNodes(before)) {
    const current = now.get(node.id);
    if (current === undefined || shallow(current) !== shallow(node)) changed.add(node.id);
  }
  return changed;
}

interface Unit {
  ref: NodeRef;
  /** The node the unit belongs to; for a node, the node itself. */
  node: IrNode;
  type: 'node' | 'note' | 'label';
  noteId?: NodeId;
}

class Rendered {
  readonly result: RenderResult;
  readonly lines: string[];

  constructor(program: Program) {
    this.result = render(program, { mode: 'ui' });
    this.lines = this.result.text.split('\n');
  }

  /** The full lines a node covers. */
  linesOf(id: NodeId): string[] {
    const range = this.result.sourceMap.nodes.get(id);
    if (range === undefined) return [];
    const last =
      range.end.column === 0 && range.end.line > range.start.line
        ? range.end.line - 1
        : range.end.line;
    return this.lines.slice(range.start.line, last + 1);
  }

  text(id: NodeId): string {
    const range = this.result.sourceMap.nodes.get(id) ?? this.result.sourceMap.notes.get(id);
    if (range === undefined) return '';
    const text = this.result.text.slice(range.start.offset, range.end.offset);
    const [first = '', ...rest] = text.split('\n');
    return rest.some((line) => line.trim() !== '') ? `${first.trimEnd()} …` : first.trimEnd();
  }

  ref(node: IrNode): NodeRef {
    return { id: node.id, kind: node.kind, text: this.text(node.id) };
  }
}

/** What a step added or changed: nodes, labels, and note IDs. */
export interface Changes {
  nodes: Set<IrNode>;
  labels: Set<IrNode>;
  notes: Set<NodeId>;
}

/**
 * The units of `after` that aren't in `before`. A node is unchanged if it
 * keeps its ID and values, or if it lines up with an equal node in `before`
 * (code rewritten as it was, as when an `if` is replaced to add an `elif`).
 */
export function changes(before: Program, after: Program): Changes {
  const old = new Map(allNodes(before).map((node) => [node.id, node]));
  const oldNotes = new Set(
    allNodes(before).flatMap((node) => (node.notes ?? []).map((note) => note.id)),
  );
  const same = align(after, before);
  const sameNotes = new Set(same.notes.map((pair) => pair.gold.id));
  const result: Changes = { nodes: new Set(), labels: new Set(), notes: new Set() };
  walk(after, (node) => {
    const previous = old.get(node.id);
    const kept =
      (previous !== undefined &&
        scalarSignature(previous, identity) === scalarSignature(node, identity)) ||
      same.equal.has(node);
    if (!STRUCTURAL.has(node.kind) && !kept) result.nodes.add(node);
    if (node.label !== undefined && node.label !== previous?.label && !same.labels.has(node)) {
      result.labels.add(node);
    }
    for (const note of node.notes ?? []) {
      if (!oldNotes.has(note.id) && !sameNotes.has(note.id)) result.notes.add(note.id);
    }
  });
  return result;
}

function producedUnits(before: Program, after: Program, rendered: Rendered): Unit[] {
  const changed = changes(before, after);
  const units: Unit[] = [];
  walk(after, (node) => {
    if (changed.nodes.has(node)) units.push({ ref: rendered.ref(node), node, type: 'node' });
    if (changed.labels.has(node)) {
      units.push({
        ref: {
          id: node.id,
          kind: 'Label',
          text: `label "${node.label ?? ''}" on ${rendered.text(node.id)}`,
        },
        node,
        type: 'label',
      });
    }
    for (const note of node.notes ?? []) {
      if (changed.notes.has(note.id)) {
        units.push({
          ref: { id: note.id, kind: 'Note', text: rendered.text(note.id) },
          node,
          type: 'note',
          noteId: note.id,
        });
      }
    }
  });
  return units;
}

/** Whether a function body, or the top-level code, returns a value somewhere. */
function returnsValue(scope: IrNode): boolean {
  let found = false;
  walk(scope, (node) => {
    if (node !== scope && node.kind === 'FunctionDef') return false;
    if (node.kind === 'Return' && node.value !== undefined) found = true;
    return !found;
  });
  return found;
}

/**
 * Whether the translator closed a gold gap on `node`, whose counterpart in
 * its state is `pair`. A hole stays open if any hole (or a step in words)
 * takes its place. Other gaps are closed if the counterpart doesn't have
 * them, except a missing return (GAP003), which only exists once something
 * returns a value: it's closed only if the counterpart returns a value too.
 */
function closed(
  code: string,
  node: IrNode,
  pair: IrNode,
  producedGaps: ReadonlyMap<NodeId, ReadonlySet<string>>,
): boolean {
  if (isPlaceholder(node)) return !isPlaceholder(pair);
  if (producedGaps.get(pair.id)?.has(code) === true) return false;
  return code !== 'GAP003' || returnsValue(pair);
}

/** Gap-level diagnostics; warnings and inferences aren't gaps. */
function gapsOf(program: Program, inputs: readonly string[]): Diagnostic[] {
  return analyze(program, { builtins: PYTHON_BUILTINS, inputs }).diagnostics.filter(
    (d) => d.severity === 'gap',
  );
}

function parents(program: Program): Map<IrNode, IrNode> {
  const map = new Map<IrNode, IrNode>();
  walk(program, (node, context) => {
    if (context.position) map.set(node, context.position.parent);
  });
  return map;
}

/** Keeps a node unless its parent is also in the list. */
function outermost(units: Unit[], parentOf: Map<IrNode, IrNode>): NodeRef[] {
  const nodes = new Set(units.filter((u) => u.type === 'node').map((u) => u.node));
  return units
    .filter((u) => {
      if (u.type !== 'node') return true;
      for (let p = parentOf.get(u.node); p !== undefined; p = parentOf.get(p)) {
        if (nodes.has(p)) return false;
        if (!STRUCTURAL.has(p.kind)) break;
      }
      return true;
    })
    .map((u) => u.ref);
}

function stability(
  before: Program,
  gold: Program,
  produced: Program,
  renderedBefore: Rendered,
  renderedProduced: Rendered,
) {
  const goldNodes = new Map(allNodes(gold).map((node) => [node.id, node]));
  const producedNodes = new Map(allNodes(produced).map((node) => [node.id, node]));
  const result = { lines: 0, kept: 0, changed: [] as NodeRef[] };
  const visitBlock = (stmts: readonly IrNode[]) => {
    for (const stmt of stmts) {
      const goldStmt = goldNodes.get(stmt.id);
      if (goldStmt !== undefined && stableStringify(goldStmt) === stableStringify(stmt)) {
        const lines = renderedBefore.linesOf(stmt.id);
        result.lines += lines.length;
        const after = producedNodes.get(stmt.id);
        const same =
          after !== undefined &&
          stableStringify(after) === stableStringify(stmt) &&
          renderedProduced.linesOf(stmt.id).join('\n') === lines.join('\n');
        if (same) result.kept += lines.length;
        else result.changed.push(renderedBefore.ref(stmt));
        continue;
      }
      for (const { value } of childFields(stmt)) {
        if (value !== undefined && !Array.isArray(value) && value.kind === 'Block')
          visitBlock(value.stmts);
        if (Array.isArray(value))
          for (const child of value) if (child.kind === 'Elif') visitBlock(child.body.stmts);
      }
    }
  };
  visitBlock(before.body);
  return result;
}

function compareWith(
  before: IrDocument,
  gold: GoldAnswer,
  produced: IrDocument,
  context: {
    inputs: readonly string[];
    renderedBefore: Rendered;
    renderedProduced: Rendered;
    producedUnits: Unit[];
    producedChanged: Set<NodeId>;
    producedGaps: Map<NodeId, Set<string>>;
  },
): Omit<StepComparison, 'alternative' | 'asked'> {
  const alignment: Alignment = align(gold.after.program, produced.program);
  const renderedGold = new Rendered(gold.after.program);
  const goldUnits = producedUnits(before.program, gold.after.program, renderedGold);

  const coveredUnit = (unit: Unit) => {
    if (unit.type === 'node') return alignment.equal.has(unit.node);
    if (unit.type === 'label') return alignment.labels.has(unit.node);
    return alignment.notes.some((pair) => pair.gold.id === unit.noteId);
  };
  const supportedUnit = (unit: Unit) => {
    if (unit.type === 'note')
      return alignment.notes.some((pair) => pair.produced.id === unit.noteId);
    const g = alignment.reverse.get(unit.node);
    if (g === undefined) return false;
    return unit.type === 'node' ? alignment.equal.has(g) : alignment.labels.has(g);
  };

  const missing = goldUnits.filter((unit) => !coveredUnit(unit));
  const counted = context.producedUnits.filter(
    (unit) => !(unit.type === 'node' && isPlaceholder(unit.node)),
  );
  const unsupported = counted.filter((unit) => !supportedUnit(unit));

  // Gaps on nodes the translator didn't produce at all aren't closed.
  const goldNodes = new Map(allNodes(gold.after.program).map((node) => [node.id, node]));
  const gaps = gapsOf(gold.after.program, context.inputs);
  const filled: FilledGap[] = [];
  for (const gap of gaps) {
    const node = goldNodes.get(gap.nodeId);
    const pair = node === undefined ? undefined : alignment.pairs.get(node);
    if (node === undefined || pair === undefined) continue;
    if (!closed(gap.code, node, pair, context.producedGaps)) continue;
    filled.push({
      code: gap.code,
      message: gap.message,
      node: renderedGold.ref(node),
      ...(isPlaceholder(node) ? { filledWith: context.renderedProduced.ref(pair) } : {}),
    });
  }

  // A filled hole is reported once, as filled, not also as missing and extra.
  const filledIds = new Set(filled.map((gap) => gap.node.id));
  const fillerIds = new Set(filled.flatMap((gap) => (gap.filledWith ? [gap.filledWith.id] : [])));

  const expectedChanged = changedNodes(before.program, gold.after.program);
  const refinement = [...expectedChanged].some((id) => id !== before.program.id);
  const sorted = (ids: Set<NodeId>) =>
    [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

  return {
    goldUnits: goldUnits.length,
    covered: goldUnits.length - missing.length,
    missing: outermost(missing, parents(gold.after.program)).filter(
      (ref) => !filledIds.has(ref.id),
    ),
    producedUnits: counted.length,
    supported: counted.length - unsupported.length,
    unsupported: outermost(unsupported, parents(produced.program)).filter(
      (ref) => !fillerIds.has(ref.id),
    ),
    gaps: gaps.length,
    filled,
    ...(refinement
      ? {
          placement: {
            expected: sorted(expectedChanged),
            actual: sorted(context.producedChanged),
            correct:
              expectedChanged.size === context.producedChanged.size &&
              [...expectedChanged].every((id) => context.producedChanged.has(id)),
          },
        }
      : {}),
    stability: stability(
      before.program,
      gold.after.program,
      produced.program,
      context.renderedBefore,
      context.renderedProduced,
    ),
  };
}

/**
 * Scores a step against the gold alternative most favorable to the
 * translator: fewest closed gaps, then the best coverage and support.
 * `produced` is the state after the translator's batch, or `before` if the
 * batch was rejected.
 */
export function compareStep(
  before: IrDocument,
  alternatives: readonly GoldAnswer[],
  produced: { document: IrDocument; batch: EditBatch },
  options: { inputs: readonly string[] },
): StepComparison {
  const producedGaps = new Map<NodeId, Set<string>>();
  for (const gap of gapsOf(produced.document.program, options.inputs)) {
    producedGaps.set(gap.nodeId, (producedGaps.get(gap.nodeId) ?? new Set()).add(gap.code));
  }
  const context = {
    inputs: options.inputs,
    producedGaps,
    renderedBefore: new Rendered(before.program),
    renderedProduced: new Rendered(produced.document.program),
    producedUnits: producedUnits(
      before.program,
      produced.document.program,
      new Rendered(produced.document.program),
    ),
    producedChanged: changedNodes(before.program, produced.document.program),
  };
  const asking = alternatives.map((alt) => asks(alt.batch));
  const expected = asking.every(Boolean) ? 'yes' : asking.some(Boolean) ? 'either' : 'no';
  let best: StepComparison | undefined;
  let bestScore = -Infinity;
  for (const [alternative, gold] of alternatives.entries()) {
    const result = compareWith(before, gold, produced.document, context);
    const score =
      -1000 * result.filled.length + result.covered + 2 * result.supported - result.producedUnits;
    if (score > bestScore) {
      bestScore = score;
      best = { alternative, ...result, asked: { actual: asks(produced.batch), expected } };
    }
  }
  if (best === undefined) throw new Error('A gold step needs at least one alternative');
  return best;
}
