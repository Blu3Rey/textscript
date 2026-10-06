export { IR_SCHEMA_VERSION } from './ir/version';
export type * from './ir/types';
export { INFERENCE_RULE_IDS, type InferenceRuleId } from './ir/inference';
export { createIdAllocator, nodeIdNumber, type IdAllocator } from './ir/ids';
export { createBuilder, type Builder, type MetaInput } from './ir/build';
export {
  CHILD_FIELDS,
  NODE_KINDS,
  allNodes,
  children,
  findNode,
  indexTree,
  isIrNode,
  isNodeKind,
  parentOf,
  pathTo,
  replaceNode,
  updateNode,
  walk,
  type ChildFieldOf,
  type ChildSlot,
  type IndexEntry,
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
