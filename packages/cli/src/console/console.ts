// The developer console: drive the engine by hand (docs/adr/010).
//
// `say` starts an utterance; edit commands add operations to its batch,
// which is applied as a preview after every command so mistakes show up at
// once. The batch is committed to the session when the next utterance
// starts, or on :commit, :undo, :redo, :revert or :save.

import {
  commandFailure,
  compileCommand,
  describeApplyError,
  resolveRef,
} from '@textscript/commands';
import {
  analyze,
  apply,
  applyEvent,
  createUtterance,
  emptySession,
  indexTree,
  parseSessionLog,
  replay,
  serializeSessionLog,
  type Analysis,
  type Clarification,
  type EditOp,
  type IrDocument,
  type SessionEvent,
  type SessionState,
  type Span,
  type Utterance,
} from '@textscript/core';
import { PYTHON_BUILTINS, render } from '@textscript/render-python';
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
      const failure =
        error instanceof ConsoleError
          ? { code: error.code, message: error.message }
          : commandFailure(error);
      if (failure !== undefined) {
        this.#lastError = failure;
        this.#out.push(`✗ ${failure.code}: ${failure.message}`);
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
        this.#edit(text);
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

  #edit(text: string): void {
    const pending = this.#pending ?? this.#beginImplicit(text);
    const tokens = pending.utterance.tokens.length;
    const provenance: Span[] =
      tokens > 0 ? [{ utteranceId: pending.utterance.id, start: 0, end: tokens }] : [];
    const ops = compileCommand(this.document, text, {
      utteranceId: pending.utterance.id,
      provenance,
      nextId: () => `t${String(++pending.temp)}`,
    });

    const all = [...pending.ops, ...ops];
    const result = apply(this.#state.document, { utteranceId: pending.utterance.id, ops: all });
    if (!result.ok)
      throw new ConsoleError(
        result.error.code,
        describeApplyError(result.error, pending.ops.length, ops.length),
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
