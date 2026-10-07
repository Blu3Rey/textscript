// Edit commands (docs/adr/010, docs/adr/012): one line of text, plus
// indented continuation lines, compiled into edit operations.
//
//   add <parent> [start|end|before <ref>|after <ref>]: <statements>
//   fill <hole>: <code>
//   set <ref>.<field> = <value>
//   replace <ref>: <code>
//   remove <ref>       move <ref> <parent> [position]
//   wrap <ref>[,<ref>...]: <compound header>
//   rename <ref> <name>    label <ref> <text>    unlabel <ref>
//   note <ref> [general|edge-case|complexity]: <text>    unnote <note-id>
//   ask <question> [-- <ref> ...]
//   op <json>
//
// The developer console, gold annotations and translators all write edits
// in this language. References are resolved against the document given,
// so a command can refer to nodes earlier commands of the same batch made.

import {
  apply,
  CHILD_FIELDS,
  EditOpSchema,
  indexTree,
  resolveTempIds,
  zodIssueMessages,
  type ApplyError,
  type Block,
  type Clarification,
  type EditBatch,
  type EditOp,
  type InsertPosition,
  type IrDocument,
  type JsonValue,
  type NoteTag,
  type Span,
  type Stmt,
} from '@textscript/core';
import { SnippetError } from './lexer';
import { RefError, resolveRef } from './refs';
import { parseCondition, parseExpression, parseStatements, type SnippetOptions } from './snippet';

export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/** The words that start an edit command. */
export const EDIT_COMMANDS: ReadonlySet<string> = new Set([
  'add',
  'fill',
  'set',
  'replace',
  'remove',
  'move',
  'wrap',
  'rename',
  'label',
  'unlabel',
  'note',
  'unnote',
  'ask',
  'op',
]);

const NOTE_TAGS: readonly NoteTag[] = ['general', 'edge-case', 'complexity'];

/** Fields holding a block of statements. */
const BLOCK_FIELDS: ReadonlySet<string> = new Set(['body', 'orelse']);

/** Whether code for a hole is statements rather than an expression. */
function looksLikeStatements(code: string): boolean {
  const lines = code.trim().split('\n');
  const first = lines[0]?.trim() ?? '';
  return (
    lines.length > 1 ||
    /^(if|elif|else|for|while|return|break|continue|def|intent)\b/.test(first) ||
    /^[^=!<>]*[^=!<>+\-*/%]=(?!=)/.test(first)
  );
}
/** Fields holding a condition, where `?` means a condition hole. */
const CONDITION_FIELDS: ReadonlySet<string> = new Set(['cond']);

export interface CompileOptions {
  utteranceId: string;
  /** Provenance for every node and op the command creates (unless marked with `@a:b`). */
  provenance: Span[];
  /** Temporary IDs for new nodes; unique across the batch. */
  nextId: () => string;
}

/** A command, snippet or reference error as a code and a message, or undefined for other errors. */
export function commandFailure(error: unknown): { code: string; message: string } | undefined {
  if (error instanceof CommandError) return { code: error.code, message: error.message };
  if (error instanceof SnippetError) return { code: 'syntax', message: error.message };
  if (error instanceof RefError) return { code: 'bad-ref', message: error.message };
  return undefined;
}

function isBlock(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'Block';
}

