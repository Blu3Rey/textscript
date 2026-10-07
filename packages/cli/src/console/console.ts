// The developer console: drive the engine by hand (docs/adr/010).
//
// `say` starts an utterance; edit commands add operations to its batch,
// which is applied as a preview after every command so mistakes show up at
// once. The batch is committed to the session when the next utterance
// starts, or on :commit, :undo, :redo, :revert or :save.

import {
  CHILD_FIELDS,
  EditOpSchema,
  analyze,
  apply,
  applyEvent,
  createUtterance,
  emptySession,
  indexTree,
  parseSessionLog,
  replay,
  resolveTempIds,
  serializeSessionLog,
  zodIssueMessages,
  type Analysis,
  type ApplyError,
  type Block,
  type Clarification,
  type EditOp,
  type InsertPosition,
  type IrDocument,
  type JsonValue,
  type NoteTag,
  type SessionEvent,
  type SessionState,
  type Span,
  type Stmt,
  type Utterance,
} from '@textscript/core';
import { PYTHON_BUILTINS, render } from '@textscript/render-python';
import {
  SnippetError,
  parseCondition,
  parseExpression,
  parseStatements,
  type SnippetOptions,
} from '../snippet/parser';
import { RefError, resolveRef } from './refs';
import { formatCode, formatCoverage, formatDiagnostics } from './view';

export interface FileSystem {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}

export type ExecuteStatus =
  | 'ok'
  /** The command failed; the error is in `error`. */
  | 'error'
  /** An `expect` command found something different. */
  | 'mismatch'
  | 'quit';

export interface ExecuteResult {
  status: ExecuteStatus;
  output: string[];
  error?: { code: string; message: string };
}

export class ConsoleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
  }
}

interface Pending {
  utterance: Utterance;
  ops: EditOp[];
  preview: IrDocument;
  clarifications: Clarification[];
  temp: number;
}

const NOTE_TAGS: readonly NoteTag[] = ['general', 'edge-case', 'complexity'];

/** Fields holding a block of statements. */
const BLOCK_FIELDS: ReadonlySet<string> = new Set(['body', 'orelse']);
/** Fields holding a condition, where `?` means a condition hole. */
const CONDITION_FIELDS: ReadonlySet<string> = new Set(['cond']);

export const HELP = `Commands (refs: root, n12, h2 for the 2nd hole, @label):

  say <text>                         start an utterance; edits below belong to it
  add <parent> [start|end|before <ref>|after <ref>]: <statements>
  fill <hole>: <statements or expression>
  set <ref>.<field> = <value or snippet>
  replace <ref>: <snippet>
  remove <ref>
  move <ref> <parent> [start|end|before <ref>|after <ref>]
  wrap <ref>[,<ref>...]: <compound header, e.g. "if ready:">
  rename <name-ref> <new-name>
  label <ref> <text>                 unlabel <ref>
  note <ref> [general|edge-case|complexity]: <text>
  unnote <note-id>
  ask <question> [-- <ref> ...]
  op <json>                          any edit operation, as JSON

  show                               the code and its gaps
  :diag [all]   :coverage   :log   :ir [ref]   :inputs [a,b]
  :commit   :undo   :redo   :revert <utterance-id>
  :export <file.py>   :save <file.json>   :load <file.json>
  :help   :quit

Snippets are a Python subset: ? is a hole, ... an empty block, ~loopvar an
inference, @2:6 the words a node came from; annotate a statement in a trailing
comment ("seen.add(num)  # ~synonym"). Write "intent <words>" for a step in words.

In scripts: expect code: (indented code)  |  expect gaps <codes|none>  |  expect error <code>
`;

export class Console {
  readonly fs: FileSystem;
  #state: SessionState = emptySession();
  #events: SessionEvent[] = [];
  #pending: Pending | undefined;
  #inputs: string[];
  #lastError: { code: string; message: string } | undefined;
  #out: string[] = [];

  /** `session` continues an existing session instead of starting an empty one. */
  constructor(options: {
    fs: FileSystem;
    inputs?: string[];
    session?: { state: SessionState; events: readonly SessionEvent[] };
  }) {
    this.fs = options.fs;
    this.#inputs = options.inputs ?? [];
    if (options.session) {
      this.#state = options.session.state;
      this.#events = [...options.session.events];
    }
  }

  /** The committed session, without pending edits. */
  get state(): SessionState {
    return this.#state;
  }

