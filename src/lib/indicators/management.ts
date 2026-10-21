/**
 * Indicator management primitives.
 *
 * Pure helpers behind the indicator manager UI. They never touch the chart
 * adapter or the store: the caller decides how to persist the returned list.
 * Like the drawing helpers in `lib/drawings/management`, an operation that
 * would change nothing returns the same array reference so a caller that
 * compares references can skip a pointless workspace write and history entry.
 */

import type { IndicatorInstance } from '../../domain/types';
import type { IndicatorDefinition, IndicatorParameterSpec } from '../../domain/indicators/types';
import { normaliseParameters } from './index';

/**
 * A short, disambiguating label for one stored instance.
 *
 * The definition name is followed by its parameter values in the definition's
 * declared order (`SMA 20`, `Bollinger 20/2`, `MACD 12/26/9`), so two
 * instances of the same indicator with different settings are always
 * distinguishable everywhere the label is shown. A missing parameter falls
 * back to its declared default, and an instance whose type is unknown in this
 * build is labelled with the raw stored type and stays removable.
 */
export function describeIndicatorInstance(
  definition: IndicatorDefinition | undefined,
  instance: IndicatorInstance,
): string {
  if (!definition) return instance.type;
  if (definition.parameters.length === 0) return definition.name;
  const values = definition.parameters.map((spec) => {
    const value = instance.parameters[spec.key];
    const usable = typeof value === 'number' && Number.isFinite(value) ? value : spec.defaultValue;
    return spec.integer ? String(Math.round(usable)) : String(usable);
  });
  return `${definition.name} ${values.join('/')}`;
}

/**
 * Moves one instance one position up or down in the stored order.
 *
 * The array order is the chart's own contract: overlay outputs share the top
 * pane, separate panes are handed out in list order and the legend lists
 * indicators in the same order. Returns the same reference when the instance
 * is missing or already at the requested edge, so the caller can skip a write.
 */
export function reorderIndicators(
  instances: readonly IndicatorInstance[],
  id: string,
  direction: 'up' | 'down',
): IndicatorInstance[] {
  const index = instances.findIndex((instance) => instance.id === id);
  if (index === -1) return [...instances];
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= instances.length) return [...instances];
  const next = [...instances];
  next[index] = next[target] as IndicatorInstance;
  next[target] = instances[index] as IndicatorInstance;
  return next;
}

/**
 * Validates and applies an edit draft to one instance.
 *
 * Values are clamped to the definition's declared bounds through the same
 * `normaliseParameters` used at calculation time, so an out-of-range or
 * half-typed value can never reach the persist path: a stored 999-period SMA
 * becomes whatever the definition's maximum allows, and unknown keys are
 * dropped. Returns the same reference when nothing changes.
 */
export function updateIndicatorParameters(
  instances: readonly IndicatorInstance[],
  id: string,
  definition: IndicatorDefinition,
  draft: Record<string, number>,
): IndicatorInstance[] {
  let changed = false;
  const next = instances.map((instance) => {
    if (instance.id !== id) return instance;
    const parameters = normaliseParameters(definition, { ...instance.parameters, ...draft });
    for (const key of Object.keys(parameters)) {
      if (instance.parameters[key] !== parameters[key]) {
        changed = true;
        break;
      }
    }
    for (const key of Object.keys(instance.parameters)) {
      if (!(key in parameters)) {
        changed = true;
        break;
      }
    }
    return changed ? { ...instance, parameters } : instance;
  });
  return changed ? next : [...instances];
}

/** True when the draft differs from the stored parameters after clamping. */
export function parametersDifferFromStore(
  definition: IndicatorDefinition,
  stored: Record<string, number>,
  draft: Record<string, number>,
): boolean {
  const normalised = normaliseParameters(definition, draft);
  for (const spec of definition.parameters as IndicatorParameterSpec[]) {
    if ((stored[spec.key] ?? spec.defaultValue) !== normalised[spec.key]) return true;
  }
  return false;
}
