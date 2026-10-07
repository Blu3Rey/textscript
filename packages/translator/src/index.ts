// Public API of @textscript/translator.
export {
  ANSWER_JSON_SCHEMA,
  AnswerSchema,
  encodeAnswer,
  salvageAnswer,
  withUnparsedNotes,
  type Answer,
  type AnswerCommand,
  type EncodeResult,
} from './answer';
export {
  createClaudeTranslator,
  DEFAULT_MODEL,
  PRICES,
  TranslatorError,
  type ClaudeTranslatorOptions,
  type Effort,
  type MessagesApi,
  type ModelReply,
} from './claude';
export { numberedWords, packProblem, packTurn } from './context';
export { systemPrompt, type Example, type ExampleStep } from './prompt';
export {
  createRemoteTranslator,
  RemoteTranslatorError,
  type RemoteTranslatorOptions,
} from './remote';
export { rulesTranslator, translateWithRules } from './rules';
export {
  emptyTranslator,
  type HeldBackNotice,
  type ProblemContext,
  type Translation,
  type TranslationContext,
  type TranslationUsage,
  type Translator,
} from './translator';
export { parseTranslation, parseTranslationContext, type WireResult } from './wire';
