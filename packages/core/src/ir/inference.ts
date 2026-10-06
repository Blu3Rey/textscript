/**
 * The allowed-inference rules (ROADMAP.md §3.5, docs/adr/004).
 *
 * A node may skip provenance only if one of these rules produced it. The
 * list is deliberately short; adding a rule needs corpus cases showing it
 * doesn't fill real gaps. Each rule's checker lives with the analyzer (S4).
 */
export const INFERENCE_RULE_IDS = [
  /** Name a loop variable from the iterable's name: "the numbers" → `num`. */
  'INF-LOOPVAR',
  /** Use `i`/`j` for index loops when no name is given. */
  'INF-INDEXVAR',
  /** `range(len(x))` for "each index of x". */
  'INF-RANGE-BOUNDS',
  /** Map common synonyms to one operation: "put it in the set" → `add`. */
  'INF-SYNONYM',
  /** Plural collection names when the user names the item: "the number list" → `nums`. */
  'INF-PLURAL-NAME',
  /** Close a block when the next statement clearly starts outside it. */
  'INF-BLOCK-END',
] as const;

export type InferenceRuleId = (typeof INFERENCE_RULE_IDS)[number];
