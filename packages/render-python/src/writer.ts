// Accumulates tokens line by line and records the text range of every node.
//
// A renderer opens a frame for each node, emits its tokens, and closes it.
// A frame's range runs from its first token to the end of its last, so
// indentation and the parentheses a parent adds around it are excluded.

import type { NodeId } from '@textscript/core';
import type { Position, SourceRange, Token, TokenKind } from './output';

export const INDENT_UNIT = '    ';

interface Frame {
  id: NodeId;
  isNote: boolean;
  start?: Position;
  end?: Position;
}

export class Writer {
  readonly lines: Token[][] = [];
  readonly nodeRanges = new Map<NodeId, SourceRange>();
  readonly noteRanges = new Map<NodeId, SourceRange>();

  #current: Token[] = [];
  #line = 0;
  #column = 0;
  #offset = 0;
  #depth = 0;
  #frames: Frame[] = [];
  /** TODO reasons to append to the current line before it ends. */
  #todos: string[] = [];

  get depth(): number {
    return this.#depth;
  }

  position(): Position {
    return { line: this.#line, column: this.#column, offset: this.#offset };
  }

  indent(): void {
    this.#depth += 1;
  }

  dedent(): void {
    this.#depth -= 1;
  }

  token(kind: TokenKind, text: string): void {
    if (this.#current.length === 0 && this.#depth > 0) {
      this.#push({ kind: 'indent', text: INDENT_UNIT.repeat(this.#depth) });
    }
    const start = this.position();
    const owner = this.#frames.findLast((frame) => !frame.isNote);
    const note = this.#frames.at(-1)?.isNote === true ? this.#frames.at(-1) : undefined;
    this.#push({
      kind,
      text,
      ...(owner === undefined ? {} : { nodeId: owner.id }),
      ...(note === undefined ? {} : { noteId: note.id }),
    });
    const end = this.position();
    for (const frame of this.#frames) {
      frame.start ??= start;
      frame.end = end;
    }
  }

  /**
   * Queues a reason for the TODO comment at the end of the current line.
   * Several on one line share one comment: `# TODO(textscript): a; b`.
   */
  todo(reason: string): void {
    this.#todos.push(reason);
  }

  /** Ends the current line, flushing any queued TODO comment first. */
  newline(): void {
    if (this.#todos.length > 0) {
      this.token('space', '  ');
      this.token('comment', `# TODO(textscript): ${this.#todos.join('; ')}`);
      this.#todos = [];
    }
    this.lines.push(this.#current);
    this.#current = [];
    this.#line += 1;
    this.#column = 0;
    this.#offset += 1;
  }

  /** Emits an empty line. Must be called at the start of a line. */
  blankLine(): void {
    if (this.#current.length > 0) throw new Error('blankLine() called mid-line');
    this.newline();
  }

  open(id: NodeId, isNote = false): void {
    this.#frames.push({ id, isNote });
  }

  close(): void {
    const frame = this.#frames.pop();
    if (frame === undefined) throw new Error('close() without open()');
    const here = this.position();
    const range = { start: frame.start ?? here, end: frame.end ?? here };
    (frame.isNote ? this.noteRanges : this.nodeRanges).set(frame.id, range);
  }

  /** Renders `body` inside a frame for node `id`. */
  node(id: NodeId, body: () => void): void {
    this.open(id);
    body();
    this.close();
  }

  text(): string {
    if (this.#current.length > 0) throw new Error('text() called mid-line');
    return this.lines.map((line) => line.map((token) => token.text).join('') + '\n').join('');
  }

  #push(token: Token): void {
    this.#current.push(token);
    this.#column += token.text.length;
    this.#offset += token.text.length;
  }
}
