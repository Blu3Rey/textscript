import { describe, expect, it } from 'vitest';
import { parseProblem, parseWalkthrough, type CorpusIssue } from '../src/corpus/corpus';
import { parseGold } from '../src/corpus/gold';
import { readCorpusDir } from '../src/corpus/load';
import {
  corpusOf,
  fixture,
  INCOMPLETE,
  INCOMPLETE_GOLD,
  PROBLEM,
  TERSE,
  TERSE_GOLD,
} from './helpers';

function messages(issues: CorpusIssue[]): string[] {
  return issues.map(
    (i) => `${i.file}${i.line === undefined ? '' : `:${String(i.line)}`} ${i.message}`,
  );
}

describe('problems', () => {
  it('parse the header and statement', () => {
    const issues: CorpusIssue[] = [];
    const problem = parseProblem(
      'two-sum',
      '---\ntitle: Two Sum\ninputs: nums, target\nsplit: test\ntags: array, hash-map\n---\nFind two.\n',
      issues,
    );
    expect(issues).toEqual([]);
    expect(problem).toEqual({
      id: 'two-sum',
      title: 'Two Sum',
      inputs: ['nums', 'target'],
      split: 'test',
      tags: ['array', 'hash-map'],
      statement: 'Find two.',
    });
  });

  it('report every problem with the file', () => {
    const issues: CorpusIssue[] = [];
    parseProblem(
      'Bad_ID',
      '---\nsplit: dev\ncolor: red\ntitle: X\ntitle: Y\nnot a field\n---\n',
      issues,
    );
    expect(messages(issues)).toEqual([
      'problems/Bad_ID.md Problem IDs are lowercase words joined by dashes',
      'problems/Bad_ID.md:5 "title" is given twice',
      'problems/Bad_ID.md:6 Expected "key: value", found "not a field"',
      'problems/Bad_ID.md:3 Unknown header field "color"',
      'problems/Bad_ID.md:2 Split must be train or test, not "dev"',
      'problems/Bad_ID.md A problem needs its inputs ("inputs: nums, target")',
      'problems/Bad_ID.md The statement is empty',
    ]);
  });

  it('need a header', () => {
    const issues: CorpusIssue[] = [];
    expect(parseProblem('x', 'no header', issues)).toBeUndefined();
    expect(parseProblem('y', '---\ntitle: open', issues)).toBeUndefined();
    expect(parseProblem('z', '---\ninputs: a\n---\nS', issues)?.title).toBe('');
    expect(messages(issues)).toEqual([
      'problems/x.md:1 Expected a "---" header line',
      'problems/y.md:1 The header has no closing "---"',
      'problems/z.md A problem needs a title',
    ]);
  });
});

describe('walkthroughs', () => {
  it('have one utterance per non-empty line', () => {
    const issues: CorpusIssue[] = [];
    expect(
      parseWalkthrough(
        'dup.terse-2',
        '---\nproblem: dup\nstyle: terse\n---\n\n  One.  \n\nTwo.\n',
        issues,
      ),
    ).toEqual({
      id: 'dup.terse-2',
      problem: 'dup',
      style: 'terse',
      utterances: ['One.', 'Two.'],
    });
    expect(issues).toEqual([]);
  });

  it('must be named after their problem and style', () => {
    const issues: CorpusIssue[] = [];
    parseWalkthrough('dup.rambling', '---\nproblem: dup\nstyle: terse\n---\nA.', issues);
    parseWalkthrough('dup.x', '---\nproblem: dup\nstyle: chatty\n---\nA.', issues);
    parseWalkthrough('dup.terse', '---\nproblem: dup\nstyle: terse\n---\n', issues);
    parseWalkthrough('dup.terse', 'nope', issues);
    expect(messages(issues)).toEqual([
      'walkthroughs/dup.rambling.txt The file should be named dup.terse.txt (or dup.terse-2.txt, …)',
      'walkthroughs/dup.x.txt Style must be one of terse, rambling, corrective, incomplete, not "chatty"',
      'walkthroughs/dup.terse.txt A walkthrough needs at least one utterance',
      'walkthroughs/dup.terse.txt:1 Expected a "---" header line',
    ]);
  });
});

