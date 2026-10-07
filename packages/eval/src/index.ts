// Public API of @textscript/eval.
export { agreement, compareSteps, type Agreement, type StepAgreement } from './agreement';
export { align, isPlaceholder, type Alignment } from './compare/align';
export {
  changedNodes,
  compareStep,
  type FilledGap,
  type NodeRef,
  type StepComparison,
} from './compare/step';
export {
  parseProblem,
  parseWalkthrough,
  SPLITS,
  STYLES,
  type CorpusFiles,
  type CorpusIssue,
  type Problem,
  type Split,
  type Style,
  type Walkthrough,
} from './corpus/corpus';
export { compileGold, parseGold, type CompiledGold, type GoldStep } from './corpus/gold';
export { loadCorpus, readCorpusDir, type Corpus } from './corpus/load';
export { baselineOf, checkGate, type Baseline, type GateResult } from './gate';
export { computeMetrics, isExact, type Metrics, type Ratio } from './metrics';
export { explain, type Reason } from './report/explain';
export { htmlReport, M2_TARGETS, markdownReport } from './report/report';
export {
  breakdown,
  oracleTranslator,
  runEval,
  type RunOptions,
  type RunResult,
  type StepResult,
} from './run';
