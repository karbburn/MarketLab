/**
 * Token handling for symbol suggestions in a free-form batch list.
 *
 * The batch field accepts several symbols separated by commas, semicolons or
 * newlines, so a suggestion must only ever replace the token the caret is in —
 * picking a ticker for one line can never rewrite the rest of the list.
 *
 * Everything here is a pure string operation: no DOM, no provider, so the
 * behaviour can be unit tested directly.
 */

import { SYMBOL_PATTERN } from './queue';

/** The same separators `parseSymbolList` splits on, so both see identical tokens. */
const TOKEN_SEPARATOR = /[\s,;]/;

/** A search is only useful once the operator has typed something to search for. */
export const MIN_SUGGEST_QUERY_LENGTH = 2;

export interface SymbolToken {
  /** The token exactly as typed; case is preserved. */
  text: string;
  /** Index of the first character inside `value`. */
  start: number;
  /** Index just past the last character inside `value`. */
  end: number;
}

/**
 * The token the caret sits in, or null when the caret is on a separator or in
 * an empty field. A caret placed directly after a token still belongs to it
 * (`google|, msft`), because that is where the operator is typing.
 */
export function tokenAtCaret(value: string, caret: number): SymbolToken | null {
  const position = Math.min(Math.max(Number.isFinite(caret) ? caret : 0, 0), value.length);
  let start = position;
  while (start > 0 && !TOKEN_SEPARATOR.test(value[start - 1] as string)) start -= 1;
  let end = position;
  while (end < value.length && !TOKEN_SEPARATOR.test(value[end] as string)) end += 1;
  if (start === end) return null;
  return { text: value.slice(start, end), start, end };
}

/**
 * The provider query for a token, or null when the provider cannot answer it:
 * too short to be meaningful, or not shaped like a symbol at all.
 */
export function searchQueryForToken(token: SymbolToken | null): string | null {
  if (!token) return null;
  const text = token.text;
  if (text.length < MIN_SUGGEST_QUERY_LENGTH) return null;
  return SYMBOL_PATTERN.test(text) ? text : null;
}

export interface TokenReplacement {
  value: string;
  /** Where the caret belongs once the replacement is rendered. */
  caret: number;
}

/**
 * Replaces one token with a chosen symbol and keeps the rest of the list.
 *
 * When the accepted token was the last thing in the field a separator is
 * appended, so the next keystroke starts a new symbol instead of being glued
 * onto the ticker that was just picked.
 */
export function replaceTokenWithSymbol(value: string, token: SymbolToken, symbol: string): TokenReplacement {
  const next = value.slice(0, token.start) + symbol + value.slice(token.end);
  const atEnd = token.end === value.length;
  return {
    value: atEnd ? `${next}, ` : next,
    caret: token.start + symbol.length + (atEnd ? 2 : 0),
  };
}
