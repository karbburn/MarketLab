const priceFormatters = new Map<number, Intl.NumberFormat>();

export function formatPrice(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return '-';
  const digits = Math.max(0, Math.min(8, maximumFractionDigits));
  let formatter = priceFormatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    });
    priceFormatters.set(digits, formatter);
  }
  return formatter.format(value);
}

export function formatSignedPrice(value: number, digits = 2): string {
  const formatted = formatPrice(Math.abs(value), digits);
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatted}`;
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(digits)}%`;
}

export function formatSignedPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(0);
}

export function formatRatio(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}
