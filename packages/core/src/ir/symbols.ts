// Symbol table: which names are defined where, and what each use refers to.
//
// Scoping follows Python, the first output language (docs/adr/003): only
// the program and functions create scopes, and a name assigned anywhere in a
// function is local to that whole function. Loops and ifs don't create
// scopes. The table records facts only; deciding what's a gap (a name used
// but never defined, used before it's defined, unused) is the analyzer's job.

import { children } from './tree';
import type { Block, FunctionDef, IrNode, NodeId, Program, Stmt, Target } from './types';

export type ScopeKind = 'module' | 'function';

export interface Scope {
  /** The ID of the `Program` or `FunctionDef` that owns the scope. */
  id: NodeId;
  kind: ScopeKind;
  /** The enclosing scope; absent for the module scope. */
  parent?: NodeId;
}

/** One place a name appears. `nodeId` is the `Name` node. */
export interface Occurrence {
  nodeId: NodeId;
  /** The scope the occurrence is in. */
  scope: NodeId;
  /**
   * Position in evaluation order across the whole program. In `x = x + 1`
   * the use of `x` comes before its definition.
   */
  order: number;
}

export interface SymbolInfo {
  /** `<scope id>:<name>`, stable while the scope and name exist. */
  id: string;
  name: string;
  /** The scope the symbol is defined in. */
  scope: NodeId;
  definitions: Occurrence[];
  uses: Occurrence[];
}

export type Resolution =
  { kind: 'symbol'; symbolId: string } | { kind: 'builtin' } | { kind: 'unresolved' };

export interface Reference extends Occurrence {
  name: string;
  resolution: Resolution;
}

export interface SymbolTable {
  /** In document order, module scope first. */
  scopes: Scope[];
  /** In order of first definition. */
  symbols: SymbolInfo[];
  /** Every use of a name, in evaluation order. */
  references: Reference[];
}

export interface SymbolTableOptions {
  /**
   * Names that are always available, such as a language's built-in
   * functions. The IR is language-neutral, so the renderer supplies these.
   */
  builtins?: Iterable<string>;
}

interface PendingUse {
  nodeId: NodeId;
  name: string;
  scope: NodeId;
  order: number;
}

