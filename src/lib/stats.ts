/** Small, dependency-free numeric helpers shared by indicators, quant and screener code. */

export type MaybeNumber = number | null;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample standard deviation (ddof = 1). */
export function sampleStdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const value of values) acc += (value - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/** Population standard deviation (ddof = 0), used by Bollinger Bands. */
export function populationStdDev(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const value of values) acc += (value - m) ** 2;
  return Math.sqrt(acc / values.length);
}

export function variance(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const value of values) acc += (value - m) ** 2;
  return acc / (values.length - 1);
}

export function covariance(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = mean(a);
  const meanB = mean(b);
  if (meanA === null || meanB === null) return null;
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    acc += ((a[i] as number) - meanA) * ((b[i] as number) - meanB);
  }
  return acc / (a.length - 1);
}

export function pearsonCorrelation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const sdA = sampleStdDev(a);
  const sdB = sampleStdDev(b);
  if (sdA === null || sdB === null || sdA === 0 || sdB === 0) return null;
  const cov = covariance(a, b);
  if (cov === null) return null;
  return cov / (sdA * sdB);
}

/**
 * Simple skewness estimator (Fisher-Pearson standardised third moment with
 * sample correction). Requires at least three observations.
 */
export function skewness(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const m = mean(values);
  const sd = sampleStdDev(values);
  if (m === null || sd === null || sd === 0) return null;
  let acc = 0;
  for (const value of values) acc += ((value - m) / sd) ** 3;
  return (n / ((n - 1) * (n - 2))) * acc;
}

/** Excess kurtosis estimator. Requires at least four observations. */
export function excessKurtosis(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 4) return null;
  const m = mean(values);
  const sd = sampleStdDev(values);
  if (m === null || sd === null || sd === 0) return null;
  let acc = 0;
  for (const value of values) acc += ((value - m) / sd) ** 4;
  const numerator = (n * (n + 1) * acc) / ((n - 1) * (n - 2) * (n - 3));
  const correction = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return numerator - correction;
}

export function quantile(sortedValues: readonly number[], q: number): number | null {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * Math.max(0, Math.min(1, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower] as number;
  const upperValue = sortedValues[upper] as number;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function percentageChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return null;
  return (to / from - 1) * 100;
}