describe('gold', () => {
  it('splits steps and alternatives', () => {
    const issues: CorpusIssue[] = [];
    const steps = parseGold(
      'w',
      '# c\nstep 1\nadd root: x = 1\nor\nadd root:\n  y = 2\nstep 2\n',
      issues,
    );
    expect(issues).toEqual([]);
    expect(steps).toEqual([
      {
        number: 1,
        line: 2,
        alternatives: [
          [{ line: 3, text: 'add root: x = 1' }],
          [{ line: 5, text: 'add root:\n  y = 2' }],
        ],
      },
      { number: 2, line: 7, alternatives: [[]] },
    ]);
  });

  it('rejects commands outside steps, wrong numbering and non-edit commands', () => {
    const issues: CorpusIssue[] = [];
    parseGold('w', 'add root: x = 1\nstep 2\n:undo\nsay hi\n', issues);
    expect(messages(issues)).toEqual([
      'gold/w.gold:1 Commands must come after a "step <n>" line',
      'gold/w.gold:2 Expected step 1, found step 2',
      `gold/w.gold:3 ":undo" can't be used in gold; use edit commands and expect`,
      `gold/w.gold:4 "say" can't be used in gold; use edit commands and expect`,
    ]);
  });

  it('compiles into states, batches and alternatives', () => {
    const corpus = fixture();
    expect(corpus.issues).toEqual([]);
    const gold = corpus.gold.get('dup.terse');
    expect(gold?.complete).toBe(true);
    expect(gold?.steps.map((s) => s.alternatives.length)).toEqual([1, 1, 2]);
    expect(gold?.steps[1]?.alternatives[0]?.batch.ops).toEqual([]);
    expect(gold?.steps[2]?.recent.map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(gold?.steps[2]?.utterance.text).toBe(
      'For each num in nums, if num is in seen return True.',
    );
  });
});

describe('loadCorpus', () => {
  it('reports cross-file problems', () => {
    const corpus = corpusOf({
      problems: { dup: PROBLEM, lonely: PROBLEM },
      walkthroughs: {
        'dup.incomplete': INCOMPLETE,
        'dup.terse': TERSE,
        'ghost.terse': TERSE.replace('dup', 'ghost'),
      },
      gold: { 'dup.incomplete': INCOMPLETE_GOLD, 'orphan.terse': TERSE_GOLD },
    });
    expect(messages(corpus.issues)).toEqual([
      'walkthroughs/ghost.terse.txt No problem "ghost"',
      'gold/orphan.terse.gold No walkthrough "orphan.terse"',
      'walkthroughs/dup.terse.txt This walkthrough has no gold file',
      'walkthroughs/ghost.terse.txt This walkthrough has no gold file',
      'problems/lonely.md Has 0 walkthroughs; every problem needs at least 2',
    ]);
  });

  it('keeps the steps before a failing one as a draft', () => {
    const corpus = corpusOf({
      problems: { dup: PROBLEM },
      walkthroughs: { 'dup.incomplete': INCOMPLETE, 'dup.terse': TERSE },
      gold: {
        'dup.incomplete': INCOMPLETE_GOLD.replace('expect gaps GAP002', 'expect gaps none'),
        'dup.terse': 'step 1\nadd root: seen = set()\nstep 2\nremove n99\nstep 3\n',
      },
    });
    expect(corpus.gold.size).toBe(0);
    expect(corpus.drafts.get('dup.incomplete')?.steps).toHaveLength(0);
    expect(corpus.drafts.get('dup.terse')?.steps).toHaveLength(1);
    expect(messages(corpus.issues)).toEqual([
      'gold/dup.incomplete.gold:5 Step 1: ✗ expected gaps none, got GAP002',
      'gold/dup.terse.gold:4 Step 2: ✗ bad-ref: There is no node n99',
    ]);
  });

  it('needs a step for every utterance', () => {
    const corpus = corpusOf({
      problems: { dup: PROBLEM },
      walkthroughs: { 'dup.incomplete': INCOMPLETE, 'dup.terse': TERSE },
      gold: { 'dup.incomplete': INCOMPLETE_GOLD, 'dup.terse': 'step 1\nstep 2\nstep 3\nstep 4\n' },
    });
    expect(messages(corpus.issues)).toEqual([
      'gold/dup.terse.gold The walkthrough has 3 utterances but the gold has 4 steps',
    ]);
  });

  it('reads nothing from a missing directory', () => {
    const files = readCorpusDir('/nonexistent/corpus');
    expect(files.problems.size + files.walkthroughs.size + files.gold.size).toBe(0);
  });
});
