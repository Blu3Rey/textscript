// The baseline translator (ROADMAP.md S7): about thirty phrase patterns, no
// model. It's the floor every other translator must beat, an offline
// fallback, and the translator CI gates on.
//
// It is faithful by construction. Values come only from the words; a
// condition or value it can't read becomes a hole holding those words; a
// clause no pattern matches is reported as unparsed. It never guesses.
//
// An utterance is split into clauses at punctuation. Each clause becomes at
// most one edit command, compiled at once so the next clause can refer to
// what it made (a loop's body, the `if` an "otherwise" belongs to).

import {
  compileCommands,
  parseExpression,
  parseStatements,
  type CommandInput,
} from '@textscript/commands';
import {
  allNodes,
  walk,
  type IrDocument,
  type IrNode,
  type Span,
  type Stmt,
} from '@textscript/core';
import type { Translation, TranslationContext, Translator } from './translator';

interface Clause {
  /** Lowercase words, filler at the start removed. */
  words: string[];
  /** The clause as typed, for code the speaker said literally. */
  raw: string;
  span: Span;
}

/** What a clause becomes. */
type Place = 'after-loop' | 'top-level';
type Edit =
  | { kind: 'stmt'; code: string; place?: Place }
  | { kind: 'place'; place: Place }
  | { kind: 'if'; cond: string }
  | { kind: 'else'; code: string }
  | { kind: 'command'; command: string };

const FILLER: ReadonlySet<string> = new Set([
  'um',
  'uh',
  'umm',
  'uhh',
  'okay',
  'ok',
  'so',
  'basically',
  'yeah',
  'well',
  'right',
  'alright',
  'anyway',
  'just',
  'then',
  'now',
  'first',
  'next',
  'also',
  'and',
  "i'll",
  "we'll",
  "i'd",
  "let's",
  'we',
  "i'm",
  'gonna',
  'finally',
  'actually',
  'oh',
]);

const NUMBERS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  true: 'True',
  false: 'False',
  none: 'None',
  nothing: 'None',
  infinity: 'float("inf")',
};

/** Spoken operators, longest first. */
const OPERATORS: readonly [string, string][] = [
  ['is greater than or equal to', '>='],
  ['is less than or equal to', '<='],
  ['greater than or equal to', '>='],
  ['less than or equal to', '<='],
  ['is not in', 'not in'],
  ['is greater than', '>'],
  ['is bigger than', '>'],
  ['is larger than', '>'],
  ['is more than', '>'],
  ['is less than', '<'],
  ['is smaller than', '<'],
  ['is equal to', '=='],
  ['is not equal to', '!='],
  ['greater than', '>'],
  ['bigger than', '>'],
  ['larger than', '>'],
  ['more than', '>'],
  ['less than', '<'],
  ['smaller than', '<'],
  ['at least', '>='],
  ['at most', '<='],
  ['divided by', '/'],
  ['not in', 'not in'],
  ['is in', 'in'],
  ['equals', '=='],
  ['is', '=='],
  ['plus', '+'],
  ['minus', '-'],
  ['times', '*'],
  ['mod', '%'],
  ['in', 'in'],
  ['and', 'and'],
  ['or', 'or'],
  ['not', 'not'],
];

const COLLECTIONS: Readonly<Record<string, string>> = {
  set: 'set()',
  hashset: 'set()',
  list: '[]',
  array: '[]',
  stack: '[]',
  queue: '[]',
  dictionary: '{}',
  dict: '{}',
  hashmap: '{}',
  map: '{}',
};

