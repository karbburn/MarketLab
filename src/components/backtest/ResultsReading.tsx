import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { BacktestResult, Frequency } from '../../domain/types';
import { interpretBacktest } from '../../lib/backtest/interpretation';
import { Panel, Tag } from '../ui';

/**
 * Plain-language readings for a recomputed result.
 *
 * The subtitle is deliberately explicit about where the numbers came from: a
 * loaded saved run is a working copy, and its recorded metrics are not replaced
 * by this run.
 */
export function ResultsReading({
  metrics,
  sessionCount,
  frequency,
  savedRunName,
  savedRunCreatedAt,
  inputsChanged,
}: {
  metrics: BacktestResult['metrics'];
  sessionCount: number;
  frequency: Frequency;
  savedRunName?: string | null;
  savedRunCreatedAt?: string | null;
  inputsChanged?: boolean;
}) {
  const interpretation = useMemo(
    () => interpretBacktest({ metrics, sessionCount, frequency }),
    [metrics, sessionCount, frequency],
  );

  const subtitle = savedRunName
    ? `Recomputed now from the loaded configuration. The saved run “${savedRunName}” keeps the metrics it recorded${
        savedRunCreatedAt ? ` on ${savedRunCreatedAt.slice(0, 10)}` : ''
      }.${inputsChanged ? ' The stored dataset differs from the one that run used, so the numbers can legitimately differ.' : ''}`
    : 'Recomputed in this browser from the current stored dataset.';

  return (
    <Panel title="Reading these results" subtitle={subtitle} actions={<Tag tone="accent">Recomputed</Tag>}>
      <div className="stack">
        <p className="results-headline">{interpretation.headline}</p>
        <p className="field-hint">{interpretation.sampleNote}</p>

        <div className="results-readings">
          {interpretation.readings.map((reading) => (
            <div key={reading.id} className="results-reading">
              <div className="spread">
                <span className="field-label">{reading.label}</span>
                <span className="mono">{reading.value}</span>
              </div>
              <p>{reading.reading}</p>
              {reading.caveat && <p className="field-hint">{reading.caveat}</p>}
            </div>
          ))}
        </div>

        <div>
          <span className="field-label">What this does not tell you</span>
          <ul className="list-reset stack field-hint">
            {interpretation.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>

        <div className="row tight">
          <Link to="/learn?section=risk">Risk metrics and conventions</Link>
          <Link to="/learn?section=execution">Execution model</Link>
        </div>
      </div>
    </Panel>
  );
}