export function buildSymbolTable(program: Program, options: SymbolTableOptions = {}): SymbolTable {
  const builtins = new Set(options.builtins);
  const moduleScope: Scope = { id: program.id, kind: 'module' };
  const scopes: Scope[] = [moduleScope];
  const scopeById = new Map<NodeId, Scope>([[program.id, moduleScope]]);
  const symbols = new Map<string, SymbolInfo>();
  const pendingUses: PendingUse[] = [];
  let order = 0;

  const define = (nodeId: NodeId, name: string, scope: NodeId) => {
    const id = `${scope}:${name}`;
    let symbol = symbols.get(id);
    if (symbol === undefined) {
      symbol = { id, name, scope, definitions: [], uses: [] };
      symbols.set(id, symbol);
    }
    symbol.definitions.push({ nodeId, scope, order: order++ });
  };

  const use = (nodeId: NodeId, name: string, scope: NodeId) => {
    pendingUses.push({ nodeId, name, scope, order: order++ });
  };

  /** Visits an expression subtree. Expressions never bind names, so every Name is a use. */
  const visitExpr = (node: IrNode, scope: NodeId) => {
    if (node.kind === 'Name') {
      use(node.id, node.name, scope);
      return;
    }
    for (const slot of children(node)) visitExpr(slot.node, scope);
  };

  const visitAssignedTarget = (target: Target, scope: NodeId) => {
    switch (target.kind) {
      case 'Name':
        define(target.id, target.name, scope);
        return;
      case 'NameHole':
        return;
      case 'Index':
        visitExpr(target.object, scope);
        visitExpr(target.index, scope);
        return;
      case 'Attribute':
        visitExpr(target.object, scope);
        return;
    }
  };

  const visitBlock = (block: Block, scope: NodeId) => {
    for (const stmt of block.stmts) visitStmt(stmt, scope);
  };

  const visitFunction = (fn: FunctionDef, scope: NodeId) => {
    if (fn.name.kind === 'Name') define(fn.name.id, fn.name.name, scope);
    const inner: Scope = { id: fn.id, kind: 'function', parent: scope };
    scopes.push(inner);
    scopeById.set(fn.id, inner);
    for (const param of fn.params) {
      if (param.kind === 'Name') define(param.id, param.name, fn.id);
    }
    visitBlock(fn.body, fn.id);
  };

  const visitStmt = (stmt: Stmt, scope: NodeId) => {
    switch (stmt.kind) {
      case 'FunctionDef':
        visitFunction(stmt, scope);
        return;
      case 'ForEach':
        visitExpr(stmt.iterable, scope);
        if (stmt.target.kind === 'Name') define(stmt.target.id, stmt.target.name, scope);
        visitBlock(stmt.body, scope);
        return;
      case 'ForRange':
        if (stmt.start !== undefined) visitExpr(stmt.start, scope);
        visitExpr(stmt.stop, scope);
        if (stmt.step !== undefined) visitExpr(stmt.step, scope);
        if (stmt.target.kind === 'Name') define(stmt.target.id, stmt.target.name, scope);
        visitBlock(stmt.body, scope);
        return;
      case 'While':
        visitExpr(stmt.cond, scope);
        visitBlock(stmt.body, scope);
        return;
      case 'If':
        visitExpr(stmt.cond, scope);
        visitBlock(stmt.body, scope);
        for (const elif of stmt.elifs) {
          visitExpr(elif.cond, scope);
          visitBlock(elif.body, scope);
        }
        if (stmt.orelse !== undefined) visitBlock(stmt.orelse, scope);
        return;
      case 'Assign':
        // The value is evaluated before the target is bound.
        visitExpr(stmt.value, scope);
        visitAssignedTarget(stmt.target, scope);
        return;
      case 'Update':
        // An update reads its target (`count += 1`, `seen.add(x)`), so a
        // plain name is a use, not a definition.
        if (stmt.target.kind === 'Name' || stmt.target.kind === 'NameHole') {
          visitExpr(stmt.target, scope);
        } else {
          visitAssignedTarget(stmt.target, scope);
        }
        visitExpr(stmt.value, scope);
        return;
      case 'Return':
        if (stmt.value !== undefined) visitExpr(stmt.value, scope);
        return;
      case 'ExprStmt':
        visitExpr(stmt.expr, scope);
        return;
      case 'Break':
      case 'Continue':
      case 'IntentStmt':
      case 'BlockHole':
        return;
    }
  };

  for (const stmt of program.body) visitStmt(stmt, program.id);

  // Resolve after the walk: a name assigned anywhere in a scope belongs to
  // that scope, even where it's used before the assignment.
  const resolve = (name: string, scope: NodeId): Resolution => {
    let current = scopeById.get(scope);
    while (current !== undefined) {
      const symbol = symbols.get(`${current.id}:${name}`);
      if (symbol !== undefined) return { kind: 'symbol', symbolId: symbol.id };
      current = current.parent === undefined ? undefined : scopeById.get(current.parent);
    }
    return builtins.has(name) ? { kind: 'builtin' } : { kind: 'unresolved' };
  };

  const references = pendingUses.map((pending): Reference => {
    const resolution = resolve(pending.name, pending.scope);
    if (resolution.kind === 'symbol') {
      symbols.get(resolution.symbolId)?.uses.push({
        nodeId: pending.nodeId,
        scope: pending.scope,
        order: pending.order,
      });
    }
    return { ...pending, resolution };
  });

  return { scopes, symbols: [...symbols.values()], references };
}

/** The symbol a `Name` node defines or refers to, if any. */
export function symbolAt(table: SymbolTable, nameNodeId: NodeId): SymbolInfo | undefined {
  const reference = table.references.find((ref) => ref.nodeId === nameNodeId);
  if (reference !== undefined) {
    const { resolution } = reference;
    return resolution.kind === 'symbol'
      ? table.symbols.find((symbol) => symbol.id === resolution.symbolId)
      : undefined;
  }
  return table.symbols.find((symbol) =>
    symbol.definitions.some((definition) => definition.nodeId === nameNodeId),
  );
}
