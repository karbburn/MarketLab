import type { Bar, IndicatorPlacement } from '../types';

export type IndicatorValues = number | null;

export interface IndicatorOutput {
  key: string;
  label: string;
  /** `band` renders as a filled region between `key` and `bandWith`. */
  kind: 'line' | 'histogram' | 'band';
  bandWith?: string;
  defaultColor?: string;
}

export interface IndicatorParameterSpec {
  key: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

export interface IndicatorDefinition {
  type: string;
  name: string;
  version: number;
  placement: IndicatorPlacement;
  category: 'Trend' | 'Momentum' | 'Volatility' | 'Volume';
  description: string;
  formula: string;
  parameters: IndicatorParameterSpec[];
  outputs: IndicatorOutput[];
  calculate: (bars: readonly Bar[], parameters: Record<string, number>) => Record<string, IndicatorValues[]>;
}

export interface IndicatorInput {
  bars: readonly Bar[];
}
