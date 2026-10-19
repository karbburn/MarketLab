import type { Bar } from '../../domain/types';
import type { IndicatorDefinition, IndicatorValues } from '../../domain/indicators/types';
import { indicatorBollinger, indicatorEma, indicatorSma } from './moving-averages';
import { indicatorMacd, indicatorRsi, indicatorStochastic } from './momentum';
import { indicatorAdx, indicatorAtr } from './volatility';
import { indicatorObv, indicatorVwap, indicatorVolumeSma } from './volume';
import { indicatorIchimoku } from './ichimoku';

export const INDICATOR_DEFINITIONS: IndicatorDefinition[] = [
  indicatorSma,
  indicatorEma,
  indicatorBollinger,
  indicatorRsi,
  indicatorMacd,
  indicatorAtr,
  indicatorAdx,
  indicatorStochastic,
  indicatorVwap,
  indicatorVolumeSma,
  indicatorObv,
  indicatorIchimoku,
];

const byType = new Map(INDICATOR_DEFINITIONS.map((definition) => [definition.type, definition]));

export function getIndicatorDefinition(type: string): IndicatorDefinition | undefined {
  return byType.get(type);
}

export function listIndicatorDefinitions(): IndicatorDefinition[] {
  return INDICATOR_DEFINITIONS;
}

export function defaultParameters(definition: IndicatorDefinition): Record<string, number> {
  const parameters: Record<string, number> = {};
  for (const spec of definition.parameters) parameters[spec.key] = spec.defaultValue;
  return parameters;
}

/** Clamps parameters to the definition's declared bounds; unknown keys are dropped. */
export function normaliseParameters(
  definition: IndicatorDefinition,
  parameters: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const spec of definition.parameters) {
    const raw = parameters[spec.key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : spec.defaultValue;
    const clamped = Math.max(spec.min, Math.min(spec.max, value));
    result[spec.key] = spec.integer ? Math.round(clamped) : clamped;
  }
  return result;
}

export interface IndicatorCalculation {
  byType: string;
  outputs: Record<string, IndicatorValues[]>;
}

export function calculateIndicator(
  type: string,
  bars: readonly Bar[],
  parameters: Record<string, number>,
): IndicatorCalculation | null {
  const definition = getIndicatorDefinition(type);
  if (!definition) return null;
  const normalised = normaliseParameters(definition, parameters);
  return { byType: type, outputs: definition.calculate(bars, normalised) };
}

export function indicatorRequiresVolume(type: string): boolean {
  return type === 'vwap' || type === 'volume-sma' || type === 'obv';
}
