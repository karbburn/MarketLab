import type { Drawing, DrawingStyle, DrawingType } from '../../domain/types';

/**
 * Human labels for the stored drawing types. They match the drawing rail so the
 * object list and the tool that created the object use the same vocabulary.
 */
export const DRAWING_TYPE_LABELS: Record<DrawingType, string> = {
  trendline: 'Trend line',
  ray: 'Ray',
  'horizontal-line': 'Horizontal level',
  'vertical-line': 'Vertical marker',
  rectangle: 'Zone rectangle',
  text: 'Text label',
  'price-range': 'Measure move',
  fibonacci: 'Fibonacci retracement',
};

export function drawingTypeLabel(type: DrawingType): string {
  return DRAWING_TYPE_LABELS[type];
}

/** The primary name shown in the object list. */
export function drawingLabel(drawing: Drawing): string {
  if (drawing.type === 'text') {
    const text = drawing.text?.trim();
    return text && text.length > 0 ? text : DRAWING_TYPE_LABELS.text;
  }
  return drawingTypeLabel(drawing.type);
}

/**
 * Applies an update to one drawing and returns the original array when nothing
 * changed. Keeping the array identity stable means a no-op gesture cannot add a
 * history entry or a persistence write.
 */
export function updateDrawing(
  drawings: Drawing[],
  id: string,
  update: (drawing: Drawing) => Drawing,
): Drawing[] {
  let changed = false;
  const next = drawings.map((drawing) => {
    if (drawing.id !== id) return drawing;
    const updated = update(drawing);
    if (updated === drawing) return drawing;
    changed = true;
    return updated;
  });
  return changed ? next : drawings;
}

export function setDrawingVisibility(drawings: Drawing[], id: string, visible: boolean): Drawing[] {
  return updateDrawing(drawings, id, (drawing) =>
    drawing.visible === visible ? drawing : { ...drawing, visible },
  );
}

export function toggleDrawingVisibility(drawings: Drawing[], id: string): Drawing[] {
  return updateDrawing(drawings, id, (drawing) => ({ ...drawing, visible: !drawing.visible }));
}

export function setDrawingLocked(drawings: Drawing[], id: string, locked: boolean): Drawing[] {
  return updateDrawing(drawings, id, (drawing) =>
    drawing.locked === locked ? drawing : { ...drawing, locked },
  );
}

export function toggleDrawingLocked(drawings: Drawing[], id: string): Drawing[] {
  return updateDrawing(drawings, id, (drawing) => ({ ...drawing, locked: !drawing.locked }));
}

/**
 * Style edits are refused while a drawing is locked. Locking must not be
 * decorative: the object list keeps a locked drawing selectable so it can be
 * inspected and unlocked, but its rendered style is immutable until then.
 */
export function setDrawingStyle(drawings: Drawing[], id: string, patch: Partial<DrawingStyle>): Drawing[] {
  return updateDrawing(drawings, id, (drawing) => {
    if (drawing.locked) return drawing;
    const style = normalizeDrawingStyle({ ...drawing.style, ...patch });
    if (sameStyle(drawing.style, style)) return drawing;
    return { ...drawing, style };
  });
}

/** Text edits follow the same lock rule as style edits. Empty labels are ignored. */
export function setDrawingText(drawings: Drawing[], id: string, text: string): Drawing[] {
  const value = text.trim();
  if (value.length === 0) return drawings;
  return updateDrawing(drawings, id, (drawing) => {
    if (drawing.locked || drawing.text === value) return drawing;
    return { ...drawing, text: value };
  });
}

/**
 * Deletes an unlocked drawing. A locked drawing is left in place; the UI
 * disables its delete action for the same reason.
 */
export function removeDrawing(drawings: Drawing[], id: string): Drawing[] {
  const target = drawings.find((drawing) => drawing.id === id);
  if (!target || target.locked) return drawings;
  return drawings.filter((drawing) => drawing.id !== id);
}

/** Clamps a style patch to the bounds enforced by the workspace schema. */
export function normalizeDrawingStyle(style: DrawingStyle): DrawingStyle {
  const next: DrawingStyle = {
    color: style.color.trim().length > 0 ? style.color.trim() : '#3fb8a3',
    lineWidth: clamp(style.lineWidth, 0.5, 8),
  };
  if (style.fillOpacity !== undefined) next.fillOpacity = clamp(style.fillOpacity, 0, 1);
  if (style.fontSize !== undefined) next.fontSize = Math.round(clamp(style.fontSize, 8, 48));
  if (style.lineStyle === 'dashed' || style.lineStyle === 'solid') next.lineStyle = style.lineStyle;
  return next;
}

/**
 * The native color input only accepts `#rrggbb`. Stored colors are otherwise
 * free-form (a backup may contain a named color), so callers get a safe value
 * for the control while the stored value stays untouched until the user picks.
 */
export function hexColorForInput(color: string, fallback = '#3fb8a3'): string {
  const value = color.trim();
  const six = /^#([0-9a-f]{6})$/i.exec(value);
  if (six) return `#${six[1]?.toLowerCase() ?? ''}`;
  const three = /^#([0-9a-f]{3})$/i.exec(value);
  if (three) {
    const digits = three[1] ?? '';
    const red = digits.charAt(0);
    const green = digits.charAt(1);
    const blue = digits.charAt(2);
    return `#${red}${red}${green}${green}${blue}${blue}`.toLowerCase();
  }
  return fallback;
}

export function sameStyle(left: DrawingStyle, right: DrawingStyle): boolean {
  return (
    left.color === right.color &&
    left.lineWidth === right.lineWidth &&
    (left.fillOpacity ?? 0.12) === (right.fillOpacity ?? 0.12) &&
    (left.fontSize ?? 12) === (right.fontSize ?? 12) &&
    (left.lineStyle ?? 'solid') === (right.lineStyle ?? 'solid')
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
