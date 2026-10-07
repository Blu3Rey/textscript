import { createUtterance, emptySession } from '@textscript/core';
import { expect, it } from 'vitest';
import { emptyTranslator } from '../src/index';

it('the empty translator returns an empty batch for the utterance', async () => {
  const utterance = createUtterance('u3', 'Loop through the numbers.');
  const result = await emptyTranslator.translate({
    utterance,
    document: emptySession().document,
    recent: [],
    problem: { id: 'p', title: 'P', statement: 'S', inputs: [] },
  });
  expect(result).toEqual({ batch: { utteranceId: 'u3', ops: [] }, unparsedSpans: [] });
});
