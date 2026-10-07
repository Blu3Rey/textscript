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
  claudeBackend,
  createClaudeTranslator,
  DEFAULT_MODEL,
  PRICES,
  type ClaudeTranslatorOptions,
  type MessagesApi,
  type ModelReply,
} from './claude';
export {
  createGeminiTranslator,
  GEMINI_DEFAULT_MODEL,
  GEMINI_PRICES,
  geminiBackend,
  type GeminiModelsApi,
  type GeminiReply,
  type GeminiTranslatorOptions,
} from './gemini';
export {
  createLlmTranslator,
  TranslatorError,
  type Conversation,
  type Effort,
  type LlmBackend,
  type LlmTranslatorOptions,
  type Price,
} from './llm';
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
