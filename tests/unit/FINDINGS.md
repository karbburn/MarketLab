# Unit test findings

Issues discovered while writing the unit tests where the source behaves
differently from what was assumed.

## Non-positive prices were not rejected by CSV validation (fixed)

- File: `src/lib/validation/dataset.ts`
- Function: `validateCsvRows`
- Originally: there was no positivity check on `open`, `high`, `low`, `close`.
  A row such as `-10,-5,-12,-8` or `0,0,0,0` passed the OHLC invariants and was
  accepted. The only numeric guard was `volume < 0`.
- Resolution: a positivity guard was added to the validator. Rows with any price
  `<= 0` are rejected with the reason "Prices must be greater than zero ... Series
  with zero or negative prices (such as spread quotes) are not supported."
  `tests/unit/validation.test.ts` now covers both the negative and zero cases.

## `high < low` is rejected, but only via the `high < max(open, close)` guard

- File: `src/lib/validation/dataset.ts`
- Function: `validateCsvRows`
- Note: A row where `high < low` cannot pass the earlier checks because
  `high >= max(open, close) >= min(open, close) >= low` is required first. Such a
  row is still rejected, so the test asserts rejection (row number recorded)
  without asserting the exact `high < low` message. This is documented rather
  than treated as a defect.
