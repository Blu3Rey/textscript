# @textscript/translator

The `Translator` interface: one utterance, the solution so far, recent
utterances and the problem in; an edit batch out (ROADMAP.md §2.1). It is
the only part of TextScript that may use a language model. Everything it
returns still goes through `apply`.

S6 defines the contract and `emptyTranslator`, which translates nothing.
S7 adds the rule-based baseline and the LLM translator. Browser-safe.
