export { IR_SCHEMA_VERSION } from './ir/version';
export type * from './ir/types';
export { INFERENCE_RULE_IDS, type InferenceRuleId } from './ir/inference';
export { createIdAllocator, nodeIdNumber, type IdAllocator } from './ir/ids';
export { createBuilder, type Builder, type MetaInput } from './ir/build';
export {
  CHILD_FIELDS,
  NODE_KINDS,
  OPTIONAL_CHILD_FIELDS,
  allNodes,
  children,
  findNode,
  indexTree,
  isIrNode,
  isNodeKind,
  isOptionalChildField,
  parentOf,
  pathTo,
  replaceNode,
  updateNode,
  walk,
  type ChildFieldOf,
  type ChildSlot,
  type IndexEntry,
  type OptionalChildFieldOf,
  type Position,
  type WalkContext,
} from './ir/tree';
export {
  ExprSchema,
  IDENTIFIER_PATTERN,
  IrDocumentSchema,
  NODE_ID_PATTERN,
  NODE_SCHEMAS,
  StmtSchema,
  TEMP_ID_PATTERN,
  irDocumentJsonSchema,
} from './ir/schema';
export { checkInvariants, type InvariantCode, type InvariantIssue } from './ir/invariants';
export {
  MIGRATIONS,
  migrate,
  type JsonObject,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
} from './ir/migrations';
export {
  IrValidationError,
  deserialize,
  parseDocument,
  serialize,
  zodIssueMessages,
  type ParseResult,
  type ParseStage,
} from './ir/serialize';
export {
  buildSymbolTable,
  symbolAt,
  type Occurrence,
  type Reference,
  type Resolution,
  type Scope,
  type ScopeKind,
  type SymbolInfo,
  type SymbolTable,
  type SymbolTableOptions,
} from './ir/symbols';
export { diffPrograms, isEmptyDiff, type IrDiff } from './ir/diff';
export type * from './ops/types';
export { HOLE_REASONS, apply } from './ops/apply';
export { EditBatchSchema, EditOpSchema, OP_SCHEMAS, editBatchJsonSchema } from './ops/schema';
export { resolveTempIds, type TempIdResult } from './ops/temp-ids';
export {
  createUtterance,
  quoteSpan,
  tokenize,
  type Utterance,
  type UtteranceToken,
} from './session/tokenize';
export {
  SessionLogSchema,
  applyEvent,
  emptySession,
  parseSessionLog,
  replay,
  serializeSessionLog,
  UtteranceSchema,
  type AppliedEdit,
  type ParseSessionLogResult,
  type ReplayResult,
  type SessionError,
  type SessionErrorCode,
  type SessionEvent,
  type SessionLog,
  type SessionResult,
  type SessionState,
} from './session/session';
export {
  DIAGNOSTICS,
  type Diagnostic,
  type DiagnosticCode,
  type Severity,
} from './analyze/diagnostics';
export { INFERENCE_RULES, fitsInferenceRule, type InferenceRule } from './analyze/inference-rules';
export { completesNormally, fallsThrough } from './analyze/flow';
export {
  analyze,
  type Analysis,
  type AnalyzeOptions,
  type CoverageSummary,
} from './analyze/analyze';
