import { useMemo } from 'react';

export interface SeriesPoint {
  x: number;
  y: number;
}

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  points: SeriesPoint[];
}

/**
 * Dependency-free SVG line chart.
 *
 * Strokes use `vector-effect="non-scaling-stroke"` so a stretched viewBox never
 * thickens or thins the lines. Missing values are represented by gaps rather
 * than being interpolated across, which matches how the underlying series are
 * computed.
 */
export function LineChart({
  series,
  height = 200,
  yFormat = (value: number) => value.toFixed(2),
  xLabels = [],
  baseline,
  ariaLabel,
}: {
  series: readonly ChartSeries[];
  height?: number;
  yFormat?: (value: number) => string;
  xLabels?: Array<{ x: number; label: string }>;
  baseline?: number;
  ariaLabel: string;
}) {
  const { min, max, count } = useMemo(() => {
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let points = 0;
    for (const entry of series) {
      for (const point of entry.points) {
        if (Number.isFinite(point.y)) {
          if (point.y < lowest) lowest = point.y;
          if (point.y > highest) highest = point.y;
        }
        if (point.x + 1 > points) points = point.x + 1;
      }
    }
    if (baseline !== undefined) {
      lowest = Math.min(lowest, baseline);
      highest = Math.max(highest, baseline);
    }
    if (!Number.isFinite(lowest) || !Number.isFinite(highest)) {
      return { min: 0, max: 1, count: 0 };
    }
    if (lowest === highest) {
      const pad = Math.abs(lowest) * 0.05 || 1;
      return { min: lowest - pad, max: highest + pad, count: points };
    }
    const pad = (highest - lowest) * 0.08;
    return { min: lowest - pad, max: highest + pad, count: points };
  }, [series, baseline]);

  const width = 1000;
  const plotTop = 8;
  const plotBottom = height - 18;
  const toY = (value: number) => plotTop + ((max - value) / (max - min || 1)) * (plotBottom - plotTop);
  const toX = (x: number) => (count <= 1 ? 0 : (x / (count - 1)) * width);

  const paths = series.map((entry) => {
    let path = '';
    let penDown = false;
    for (const point of entry.points) {
      if (!Number.isFinite(point.y)) {
        penDown = false;
        continue;
      }
      const command = penDown ? 'L' : 'M';
      path += `${command}${toX(point.x).toFixed(2)},${toY(point.y).toFixed(2)} `;
      penDown = true;
    }
    return { entry, path: path.trim() };
  });

  if (count === 0) {
    return (
      <div className="empty" style={{ padding: 20 }}>
        <span className="empty-body">Nothing to plot for this selection.</span>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row tight">
        {series.map((entry) => (
          <span key={entry.id} className="row tight">
            <span className="legend-swatch" style={{ background: entry.color }} />
            <span className="panel-sub">{entry.label}</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, alignItems: 'stretch' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height, display: 'block', background: 'var(--surface-inset)', borderRadius: 'var(--radius)' }}
          role="img"
          aria-label={ariaLabel}
          preserveAspectRatio="none"
        >
          <line x1={0} x2={width} y1={plotTop} y2={plotTop} stroke="var(--border-subtle)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={width} y1={plotBottom} y2={plotBottom} stroke="var(--border-subtle)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {baseline !== undefined && (
            <line
              x1={0}
              x2={width}
              y1={toY(baseline)}
              y2={toY(baseline)}
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {paths.map(({ entry, path }) => (
            <path
              key={entry.id}
              d={path}
              fill="none"
              stroke={entry.color}
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <div className="mono" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-muted)' }}>
          <span>{yFormat(max)}</span>
          <span>{yFormat((max + min) / 2)}</span>
          <span>{yFormat(min)}</span>
        </div>
      </div>
      {xLabels.length > 0 && (
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-muted)' }}>
          {xLabels.map((label) => (
            <span key={label.x}>{label.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}
