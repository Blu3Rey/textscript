// Reading and writing IR documents as JSON.
//
// Reading runs every check in order: JSON syntax, schema version (with
// migration), shape, then invariants. Writing re-parses the document through
// the schema first, which both validates it and puts every object's keys in
// schema order, so equal documents always serialize to identical text.

import type { z } from 'zod';
import { checkInvariants } from './invariants';
import { migrate, type MigrateOptions } from './migrations';
import { IrDocumentSchema } from './schema';
import type { IrDocument } from './types';

export type ParseStage = 'json' | 'version' | 'shape' | 'invariants';

export type ParseResult =
  { ok: true; document: IrDocument } | { ok: false; stage: ParseStage; issues: string[] };

export class IrValidationError extends Error {
  readonly stage: ParseStage;
  readonly issues: readonly string[];

  constructor(stage: ParseStage, issues: readonly string[]) {
    super(`Invalid IR document (${stage}):\n  ${issues.join('\n  ')}`);
    this.name = 'IrValidationError';
    this.stage = stage;
    this.issues = issues;
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, key) => {
    if (typeof key === 'number') return `${text}[${String(key)}]`;
    return text === '' ? String(key) : `${text}.${String(key)}`;
  }, '');
}

/** Zod issues as `path: message` lines. */
export function zodIssueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = formatPath(issue.path);
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

/** Validates an already-parsed JSON value as a document, migrating it if it's older. */
export function parseDocument(raw: unknown, options: MigrateOptions = {}): ParseResult {
  const migrated = migrate(raw, options);
  if (!migrated.ok) return { ok: false, stage: 'version', issues: [migrated.issue] };

  const shaped = IrDocumentSchema.safeParse(migrated.document);
  if (!shaped.success) return { ok: false, stage: 'shape', issues: zodIssueMessages(shaped.error) };

  const invariantIssues = checkInvariants(shaped.data);
  if (invariantIssues.length > 0) {
    return {
      ok: false,
      stage: 'invariants',
      issues: invariantIssues.map((issue) => `${issue.code}: ${issue.message}`),
    };
  }
  return { ok: true, document: shaped.data };
}

/** Parses and validates a document from JSON text. */
export function deserialize(text: string, options: MigrateOptions = {}): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, stage: 'json', issues: [error.message] };
  }
  return parseDocument(raw, options);
}

/**
 * Writes a document as canonical JSON. Throws `IrValidationError` if the
 * document is invalid, so an invalid document is never persisted.
 */
export function serialize(doc: IrDocument, options: { pretty?: boolean } = {}): string {
  const result = parseDocument(doc);
  if (!result.ok) throw new IrValidationError(result.stage, result.issues);
  return JSON.stringify(result.document, null, options.pretty === true ? 2 : undefined);
}
