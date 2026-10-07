// Node references in console commands:
//
//   root      the program
//   n12       a node by ID
//   h2        the second hole, in document order
//   @label    a node by its label (spaces written as dashes)

import { allNodes, indexTree, type NodeId, type Program } from '@textscript/core';
import { holes } from './view';

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

function slug(text: string): string {
  return text.trim().toLowerCase().replaceAll(/\s+/g, '-');
}

export function resolveRef(program: Program, ref: string): NodeId {
  if (ref === 'root') return program.id;
  if (/^n\d+$/.test(ref)) {
    if (!indexTree(program).has(ref)) throw new RefError(`There is no node ${ref}`);
    return ref;
  }
  const hole = /^h(\d+)$/.exec(ref);
  if (hole !== null) {
    const all = holes(program);
    const id = all[Number(hole[1]) - 1];
    if (id === undefined) {
      throw new RefError(
        `There is no hole ${ref}; there ${all.length === 1 ? 'is 1 hole' : `are ${String(all.length)} holes`}`,
      );
    }
    return id;
  }
  if (ref.startsWith('@')) {
    const wanted = slug(ref.slice(1));
    const node = allNodes(program).find((n) => n.label !== undefined && slug(n.label) === wanted);
    if (node === undefined) throw new RefError(`No node is labeled "${ref.slice(1)}"`);
    return node.id;
  }
  throw new RefError(`"${ref}" is not a reference; use root, n12, h2 or @label`);
}
