import type { RuleField, ScreenerOperator, StrategyRule } from '../../domain/types';

export interface RuleFieldOption {
  value: RuleField;
  label: string;
  needsSecondary: boolean;
  implicitThreshold: boolean;
}

/**
 * One catalogue for the strategy editor and the saved-run inspector, so a saved
 * rule is described with the same wording it was edited with.
 */
export const RULE_FIELDS: readonly RuleFieldOption[] = [
  { value: 'price-vs-sma', label: 'Price vs SMA (%)', needsSecondary: false, implicitThreshold: false },
  { value: 'price-vs-ema', label: 'Price vs EMA (%)', needsSecondary: false, implicitThreshold: false },
  { value: 'sma-cross', label: 'SMA cross', needsSecondary: true, implicitThreshold: true },
  { value: 'macd-cross', label: 'MACD cross', needsSecondary: true, implicitThreshold: true },
  { value: 'rsi', label: 'RSI level', needsSecondary: false, implicitThreshold: false },
  { value: 'breakout-high', label: 'Breakout above high', needsSecondary: false, implicitThreshold: true },
  { value: 'breakout-low', label: 'Breakdown below low', needsSecondary: false, implicitThreshold: true },
];

export const RULE_OPERATORS: ReadonlyArray<{ value: ScreenerOperator; label: string }> = [
  { value: 'crosses-above', label: 'crosses above' },
  { value: 'crosses-below', label: 'crosses below' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
];

function operatorLabel(operator: ScreenerOperator): string {
  return RULE_OPERATORS.find((entry) => entry.value === operator)?.label ?? operator;
}

/** A plain-language description of one stored rule, parameters included. */
export function describeStrategyRule(rule: StrategyRule): string {
  const operator = operatorLabel(rule.operator);
  switch (rule.field) {
    case 'price-vs-sma':
      return `Price vs ${rule.window}-session SMA ${operator} ${rule.value}%`;
    case 'price-vs-ema':
      return `Price vs ${rule.window}-session EMA ${operator} ${rule.value}%`;
    case 'sma-cross': {
      const slow = rule.secondaryWindow ?? rule.window * 2;
      return `${rule.window}-session SMA ${operator} ${slow}-session SMA`;
    }
    case 'macd-cross': {
      const slow = rule.window * 2 + 2;
      const signal = rule.secondaryWindow ?? 9;
      return `MACD (${rule.window}, ${slow}, ${signal}) ${operator} its signal line`;
    }
    case 'rsi':
      return `RSI(${rule.window}) ${operator} ${rule.value}`;
    case 'breakout-high':
      return `Close ${operator} the prior ${rule.window}-session high`;
    case 'breakout-low':
      return `Close ${operator} the prior ${rule.window}-session low`;
  }
}

/** Joins a rule set with the logic that was actually used. */
export function describeStrategyRules(rules: readonly StrategyRule[], logic: 'AND' | 'OR'): string {
  if (rules.length === 0) return 'No rules';
  return rules.map(describeStrategyRule).join(` ${logic} `);
}
