// Few-shot examples for the LLM translator, made from corpus gold
// (docs/adr/012). They come only from training-split problems, and the
// runner leaves those problems out when it scores the LLM translator, so a
// walkthrough is never scored with its own answer in the prompt.

import { packProblem, packTurn, type Example } from '@textscript/translator';
import type { CorpusFiles } from './corpus/corpus';
import { parseGold } from './corpus/gold';
import type { Corpus } from './corpus/load';

/** One walkthrough per style, from four training problems. */
export const EXAMPLE_WALKTHROUGHS: readonly string[] = [
  'contains-duplicate.incomplete',
  'two-sum.corrective',
  'valid-anagram.rambling',
  'move-zeroes.terse',
];

/** Problems the examples come from. */
export function exampleProblems(corpus: Corpus): string[] {
  return EXAMPLE_WALKTHROUGHS.flatMap((id) => {
    const problem = corpus.walkthroughs.get(id)?.problem;
    return problem === undefined ? [] : [problem];
  });
}

export function buildExamples(corpus: Corpus, files: CorpusFiles): Example[] {
  return EXAMPLE_WALKTHROUGHS.map((id) => {
    const gold = corpus.gold.get(id);
    const text = files.gold.get(id);
    const problem = gold ? corpus.problems.get(gold.walkthrough.problem) : undefined;
    if (gold === undefined || text === undefined || problem === undefined) {
      throw new Error(`Example walkthrough ${id} has no compiled gold`);
    }
    if (problem.split !== 'train')
      throw new Error(`Example walkthrough ${id} isn't in the training split`);
    const sources = parseGold(id, text, []);
    const problemContext = {
      id: problem.id,
      title: problem.title,
      statement: problem.statement,
      inputs: problem.inputs,
    };
    return {
      walkthrough: id,
      problem: packProblem(problemContext),
      steps: gold.steps.map((step, i) => ({
        turn: packTurn({
          utterance: step.utterance,
          document: step.before,
          recent: step.recent,
          problem: problemContext,
        }),
        answer: {
          commands: (sources[i]?.alternatives[0] ?? [])
            .filter((command) => !command.text.startsWith('expect'))
            .map((command) => ({ command: command.text, words: [] })),
          unparsed: [],
        },
      })),
    };
  });
}
