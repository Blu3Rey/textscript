// The diagnostic catalog (ROADMAP.md §3.4, docs/adr/009).
//
// Every diagnostic states what's missing or inconsistent. None suggests a
// fix: "`seen` is used but never set up", not "add `seen = set()`".

import type { NodeId, Span } from '../ir/types';

/**
 * - `gap`: something the explanation hasn't covered yet.
 * - `warning`: something covered in a way that probably isn't meant.
 * - `info`: something worth seeing, such as an inference the tool made.
 */
export type Severity = 'gap' | 'warning' | 'info';

export const DIAGNOSTICS = {
  GAP001: { name: 'undeclared-name', severity: 'gap', summary: 'A name is used but never set up' },
  GAP002: { name: 'empty-block', severity: 'gap', summary: 'A block has no steps described' },
  GAP003: {
    name: 'missing-return',
    severity: 'gap',
    summary: 'Some path reaches the end without saying what to return',
  },
  GAP004: {
    name: 'unstated-condition',
    severity: 'gap',
    summary: 'A condition is mentioned but not stated',
  },
  GAP005: {
    name: 'vague-value',
    severity: 'gap',
    summary: 'A value is mentioned but not described',
  },
  GAP006: { name: 'unknown-input', severity: 'gap', summary: "A function's input isn't named" },
  GAP007: {
    name: 'ambiguous-reference',
    severity: 'gap',
    summary: 'A reference could mean more than one thing',
  },
  GAP008: { name: 'unnamed', severity: 'gap', summary: 'Something is referred to but never named' },
  GAP009: {
    name: 'step-in-words-only',
    severity: 'gap',
    summary: 'A step is described in words but not how it works',
  },
  WARN001: { name: 'unused-name', severity: 'warning', summary: 'A name is set up but never used' },
  WARN002: { name: 'unreachable', severity: 'warning', summary: 'A step can never run' },
  WARN003: {
    name: 'shadowing',
    severity: 'warning',
    summary: 'A name is set up again inside a function, hiding the outer one',
  },
  WARN004: {
    name: 'unsupported-inference',
    severity: 'warning',
    summary: "Something marked as inferred doesn't fit its inference rule",
  },
  WARN005: {
    name: 'used-before-set',
    severity: 'warning',
    summary: 'A name is used before it is set up',
  },
  WARN006: {
    name: 'jump-outside-loop',
    severity: 'warning',
    summary: '`break` or `continue` is not inside a loop',
  },
  WARN007: {
    name: 'duplicate-parameter',
    severity: 'warning',
    summary: 'A function has two inputs with the same name',
  },
  INFO001: { name: 'inferred', severity: 'info', summary: 'Added by an allowed inference rule' },
} as const satisfies Record<string, { name: string; severity: Severity; summary: string }>;

export type DiagnosticCode = keyof typeof DIAGNOSTICS;

export interface Diagnostic {
  code: DiagnosticCode;
  name: (typeof DIAGNOSTICS)[DiagnosticCode]['name'];
  severity: Severity;
  /** The node the diagnostic is about. */
  nodeId: NodeId;
  /** States what's missing; never the fix. */
  message: string;
  /** Other nodes involved, such as every use of an undeclared name. */
  related: NodeId[];
  /** The user's words involved. */
  spans: Span[];
  /** The text of `spans`, when the analysis was given the utterances. */
  quotes: string[];
}
