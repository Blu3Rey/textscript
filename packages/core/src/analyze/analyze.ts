// Turns a program into the list of what's missing (docs/adr/009). Stateless
// and recomputed from scratch for every version, so it never drifts.

import { buildSymbolTable, type SymbolTable } from '../ir/symbols';
import { allNodes, indexTree, walk, type Position } from '../ir/tree';
import type { FunctionDef, IrNode, NodeId, Program, Span, Stmt } from '../ir/types';
import { quoteSpan, type Utterance } from '../session/tokenize';
import { DIAGNOSTICS, type Diagnostic, type DiagnosticCode } from './diagnostics';
import { completesNormally, fallsThrough } from './flow';
import { INFERENCE_RULES, fitsInferenceRule } from './inference-rules';

export interface AnalyzeOptions {
  /**
   * Names the language always provides, such as Python's `len`
   * (`PYTHON_BUILTINS` in render-python). Uses of them aren't gaps.
   */
  builtins?: Iterable<string>;
  /**
   * Names the problem gives as inputs, such as `nums`. Uses of them aren't
   * gaps, and they count as named inputs in the coverage summary.
   */
  inputs?: Iterable<string>;
  /** When given, each diagnostic quotes the words its spans cover. */
  utterances?: readonly Utterance[];
}

/**
 * What the explanation covers, for the practice checklist (S11). It
 * describes coverage; it never judges whether the approach is right.
 */
export interface CoverageSummary {
  /** Something has been described. */
  approach: boolean;
  /**
   * `named`: the function's inputs (or the problem's) are known.
   * `unnamed`: a function input is a hole. `unknown`: there's no function
   * and no inputs were given.
   */
  inputs: 'named' | 'unnamed' | 'unknown';
  inputNames: string[];
  /**
   * `all-paths`: every path that ends says what it returns.
   * `some-paths`: something is returned, but some path ends without saying.
   * `none`: nothing is returned anywhere.
   */
  returns: 'all-paths' | 'some-paths' | 'none';
  /** Notes tagged as edge cases. */
  edgeCases: NodeId[];
  /** Notes tagged as complexity. */
  complexity: NodeId[];
  /** How many `gap` diagnostics there are. */
  gaps: number;
}

export interface Analysis {
  diagnostics: Diagnostic[];
  coverage: CoverageSummary;
  symbols: SymbolTable;
}

function code(name: string): string {
  return `\`${name}\``;
}

/** Return statements with a value, not counting nested functions. */
function valueReturns(stmts: readonly Stmt[]): Stmt[] {
  const found: Stmt[] = [];
  for (const stmt of stmts) {
    walk(stmt, (node) => {
      if (node.kind === 'FunctionDef') return false;
      if (node.kind === 'Return' && node.value !== undefined) found.push(node);
      return true;
    });
  }
  return found;
}

/** How the statements' paths end, for GAP003 and the coverage summary. */
function returnStatus(stmts: readonly Stmt[]): CoverageSummary['returns'] {
  if (valueReturns(stmts).length === 0) return 'none';
  return fallsThrough(stmts) ? 'some-paths' : 'all-paths';
}

function functionLabel(fn: FunctionDef): string {
  return fn.name.kind === 'Name' ? `the function ${code(fn.name.name)}` : 'the function';
}

/** How to refer to the statement or clause that owns a block. */
function blockOwner(owner: IrNode | undefined, field: string | undefined): string {
  switch (owner?.kind) {
    case 'ForEach':
      return owner.iterable.kind === 'Name'
        ? `the loop over ${code(owner.iterable.name)}`
        : 'the loop';
    case 'ForRange':
      return owner.target.kind === 'Name' ? `the ${code(owner.target.name)} loop` : 'the loop';
    case 'While':
      return 'the while loop';
    case 'If':
      return field === 'orelse' ? 'the else branch' : 'the if branch';
    case 'Elif':
      return 'the elif branch';
    case 'FunctionDef':
      return functionLabel(owner);
    default:
      return 'this block';
  }
}

function terminatorLabel(stmt: Stmt): string {
  switch (stmt.kind) {
    case 'Return':
      return code('return');
    case 'Break':
      return code('break');
    case 'Continue':
      return code('continue');
    case 'If':
      return `an ${code('if')} whose every branch ends early`;
    default:
      return 'a loop that never ends';
  }
}