  /** The document as it stands, including any pending edits. */
  get document(): IrDocument {
    return this.#pending?.preview ?? this.#state.document;
  }

  get events(): readonly SessionEvent[] {
    return this.#events;
  }

  /** Runs one command, which may span several lines. */
  execute(command: string): ExecuteResult {
    this.#out = [];
    const text = command.trim();
    if (text === '') return { status: 'ok', output: [] };
    const word = text.split(/\s/, 1)[0] ?? '';
    const rest = text.slice(word.length);
    const isExpectation = word === 'expect';
    if (!isExpectation) this.#lastError = undefined;
    try {
      const status = this.#dispatch(word, rest, text);
      return { status, output: this.#out };
    } catch (error) {
      if (
        error instanceof ConsoleError ||
        error instanceof SnippetError ||
        error instanceof RefError
      ) {
        const code =
          error instanceof ConsoleError
            ? error.code
            : error instanceof SnippetError
              ? 'syntax'
              : 'bad-ref';
        const failure = { code, message: error.message };
        this.#lastError = failure;
        this.#out.push(`✗ ${code}: ${error.message}`);
        return { status: 'error', output: this.#out, error: failure };
      }
      throw error;
    }
  }

  #print(...lines: string[]): void {
    this.#out.push(...lines);
  }

  #dispatch(word: string, rest: string, text: string): ExecuteStatus {
    switch (word) {
      case 'say':
        this.#say(rest.trim());
        return 'ok';
      case 'add':
      case 'fill':
      case 'set':
      case 'replace':
      case 'remove':
      case 'move':
      case 'wrap':
      case 'rename':
      case 'label':
      case 'unlabel':
      case 'note':
      case 'unnote':
      case 'ask':
      case 'op':
        this.#edit(word, rest, text);
        return 'ok';
      case 'show':
      case ':show':
        this.#view();
        return 'ok';
      case 'expect':
        return this.#expect(rest);
      case ':commit':
        this.#commit(true);
        return 'ok';
      case ':undo':
      case ':redo':
        this.#control({ type: word === ':undo' ? 'undo' : 'redo' });
        this.#print(`✓ ${word.slice(1)}`);
        this.#view();
        return 'ok';
      case ':revert': {
        const target = rest.trim();
        if (target === '') throw new ConsoleError('usage', 'Write :revert <utterance-id>');
        this.#control({ type: 'revert', target });
        this.#print(`✓ reverted ${target}`);
        this.#view();
        return 'ok';
      }
      case ':log':
        this.#log();
        return 'ok';
      case ':ir':
        this.#ir(rest.trim());
        return 'ok';
      case ':diag':
        this.#print(
          ...formatDiagnostics(this.document.program, this.#analysis(), rest.trim() === 'all'),
        );
        return 'ok';
      case ':coverage':
        this.#print(...formatCoverage(this.#analysis()));
        return 'ok';
      case ':inputs':
        if (rest.trim() !== '')
          this.#inputs = rest
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        this.#print(`inputs: ${this.#inputs.length > 0 ? this.#inputs.join(', ') : '(none)'}`);
        return 'ok';
      case ':export': {
        const path = this.#path(rest);
        const code = render(this.document.program).text;
        this.#write(path, code);
        this.#print(`✓ wrote ${path} (${String(code.split('\n').length - 1)} lines)`);
        return 'ok';
      }
      case ':save': {
        const path = this.#path(rest);
        this.#commit(false);
        this.#write(path, serializeSessionLog({ formatVersion: 1, events: this.#events }) + '\n');
        this.#print(`✓ saved ${String(this.#events.length)} events to ${path}`);
        return 'ok';
      }
      case ':load':
        this.#load(this.#path(rest));
        return 'ok';
      case ':help':
        this.#print(...HELP.trimEnd().split('\n'));
        return 'ok';
      case ':quit':
        this.#commit(false);
        return 'quit';
      default:
        throw new ConsoleError('unknown-command', `Unknown command "${word}"; :help lists them`);
    }
  }

