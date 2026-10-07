export { checkBatch, heldBackNotice, validatedTranslator, type CheckOptions } from './check';
export {
  codeOf,
  HELD_BACK_REASON,
  validate,
  VALIDATION_CODES,
  type Claim,
  type HeldBack,
  type ValidationCode,
  type ValidationInput,
  type ValidationResult,
} from './validate';
export {
  createClaudeVerifier,
  VERIFIER_MODEL,
  type ClaudeVerifierOptions,
  type Verifier,
} from './verifier';
export { inflects, nameParts, nameSaid, partMatches, Words } from './words';
