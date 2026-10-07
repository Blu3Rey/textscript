// Translation contexts and translations as JSON, for calls between the
// browser and apps/server. Both sides validate what they receive.

import {
  EditBatchSchema,
  parseDocument,
  UtteranceSchema,
  zodIssueMessages,
} from '@textscript/core';
import { z } from 'zod';
import type { Translation, TranslationContext } from './translator';

const ProblemSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  statement: z.string(),
  inputs: z.array(z.string()),
});

const ContextShape = z.strictObject({
  utterance: UtteranceSchema,
  document: z.unknown(),
  recent: z.array(UtteranceSchema),
  problem: ProblemSchema,
});

const SpanSchema = z.strictObject({
  utteranceId: z.string(),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
});

const TranslationSchema = z.strictObject({
  batch: EditBatchSchema,
  unparsedSpans: z.array(SpanSchema),
  usage: z
    .strictObject({
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number().exactOptional(),
    })
    .exactOptional(),
  trace: z
    .strictObject({ attempts: z.number(), salvaged: z.boolean(), errors: z.array(z.string()) })
    .exactOptional(),
  heldBack: z
    .array(
      z.strictObject({
        code: z.string(),
        proposed: z.string(),
        message: z.string(),
        spans: z.array(SpanSchema),
      }),
    )
    .exactOptional(),
});

export type WireResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function parseTranslationContext(raw: unknown): WireResult<TranslationContext> {
  const shape = ContextShape.safeParse(raw);
  if (!shape.success) return { ok: false, issues: zodIssueMessages(shape.error) };
  const document = parseDocument(shape.data.document);
  if (!document.ok)
    return { ok: false, issues: document.issues.map((issue) => `document: ${issue}`) };
  return { ok: true, value: { ...shape.data, document: document.document } };
}

export function parseTranslation(raw: unknown): WireResult<Translation> {
  const parsed = TranslationSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: zodIssueMessages(parsed.error) };
}
