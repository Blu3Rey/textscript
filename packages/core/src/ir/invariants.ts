// Rules that span more than one node, so the schemas can't check them.
// A document is valid when it matches IrDocumentSchema and has no issues here.

import { nodeIdNumber } from './ids';
import { TEMP_ID_PATTERN } from './schema';
import { walk } from './tree';
import type { IrDocument, IrNode, NodeId, NodeKind, Note, Span } from './types';

export type InvariantCode =
  /** Two nodes or notes share an ID. */
  | 'duplicate-id'
  /** A temporary ID (`t…`) from an edit batch was never replaced. */
  | 'temp-id'
  /** An ID is not below `nextId`, so the allocator could hand it out again. */
  | 'id-not-below-next'
  /** A node that needs a source has no provenance and no inference rule (ADR-004). */
  | 'missing-provenance'
  /** A note has no provenance; notes always come from the user's words. */
  | 'note-missing-provenance'
  /** A span's `start` is not before its `end`. */
  | 'invalid-span'
  /** A `BlockHole` shares its block with other statements. */
  | 'block-hole-not-alone'
  /** A `BlockHole` sits directly in the program body instead of a block. */
  | 'block-hole-outside-block'
  /** A `RefHole` candidate is not a node in the document. */
  | 'unknown-candidate';

export interface InvariantIssue {
  code: InvariantCode;
  /** The node or note the issue is about. */
  nodeId: NodeId;
  message: string;
}

/**
 * Kinds that may have empty provenance without an inference rule: holes
 * (they mark what wasn't said) and structural containers.
 */
const PROVENANCE_EXEMPT: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'Program',
  'Block',
  'BlockHole',
  'CondHole',
  'ExprHole',
  'NameHole',
  'RefHole',
]);

/** Checks a shape-valid document. Issues are returned in document order. */
export function checkInvariants(doc: IrDocument): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  const seen = new Set<NodeId>();
  const nodeIds = new Set<NodeId>();
  const refHoles: Extract<IrNode, { kind: 'RefHole' }>[] = [];

  const checkId = (id: NodeId) => {
    if (seen.has(id)) {
      issues.push({ code: 'duplicate-id', nodeId: id, message: `ID ${id} is used more than once` });
    }
    seen.add(id);
    if (TEMP_ID_PATTERN.test(id)) {
      issues.push({
        code: 'temp-id',
        nodeId: id,
        message: `Temporary ID ${id} was never assigned a permanent one`,
      });
    }
    const number = nodeIdNumber(id);
    if (number !== undefined && number >= doc.nextId) {
      issues.push({
        code: 'id-not-below-next',
        nodeId: id,
        message: `ID ${id} is not below nextId ${String(doc.nextId)}`,
      });
    }
  };

  const checkSpans = (id: NodeId, spans: readonly Span[]) => {
    for (const span of spans) {
      if (span.start >= span.end) {
        issues.push({
          code: 'invalid-span',
          nodeId: id,
          message: `Span ${String(span.start)}..${String(span.end)} in ${span.utteranceId} is empty or reversed`,
        });
      }
    }
  };

  const checkNote = (note: Note) => {
    checkId(note.id);
    checkSpans(note.id, note.provenance);
    if (note.provenance.length === 0) {
      issues.push({
        code: 'note-missing-provenance',
        nodeId: note.id,
        message: `Note ${note.id} has no provenance`,
      });
    }
  };

  walk(doc.program, (node, { position }) => {
    checkId(node.id);
    nodeIds.add(node.id);
    checkSpans(node.id, node.provenance);
    for (const note of node.notes ?? []) checkNote(note);

    if (
      node.provenance.length === 0 &&
      node.inferred === undefined &&
      !PROVENANCE_EXEMPT.has(node.kind)
    ) {
      issues.push({
        code: 'missing-provenance',
        nodeId: node.id,
        message: `${node.kind} ${node.id} has no provenance and no inference rule`,
      });
    }

    if (node.kind === 'BlockHole' && position?.parent.kind === 'Program') {
      issues.push({
        code: 'block-hole-outside-block',
        nodeId: node.id,
        message: `BlockHole ${node.id} is in the program body; holes for blocks belong in a Block`,
      });
    }
    if (node.kind === 'Block' && node.stmts.length > 1) {
      for (const stmt of node.stmts) {
        if (stmt.kind === 'BlockHole') {
          issues.push({
            code: 'block-hole-not-alone',
            nodeId: stmt.id,
            message: `BlockHole ${stmt.id} must be the only statement in block ${node.id}`,
          });
        }
      }
    }
    if (node.kind === 'RefHole') refHoles.push(node);
  });

  // Candidates may point anywhere in the tree, so check them after the walk.
  for (const hole of refHoles) {
    for (const candidate of hole.candidates) {
      if (!nodeIds.has(candidate)) {
        issues.push({
          code: 'unknown-candidate',
          nodeId: hole.id,
          message: `RefHole ${hole.id} lists candidate ${candidate}, which is not a node`,
        });
      }
    }
  }
  return issues;
}
