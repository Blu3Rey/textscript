// Splits an utterance into the tokens that provenance spans count
// (docs/adr/006). Tokens are stored with the utterance, so changing this
// function never shifts the spans of sessions already recorded.

export interface UtteranceToken {
  text: string;
  /** Offset of the first character, in UTF-16 code units. */
  start: number;
  /** Offset just past the last character. */
  end: number;
}

export interface Utterance {
  id: string;
  text: string;
  tokens: UtteranceToken[];
}

/**
 * A token is a decimal number ("0.5"), a word (letters, digits, underscores
 * and inner apostrophes: "we've", "two_sum"), or any other single character
 * that isn't whitespace ("(", ",", "😀").
 */
const TOKEN = /\p{N}+(?:\.\p{N}+)+|[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*|\S/gu;

export function tokenize(text: string): UtteranceToken[] {
  return [...text.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function createUtterance(id: string, text: string): Utterance {
  return { id, text, tokens: tokenize(text) };
}
