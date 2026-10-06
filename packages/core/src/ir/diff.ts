// Structural diff between two versions of a program, by node ID. The UI uses
// it to animate a change: fade in what was added, fade out what was removed,
// flash what changed in place, and slide what moved.

import { CHILD_FIELDS, allNodes, children, indexTree } from './tree';
import type { IrNode, NodeId, Program } from './types';

export interface IrDiff {
  /** In the new version only, in its document order. */
  added: NodeId[];
  /** In the old version only, in its document order. */
  removed: NodeId[];
  /**
   * In both, with different content of their own: fields, labels, notes,
   * provenance. Changes to children show up as the children's own entries.
   */
  changed: NodeId[];
  /** In both, but under a different parent or field, or reordered among siblings. */
  moved: NodeId[];
}

/** A node's own content, with child nodes left out. */
function ownContent(node: IrNode): string {
  const childFields: readonly string[] = CHILD_FIELDS[node.kind];
  return JSON.stringify(node, (key, value: unknown) =>
    key !== '' && childFields.includes(key) ? undefined : value,
  );
}

/** Indices (into `sequence`) of a longest strictly increasing subsequence. */
function longestIncreasing(sequence: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = [];
  sequence.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sequence[tails[mid] ?? 0] ?? 0) < value) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? (tails[lo - 1] ?? -1) : -1;
    tails[lo] = i;
  });
  const kept = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i] ?? -1) kept.add(i);
  return kept;
}

export function diffPrograms(before: Program, after: Program): IrDiff {
  const oldIndex = indexTree(before);
  const newIndex = indexTree(after);
  const diff: IrDiff = { added: [], removed: [], changed: [], moved: [] };
  const moved = new Set<NodeId>();

  for (const node of allNodes(before)) {
    if (!newIndex.has(node.id)) diff.removed.push(node.id);
  }

  for (const node of allNodes(after)) {
    const old = oldIndex.get(node.id);
    if (old === undefined) {
      diff.added.push(node.id);
      continue;
    }
    if (old.node !== node && ownContent(old.node) !== ownContent(node)) diff.changed.push(node.id);
    const oldPosition = old.position;
    const newPosition = newIndex.get(node.id)?.position;
    if (
      oldPosition?.parent.id !== newPosition?.parent.id ||
      oldPosition?.field !== newPosition?.field
    ) {
      moved.add(node.id);
    }
  }

  // Reorders within one list: siblings that kept their parent and field but
  // fell out of the longest run that stayed in order.
  for (const node of allNodes(after)) {
    const stayed = new Map<string, { id: NodeId; oldIndex: number }[]>();
    for (const slot of children(node)) {
      const old = oldIndex.get(slot.node.id)?.position;
      if (slot.index === undefined || old?.index === undefined) continue;
      if (old.parent.id !== node.id || old.field !== slot.field) continue;
      const list = stayed.get(slot.field) ?? [];
      list.push({ id: slot.node.id, oldIndex: old.index });
      stayed.set(slot.field, list);
    }
    for (const list of stayed.values()) {
      const inOrder = longestIncreasing(list.map((entry) => entry.oldIndex));
      list.forEach((entry, i) => {
        if (!inOrder.has(i)) moved.add(entry.id);
      });
    }
  }

  diff.moved = allNodes(after)
    .map((node) => node.id)
    .filter((id) => moved.has(id));
  return diff;
}

export function isEmptyDiff(diff: IrDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.moved.length === 0
  );
}
