import { describe, expect, it } from 'vitest';
import {
  MIN_SUGGEST_QUERY_LENGTH,
  replaceTokenWithSymbol,
  searchQueryForToken,
  tokenAtCaret,
  type SymbolToken,
} from '../../src/lib/marketdata/symbol-suggest';

/**
 * Deterministic suite for the token handling behind symbol suggestions.
 *
 * A suggestion must only ever rewrite the token the caret is in: the rest of a
 * pasted batch has to survive untouched. These are pure string operations, so
 * every boundary is asserted directly rather than through the DOM.
 */

/** Fails loudly instead of silently accepting a null token in a test. */
function token(value: string, caret: number): SymbolToken {
  const found = tokenAtCaret(value, caret);
  if (!found) throw new Error(`expected a token at ${caret} in ${JSON.stringify(value)}`);
  return found;
}

describe('tokenAtCaret', () => {
  it('finds the token a caret sits inside', () => {
    expect(token('aapl msft', 2)).toEqual({ text: 'aapl', start: 0, end: 4 });
    expect(token('aapl msft', 7)).toEqual({ text: 'msft', start: 5, end: 9 });
  });

  it('keeps the caret in the token it touches at either edge', () => {
    expect(token('aapl', 0)).toEqual({ text: 'aapl', start: 0, end: 4 });
    expect(token('aapl', 4)).toEqual({ text: 'aapl', start: 0, end: 4 });
    expect(token('google, amzn', 6)).toEqual({ text: 'google', start: 0, end: 6 });
  });

  it('treats commas, semicolons, spaces and newlines as token boundaries', () => {
    expect(token('a,b', 0).text).toBe('a');
    expect(token('a;b', 2).text).toBe('b');
    expect(token('amzn\ngoogle', 8).text).toBe('google');
  });

  it('returns null when the caret is between two separators or in an empty field', () => {
    // A caret directly after a token still belongs to that token...
    expect(token('aapl, msft', 4).text).toBe('aapl');
    // ...but between the comma and the space there is nothing to search for.
    expect(tokenAtCaret('aapl, msft', 5)).toBeNull();
    expect(tokenAtCaret('', 0)).toBeNull();
    expect(tokenAtCaret('   ', 2)).toBeNull();
    expect(tokenAtCaret('aapl\n', 5)).toBeNull();
  });

  it('clamps a caret outside the value instead of throwing', () => {
    expect(tokenAtCaret('aapl', 99)).toEqual({ text: 'aapl', start: 0, end: 4 });
    expect(tokenAtCaret('aapl', -3)).toEqual({ text: 'aapl', start: 0, end: 4 });
    expect(tokenAtCaret('aapl', Number.NaN)).toEqual({ text: 'aapl', start: 0, end: 4 });
  });

  it('keeps the typed case and the surrounding text intact', () => {
    const found = token('  Google ,msft', 4);
    expect(found).toEqual({ text: 'Google', start: 2, end: 8 });
    expect('  Google ,msft'.slice(0, found.start) + found.text + '  Google ,msft'.slice(found.end)).toBe('  Google ,msft');
  });
});

describe('searchQueryForToken', () => {
  it('asks the provider for tokens long enough to be meaningful', () => {
    expect(searchQueryForToken(token('google', 3))).toBe('google');
    expect(searchQueryForToken(token('go', 1))).toBe('go');
  });

  it('stays quiet for short or symbol-shaped-invalid tokens', () => {
    expect(MIN_SUGGEST_QUERY_LENGTH).toBe(2);
    expect(searchQueryForToken(token('AAPL, g', 7))).toBeNull();
    expect(searchQueryForToken(token('goo/gle', 4))).toBeNull();
    expect(searchQueryForToken(null)).toBeNull();
  });

  it('accepts the punctuation real provider symbols use', () => {
    expect(searchQueryForToken(token('^GSPC', 3))).toBe('^GSPC');
    expect(searchQueryForToken(token('BP.L', 2))).toBe('BP.L');
  });
});

describe('replaceTokenWithSymbol', () => {
  it('rewrites only the token under the caret', () => {
    expect(replaceTokenWithSymbol('amzn\ngoogle', token('amzn\ngoogle', 8), 'GOOGL')).toEqual({
      value: 'amzn\nGOOGL, ',
      caret: 12,
    });
  });

  it('leaves the rest of the list untouched when the token is in the middle', () => {
    const value = 'googl, msft, nvda';
    const result = replaceTokenWithSymbol(value, token(value, 3), 'GOOGL');
    expect(result.value).toBe('GOOGL, msft, nvda');
    expect(result.caret).toBe(5);
  });

  it('adds a separator only for the last token so typing continues cleanly', () => {
    expect(replaceTokenWithSymbol('nvda', token('nvda', 4), 'NVDA').value).toBe('NVDA, ');
    expect(replaceTokenWithSymbol('nvda\n', token('nvda\n', 2), 'NVDA').value).toBe('NVDA\n');
    expect(replaceTokenWithSymbol('aapl, googl, ', token('aapl, googl, ', 7), 'GOOGL').value).toBe('aapl, GOOGL, ');
  });

  it('produces a list the batch parser reads back as one symbol per pick', () => {
    const picked = replaceTokenWithSymbol('amzn\ngoogle', token('amzn\ngoogle', 8), 'GOOGL');
    expect(picked.value.split(',')).toHaveLength(2);
  });
});
