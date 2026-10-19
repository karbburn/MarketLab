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
  const units: ReadonlyArray<{ size: number; suffix: string }> = [
    { size: 1_000_000_000, suffix: 'B' },
    { size: 1_000_000, suffix: 'M' },
    { size: 1_000, suffix: 'K' },
  ];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i] as { size: number; suffix: string };
    if (abs < unit.size) continue;
    // Normalise before choosing the unit: a value that rounds to 1000.00 in
    // this unit belongs to the next larger one.
    if (i > 0 && Number((abs / unit.size).toFixed(2)) >= 1000) {
      const larger = units[i - 1] as { size: number; suffix: string };
      return `${(value / larger.size).toFixed(2)}${larger.suffix}`;
    }
    return `${(value / unit.size).toFixed(2)}${unit.suffix}`;
  }
  return value.toFixed(0);
}

export function formatRatio(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}
