import type { NodeId } from './types';

const NODE_ID = /^n([1-9][0-9]*)$/;

/**
 * Hands out node IDs in increasing order. IDs are never reused: the
 * allocator's position is saved as `IrDocument.nextId`, so a document
 * reloaded later keeps counting from where it stopped.
 */
export interface IdAllocator {
  allocate(): NodeId;
  /** The number the next allocated ID will have. */
  readonly next: number;
}

export function createIdAllocator(next = 1): IdAllocator {
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new RangeError(`next must be a positive integer, got ${String(next)}`);
  }
  let counter = next;
  return {
    allocate() {
      const id = `n${String(counter)}`;
      counter += 1;
      return id;
    },
    get next() {
      return counter;
    },
  };
}

/** The numeric part of a node ID, or `undefined` if the ID is malformed. */
export function nodeIdNumber(id: NodeId): number | undefined {
  const match = NODE_ID.exec(id);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