/** A scalar for `set`: a Python literal if it reads as one, otherwise the text. */
function scalar(text: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed === 'True' || trimmed === 'False') return trimmed === 'True';
  if (trimmed === 'None') return null;
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (/^(".*"|'.*')$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Joins code written after a command's colon (or `=`) with the indented
 * lines below it. The lines below keep their shape relative to each other:
 * they're the body of a compound header written inline (`for x in xs:`),
 * or more statements after a simple one.
 */
export function joinBody(inline: string, more: string): string {
  const lines = more.split('\n').filter((line) => line.trim() !== '');
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  const below = lines.map((line) => line.slice(indent));
  if (inline === '') return below.join('\n');
  if (below.length === 0) return inline;
  const nested = inline.endsWith(':') ? below.map((line) => `    ${line}`) : below;
  return [inline, ...nested].join('\n');
}

/** Splits `head: body` at the first colon of the first line. */
function headAndBody(rest: string, usage: string): { head: string; body: string } {
  const newline = rest.indexOf('\n');
  const firstLine = newline === -1 ? rest : rest.slice(0, newline);
  const colon = firstLine.indexOf(':');
  if (colon === -1) throw new CommandError('usage', usage);
  const inline = firstLine.slice(colon + 1).trim();
  const more = newline === -1 ? '' : rest.slice(newline + 1);
  return { head: firstLine.slice(0, colon).trim(), body: joinBody(inline, more) };
}

/** Compiles one command against `document`. Throws CommandError, SnippetError or RefError. */
export function compileCommand(
  document: IrDocument,
  text: string,
  options: CompileOptions,
): EditOp[] {
  const program = document.program;
  const trimmed = text.trim();
  const word = trimmed.split(/\s/, 1)[0] ?? '';
  const rest = trimmed.slice(word.length);
  if (!EDIT_COMMANDS.has(word)) {
    throw new CommandError('unknown-command', `Unknown command "${word}"`);
  }
  const { provenance } = options;
  const snippet: SnippetOptions = {
    nextId: options.nextId,
    provenance,
    utteranceId: options.utteranceId,
  };
  const words = rest.trim().split(/\s+/).filter(Boolean);

  const ref = (value: string | undefined): string => {
    if (value === undefined || value === '')
      throw new CommandError('usage', 'A node reference is missing');
    return resolveRef(program, value);
  };

  /**
   * A block to add statements to: `root`, a block, or a compound statement
   * (meaning its body). `n7.orelse` picks another block field.
   */
  const parent = (value: string | undefined): string => {
    const [base, explicit] = (value ?? '').split('.');
    const field = explicit ?? 'body';
    const id = ref(base);
    const node = indexTree(program).get(id)?.node;
    if (node === undefined || node.kind === 'Program' || node.kind === 'Block') {
      if (node !== undefined && explicit !== undefined)
        throw new CommandError('usage', `${node.kind} ${id} has no block "${explicit}"`);
      return id;
    }
    const fields: [string, unknown][] = Object.entries(node);
    const child = fields.find(([key]) => key === field)?.[1];
    if (isBlock(child)) return child.id;
    throw new CommandError('usage', `${node.kind} ${id} has no block "${field}"`);
  };

  const position = (where: string[]): InsertPosition => {
    const [at, anchor] = where;
    switch (at) {
      case undefined:
      case 'end':
        return { at: 'end' };
      case 'start':
        return { at: 'start' };
      case 'before':
        return { before: ref(anchor) };
      case 'after':
        return { after: ref(anchor) };
      default:
        throw new CommandError(
          'usage',
          `Position must be start, end, before <ref> or after <ref>, not "${at}"`,
        );
    }
  };

  switch (word) {
    case 'add': {
      const { head, body } = headAndBody(rest, 'Write add <parent> [position]: <statements>');
      const [parentRef, ...where] = head.split(/\s+/);
      // "Otherwise …" on an `if` with no `else` yet: the statements become its `else`.
      const [base, field] = (parentRef ?? '').split('.');
      if (field === 'orelse') {
        const id = ref(base);
        const node = indexTree(program).get(id)?.node;
        if (node?.kind === 'If' && node.orelse === undefined) {
          const value: Block = {
            kind: 'Block',
            id: snippet.nextId(),
            stmts: parseStatements(body, snippet),
            provenance,
          };
          return [{ op: 'update_field', node: id, field: 'orelse', value, provenance }];
        }
      }
      let first = position(where);
      const index = indexTree(program);
      /** The block (or root) that holds a statement directly. */
      const holder = (id: string): string | undefined => {
        const parentNode = index.get(id)?.position?.parent;
        return parentNode?.kind === 'Block' || parentNode?.kind === 'Program'
          ? parentNode.id
          : undefined;
      };
      const named = index.get(ref(base));
      let target: string;
      if (
        field === undefined &&
        named !== undefined &&
        !('body' in named.node) &&
        named.node.kind !== 'BlockHole' &&
        holder(named.node.id) !== undefined &&
        where.length === 0
      ) {
        // `add n30: …` on a plain statement can only mean right after it.
        target = holder(named.node.id) ?? '';
        first = { after: named.node.id };
      } else {
        target = parent(parentRef);
      }
      // `add root after n30` with n30 inside a loop: the anchor says where.
      const anchor = 'after' in first ? first.after : 'before' in first ? first.before : undefined;
      const anchorHolder = anchor === undefined ? undefined : holder(anchor);
      if (anchorHolder !== undefined) target = anchorHolder;
      const stmts = parseStatements(body, snippet);
      return stmts.map((stmt, i): EditOp => {
        const previous = stmts[i - 1];
        return {
          op: 'add_stmt',
          parent: target,
          position: previous === undefined ? first : { after: previous.id },
          stmt,
          provenance,
        };
      });
    }
    case 'fill': {
      const { head, body } = headAndBody(rest, 'Write fill <hole>: <code>');
      const hole = ref(head);
      const kind = indexTree(program).get(hole)?.node.kind;
      if (kind !== undefined && kind !== 'BlockHole' && looksLikeStatements(body)) {
        const what =
          kind === 'CondHole'
            ? 'a condition'
            : kind === 'NameHole'
              ? 'a name'
              : kind === 'RefHole'
                ? 'a reference'
                : 'a value';
        throw new CommandError(
          'usage',
          `${head} is a hole for ${what}: fill it with one expression. To add statements, use add with a block`,
        );
      }
      const value =
        kind === 'BlockHole'
          ? parseStatements(body, snippet)
          : kind === 'CondHole'
            ? parseCondition(body, snippet)
            : parseExpression(body, snippet);
      return [{ op: 'fill_hole', hole, value, provenance }];
    }
    case 'set': {
      const match = /^\s*(\S+)\.([A-Za-z]+)\s*=\s*([\s\S]*)$/.exec(rest);
      if (match === null) throw new CommandError('usage', 'Write set <ref>.<field> = <value>');
      const [, nodeRef, field = '', value = ''] = match;
      const newline = value.indexOf('\n');
      const statedValue =
        newline === -1 ? value : joinBody(value.slice(0, newline).trim(), value.slice(newline + 1));
      const node = ref(nodeRef);
      const target = indexTree(program).get(node)?.node;
      // `set n54.value = return not stack`, `set n42.value = hi = mid`: the
      // statement around the value was repeated.
      let valueText = statedValue;
      if (field === 'value' && target?.kind === 'Return')
        valueText = valueText.replace(/^\s*return\s+/, '');
      if (field === 'value' && target?.kind === 'Assign' && target.target.kind === 'Name') {
        const prefix = new RegExp(`^\\s*${target.target.name}\\s*=(?!=)\\s*`);
        valueText = valueText.replace(prefix, '');
      }
      const childFields: readonly string[] = target ? CHILD_FIELDS[target.kind] : [];
      let newValue: JsonValue | Stmt | Block | ReturnType<typeof parseExpression>;
      if (BLOCK_FIELDS.has(field) && childFields.includes(field)) {
        newValue = {
          kind: 'Block',
          id: snippet.nextId(),
          stmts: parseStatements(valueText, snippet),
          provenance,
        };
      } else if (childFields.includes(field)) {
        newValue = CONDITION_FIELDS.has(field)
          ? parseCondition(valueText, snippet)
          : parseExpression(valueText, snippet);
      } else {
        newValue = scalar(valueText);
      }
      return [{ op: 'update_field', node, field, value: newValue, provenance }];
    }
    case 'replace': {
      const { head, body } = headAndBody(rest, 'Write replace <ref>: <code>');
      const node = ref(head);
      const field = indexTree(program).get(node)?.position?.field ?? '';
      if (field === 'body' || field === 'stmts') {
        const stmts = parseStatements(body, snippet);
        const [stmt] = stmts;
        if (stmt === undefined || stmts.length !== 1)
          throw new CommandError('usage', 'Replace one statement with one statement');
        return [{ op: 'replace_node', node, replacement: stmt, provenance }];
      }
      const replacement = CONDITION_FIELDS.has(field)
        ? parseCondition(body, snippet)
        : parseExpression(body, snippet);
      return [{ op: 'replace_node', node, replacement, provenance }];
    }
    case 'remove':
      return [{ op: 'remove_node', node: ref(words[0]), provenance }];
    case 'move': {
      const [nodeRef, parentRef, ...where] = words;
      return [
        {
          op: 'move_node',
          node: ref(nodeRef),
          parent: parent(parentRef),
          position: position(where),
          provenance,
        },
      ];
    }
    case 'wrap': {
      const { head, body } = headAndBody(rest, 'Write wrap <ref>,<ref>: <header>:');
      const nodes = head.split(',').map((item) => ref(item.trim()));
      const [wrapper, extra] = parseStatements(body.endsWith(':') ? body : `${body}:`, snippet);
      if (wrapper === undefined || extra !== undefined)
        throw new CommandError('usage', 'Give one compound header, such as "if ready:"');
      return [{ op: 'wrap_nodes', nodes, wrapper, provenance }];
    }
    case 'rename': {
      const [nodeRef, name] = words;
      if (name === undefined) throw new CommandError('usage', 'Write rename <name-ref> <new-name>');
      return [{ op: 'rename_symbol', node: ref(nodeRef), name, provenance }];
    }
    case 'label': {
      const [nodeRef, ...label] = words;
      if (label.length === 0) throw new CommandError('usage', 'Write label <ref> <text>');
      return [{ op: 'set_label', node: ref(nodeRef), label: label.join(' '), provenance }];
    }
    case 'unlabel':
      return [{ op: 'set_label', node: ref(words[0]), provenance }];
    case 'note': {
      const { head, body } = headAndBody(rest, 'Write note <ref> [tag]: <text>');
      const [nodeRef, tagWord = 'general'] = head.split(/\s+/);
      const tag = NOTE_TAGS.find((t) => t === tagWord);
      if (tag === undefined)
        throw new CommandError('usage', `Note tags are ${NOTE_TAGS.join(', ')}`);
      if (body === '') throw new CommandError('usage', 'A note needs text');
      return [{ op: 'add_note', node: ref(nodeRef), text: body, tag, provenance }];
    }
    case 'unnote':
      if (words[0] === undefined) throw new CommandError('usage', 'Write unnote <note-id>');
      return [{ op: 'remove_note', note: words[0], provenance }];
    case 'ask': {
      const [question = '', refs = ''] = rest.split(' -- ');
      if (question.trim() === '')
        throw new CommandError('usage', 'Write ask <question> [-- <ref> ...]');
      const candidates = refs.trim().split(/\s+/).filter(Boolean).map(ref);
      return [{ op: 'ask_clarification', question: question.trim(), candidates }];
    }
    default: {
      let json: unknown;
      try {
        json = JSON.parse(rest);
      } catch {
        throw new CommandError('usage', 'Write op <json>');
      }
      // Its temporary IDs may clash with ones earlier commands in this
      // batch used, so they are renumbered from the batch's counter.
      const renumbered = resolveTempIds(json, { allocate: options.nextId, next: 0 });
      if (!renumbered.ok) throw new CommandError('invalid-temp-id', renumbered.message);
      const op = EditOpSchema.safeParse(renumbered.value);
      if (!op.success)
        throw new CommandError('invalid-batch', zodIssueMessages(op.error).join('; '));
      return [op.data];
    }
  }
}

/**
 * An apply error, as a message. When one command made several ops, says
 * which one failed, counting from the command rather than the whole batch.
 */
export function describeApplyError(error: ApplyError, earlier: number, count: number): string {
  const issues =
    error.issues && error.issues.length > 0 ? ` (${error.issues.slice(0, 3).join('; ')})` : '';
  const which =
    count > 1 && error.opIndex !== undefined && error.opIndex >= earlier
      ? ` [op ${String(error.opIndex - earlier + 1)} of this command]`
      : '';
  return `${error.message}${which}${issues}`;
}

export interface CommandInput {
  text: string;
  /** Overrides `CompileOptions.provenance` for this command. */
  provenance?: Span[];
}

export type CompileBatchResult =
  | { ok: true; batch: EditBatch; document: IrDocument; clarifications: Clarification[] }
  | {
      ok: false;
      /** The commands before the failing one, compiled and applied. */
      batch: EditBatch;
      document: IrDocument;
      /** 0-based index of the failing command. */
      index: number;
      code: string;
      message: string;
    };

/**
 * Compiles commands one at a time, applying each to the result of the ones
 * before, so later commands can refer to what earlier ones made. Stops at
 * the first command that doesn't compile or apply.
 */
export function compileCommands(
  document: IrDocument,
  commands: readonly CommandInput[],
  options: { utteranceId: string; provenance: Span[] },
): CompileBatchResult {
  let temp = 0;
  let ops: EditOp[] = [];
  let current = document;
  let clarifications: Clarification[] = [];
  const nextId = () => `t${String(++temp)}`;
  for (const [index, command] of commands.entries()) {
    const failure = (code: string, message: string): CompileBatchResult => ({
      ok: false,
      batch: { utteranceId: options.utteranceId, ops },
      document: current,
      index,
      code,
      message,
    });
    let compiled: EditOp[];
    try {
      compiled = compileCommand(current, command.text, {
        utteranceId: options.utteranceId,
        provenance: command.provenance ?? options.provenance,
        nextId,
      });
    } catch (error) {
      const known = commandFailure(error);
      if (known === undefined) throw error;
      return failure(known.code, known.message);
    }
    const all = [...ops, ...compiled];
    const result = apply(document, { utteranceId: options.utteranceId, ops: all });
    if (!result.ok) {
      return failure(
        result.error.code,
        describeApplyError(result.error, ops.length, compiled.length),
      );
    }
    ops = all;
    current = result.document;
    clarifications = result.clarifications;
  }
  return {
    ok: true,
    batch: { utteranceId: options.utteranceId, ops },
    document: current,
    clarifications,
  };
}
