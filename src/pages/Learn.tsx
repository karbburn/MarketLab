import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, CopySimple } from '@phosphor-icons/react';
import { Field, TextInput } from '../components/ui';
import {
  LEARN_CASES,
  LEARN_EXECUTION_STEPS,
  LEARN_FACTS,
  LEARN_INDICATORS,
  LEARN_METRIC_GROUPS,
  LEARN_METRICS,
  LEARN_ROUTE,
  LEARN_SECTIONS,
  LEARN_WITHHELD,
  type LearnMetricGroup,
} from '../lib/learn/content';
import {
  calculateCagrExample,
  SCREEN_DRILL_SESSIONS,
  SCREEN_DRILL_WINDOW,
  screenWindowDrill,
} from '../lib/learn/calculations';
import { formatSignedPercent } from '../lib/format';

/**
 * The in-app field guide. This page explains the conventions behind the
 * product's calculations without replacing them. Its two calculators are
 * deliberately separate from the production metrics and screener modules.
 */
function revealSection(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  const heading = target.querySelector('h2');
  heading?.focus({ preventScroll: true });
}

export function LearnPage() {
  const [searchParams] = useSearchParams();
  const section = searchParams.get('section');
  const requestedSection = LEARN_SECTIONS.some((item) => item.id === section)
    ? (section as string)
    : null;
  const [activeSection, setActiveSection] = useState(
    requestedSection ?? LEARN_SECTIONS[0]?.id ?? '',
  );

  // A programmatic reveal owns the highlight until its smooth scroll has
  // arrived. Without this pause the scroll spy would immediately highlight
  // whichever section is still under the viewport when the link is clicked.
  const spyPausedUntil = useRef(0);
  const refreshSpyRef = useRef<() => void>(() => {});

  const reveal = useCallback((id: string) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setActiveSection(id);
    spyPausedUntil.current = Date.now() + (reduced ? 150 : 1000);
    revealSection(id);
  }, []);

  // Deep links, browser history and rail navigation all end here: the URL
  // section is authoritative and the spy waits for the scroll to finish. The
  // highlight is applied on the next frame so this effect only drives the DOM.
  useEffect(() => {
    if (!requestedSection) {
      // Leaving a section query (for example the sidebar link back to the
      // guide) must not leave the old section current. Recompute from scroll
      // rather than assuming the top of the page.
      spyPausedUntil.current = 0;
      refreshSpyRef.current();
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    spyPausedUntil.current = Date.now() + (reduced ? 150 : 1000);
    revealSection(requestedSection);
    const frame = window.requestAnimationFrame(() => setActiveSection(requestedSection));
    return () => window.cancelAnimationFrame(frame);
  }, [requestedSection]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Date.now() < spyPausedUntil.current) return;
      // The last section cannot always reach the 170px line, so the document
      // bottom is treated as arrival at the final section.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      const current = atBottom
        ? LEARN_SECTIONS[LEARN_SECTIONS.length - 1]
        : ([...LEARN_SECTIONS]
            .reverse()
            .find((item) => {
              const element = document.getElementById(item.id);
              return element ? element.getBoundingClientRect().top <= 170 : false;
            }) ?? LEARN_SECTIONS[0]);
      if (current) setActiveSection(current.id);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    refreshSpyRef.current = update;
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      refreshSpyRef.current = () => {};
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const chooseSection = (id: string) => {
    setActiveSection(id);
    // A click on the section already in the URL does not change the URL, so
    // the effect above will not run. Reveal it directly instead.
    if (requestedSection === id) reveal(id);
  };

  return (
    <div className="page learn-page">
      <header className="learn-hero">
        <div className="learn-hero-copy">
          <h1>How MarketLab works</h1>
          <p className="learn-lede">
            A working guide to the data, arithmetic and assumptions behind every chart, screen and
            backtest.
          </p>
        </div>
        <div className="learn-facts" aria-label="Conventions used throughout MarketLab">
          {LEARN_FACTS.map((fact) => (
            <Link
              key={fact.value}
              to={`/learn?section=${fact.section}`}
              className="learn-fact"
              onClick={() => chooseSection(fact.section)}
            >
              <span className="learn-fact-value">{fact.value}</span>
              <span className="learn-fact-label">{fact.label}</span>
            </Link>
          ))}
        </div>
      </header>

      <div className="learn-layout">
        <nav className="learn-rail" aria-label="On this page">
          <span className="learn-rail-title">On this page</span>
          {LEARN_SECTIONS.map((item) => (
            <Link
              key={item.id}
              to={`/learn?section=${item.id}`}
              aria-current={activeSection === item.id ? 'location' : undefined}
              onClick={() => chooseSection(item.id)}
            >
              {item.title}
            </Link>
          ))}
        </nav>

        <div className="learn-content">
          <section className="learn-section" id="stored" aria-labelledby="stored-title">
            <h2 id="stored-title" tabIndex={-1}>
              What is stored
            </h2>
            <div className="learn-prose">
              <p>
                <strong>MarketLab stores bars, not ticks.</strong> A bar is one exchange session: a
                date, open, high, low, close and volume. Dates are date-only ISO strings. There is no
                timezone conversion and no intraday timestamp.
              </p>
              <p>
                Daily bars can be viewed weekly or monthly. Weekly buckets start on Monday. Open is
                the first open, high the highest high, low the lowest low, close the last close, and
                volume the sum. If any bar in a bucket has no volume, the bucket volume stays blank.
                Partial buckets at the edges are kept; missing buckets are never synthesized.
              </p>
              <p>
                Every source goes through the same validation. Prices must be positive. High must be
                at least the greater of open and close, and low at most the lesser. Duplicate sessions
                follow the policy you choose. Rows are sorted, and gaps are reported rather than
                filled. Missing volume stays missing.
              </p>
              <p>
                MarketLab does not adjust prices itself. A downloaded dataset carries the provider's
                adjustment policy. Yahoo Finance prices are split-adjusted and dividends are not
                reinvested. A CSV keeps the prices you imported.
              </p>
            </div>
            <div className="learn-callout">
              <span className="learn-callout-label">The rule</span>
              <p>A gap is information. MarketLab shows it; it does not invent a session to fill it.</p>
            </div>
            <p className="learn-links">
              <Link to="/data">Read the data library</Link>
              <Link to="/chart">Open the chart workspace</Link>
            </p>
          </section>

          <section className="learn-section" id="returns" aria-labelledby="returns-title">
            <h2 id="returns-title" tabIndex={-1}>
              Returns
            </h2>
            <div className="learn-prose">
              <p>
                Total return is the simplest calculation here: last close divided by first close,
                minus one. It is a simple return, not a log return. It includes whatever price
                adjustment is already in the stored bars and adds no dividends, fees or taxes.
              </p>
              <p>
                CAGR answers a different question: what constant yearly rate would turn the first
                close into the last close over the calendar time between them? MarketLab uses 365.25
                days per year, not 252 sessions, and withholds CAGR when the span is 30 calendar days
                or less. A 20% gain in six months is not a 20% annual return.
              </p>
              <p>
                Volatility is annualised with 252 sessions. That is a convention, not a property of
                the data. A series with 100 sessions still gets the same square-root-of-252
                multiplier. The app uses the sample standard deviation, with n - 1 in the
                denominator.
              </p>
            </div>
            <div className="learn-formula" aria-label="Return formulas">
              <code>
                {'totalReturnPct = (lastClose / firstClose - 1) * 100\n'}
                {'CAGR = ((lastClose / firstClose) ^ (1 / years) - 1) * 100\n'}
                {'years = calendarDays / 365.25'}
              </code>
            </div>
            <CagrCalculator />
            <p className="learn-links">
              <Link to="/quant">See these calculations in the Quant lab</Link>
            </p>
          </section>

          <section className="learn-section" id="risk" aria-labelledby="risk-title">
            <h2 id="risk-title" tabIndex={-1}>
              Risk
            </h2>
            <div className="learn-grid">
              <div className="learn-item">
                <strong>Volatility</strong>
                <span>
                  Annualised sample standard deviation of simple daily returns. Up and down moves
                  count as risk in the same way.
                </span>
              </div>
              <div className="learn-item">
                <strong>Maximum drawdown</strong>
                <span>
                  The worst close-to-close decline from a running peak. An intraday low can be worse;
                  MarketLab has no intraday bars, so it does not pretend to know.
                </span>
              </div>
              <div className="learn-item">
                <strong>Ulcer index</strong>
                <span>
                  Root mean square of every percentage drawdown. It punishes both depth and time spent
                  below the peak.
                </span>
              </div>
              <div className="learn-item">
                <strong>Calmar ratio</strong>
                <span>
                  CAGR divided by the absolute maximum drawdown. A zero drawdown gives no value rather
                  than infinity.
                </span>
              </div>
            </div>
            <div className="learn-prose">
              <p>
                <strong>VaR and CVaR are historical, not fitted.</strong> VaR 95 is the 5th percentile
                of observed daily returns, reported as a non-negative loss percentage, floored at
                zero. CVaR 95 is the average of the observed returns at or below that threshold. Both
                need at least 20 returns. Below
                that, MarketLab shows nothing instead of fitting a normal curve to a short sample.
              </p>
              <p>
                These are descriptions of the stored sample, not forecasts. A 95% VaR is not a
                promise that the next loss will be smaller.
              </p>
            </div>
            <p className="learn-links">
              <Link to="/quant">Open the risk panel</Link>
            </p>
          </section>

          <section className="learn-section" id="comparison" aria-labelledby="comparison-title">
            <h2 id="comparison-title" tabIndex={-1}>
              Comparison
            </h2>
            <div className="learn-prose">
              <p>
                Before comparing, MarketLab intersects the dates. A date is kept only if every
                selected series has a bar for it. Nothing is forward-filled or interpolated. If two
                series share no dates, the comparison says so and draws nothing.
              </p>
              <p>
                The chart overlay rebases every line to 100 at the first session they all share. A
                move to 110 is +10% from that baseline. The Quant lab expresses the same idea as a
                percentage change, so the first shared close is 0%. In both places the baseline is
                the first session shared by the stored series. Panning the view does not move it;
                changing the timeframe can.
              </p>
              <p>
                Correlation is Pearson on the daily simple returns of the shared sessions. It needs
                at least three shared returns, which means four shared sessions, and variation in
                both series. Beta is covariance over
                benchmark variance, with at least two shared returns and a benchmark that moved.
                Alpha is annualised arithmetic:{' '}
                <span className="mono">
                  (mean asset - beta * mean benchmark) * 252 * 100
                </span>
                . The risk-free rate is zero. Alpha is computed with beta and mentioned in the
                method notes, not shown as a separate tile. A high correlation is not a cause, and a
                beta from 60 shared sessions is not a permanent property.
              </p>
            </div>
            <p className="learn-links">
              <Link to="/quant">Compare series in the Quant lab</Link>
              <Link to="/chart">See rebased overlays in the chart</Link>
            </p>
          </section>

          <section className="learn-section" id="screening" aria-labelledby="screening-title">
            <h2 id="screening-title" tabIndex={-1}>
              Screens
            </h2>
            <div className="learn-prose">
              <p>
                A screen is a set of numeric filters over stored series. The cutoff is the part that
                matters: only sessions on or before the cutoff are used to compute fields and the
                as-of date. Nothing after the cutoff leaks in.
              </p>
              <p>
                Fields cover return over a window, price versus SMA or EMA, RSI, annualised
                volatility, maximum drawdown inside the window, relative volume and last close.
                &quot;Crossed above&quot; and &quot;crossed below&quot; compare the current reading
                with the previous session, so a single touch does not qualify.
              </p>
              <p>
                If a field cannot be computed, its filter is false, not true. A missing volume makes
                relative volume unavailable. A window longer than the available history makes return
                and drawdown unavailable. Missing input is never turned into a match.
              </p>
            </div>
            <CutoffDrill />
            <p className="learn-links">
              <Link to="/screener">Run a screen at a cutoff</Link>
            </p>
          </section>

          <section className="learn-section" id="execution" aria-labelledby="execution-title">
            <h2 id="execution-title" tabIndex={-1}>
              Backtests
            </h2>
            <div className="learn-prose">
              <p>
                A backtest is an accounting simulation on historical bars, not a prediction. MarketLab
                evaluates rules at the close and fills at the next open. That one rule removes
                same-bar look-ahead. The rest of the execution model is just as explicit.
              </p>
            </div>
            <ExecutionWalkthrough />
            <div className="learn-prose">
              <p>
                Commission is charged on the notional at entry and again at exit. Slippage is adverse
                on every fill. Position size is a fixed percentage of equity at entry, the share count
                is fractional, and only long positions are simulated. The buy-and-hold benchmark uses
                the same window and capital with no costs, so the difference is stated rather than
                hidden.
              </p>
              <p>
                A backtest result is one path through one window. It is not a probability, and it is
                not a promise that the next window will behave the same way.
              </p>
            </div>
            <p className="learn-links">
              <Link to="/backtest">Open the backtest lab</Link>
            </p>
          </section>

          <section className="learn-section" id="indicators" aria-labelledby="indicators-title">
            <h2 id="indicators-title" tabIndex={-1}>
              Indicators
            </h2>
            <div className="learn-prose">
              <p>
                Chart indicators are parameters on the same stored bars. The seed and the warm-up
                decide when a line begins, and those choices are part of the number.
              </p>
            </div>
            <div className="learn-grid">
              {LEARN_INDICATORS.map((indicator) => (
                <div className="learn-item" key={indicator.name}>
                  <strong>{indicator.name}</strong>
                  <span>{indicator.note}</span>
                </div>
              ))}
            </div>
            <div className="learn-prose">
              <p>
                The chart does not shorten a window to produce a value. If there are not enough bars,
                the line starts later. Missing volume clears the rolling volume window instead of
                counting as zero.
              </p>
            </div>
            <p className="learn-links">
              <Link to="/chart">Add an indicator in the chart workspace</Link>
            </p>
          </section>

          <section className="learn-section" id="reference" aria-labelledby="reference-title">
            <h2 id="reference-title" tabIndex={-1}>
              Metric reference
            </h2>
            <div className="learn-prose">
              <p>
                Pick a metric to see the exact formula, the inputs and the cases where MarketLab
                returns nothing. The formula is the contract; the conventions are where two
                implementations usually disagree.
              </p>
            </div>
            <MetricExplorer />
          </section>

          <section className="learn-section" id="blanks" aria-labelledby="blanks-title">
            <h2 id="blanks-title" tabIndex={-1}>
              Blank results
            </h2>
            <div className="learn-prose">
              <p>
                <strong>A blank is a result.</strong> MarketLab prefers a blank to a guess. Missing
                input usually withholds the result instead of substituting zero, a default or a
                synthetic session. A few empty-run values are zero by convention, not a measurement.
                These are the common cases.
              </p>
            </div>
            <div className="learn-grid learn-grid-compact">
              {LEARN_WITHHELD.map((entry) => (
                <div className="learn-item" key={entry.condition}>
                  <strong>{entry.condition}</strong>
                  <span>{entry.result}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="learn-section" id="rule-check" aria-labelledby="rule-check-title">
            <h2 id="rule-check-title" tabIndex={-1}>
              Check the rule
            </h2>
            <div className="learn-prose">
              <p>
                Work through four cases where the convention decides the answer. Each one explains
                why.
              </p>
            </div>
            <RuleCheck />
          </section>

          <section className="learn-section" id="route" aria-labelledby="route-title">
            <h2 id="route-title" tabIndex={-1}>
              A route through the app
            </h2>
            <div className="learn-prose">
              <p>
                The fastest way to understand a convention is to change the input that depends on it
                and watch the number move. Start with your own data.
              </p>
            </div>
            <div className="learn-route">
              {LEARN_ROUTE.map((item) => (
                <Link key={item.to} to={item.to}>
                  <span className="learn-route-label">{item.label}</span>
                  <span className="learn-route-body">{item.body}</span>
                  <ArrowRight size={14} aria-hidden />
                </Link>
              ))}
            </div>
            <div className="learn-callout">
              <span className="learn-callout-label">Before the formula</span>
              <p>
                If a number surprises you, check the window, the shared dates and the costs first.
                Most disagreements are about inputs, not arithmetic.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function CagrCalculator() {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [days, setDays] = useState('');

  const result = useMemo(
    () =>
      calculateCagrExample(
        start.trim() === '' ? null : Number(start),
        end.trim() === '' ? null : Number(end),
        days.trim() === '' ? null : Number(days),
      ),
    [start, end, days],
  );

  return (
    <div className="learn-calc">
      <div className="learn-calc-inputs">
        <Field label="Start value" hint="Greater than zero">
          <TextInput value={start} onChange={setStart} type="number" min={0} step="any" placeholder="100" />
        </Field>
        <Field label="End value" hint="Greater than zero">
          <TextInput value={end} onChange={setEnd} type="number" min={0} step="any" placeholder="121" />
        </Field>
        <Field label="Calendar days" hint="Whole days between the two dates">
          <TextInput value={days} onChange={setDays} type="number" min={1} step={1} placeholder="730" />
        </Field>
      </div>
      <div className="learn-calc-out" aria-live="polite">
        <span className="learn-calc-heading">CAGR with your own numbers</span>
        {result.status === 'incomplete' && (
          <p className="learn-calc-note">
            Enter a start value, an end value and the number of calendar days. No dataset is read.
          </p>
        )}
        {result.status === 'invalid' && <p className="learn-calc-error">{result.message}</p>}
        {result.status === 'ok' && (
          <>
            <div className="learn-calc-row">
              <span>Total return</span>
              <strong className={result.totalReturnPct > 0 ? 'up' : result.totalReturnPct < 0 ? 'down' : ''}>
                {formatSignedPercent(result.totalReturnPct)}
              </strong>
            </div>
            <div className="learn-calc-row">
              <span>CAGR</span>
              <strong
                className={
                  result.cagrPct === null ? '' : result.cagrPct > 0 ? 'up' : result.cagrPct < 0 ? 'down' : ''
                }
              >
                {result.cagrPct === null ? '--' : formatSignedPercent(result.cagrPct)}
              </strong>
            </div>
            <div className="learn-calc-row">
              <span>Calendar years</span>
              <strong>{result.years.toFixed(2)}</strong>
            </div>
            {result.cagrWithheld && (
              <p className="learn-calc-note">
                CAGR is withheld for spans of 30 days or less. The total return is still shown.
              </p>
            )}
            <p className="learn-calc-foot">
              Uses 365.25 days per year, the same convention as the Quant lab. This example does not
              read or change any stored dataset.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function CutoffDrill() {
  const [cutoff, setCutoff] = useState(8);
  const drill = screenWindowDrill(cutoff);
  const sessions = Array.from({ length: SCREEN_DRILL_SESSIONS }, (_, index) => index + 1);

  return (
    <div className="learn-drill">
      <div className="learn-drill-head">
        <div>
          <span className="learn-drill-kicker">A {SCREEN_DRILL_WINDOW}-session window</span>
          <h3>Move the cutoff and watch the history shrink</h3>
        </div>
        <span className="learn-drill-count">
          {cutoff} of {SCREEN_DRILL_SESSIONS} sessions
        </span>
      </div>
      <div className="learn-drill-track" aria-hidden>
        {sessions.map((session) => (
          <span
            key={session}
            className="learn-drill-session"
            data-state={session < cutoff ? 'used' : session === cutoff ? 'cutoff' : 'future'}
          >
            <span className="learn-drill-tick" />
            <span className="learn-drill-label">
              {session === 1 || session === cutoff || session === SCREEN_DRILL_SESSIONS ? `S${session}` : ''}
            </span>
          </span>
        ))}
      </div>
      <label className="learn-drill-control">
        <span>Cutoff session</span>
        <input
          type="range"
          min={1}
          max={SCREEN_DRILL_SESSIONS}
          step={1}
          value={cutoff}
          onChange={(event) => setCutoff(Number(event.currentTarget.value))}
        />
      </label>
      <div className="learn-drill-out" aria-live="polite">
        <div className="learn-drill-stat">
          <span>{SCREEN_DRILL_WINDOW}-session return</span>
          <strong data-state={drill.available ? 'ok' : 'waiting'}>
            {drill.available ? 'Available' : `Needs ${drill.required} sessions`}
          </strong>
        </div>
        <div className="learn-drill-stat">
          <span>{SCREEN_DRILL_WINDOW}-session max drawdown</span>
          <strong data-state={drill.available ? 'ok' : 'waiting'}>
            {drill.available ? 'Available' : `Needs ${drill.required} sessions`}
          </strong>
        </div>
        <div className="learn-drill-stat">
          <span>Sessions after cutoff</span>
          <strong>{drill.after}</strong>
        </div>
      </div>
      <p className="learn-drill-note">
        Sessions only, no prices. A {SCREEN_DRILL_WINDOW}-session window needs {drill.required} closes, so the
        first usable cutoff is S{drill.required}.
      </p>
    </div>
  );
}

function RuleCheck() {
  const [caseIndex, setCaseIndex] = useState(0);
  const [answerId, setAnswerId] = useState<string | null>(null);
  const promptRef = useRef<HTMLLegendElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const shouldFocusPrompt = useRef(false);
  const current = LEARN_CASES[caseIndex] ?? LEARN_CASES[0];

  // Only a deliberate advance moves focus. The initial render must not steal
  // it, and the old prompt is unmounted by the time this effect runs.
  useEffect(() => {
    if (!shouldFocusPrompt.current) return;
    shouldFocusPrompt.current = false;
    promptRef.current?.focus();
    if (document.activeElement !== promptRef.current) firstOptionRef.current?.focus();
  }, [caseIndex]);

  if (!current) return null;

  const answered = answerId !== null;
  const correct = answerId === current.answerId;
  const next = () => {
    shouldFocusPrompt.current = true;
    setAnswerId(null);
    setCaseIndex((index) => (index + 1) % LEARN_CASES.length);
  };

  return (
    <div className="learn-check">
      <div className="learn-check-head">
        <span className="learn-check-count" aria-live="polite">
          Case {caseIndex + 1} of {LEARN_CASES.length}
        </span>
        <div className="learn-check-dots" aria-hidden>
          {LEARN_CASES.map((item, index) => (
            <span key={item.id} data-active={index === caseIndex} />
          ))}
        </div>
      </div>
      <fieldset className="learn-check-body">
        <legend className="learn-check-prompt" ref={promptRef} tabIndex={-1}>
          {current.prompt}
        </legend>
        <div className="learn-check-options">
          {current.options.map((option, index) => {
            const selected = answerId === option.id;
            const result = answered
              ? option.id === current.answerId
                ? 'correct'
                : selected
                  ? 'wrong'
                  : undefined
              : undefined;
            return (
              <button
                key={option.id}
                ref={index === 0 ? firstOptionRef : undefined}
                type="button"
                className="learn-check-option"
                aria-pressed={selected}
                data-result={result}
                // One answer per case: the first choice is the recorded one.
                disabled={answered}
                onClick={() => {
                  if (!answered) setAnswerId(option.id);
                }}
              >
                {option.label}
                {result === 'correct' && <Check size={14} aria-hidden />}
              </button>
            );
          })}
        </div>
      </fieldset>
      {answered && (
        <div className="learn-check-feedback" data-correct={correct} role="status">
          <strong>{correct ? 'Correct' : 'Not quite'}</strong>
          <p>{current.explanation}</p>
          <button type="button" className="button ghost sm" onClick={next}>
            {caseIndex + 1 === LEARN_CASES.length ? 'Start over' : 'Next case'}
          </button>
        </div>
      )}
    </div>
  );
}

type CopyState = 'idle' | 'copied' | 'error';

/** Selects the formula so a failed clipboard write still leaves a manual path. */
function selectElementText(element: HTMLElement | null): void {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function MetricExplorer() {
  const [group, setGroup] = useState<LearnMetricGroup>('return');
  const [metricId, setMetricId] = useState('total-return');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const formulaRef = useRef<HTMLElement>(null);
  const metrics = LEARN_METRICS.filter((metric) => metric.group === group);
  const active = metrics.find((metric) => metric.id === metricId) ?? metrics[0];
  const groupLabel = LEARN_METRIC_GROUPS.find((entry) => entry.id === group)?.label ?? 'Metric';

  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const chooseGroup = (nextGroup: LearnMetricGroup) => {
    setCopyState('idle');
    setGroup(nextGroup);
    const first = LEARN_METRICS.find((metric) => metric.group === nextGroup);
    if (first) setMetricId(first.id);
  };

  const chooseMetric = (id: string) => {
    setCopyState('idle');
    setMetricId(id);
  };

  const copyFormula = async () => {
    if (!active) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(active.formula);
      setCopyState('copied');
    } catch {
      setCopyState('error');
      selectElementText(formulaRef.current);
    }
  };

  return (
    <div className="learn-explorer">
      <div className="learn-explorer-groups" role="group" aria-label="Metric groups">
        {LEARN_METRIC_GROUPS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="learn-tab"
            aria-pressed={entry.id === group}
            onClick={() => chooseGroup(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="learn-metric-chips" role="group" aria-label={`${groupLabel} metrics`}>
        {metrics.map((metric) => (
          <button
            key={metric.id}
            type="button"
            className="learn-chip"
            aria-pressed={metric.id === active?.id}
            onClick={() => chooseMetric(metric.id)}
          >
            {metric.name}
          </button>
        ))}
      </div>
      {active && (
        <div className="learn-metric-detail" role="region" aria-live="polite" aria-label={`${active.name} details`}>
          <div className="learn-metric-head">
            <h3>{active.name}</h3>
            <span className="learn-group-label">{groupLabel}</span>
          </div>
          <p className="learn-metric-question">{active.question}</p>
          <div className="learn-formula-row">
            <div className="learn-formula" aria-label="Formula">
              <code ref={formulaRef}>{active.formula}</code>
            </div>
            <button
              type="button"
              className="learn-copy"
              data-state={copyState}
              onClick={copyFormula}
              aria-label={
                copyState === 'copied' ? `Formula for ${active.name} copied` : `Copy formula for ${active.name}`
              }
            >
              {copyState === 'copied' ? <Check size={13} aria-hidden /> : <CopySimple size={13} aria-hidden />}
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p
            className={copyState === 'error' ? 'learn-copy-status' : 'visually-hidden'}
            data-state={copyState}
            role="status"
            aria-live="polite"
          >
            {copyState === 'error'
              ? 'Copy is unavailable here. The formula is selected, so copy it with your keyboard.'
              : copyState === 'copied'
                ? 'Formula copied to the clipboard.'
                : ''}
          </p>
          <div className="learn-meta-grid">
            <div className="learn-meta">
              <span className="learn-meta-label">Inputs</span>
              <p>{active.inputs}</p>
            </div>
            <div className="learn-meta">
              <span className="learn-meta-label">Conventions</span>
              <ul className="list-reset learn-list">
                {active.conventions.map((convention) => (
                  <li key={convention}>{convention}</li>
                ))}
              </ul>
            </div>
            <div className="learn-meta">
              <span className="learn-meta-label">Withheld when</span>
              <p>{active.withheld}</p>
            </div>
            <div className="learn-meta">
              <span className="learn-meta-label">Where it appears</span>
              <div className="learn-meta-links">
                {active.appearsIn.map((link) => (
                  <Link key={link.to} to={link.to}>
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExecutionWalkthrough() {
  const [stepId, setStepId] = useState(LEARN_EXECUTION_STEPS[0]?.id ?? 'signal');
  const active = LEARN_EXECUTION_STEPS.find((step) => step.id === stepId) ?? LEARN_EXECUTION_STEPS[0];

  return (
    <div className="learn-execution">
      <div className="learn-steps" role="group" aria-label="Backtest execution stages">
        {LEARN_EXECUTION_STEPS.map((step) => (
          <button
            key={step.id}
            type="button"
            className="learn-step"
            aria-pressed={step.id === active?.id}
            onClick={() => setStepId(step.id)}
          >
            {step.label}
          </button>
        ))}
      </div>
      {active && (
        <div className="learn-step-body" aria-live="polite">
          <h3>{active.title}</h3>
          <p>{active.body}</p>
          <p className="learn-rule">
            <span>Rule</span>
            {active.rule}
          </p>
        </div>
      )}
    </div>
  );
}
