// The allowed-inference rules (ROADMAP.md §3.5, docs/adr/004) with checkers
// that verify a node marked `inferred` really fits its rule. The analyzer
// reports misfits (WARN004); the provenance validator (S8) will reject them.
//
// Checks are structural: they confirm the node is the kind of thing the
// rule covers, in the place the rule covers. Whether the words justify it
// is S8's job.

import type { InferenceRuleId } from '../ir/inference';
import type { Position } from '../ir/tree';
import type { IrNode } from '../ir/types';

export interface InferenceRule {
  id: InferenceRuleId;
  description: string;
  example: string;
  /**
   * Rules that reinterpret what the user said (a synonym, a plural) still
   * need the words; rules that supply something unsaid (a loop variable's
   * name) don't.
   */
  requiresProvenance: boolean;
  /** Whether `node`, at `position`, is something this rule covers. */
  fits: (node: IrNode, position: Position | undefined) => boolean;
}

const INDEX_NAMES: ReadonlySet<string> = new Set(['i', 'j', 'k']);

function isStatementSlot(position: Position | undefined): boolean {
  return (
    (position?.parent.kind === 'Program' && position.field === 'body') ||
    (position?.parent.kind === 'Block' && position.field === 'stmts')
  );
}

export const INFERENCE_RULES: Readonly<Record<InferenceRuleId, InferenceRule>> = {
  'INF-LOOPVAR': {
    id: 'INF-LOOPVAR',
    description: "the loop variable is named after the collection's name",
    example: '"loop through the numbers" → `for num in nums`',
    requiresProvenance: false,
    fits: (node, position) =>
      node.kind === 'Name' &&
      position?.parent.kind === 'ForEach' &&
      position.field === 'target' &&
      position.parent.iterable.kind === 'Name' &&
      position.parent.iterable.name.startsWith(node.name),
  },
  'INF-INDEXVAR': {
    id: 'INF-INDEXVAR',
    description: 'the index variable is named `i`, `j` or `k`',
    example: '"loop over the indices" → `for i in range(len(nums))`',
    requiresProvenance: false,
    fits: (node, position) =>
      node.kind === 'Name' &&
      INDEX_NAMES.has(node.name) &&
      position?.parent.kind === 'ForRange' &&
      position.field === 'target',
  },
  'INF-RANGE-BOUNDS': {
    id: 'INF-RANGE-BOUNDS',
    description: 'looping over every index of a collection uses `len()` as the bound',
    example: '"each index of nums" → `range(len(nums))`',
    requiresProvenance: false,
    fits: (node, position) =>
      node.kind === 'Call' &&
      node.callee.kind === 'Name' &&
      node.callee.name === 'len' &&
      node.args.length === 1 &&
      position?.parent.kind === 'ForRange' &&
      position.field === 'stop',
  },
  'INF-SYNONYM': {
    id: 'INF-SYNONYM',
    description: 'a common synonym is mapped to one operation',
    example: '"put it in the set" → `.add()`',
    requiresProvenance: true,
    fits: (node) => node.kind === 'Update',
  },
  'INF-PLURAL-NAME': {
    id: 'INF-PLURAL-NAME',
    description: 'a collection is named in the plural from the item the user named',
    example: '"the number list" → `nums`',
    requiresProvenance: true,
    fits: (node) => node.kind === 'Name',
  },
  'INF-BLOCK-END': {
    id: 'INF-BLOCK-END',
    description: 'a step is placed after a block that the words clearly end',
    example: '"after the loop, return false"',
    requiresProvenance: true,
    fits: (_, position) => isStatementSlot(position),
  },
};

/** Whether an inferred node fits its rule, provenance requirement included. */
export function fitsInferenceRule(node: IrNode, position: Position | undefined): boolean {
  if (node.inferred === undefined) return true;
  const rule = INFERENCE_RULES[node.inferred];
  return rule.fits(node, position) && (!rule.requiresProvenance || node.provenance.length > 0);
}
