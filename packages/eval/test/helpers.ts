import { Console } from '@textscript/cli';
import { emptySession } from '@textscript/core';
import type { Translator } from '@textscript/translator';
import { loadCorpus, type Corpus } from '../src/corpus/load';

/** A small corpus in memory: problem ID → text, and so on. */
export function corpusOf(files: {
  problems: Record<string, string>;
  walkthroughs: Record<string, string>;
  gold: Record<string, string>;
}): Corpus {
  return loadCorpus({
    problems: new Map(Object.entries(files.problems)),
    walkthroughs: new Map(Object.entries(files.walkthroughs)),
    gold: new Map(Object.entries(files.gold)),
  });
}

/**
 * A translator that runs console commands, given per utterance ID (`u2`),
 * on the state it's handed. Utterances with no entry get an empty batch.
 */
export function scriptedTranslator(name: string, script: Record<string, string[]>): Translator {
  return {
    name,
    translate: (context) => {
      const console = new Console({
        fs: { readFile: () => '', writeFile: () => undefined },
        session: {
          state: { ...emptySession(), document: context.document, utterances: context.recent },
          events: [],
        },
      });
      console.execute(`say ${context.utterance.text}`);
      for (const command of script[context.utterance.id] ?? []) {
        const result = console.execute(command);
        if (result.status !== 'ok') throw new Error(`${command}: ${result.output.join('\n')}`);
      }
      console.execute(':commit');
      const event = console.events.at(-1);
      const batch =
        event?.type === 'edit' ? event.batch : { utteranceId: context.utterance.id, ops: [] };
      return Promise.resolve({ batch, unparsedSpans: [] });
    },
  };
}

export const PROBLEM = `---
title: Contains Duplicate
inputs: nums
tags: array
---
Return whether any value appears twice in \`nums\`.
`;

export const INCOMPLETE = `---
problem: dup
style: incomplete
---
Loop through the list of numbers.
If we've already seen the number, return true.
Oh, we keep a set called seen, empty at the start.
Otherwise add it to the set.
`;

export const INCOMPLETE_GOLD = `# Left out: what to return at the end.
step 1
add root: for num~loopvar in nums:
    ...
expect gaps GAP002
step 2
fill h1:
    if num in seen:
        return True
step 3
add root start: seen = set()
step 4
set n7.orelse = seen.add(num)  # ~synonym
expect gaps GAP003
`;

export const TERSE = `---
problem: dup
style: terse
---
Set called seen, starts empty.
Um, so, yeah.
For each num in nums, if num is in seen return True.
`;

export const TERSE_GOLD = `step 1
add root: seen = set()
step 2
step 3
add root:
    for num in nums:
        if num in seen:
            return True
or
add root:
    for num in nums:
        if num in seen:
            return True
        else:
            ...
`;

export function fixture(): Corpus {
  return corpusOf({
    problems: { dup: PROBLEM },
    walkthroughs: { 'dup.incomplete': INCOMPLETE, 'dup.terse': TERSE },
    gold: { 'dup.incomplete': INCOMPLETE_GOLD, 'dup.terse': TERSE_GOLD },
  });
}