/** Ends a sentence with a period unless the text already ends with punctuation. */
function sentence(text: string): string {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function analyze(program: Program, options: AnalyzeOptions = {}): Analysis {
  const inputs = new Set(options.inputs);
  const symbols = buildSymbolTable(program, { builtins: [...(options.builtins ?? []), ...inputs] });
  const index = indexTree(program);
  const nodes = allNodes(program);
  const order = new Map(nodes.map((node, i) => [node.id, i]));
  const positionOf = (id: NodeId): Position | undefined => index.get(id)?.position;
  const nodeOf = (id: NodeId): IrNode | undefined => index.get(id)?.node;
  const diagnostics: Diagnostic[] = [];

  const report = (
    diagnosticCode: DiagnosticCode,
    node: IrNode,
    message: string,
    extra: { related?: NodeId[]; spans?: Span[] } = {},
  ) => {
    const spans = extra.spans ?? node.provenance;
    const entry = DIAGNOSTICS[diagnosticCode];
    diagnostics.push({
      code: diagnosticCode,
      name: entry.name,
      severity: entry.severity,
      nodeId: node.id,
      message,
      related: extra.related ?? [],
      spans,
      quotes: options.utterances
        ? spans.flatMap((span) => quoteSpan(span, options.utterances ?? []) ?? [])
        : [],
    });
  };

  // Holes, steps in words only, and inferences -------------------------------

  for (const node of nodes) {
    const position = positionOf(node.id);
    switch (node.kind) {
      case 'BlockHole': {
        const block = position?.parent;
        const blockPosition = block && positionOf(block.id);
        const owner = blockPosition?.parent;
        report(
          'GAP002',
          node,
          `Nothing is described inside ${blockOwner(owner, blockPosition?.field)}.`,
          {
            related: owner ? [owner.id] : [],
            spans: node.provenance.length > 0 ? node.provenance : (owner?.provenance ?? []),
          },
        );
        break;
      }
      case 'CondHole':
        report('GAP004', node, sentence(`This condition isn't stated: ${node.reason}`));
        break;
      case 'ExprHole':
        report('GAP005', node, sentence(`This value isn't described: ${node.reason}`));
        break;
      case 'RefHole':
        report('GAP007', node, sentence(`It's unclear which is meant: ${node.reason}`), {
          related: node.candidates,
        });
        break;
      case 'NameHole':
        if (position?.parent.kind === 'FunctionDef' && position.field === 'params') {
          report(
            'GAP006',
            node,
            sentence(`An input of ${functionLabel(position.parent)} isn't named: ${node.reason}`),
            {
              related: [position.parent.id],
            },
          );
        } else {
          report('GAP008', node, sentence(`This isn't named: ${node.reason}`));
        }
        break;
      case 'IntentStmt':
        report(
          'GAP009',
          node,
          `This step is described in words but not how it works: "${node.text}".`,
        );
        break;
      default:
        break;
    }

    if (node.inferred !== undefined) {
      const rule = INFERENCE_RULES[node.inferred];
      if (fitsInferenceRule(node, position)) {
        report('INFO001', node, `Inferred (${rule.id}): ${rule.description}.`);
      } else {
        report('WARN004', node, `Marked as inferred by ${rule.id}, but it doesn't fit that rule.`);
      }
    }
  }

  // Control flow -------------------------------------------------------------------

  const checkReturns = (owner: Program | FunctionDef, stmts: readonly Stmt[]) => {
    if (returnStatus(stmts) !== 'some-paths') return;
    const label = owner.kind === 'Program' ? 'The solution' : capitalize(functionLabel(owner));
    const last = stmts.at(-1);
    report('GAP003', owner, `${label} doesn't say what it returns when it reaches the end.`, {
      related: last ? [last.id] : [],
      spans: [],
    });
  };
  checkReturns(program, program.body);

  const checkStatements = (stmts: readonly Stmt[]) => {
    const stop = stmts.findIndex((stmt) => !completesNormally(stmt));
    const terminator = stmts[stop];
    const next = stmts[stop + 1];
    if (terminator !== undefined && next !== undefined) {
      report(
        'WARN002',
        next,
        `This step comes after ${terminatorLabel(terminator)} and can never run.`,
        {
          related: [terminator.id],
        },
      );
    }
  };
  checkStatements(program.body);

  const visitJumps = (node: IrNode, inLoop: boolean) => {
    if ((node.kind === 'Break' || node.kind === 'Continue') && !inLoop) {
      report(
        'WARN006',
        node,
        `${code(node.kind === 'Break' ? 'break' : 'continue')} is not inside a loop.`,
      );
    }
    const loopBody = node.kind === 'ForEach' || node.kind === 'ForRange' || node.kind === 'While';
    walk(node, (child) => {
      if (child === node) return true;
      visitJumps(child, node.kind === 'FunctionDef' ? false : inLoop || loopBody);
      return false;
    });
  };
  visitJumps(program, false);

  for (const node of nodes) {
    if (node.kind === 'Block') checkStatements(node.stmts);
    if (node.kind === 'FunctionDef') {
      checkReturns(node, node.body.stmts);
      const seen = new Set<string>();
      for (const param of node.params) {
        if (param.kind !== 'Name') continue;
        if (seen.has(param.name)) {
          report(
            'WARN007',
            param,
            `${capitalize(functionLabel(node))} has two inputs named ${code(param.name)}.`,
          );
        }
        seen.add(param.name);
      }
    }
  }

  // Names ----------------------------------------------------------------------------

  const unresolved = new Map<string, NodeId[]>();
  for (const ref of symbols.references) {
    if (ref.resolution.kind !== 'unresolved') continue;
    unresolved.set(ref.name, [...(unresolved.get(ref.name) ?? []), ref.nodeId]);
  }
  for (const [name, ids] of unresolved) {
    const [first, ...rest] = ids;
    const node = first === undefined ? undefined : nodeOf(first);
    if (node === undefined) continue;
    report('GAP001', node, `${code(name)} is used but never set up.`, {
      related: rest,
      spans: ids.flatMap((id) => nodeOf(id)?.provenance ?? []),
    });
  }

  const scopeParent = new Map(symbols.scopes.map((scope) => [scope.id, scope.parent]));
  const symbolsByKey = new Map(symbols.symbols.map((symbol) => [symbol.id, symbol]));

  for (const symbol of symbols.symbols) {
    const [firstDef] = symbol.definitions;
    const defNode = firstDef && nodeOf(firstDef.nodeId);
    const defPosition = firstDef && positionOf(firstDef.nodeId);
    if (defNode === undefined || firstDef === undefined) continue;
    const isFunctionName =
      defPosition?.parent.kind === 'FunctionDef' && defPosition.field === 'name';
    const isLoopTarget =
      (defPosition?.parent.kind === 'ForEach' || defPosition?.parent.kind === 'ForRange') &&
      defPosition.field === 'target';
    const isParam = defPosition?.field === 'params';

    if (
      symbol.uses.length === 0 &&
      !isFunctionName &&
      !isLoopTarget &&
      !symbol.name.startsWith('_')
    ) {
      report(
        'WARN001',
        defNode,
        isParam
          ? `The input ${code(symbol.name)} is never used.`
          : `${code(symbol.name)} is set up but never used.`,
      );
    }

    const firstSet = Math.min(...symbol.definitions.map((d) => d.order));
    // A problem input is set up before the code starts, so reassigning it
    // (`nums = sorted(nums)`) doesn't make earlier uses early.
    const isInput = symbol.scope === program.id && inputs.has(symbol.name);
    const early = isInput
      ? undefined
      : symbol.uses.find((use) => use.scope === symbol.scope && use.order < firstSet);
    const earlyNode = early && nodeOf(early.nodeId);
    if (earlyNode !== undefined) {
      report('WARN005', earlyNode, `${code(symbol.name)} is used before it is set up.`, {
        related: [firstDef.nodeId],
      });
    }

    if (!isParam && !isFunctionName) {
      for (
        let scope = scopeParent.get(symbol.scope);
        scope !== undefined;
        scope = scopeParent.get(scope)
      ) {
        const outer = symbolsByKey.get(`${scope}:${symbol.name}`);
        const owner = nodeOf(symbol.scope);
        if (outer !== undefined && owner?.kind === 'FunctionDef') {
          report(
            'WARN003',
            defNode,
            `${code(symbol.name)} is set up inside ${functionLabel(owner)}, hiding the ${code(symbol.name)} outside it.`,
            { related: outer.definitions.map((d) => d.nodeId) },
          );
          break;
        }
      }
    }
  }

  diagnostics.sort(
    (a, b) =>
      (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0) || a.code.localeCompare(b.code),
  );

  return { diagnostics, coverage: coverage(program, inputs, diagnostics), symbols };
}

function coverage(
  program: Program,
  inputs: ReadonlySet<string>,
  diagnostics: readonly Diagnostic[],
): CoverageSummary {
  const functions = program.body.filter((stmt): stmt is FunctionDef => stmt.kind === 'FunctionDef');
  const notes = allNodes(program).flatMap((node) => node.notes ?? []);

  let inputStatus: CoverageSummary['inputs'];
  let inputNames: string[];
  if (functions.length > 0) {
    const params = functions.flatMap((fn) => fn.params);
    inputStatus = params.every((param) => param.kind === 'Name') ? 'named' : 'unnamed';
    inputNames = params.flatMap((param) => (param.kind === 'Name' ? [param.name] : []));
  } else {
    inputStatus = inputs.size > 0 ? 'named' : 'unknown';
    inputNames = [...inputs];
  }

  const statuses =
    functions.length > 0
      ? functions.map((fn) => returnStatus(fn.body.stmts))
      : [returnStatus(program.body)];
  const returns: CoverageSummary['returns'] = statuses.includes('some-paths')
    ? 'some-paths'
    : statuses.includes('all-paths')
      ? 'all-paths'
      : 'none';

  return {
    approach: program.body.length > 0,
    inputs: inputStatus,
    inputNames,
    returns,
    edgeCases: notes.filter((note) => note.tag === 'edge-case').map((note) => note.id),
    complexity: notes.filter((note) => note.tag === 'complexity').map((note) => note.id),
    gaps: diagnostics.filter((d) => d.severity === 'gap').length,
  };
}
