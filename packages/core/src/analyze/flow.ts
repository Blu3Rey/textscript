// Control flow, only as far as the analyzer needs it: whether a statement
// can finish and let the next one run.

import type { Block, Stmt } from '../ir/types';

/** True if a `break` in these statements would leave the enclosing loop. */
function breaksOut(stmts: readonly Stmt[]): boolean {
  return stmts.some((stmt) => {
    switch (stmt.kind) {
      case 'Break':
        return true;
      case 'If':
        return (
          breaksOut(stmt.body.stmts) ||
          stmt.elifs.some((elif) => breaksOut(elif.body.stmts)) ||
          (stmt.orelse !== undefined && breaksOut(stmt.orelse.stmts))
        );
      // A break inside a nested loop or function leaves that, not ours.
      default:
        return false;
    }
  });
}

/**
 * Whether control can continue past `stmt`. `return`, `break` and
 * `continue` never do; an `if` doesn't when every branch, `else` included,
 * ends that way; `while True` doesn't unless it can break out.
 */
export function completesNormally(stmt: Stmt): boolean {
  switch (stmt.kind) {
    case 'Return':
    case 'Break':
    case 'Continue':
      return false;
    case 'If':
      return (
        stmt.orelse === undefined ||
        fallsThrough(stmt.body) ||
        stmt.elifs.some((elif) => fallsThrough(elif.body)) ||
        fallsThrough(stmt.orelse)
      );
    case 'While':
      return (
        !(stmt.cond.kind === 'Literal' && stmt.cond.value === true) || breaksOut(stmt.body.stmts)
      );
    default:
      return true;
  }
}

/** Whether control can reach the end of a statement list. */
export function fallsThrough(block: Block | readonly Stmt[]): boolean {
  const stmts = 'stmts' in block ? block.stmts : block;
  return stmts.every(completesNormally);
}
