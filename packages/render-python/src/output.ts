// What a renderer produces: text, the tokens that make it up, and a source
// map from IR nodes to text ranges. Nothing here is Python-specific, so
// renderers for other languages (S13) can share these types.

import type { NodeId } from '@textscript/core';

/**
 * - `export`: plain source that always parses. Holes become placeholders
 *   (`...`, `__hole__("…")`) with TODO comments.
 * - `ui`: for display. Holes become `⟨reason⟩` chips the UI can decorate.
 */
export type RenderMode = 'export' | 'ui';

export type TokenKind =
  | 'indent'
  | 'space'
  | 'keyword'
  | 'name'
  | 'operator'
  | 'punctuation'
  | 'number'
  | 'string'
  | 'constant'
  | 'hole'
  | 'comment';

export interface Token {
  kind: TokenKind;
  text: string;
  /** The innermost node that produced the token. Absent for indentation. */
  nodeId?: NodeId;
  /** Set on the comment token that renders a note. */
  noteId?: NodeId;
}

/** A place in the rendered text. All fields are 0-based. */
export interface Position {
  line: number;
  column: number;
  /** Offset into `RenderResult.text`. */
  offset: number;
}

/** A span of rendered text; `end` is exclusive. */
export interface SourceRange {
  start: Position;
  end: Position;
}

export interface SourceMap {
  /** Every node in the program, including holes. */
  nodes: ReadonlyMap<NodeId, SourceRange>;
  /** The comment lines that render each note. */
  notes: ReadonlyMap<NodeId, SourceRange>;
}

export interface RenderResult {
  mode: RenderMode;
  /** The full text. Ends with a newline unless the program is empty. */
  text: string;
  /** Tokens per line. Each line's token texts concatenate to that line. */
  lines: Token[][];
  sourceMap: SourceMap;
}

/**
 * The innermost node whose range contains `offset`, for mapping a cursor or
 * hover position back to the IR.
 */
export function nodeAtOffset(result: RenderResult, offset: number): NodeId | undefined {
  let best: { id: NodeId; size: number } | undefined;
  for (const [id, range] of result.sourceMap.nodes) {
    if (range.start.offset <= offset && offset < range.end.offset) {
      const size = range.end.offset - range.start.offset;
      if (best === undefined || size < best.size) best = { id, size };
    }
  }
  return best?.id;
}

/** The rendered text of one node. */
export function textOf(result: RenderResult, nodeId: NodeId): string | undefined {
  const range = result.sourceMap.nodes.get(nodeId);
  return range && result.text.slice(range.start.offset, range.end.offset);
}