  #read(path: string): string {
    try {
      return this.fs.readFile(path);
    } catch (error) {
      throw new ConsoleError('read-failed', `Can't read ${path}: ${reason(error)}`);
    }
  }

  #write(path: string, text: string): void {
    try {
      this.fs.writeFile(path, text);
    } catch (error) {
      throw new ConsoleError('write-failed', `Can't write ${path}: ${reason(error)}`);
    }
  }

  #path(rest: string): string {
    const path = rest.trim();
    if (path === '') throw new ConsoleError('usage', 'Give a file path');
    return path;
  }

  // Utterances and committing -----------------------------------------------------

  #utteranceIds(): string[] {
    return [
      ...this.#state.utterances.map((u) => u.id),
      ...(this.#pending ? [this.#pending.utterance.id] : []),
    ];
  }

  #nextUtteranceId(): string {
    const numbers = this.#utteranceIds().map((id) => Number(/^u(\d+)$/.exec(id)?.[1] ?? 0));
    return `u${String(Math.max(0, ...numbers) + 1)}`;
  }

  #say(text: string): void {
    if (text === '') throw new ConsoleError('usage', 'Write what was said after "say"');
    this.#commit(false);
    const utterance = createUtterance(this.#nextUtteranceId(), text);
    this.#pending = {
      utterance,
      ops: [],
      preview: this.#state.document,
      clarifications: [],
      temp: 0,
    };
    this.#print(
      `${utterance.id}: ${utterance.tokens.map((t, i) => `${String(i)}:${t.text}`).join(' ')}`,
    );
  }

  /** Commits the pending batch, if any, as an edit event. */
  #commit(report: boolean): void {
    const pending = this.#pending;
    if (pending === undefined) {
      if (report) this.#print('(nothing to commit)');
      return;
    }
    this.#pending = undefined;
    this.#event({
      type: 'edit',
      utterance: pending.utterance,
      batch: { utteranceId: pending.utterance.id, ops: pending.ops },
    });
    if (report)
      this.#print(`✓ committed ${pending.utterance.id} (${String(pending.ops.length)} ops)`);
  }

  /**
   * Undo, redo or revert. If the current utterance has no edits yet, it is
   * what asked for this ("never mind that"), so it goes with the event.
   */
  #control(event: Extract<SessionEvent, { type: 'undo' | 'redo' | 'revert' }>): void {
    const pending = this.#pending;
    if (pending?.ops.length !== 0) {
      this.#commit(false);
      this.#event(event);
      return;
    }
    this.#pending = undefined;
    try {
      this.#event({ ...event, utterance: pending.utterance });
    } catch (error) {
      this.#pending = pending;
      throw error;
    }
  }

  #event(event: SessionEvent): void {
    const result = applyEvent(this.#state, event);
    if (!result.ok) {
      throw new ConsoleError(result.error.code, result.error.message);
    }
    this.#state = result.state;
    this.#events.push(event);
  }

  #load(path: string): void {
    const parsed = parseSessionLog(this.#read(path));
    if (!parsed.ok) throw new ConsoleError('bad-log', parsed.issues.join('; '));
    const result = replay(parsed.log.events);
    if (!result.ok) {
      throw new ConsoleError(
        'bad-log',
        `Event ${String(result.eventIndex)} doesn't replay: ${result.error.message}`,
      );
    }
    this.#state = result.state;
    this.#events = [...parsed.log.events];
    this.#pending = undefined;
    this.#print(`✓ loaded ${String(this.#events.length)} events from ${path}`);
    this.#view();
  }

  // Edits ---------------------------------------------------------------------------

  #edit(word: string, rest: string, text: string): void {
    const pending = this.#pending ?? this.#beginImplicit(text);
    const tokens = pending.utterance.tokens.length;
    const provenance: Span[] =
      tokens > 0 ? [{ utteranceId: pending.utterance.id, start: 0, end: tokens }] : [];
    const snippet: SnippetOptions = {
      nextId: () => `t${String(++pending.temp)}`,
      provenance,
      utteranceId: pending.utterance.id,
    };
    const ops = this.#buildOps(word, rest, snippet, provenance);

    const all = [...pending.ops, ...ops];
    const result = apply(this.#state.document, { utteranceId: pending.utterance.id, ops: all });
    if (!result.ok)
      throw new ConsoleError(
        result.error.code,
        describe(result.error, pending.ops.length, ops.length),
      );
    pending.ops = all;
    pending.preview = result.document;
    pending.clarifications = result.clarifications;
    this.#print(
      `✓ ${ops.map((op) => op.op).join(', ')} → ${pending.utterance.id} (pending, ${String(all.length)} ops)`,
    );
    this.#view();
  }

  /** Edits typed without `say` get an utterance made from the command itself. */
  #beginImplicit(text: string): Pending {
    const utterance = createUtterance(this.#nextUtteranceId(), text.split('\n')[0] ?? text);
    this.#pending = {
      utterance,
      ops: [],
      preview: this.#state.document,
      clarifications: [],
      temp: 0,
    };
    return this.#pending;
  }

  #ref(ref: string | undefined): string {
    if (ref === undefined || ref === '')
      throw new ConsoleError('usage', 'A node reference is missing');
    return resolveRef(this.document.program, ref);
  }

  /**
   * A block to add statements to: `root`, a block, or a compound statement
   * (meaning its body). `n7.orelse` picks another block field.
   */
  #parent(ref: string | undefined): string {
    const [base, field = 'body'] = (ref ?? '').split('.');
    const id = this.#ref(base);
    const node = indexTree(this.document.program).get(id)?.node;
    if (node === undefined || node.kind === 'Program' || node.kind === 'Block') return id;
    const fields: [string, unknown][] = Object.entries(node);
    const child = fields.find(([key]) => key === field)?.[1];
    if (isBlock(child)) return child.id;
    throw new ConsoleError('usage', `${node.kind} ${id} has no block "${field}"`);
  }

  /** Splits `head: body` at the first colon of the first line. */
  #headAndBody(rest: string, usage: string): { head: string; body: string } {
    const newline = rest.indexOf('\n');
    const firstLine = newline === -1 ? rest : rest.slice(0, newline);
    const colon = firstLine.indexOf(':');
    if (colon === -1) throw new ConsoleError('usage', usage);
    const inline = firstLine.slice(colon + 1).trim();
    const more = newline === -1 ? '' : rest.slice(newline + 1);
    return { head: firstLine.slice(0, colon).trim(), body: joinBody(inline, more) };
  }

  #position(words: string[]): InsertPosition {
    const [where, anchor] = words;
    switch (where) {
      case undefined:
      case 'end':
        return { at: 'end' };
      case 'start':
        return { at: 'start' };
      case 'before':
        return { before: this.#ref(anchor) };
      case 'after':
        return { after: this.#ref(anchor) };
      default:
        throw new ConsoleError(
          'usage',
          `Position must be start, end, before <ref> or after <ref>, not "${where}"`,
        );
    }
  }

  #buildOps(word: string, rest: string, snippet: SnippetOptions, provenance: Span[]): EditOp[] {
    const words = rest.trim().split(/\s+/).filter(Boolean);
    switch (word) {
      case 'add': {
        const { head, body } = this.#headAndBody(
          rest,
          'Write add <parent> [position]: <statements>',
        );
        const [parentRef, ...where] = head.split(/\s+/);
        const parent = this.#parent(parentRef);
        const position = this.#position(where);
        const stmts = parseStatements(body, snippet);
        return stmts.map((stmt, i): EditOp => {
          const previous = stmts[i - 1];
          return {
            op: 'add_stmt',
            parent,
            position: previous === undefined ? position : { after: previous.id },
            stmt,
            provenance,
          };
        });
      }
      case 'fill': {
        const { head, body } = this.#headAndBody(rest, 'Write fill <hole>: <code>');
        const hole = this.#ref(head);
        const kind = indexTree(this.document.program).get(hole)?.node.kind;
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
        if (match === null) throw new ConsoleError('usage', 'Write set <ref>.<field> = <value>');
        const [, ref, field = '', text = ''] = match;
        const newline = text.indexOf('\n');
        const valueText =
          newline === -1 ? text : joinBody(text.slice(0, newline).trim(), text.slice(newline + 1));
        const node = this.#ref(ref);
        const target = indexTree(this.document.program).get(node)?.node;
        const childFields: readonly string[] = target ? CHILD_FIELDS[target.kind] : [];
        let value: JsonValue | Stmt | Block | ReturnType<typeof parseExpression>;
        if (BLOCK_FIELDS.has(field) && childFields.includes(field)) {
          value = {
            kind: 'Block',
            id: snippet.nextId(),
            stmts: parseStatements(valueText, snippet),
            provenance,
          };
        } else if (childFields.includes(field)) {
          value = CONDITION_FIELDS.has(field)
            ? parseCondition(valueText, snippet)
            : parseExpression(valueText, snippet);
        } else {
          value = scalar(valueText);
        }
        return [{ op: 'update_field', node, field, value, provenance }];
      }
      case 'replace': {
        const { head, body } = this.#headAndBody(rest, 'Write replace <ref>: <code>');
        const node = this.#ref(head);
        const entry = indexTree(this.document.program).get(node);
        const field = entry?.position?.field ?? '';
        if (field === 'body' || field === 'stmts') {
          const stmts = parseStatements(body, snippet);
          const [stmt] = stmts;
          if (stmt === undefined || stmts.length !== 1)
            throw new ConsoleError('usage', 'Replace one statement with one statement');
          return [{ op: 'replace_node', node, replacement: stmt, provenance }];
        }
        const replacement = CONDITION_FIELDS.has(field)
          ? parseCondition(body, snippet)
          : parseExpression(body, snippet);
        return [{ op: 'replace_node', node, replacement, provenance }];
      }
      case 'remove':
        return [{ op: 'remove_node', node: this.#ref(words[0]), provenance }];
      case 'move': {
        const [ref, parentRef, ...where] = words;
        return [
          {
            op: 'move_node',
            node: this.#ref(ref),
            parent: this.#parent(parentRef),
            position: this.#position(where),
            provenance,
          },
        ];
      }
      case 'wrap': {
        const { head, body } = this.#headAndBody(rest, 'Write wrap <ref>,<ref>: <header>:');
        const nodes = head.split(',').map((ref) => this.#ref(ref.trim()));
        const [wrapper, extra] = parseStatements(body.endsWith(':') ? body : `${body}:`, snippet);
        if (wrapper === undefined || extra !== undefined)
          throw new ConsoleError('usage', 'Give one compound header, such as "if ready:"');
        return [{ op: 'wrap_nodes', nodes, wrapper, provenance }];
      }
      case 'rename': {
        const [ref, name] = words;
        if (name === undefined)
          throw new ConsoleError('usage', 'Write rename <name-ref> <new-name>');
        return [{ op: 'rename_symbol', node: this.#ref(ref), name, provenance }];
      }
      case 'label': {
        const [ref, ...label] = words;
        if (label.length === 0) throw new ConsoleError('usage', 'Write label <ref> <text>');
        return [{ op: 'set_label', node: this.#ref(ref), label: label.join(' '), provenance }];
      }
      case 'unlabel':
        return [{ op: 'set_label', node: this.#ref(words[0]), provenance }];
      case 'note': {
        const { head, body } = this.#headAndBody(rest, 'Write note <ref> [tag]: <text>');
        const [ref, tagWord = 'general'] = head.split(/\s+/);
        const tag = NOTE_TAGS.find((t) => t === tagWord);
        if (tag === undefined)
          throw new ConsoleError('usage', `Note tags are ${NOTE_TAGS.join(', ')}`);
        if (body === '') throw new ConsoleError('usage', 'A note needs text');
        return [{ op: 'add_note', node: this.#ref(ref), text: body, tag, provenance }];
      }
      case 'unnote':
        if (words[0] === undefined) throw new ConsoleError('usage', 'Write unnote <note-id>');
        return [{ op: 'remove_note', note: words[0], provenance }];
      case 'ask': {
        const [question = '', refs = ''] = rest.split(' -- ');
        if (question.trim() === '')
          throw new ConsoleError('usage', 'Write ask <question> [-- <ref> ...]');
        const candidates = refs
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((ref) => this.#ref(ref));
        return [{ op: 'ask_clarification', question: question.trim(), candidates }];
      }
      default: {
        let json: unknown;
        try {
          json = JSON.parse(rest);
        } catch {
          throw new ConsoleError('usage', 'Write op <json>');
        }
        // Its temporary IDs may clash with ones earlier commands in this
        // batch used, so they are renumbered from the batch's counter.
        const renumbered = resolveTempIds(json, { allocate: snippet.nextId, next: 0 });
        if (!renumbered.ok) throw new ConsoleError('invalid-temp-id', renumbered.message);
        const op = EditOpSchema.safeParse(renumbered.value);
        if (!op.success)
          throw new ConsoleError('invalid-batch', zodIssueMessages(op.error).join('; '));
        return [op.data];
      }
    }
  }

  // Views and inspection ------------------------------------------------------------

  #analysis(): Analysis {
    return analyze(this.document.program, {
      builtins: PYTHON_BUILTINS,
      inputs: this.#inputs,
      utterances: [...this.#state.utterances, ...(this.#pending ? [this.#pending.utterance] : [])],
    });
  }

  #view(): void {
    const program = this.document.program;
    this.#print(...formatCode(program), '──', ...formatDiagnostics(program, this.#analysis()));
    const questions = this.#pending?.clarifications ?? this.#state.clarifications;
    for (const q of questions) {
      this.#print(
        `? ${q.question}${q.candidates.length > 0 ? ` (${q.candidates.join(', ')})` : ''}`,
      );
    }
  }

  #log(): void {
    const opsOf = (ops: readonly EditOp[]) =>
      ops.length > 0 ? ops.map((op) => op.op).join(', ') : 'no changes';
    for (const event of this.#events) {
      if (event.type === 'edit') {
        this.#print(`${event.utterance.id}  "${event.utterance.text}"  ${opsOf(event.batch.ops)}`);
      } else {
        const said = event.utterance ? `  "${event.utterance.text}"` : '';
        this.#print(`${event.type}${event.type === 'revert' ? ` ${event.target}` : ''}${said}`);
      }
    }
    if (this.#pending) {
      this.#print(
        `${this.#pending.utterance.id}  "${this.#pending.utterance.text}"  ${opsOf(this.#pending.ops)} (pending)`,
      );
    }
    if (this.#events.length === 0 && this.#pending === undefined) this.#print('(nothing yet)');
  }

  #ir(ref: string): void {
    const id = ref === '' ? this.document.program.id : this.#ref(ref);
    const node = indexTree(this.document.program).get(id)?.node;
    this.#print(...JSON.stringify(node, null, 2).split('\n'));
  }

  // Expectations (for scripts) ------------------------------------------------------

  #expect(rest: string): ExecuteStatus {
    const [kind = '', ...args] = rest.trim().split(/\s+/);
    if (kind === 'error') {
      const wanted = args[0];
      const actual = this.#lastError;
      this.#lastError = undefined;
      if (actual?.code === wanted) return 'ok';
      this.#print(`✗ expected error ${wanted ?? '?'}, got ${actual ? actual.code : 'no error'}`);
      return 'mismatch';
    }
    if (kind === 'gaps') {
      const actual = this.#analysis()
        .diagnostics.filter((d) => d.severity !== 'info')
        .map((d) => d.code);
      const wanted = args.length === 1 && args[0] === 'none' ? [] : args;
      // Order doesn't matter; how many times each code appears does.
      if ([...actual].sort().join(' ') === [...wanted].sort().join(' ')) return 'ok';
      this.#print(
        `✗ expected gaps ${wanted.join(' ') || 'none'}, got ${actual.join(' ') || 'none'}`,
      );
      return 'mismatch';
    }
    if (kind === 'code:') {
      const block = rest.slice(rest.indexOf('code:') + 'code:'.length).replace(/^[^\n]*\n/, '');
      const wanted = dedent(block);
      const actual = render(this.document.program).text.trimEnd();
      if (actual === wanted) return 'ok';
      this.#print(
        '✗ expected code:',
        ...wanted.split('\n').map((l) => `  - ${l}`),
        'but got:',
        ...actual.split('\n').map((l) => `  + ${l}`),
      );
      return 'mismatch';
    }
    throw new ConsoleError(
      'usage',
      'Write expect code:, expect gaps <codes|none> or expect error <code>',
    );
  }
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
function joinBody(inline: string, more: string): string {
  const lines = more.split('\n').filter((line) => line.trim() !== '');
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  const below = lines.map((line) => line.slice(indent));
  if (inline === '') return below.join('\n');
  if (below.length === 0) return inline;
  const nested = inline.endsWith(':') ? below.map((line) => `    ${line}`) : below;
  return [inline, ...nested].join('\n');
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedent(text: string): string {
  const lines = text
    .split('\n')
    .filter((line, i, all) => line.trim() !== '' || (i > 0 && i < all.length - 1));
  const indent = Math.min(
    ...lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
  );
  return lines
    .map((l) => l.slice(indent))
    .join('\n')
    .trimEnd();
}

/**
 * An apply error. When one command made several ops, says which one failed,
 * counting from the command rather than the whole batch.
 */
function describe(error: ApplyError, earlier: number, count: number): string {
  const issues =
    error.issues && error.issues.length > 0 ? ` (${error.issues.slice(0, 3).join('; ')})` : '';
  const which =
    count > 1 && error.opIndex !== undefined && error.opIndex >= earlier
      ? ` [op ${String(error.opIndex - earlier + 1)} of this command]`
      : '';
  return `${error.message}${which}${issues}`;
}