function splitClauses(context: TranslationContext): Clause[] {
  const { tokens } = context.utterance;
  const clauses: Clause[] = [];
  let start = 0;
  const close = (end: number) => {
    let first = start;
    while (first < end && FILLER.has((tokens[first]?.text ?? '').toLowerCase())) first++;
    const firstToken = tokens[first];
    const lastToken = tokens[end - 1];
    if (first < end && firstToken && lastToken) {
      clauses.push({
        words: tokens.slice(first, end).map((t) => t.text.toLowerCase()),
        raw: context.utterance.text.slice(firstToken.start, lastToken.end),
        span: { utteranceId: context.utterance.id, start: first, end },
      });
    }
    start = end + 1;
  };
  tokens.forEach((token, i) => {
    if (['.', ',', ';', ':', '!', '?'].includes(token.text)) close(i);
  });
  close(tokens.length);
  return clauses;
}

/** Names in scope: set up in the code, given by the problem, or made earlier in this utterance. */
function namesIn(document: IrDocument, inputs: readonly string[]): Set<string> {
  const names = new Set(inputs);
  walk(document.program, (node) => {
    if (node.kind === 'Name') names.add(node.name);
  });
  return names;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A spoken name for a known one: "seen", "the numbers" → `nums`, "the array" with one input. */
function resolveName(
  phrase: string[],
  names: ReadonlySet<string>,
  inputs: readonly string[],
): string | undefined {
  const words = phrase.filter((w) => !['the', 'a', 'an', 'our', 'my', 'of'].includes(w));
  if (words.length !== 1) return undefined;
  const [word = ''] = words;
  if (names.has(word)) return word;
  if (
    ['list', 'array', 'input', 'string', 'numbers', 'values', 'elements', 'items'].includes(word) &&
    inputs.length === 1
  ) {
    return inputs[0];
  }
  const matches = [...names].filter((name) => commonPrefix(name, word) >= 3);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The singular a loop variable may take from its collection (`nums` → `num`), if the rule allows one. */
function loopVariable(collection: string): string | undefined {
  return collection.length > 3 && collection.endsWith('s') ? collection.slice(0, -1) : undefined;
}

/** Spoken words as an expression, or undefined if any word can't be read. */
function expression(
  words: readonly string[],
  names: ReadonlySet<string>,
  inputs: readonly string[],
  functions: ReadonlySet<string> = new Set(),
): string | undefined {
  const out: string[] = [];
  let i = 0;
  const known = (w: string) => names.has(w);
  while (i < words.length) {
    const rest = words.slice(i);
    const operator = OPERATORS.find(([phrase]) => phrase.split(' ').every((w, j) => rest[j] === w));
    if (operator) {
      out.push(operator[1]);
      i += operator[0].split(' ').length;
      continue;
    }
    const word = rest[0] ?? '';
    if (['the', 'a', 'an'].includes(word)) {
      i++;
      continue;
    }
    if (/^\d+$/.test(word) || NUMBERS[word] !== undefined) {
      out.push(NUMBERS[word] ?? word);
      i++;
      continue;
    }
    // "the length of x", "the max of a and b", "x at i"
    if (
      (word === 'length' || word === 'len' || word === 'size') &&
      rest[1] === 'of' &&
      rest[2] !== undefined
    ) {
      const name = resolveName([rest[2]], names, inputs);
      if (name === undefined) return undefined;
      out.push(`len(${name})`);
      i += 3;
      continue;
    }
    if (
      (word === 'max' || word === 'min' || word === 'maximum' || word === 'minimum') &&
      rest[1] === 'of'
    ) {
      const and = rest.indexOf('and');
      if (and < 3) return undefined;
      const a = expression(rest.slice(2, and), names, inputs);
      const b = expression(rest.slice(and + 1), names, inputs);
      if (a === undefined || b === undefined) return undefined;
      out.push(`${word.slice(0, 3)}(${a}, ${b})`);
      break;
    }
    // A pronoun nobody resolved is a gap, not a variable.
    if (['it', 'that', 'this', 'them'].includes(word)) return undefined;
    // "reverse of head" calls a function the walkthrough defined.
    if (functions.has(word) && rest[1] === 'of' && rest[2] !== undefined) {
      const argument = expression(rest.slice(2), names, inputs, functions);
      if (argument === undefined) return undefined;
      out.push(`${word}(${argument})`);
      break;
    }
    const name = resolveName([word], names, inputs);
    if (name !== undefined || known(word)) {
      const resolved = name ?? word;
      if (rest[1] === 'at' && rest[2] !== undefined) {
        const index = expression([rest[2]], names, inputs);
        if (index === undefined) return undefined;
        out.push(`${resolved}[${index}]`);
        i += 3;
        continue;
      }
      out.push(resolved);
      i++;
      continue;
    }
    return undefined;
  }
  if (out.length === 0) return undefined;
  const code = out.join(' ');
  try {
    parseExpression(code, { nextId: () => 't0' });
    return code;
  } catch {
    return undefined;
  }
}

/** The clause as code, if the speaker said code ("lo += 1", "seen[nums[i]] = i"). */
function literalStatement(raw: string): string | undefined {
  if (!/[=[\]()+\-*/<>]/.test(raw) || raw.split(/\s+/).length > 12) return undefined;
  try {
    const stmts = parseStatements(raw, { nextId: () => 't0' });
    return stmts.length === 1 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function hole(kind: 'cond' | 'value', words: readonly string[]): string {
  return `?${kind}${JSON.stringify(words.join(' '))}`;
}

interface State {
  names: Set<string>;
  inputs: readonly string[];
  document: IrDocument;
}

/** The statement a clause asks for, if it's one of the patterns. */
function statement(clause: Clause, state: State): Edit | undefined {
  const { names, inputs } = state;
  const text = clause.words.join(' ');
  const functions = new Set(
    allNodes(state.document.program).flatMap((node) =>
      node.kind === 'FunctionDef' && node.name.kind === 'Name' ? [node.name.name] : [],
    ),
  );
  const expr = (words: readonly string[]) =>
    expression(
      words.map((w) => (w === 'it' ? (currentLoopVariable(state.document) ?? w) : w)),
      names,
      inputs,
      functions,
    );

  // 1. "a set called seen", "an empty dictionary named counts"
  const created =
    /^(?:keep |make |create |use |have |initialize |start with )?(?:a |an |the )?(?:new |empty )?(hash ?set|set|list|array|stack|queue|dictionary|dict|hash ?map|map) (?:called|named) ([a-z_]\w*)/.exec(
      text,
    );
  if (created) {
    const [, kind = '', name = ''] = created;
    const value = COLLECTIONS[kind.replace(' ', '')];
    if (value !== undefined) {
      names.add(name);
      return { kind: 'stmt', code: `${name} = ${value}` };
    }
  }

  // 2. "x starts at 0", "set x to 0", "initialize best to the first number"
  const assign =
    /^([a-z_]\w*) (?:starts|begins|starts out) (?:at|as|from|with) (.+)$/.exec(text) ??
    /^(?:set|initialize|init) ([a-z_]\w*) (?:to|as) (.+)$/.exec(text) ??
    /^([a-z_]\w*) (?:becomes|gets) (.+)$/.exec(text);
  if (assign) {
    const [, name = '', valueText = ''] = assign;
    const value = expr(valueText.split(' ')) ?? hole('value', valueText.split(' '));
    names.add(name);
    return { kind: 'stmt', code: `${name} = ${value}` };
  }

  // 3. "for each word in words", "for every num in nums"
  const forEach = /^for (?:each|every) ([a-z_]\w*) in (.+)$/.exec(text);
  if (forEach) {
    const [, item = '', collectionText = ''] = forEach;
    const collection = resolveName(collectionText.split(' '), names, inputs);
    if (collection === undefined) return undefined;
    names.add(item);
    return { kind: 'stmt', code: `for ${item} in ${collection}:\n    ...` };
  }

  // 4. "loop over the indices of nums", "go through each index i of nums"
  const indices =
    /^(?:loop|go|iterate|walk) (?:over|through) (?:each|every|all )?(?:the )?(?:index|indices|indexes)(?: ([a-z]))? of (.+)$/.exec(
      text,
    );
  if (indices) {
    const [, index, collectionText = ''] = indices;
    const collection = resolveName(collectionText.split(' '), names, inputs);
    if (collection === undefined) return undefined;
    const name = index ?? 'i';
    names.add(name);
    const mark = index === undefined ? '~indexvar' : '';
    return {
      kind: 'stmt',
      code: `for ${name}${mark} in range(len(${collection})~range-bounds):\n    ...`,
    };
  }

  // 5. "loop through the numbers", "go over the list"
  const loop =
    /^(?:loop|go|iterate|walk|run) (?:through|over|across) (?:each of |every |all )?(.+)$/.exec(
      text,
    );
  if (loop) {
    const [, collectionText = ''] = loop;
    const collection = resolveName(collectionText.split(' ').slice(-2), names, inputs);
    if (collection === undefined) return undefined;
    const item = loopVariable(collection);
    const target = item === undefined ? '?name"loop variable"' : `${item}~loopvar`;
    if (item !== undefined) names.add(item);
    return { kind: 'stmt', code: `for ${target} in ${collection}:\n    ...` };
  }

  // 6. "while left is less than right"
  const whileLoop = /^while (.+)$/.exec(text);
  if (whileLoop) {
    const words = (whileLoop[1] ?? '').split(' ');
    return { kind: 'stmt', code: `while ${expr(words) ?? hole('cond', words)}:\n    ...` };
  }

  // 7. "if x is in seen" (the action follows in the next clause)
  const ifClause = /^if (.+)$/.exec(text);
  if (ifClause) {
    const words = (ifClause[1] ?? '').split(' ');
    return { kind: 'if', cond: expr(words) ?? hole('cond', words) };
  }

  // 8. "otherwise add it to seen", "else return false"
  const otherwise = /^(?:otherwise|else) (.+)$/.exec(text);
  if (otherwise) {
    const inner = statement({ ...clause, words: (otherwise[1] ?? '').split(' '), raw: '' }, state);
    return inner?.kind === 'stmt' ? { kind: 'else', code: inner.code } : undefined;
  }

  // 9. "return true", "return the count", "return true if the stack is empty"
  const ret = /^return (.+?)(?: if (.+))?$/.exec(text);
  if (ret) {
    const words = (ret[1] ?? '').split(' ');
    const code = `return ${expr(words) ?? hole('value', words)}`;
    if (ret[2] === undefined) return { kind: 'stmt', code };
    const cond = ret[2].split(' ');
    return { kind: 'stmt', code: `if ${expr(cond) ?? hole('cond', cond)}:\n    ${code}` };
  }

  // 10–12. "add num to seen", "append x to result", "push x onto the stack"
  const add =
    /^(add|append|push|put|insert) (.+) (?:to|onto|into|in) (?:the )?(?:end of )?(.+)$/.exec(text);
  if (add) {
    const [, verb = '', valueText = '', targetText = ''] = add;
    const target = resolveName(targetText.split(' '), names, inputs);
    if (target === undefined) return undefined;
    const value = expr(valueText.split(' '));
    if (value === undefined) return undefined;
    const isSet = targetIsSet(target, state.document);
    const method = isSet ? 'add' : 'append';
    const literal = (verb === 'add' && isSet) || (verb === 'append' && !isSet);
    return { kind: 'stmt', code: `${target}.${method}(${value})${literal ? '' : '  # ~synonym'}` };
  }

  // 13–14. "increment count", "count goes up by one", "decrement k"
  const step =
    /^(increment|decrement|bump) ([a-z_]\w*)$/.exec(text) ??
    /^([a-z_]\w*) goes (up|down) by (?:one|1)$/.exec(text);
  if (step) {
    const [, first = '', second = ''] = step;
    const [name, direction] =
      first === 'increment' || first === 'decrement' || first === 'bump'
        ? [second, first]
        : [first, second];
    if (!names.has(name)) return undefined;
    return {
      kind: 'stmt',
      code: `${name} ${direction === 'decrement' || direction === 'down' ? '-=' : '+='} 1`,
    };
  }

  // 15. "break", "stop the loop"   16. "continue", "skip it"
  if (/^(?:break|stop the loop|break out of the loop)$/.test(text))
    return { kind: 'stmt', code: 'break' };
  if (/^(?:continue|skip it|skip to the next one)$/.test(text))
    return { kind: 'stmt', code: 'continue' };

  // 17. "sort nums"
  const sort = /^sort (.+)$/.exec(text);
  if (sort) {
    const target = resolveName((sort[1] ?? '').split(' '), names, inputs);
    return target === undefined ? undefined : { kind: 'stmt', code: `${target}.sort()` };
  }

  // 18. "swap a and b": no IR for it, so a step in words
  if (text.startsWith('swap ')) return { kind: 'stmt', code: `intent ${text}` };

  // 19. complexity remarks   20. edge-case remarks
  if (/\bo\(|linear time|constant (?:time|space)|n log n|quadratic/.test(text)) {
    return { kind: 'command', command: `note root complexity: ${clause.raw}` };
  }
  if (/\bedge case\b|\bwatch out\b|\bcorner case\b/.test(text)) {
    return { kind: 'command', command: `note root edge-case: ${clause.raw}` };
  }

  // 21. "write a function two_sum that takes nums and target"
  const fn =
    /^(?:write|define|make) a function (?:called |named )?([a-z_]\w*) (?:that )?(?:takes|with|taking) (.+)$/.exec(
      text,
    );
  if (fn) {
    const [, name = '', paramsText = ''] = fn;
    const params = paramsText
      .split(/ and |, | /)
      .filter((p) => /^[a-z_]\w*$/.test(p) && !['the', 'a', 'an'].includes(p));
    names.add(name);
    for (const p of params) names.add(p);
    return { kind: 'stmt', code: `def ${name}(${params.join(', ')}):\n    ...` };
  }

  // 22. "rename x to y", "call x y instead"
  const rename = /^(?:rename ([a-z_]\w*) to|call ([a-z_]\w*)) ([a-z_]\w*)(?: instead)?$/.exec(text);
  if (rename) {
    const [, from1, from2, to = ''] = rename;
    const from = from1 ?? from2 ?? '';
    if (!names.has(from)) return undefined;
    names.add(to);
    return { kind: 'command', command: `rename @name:${from} ${to}` };
  }

  // 23. "after the loop, return false", "outside the function, call it": the
  // action is this clause's rest, or the next clause.
  const after =
    /^(?:(?:after|outside|once out of) (?:the|that) (loop|function)|at the end)(?: (.+))?$/.exec(
      text,
    );
  if (after) {
    const place = after[1] === 'function' ? 'top-level' : 'after-loop';
    if (after[2] === undefined) return { kind: 'place', place };
    const inner = statement({ ...clause, words: after[2].split(' '), raw: '' }, state);
    return inner?.kind === 'stmt' ? { kind: 'stmt', code: inner.code, place } : undefined;
  }

  // 24–25. "store i in seen under nums at i", "seen of nums at i is i"
  const store =
    /^(?:store|put|record|save) (.+) in ([a-z_]\w*) (?:under|at|for|with key) (.+)$/.exec(text);
  if (store) {
    const [, valueText = '', map = '', keyText = ''] = store;
    const value = expr(valueText.split(' '));
    const key = expr(keyText.split(' '));
    if (!names.has(map) || value === undefined || key === undefined) return undefined;
    return { kind: 'stmt', code: `${map}[${key}] = ${value}` };
  }

  // 26. code said literally: "lo += 1", "seen[nums[i]] = i"
  const literal = clause.raw === '' ? undefined : literalStatement(clause.raw);
  if (literal !== undefined) return { kind: 'stmt', code: literal };

  return undefined;
}

/** Whether `name` was set up as a set (`set()` or a set literal). */
function targetIsSet(name: string, document: IrDocument): boolean {
  let isSet = false;
  walk(document.program, (node) => {
    if (
      node.kind === 'Assign' &&
      node.target.kind === 'Name' &&
      node.target.name === name &&
      ((node.value.kind === 'Call' &&
        node.value.callee.kind === 'Name' &&
        node.value.callee.name === 'set') ||
        (node.value.kind === 'CollectionLiteral' && node.value.collection === 'set'))
    ) {
      isSet = true;
    }
  });
  return isSet;
}

/** The variable of the newest loop, which "it" refers to when one loop is open. */
function currentLoopVariable(document: IrDocument): string | undefined {
  const loops = allNodes(document.program).filter(
    (node) => node.kind === 'ForEach' || node.kind === 'ForRange',
  );
  const [loop] = loops.sort((a, b) => numericId(b.id) - numericId(a.id));
  if (loop?.kind !== 'ForEach' && loop?.kind !== 'ForRange') return undefined;
  return loop.target.kind === 'Name' ? loop.target.name : undefined;
}

function numericId(id: string): number {
  return Number(id.slice(1));
}

const COMPOUND: ReadonlySet<string> = new Set([
  'ForEach',
  'ForRange',
  'While',
  'If',
  'FunctionDef',
]);

/** The newest node of the given kinds. */
function newest(document: IrDocument, kinds: ReadonlySet<string>): IrNode | undefined {
  return allNodes(document.program)
    .filter((node) => kinds.has(node.kind))
    .sort((a, b) => numericId(b.id) - numericId(a.id))[0];
}

const LOOPS: ReadonlySet<string> = new Set(['ForEach', 'ForRange', 'While']);

/** The statements of every block, keyed by the block's reference. */
function blocks(document: IrDocument): Map<string, readonly Stmt[]> {
  const found = new Map<string, readonly Stmt[]>([['root', document.program.body]]);
  walk(document.program, (node) => {
    if (!COMPOUND.has(node.kind)) return;
    for (const field of ['body', 'orelse'] as const) {
      const block: unknown = Reflect.get(node, field);
      if (
        typeof block === 'object' &&
        block !== null &&
        'stmts' in block &&
        Array.isArray(block.stmts)
      ) {
        const stmts: readonly Stmt[] = block.stmts;
        found.set(field === 'orelse' ? `${node.id}.orelse` : node.id, stmts);
      }
    }
  });
  return found;
}

/** A loop is still open while nothing follows it in its block. */
function openLoop(document: IrDocument): IrNode | undefined {
  const lasts = new Set([...blocks(document).values()].map((stmts) => stmts.at(-1)?.id));
  return allNodes(document.program)
    .filter((node) => LOOPS.has(node.kind) && lasts.has(node.id))
    .sort((a, b) => numericId(b.id) - numericId(a.id))[0];
}

/**
 * Where a new statement goes: for a step said to come after the loop, right
 * after the open loop; else the newest open block hole; else, for a bare
 * return, after the open loop; else the open loop's body, or the newest
 * function's, or the top level.
 */
function placement(document: IrDocument, place: Place | 'after-return' | undefined): string {
  const loop = openLoop(document);
  if (place === 'after-loop' && loop) return `add ${ownerOf(document, loop.id)} after ${loop.id}`;
  const blockHole = newest(document, new Set(['BlockHole']));
  if (blockHole) return `fill ${blockHole.id}`;
  if (place === 'after-return' && loop) return `add ${ownerOf(document, loop.id)} after ${loop.id}`;
  const owner = loop ?? newest(document, new Set(['FunctionDef']));
  return `add ${owner?.id ?? 'root'}`;
}

/** The commands for an utterance, compiled one at a time. */
function rulesAnswer(context: TranslationContext): { commands: CommandInput[]; unparsed: Span[] } {
  const names = namesIn(context.document, context.problem.inputs);
  const commands: CommandInput[] = [];
  const unparsed: Span[] = [];
  let document = context.document;
  let pendingIf: { cond: string; span: Span } | undefined;
  let pendingPlace: { place: Place; span: Span } | undefined;

  const tryCommand = (command: CommandInput): boolean => {
    const result = compileCommands(context.document, [...commands, command], {
      utteranceId: context.utterance.id,
      provenance: command.provenance ?? [],
    });
    if (!result.ok) return false;
    commands.push(command);
    document = result.document;
    return true;
  };

  for (const clause of splitClauses(context)) {
    const edit = statement(clause, { names, inputs: context.problem.inputs, document });
    let command: string | undefined;
    let provenance = [clause.span];

    if (edit === undefined) {
      unparsed.push(clause.span);
      continue;
    }
    if (edit.kind === 'if') {
      pendingIf = { cond: edit.cond, span: clause.span };
      continue;
    }
    if (edit.kind === 'place') {
      pendingPlace = { place: edit.place, span: clause.span };
      continue;
    }
    if (edit.kind === 'command') {
      command = edit.command.startsWith('rename @name:')
        ? renameCommand(document, edit.command)
        : edit.command;
    } else if (edit.kind === 'else') {
      const lastIf = newest(document, new Set(['If']));
      command = lastIf ? `set ${lastIf.id}.orelse = ${edit.code}` : undefined;
    } else {
      let code = edit.code;
      const place = edit.place ?? pendingPlace?.place;
      if (pendingPlace) provenance = [{ ...clause.span, start: pendingPlace.span.start }];
      pendingPlace = undefined;
      const wrapped = pendingIf !== undefined;
      if (pendingIf) {
        code = `if ${pendingIf.cond}:\n${code
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n')}`;
        provenance = [
          {
            ...clause.span,
            start: Math.min(pendingIf.span.start, ...provenance.map((span) => span.start)),
          },
        ];
        pendingIf = undefined;
      }
      const where =
        place === 'top-level'
          ? 'add root'
          : placement(
              document,
              place ?? (!wrapped && code.startsWith('return') ? 'after-return' : undefined),
            );
      const mark = where.includes(' after ') ? '  # ~block-end' : '';
      command = `${where}:\n    ${code.split('\n').join('\n    ')}${mark}`;
    }
    if (command === undefined || !tryCommand({ text: command, provenance }))
      unparsed.push(clause.span);
  }
  if (pendingPlace) unparsed.push(pendingPlace.span);
  if (pendingIf) {
    // "if x is in seen" with nothing after it: the condition alone.
    const command = `${placement(document, undefined)}:\n    if ${pendingIf.cond}:\n        ...`;
    if (!tryCommand({ text: command, provenance: [pendingIf.span] })) unparsed.push(pendingIf.span);
  }
  return { commands, unparsed };
}

/** The statement or root that holds a node directly. */
function ownerOf(document: IrDocument, id: string): string {
  for (const [owner, stmts] of blocks(document)) {
    if (stmts.some((stmt) => stmt.id === id)) return owner;
  }
  return 'root';
}

function renameCommand(document: IrDocument, command: string): string | undefined {
  const [, from = '', to = ''] = /^rename @name:(\S+) (\S+)$/.exec(command) ?? [];
  const target = allNodes(document.program).find(
    (node) => node.kind === 'Name' && node.name === from,
  );
  return target ? `rename ${target.id} ${to}` : undefined;
}

/** Translates with phrase patterns only. */
export function translateWithRules(context: TranslationContext): Translation {
  const { commands, unparsed } = rulesAnswer(context);
  const result = compileCommands(context.document, commands, {
    utteranceId: context.utterance.id,
    provenance: [],
  });
  return {
    batch: { utteranceId: context.utterance.id, ops: result.batch.ops },
    unparsedSpans: unparsed,
  };
}

export const rulesTranslator: Translator = {
  name: 'rules',
  translate: (context) => Promise.resolve(translateWithRules(context)),
};
