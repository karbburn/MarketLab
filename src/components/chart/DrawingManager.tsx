import { useEffect, useRef, useState } from 'react';
import { Eye, EyeSlash, LockSimple, LockSimpleOpen, Trash, X } from '@phosphor-icons/react';
import type { Drawing, DrawingStyle } from '../../domain/types';
import {
  drawingLabel,
  drawingTypeLabel,
  hexColorForInput,
  removeDrawing,
  setDrawingStyle,
  setDrawingText,
  toggleDrawingLocked,
  toggleDrawingVisibility,
} from '../../lib/drawings/management';
import { Field, Select, Tag, TextInput } from '../ui';

const PRESET_COLORS = ['#3fb8a3', '#4f8cff', '#f2b84b', '#ef6f6c', '#a78bfa', '#e7edf4', '#8b97a6'] as const;

const WIDTH_OPTIONS = [
  { value: '1', label: '1 px' },
  { value: '1.5', label: '1.5 px' },
  { value: '2', label: '2 px' },
  { value: '3', label: '3 px' },
  { value: '4', label: '4 px' },
] as const;

const LINE_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
] as const;

const FILL_OPTIONS = [
  { value: '0', label: 'None' },
  { value: '0.12', label: 'Light' },
  { value: '0.25', label: 'Medium' },
  { value: '0.4', label: 'Strong' },
] as const;

const FONT_OPTIONS = [
  { value: '10', label: '10 px' },
  { value: '12', label: '12 px' },
  { value: '14', label: '14 px' },
  { value: '16', label: '16 px' },
  { value: '20', label: '20 px' },
  { value: '24', label: '24 px' },
] as const;

type DrawingMutator = (drawings: Drawing[]) => Drawing[];

/**
 * The object list and style inspector for one chart. It is an overlay inside
 * the chart stage rather than a layout row, so opening it cannot collapse a
 * four-panel workspace or resize the chart under the user.
 */
export function DrawingManager({
  drawings,
  selectedId,
  onSelect,
  onMutate,
  onClose,
}: {
  drawings: Drawing[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMutate: (mutate: DrawingMutator) => void;
  onClose: () => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // The panel is opened from a toolbar button; move focus into it so the
    // object list is reachable without tabbing through the chart controls.
    sectionRef.current?.focus({ preventScroll: true });
  }, []);

  const selected = selectedId === null ? null : drawings.find((drawing) => drawing.id === selectedId) ?? null;
  const hiddenCount = drawings.filter((drawing) => !drawing.visible).length;
  const lockedCount = drawings.filter((drawing) => drawing.locked).length;
  const summary =
    drawings.length === 0
      ? 'No objects'
      : `${drawings.length} object${drawings.length === 1 ? '' : 's'}${
          hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''
        }${lockedCount > 0 ? ` · ${lockedCount} locked` : ''}`;

  return (
    <section
      ref={sectionRef}
      className="drawing-manager"
      aria-label="Drawing objects"
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header className="drawing-manager-head">
        <div className="drawing-manager-heading">
          <span className="panel-title">Drawing objects</span>
          <span className="panel-sub">{summary}</span>
        </div>
        <button type="button" className="tool-button" aria-label="Close drawing objects" title="Close drawing objects" onClick={onClose}>
          <X size={14} weight="bold" />
        </button>
      </header>

      <div className="drawing-manager-body">
        {drawings.length === 0 ? (
          <div className="drawing-manager-empty">
            <span className="muted">No drawings on this chart.</span>
            <span className="field-hint">Choose a tool from the rail, then click the chart to place one.</span>
          </div>
        ) : (
          <ul className="drawing-list" aria-label="Drawings on this chart">
            {drawings.map((drawing) => {
              const label = drawingLabel(drawing);
              return (
                <li
                  key={drawing.id}
                  className={`drawing-row${drawing.id === selectedId ? ' selected' : ''}${drawing.visible ? '' : ' hidden'}`}
                >
                  <button
                    type="button"
                    className="drawing-row-select"
                    aria-current={drawing.id === selectedId ? 'true' : undefined}
                    aria-label={`Select ${label}`}
                    onClick={() => onSelect(drawing.id)}
                    onDoubleClick={(event) => {
                      onSelect(drawing.id);
                      const manager = event.currentTarget.closest('.drawing-manager');
                      requestAnimationFrame(() => manager?.querySelector<HTMLElement>('[data-drawing-style-first]')?.focus());
                    }}
                  >
                    <span className="drawing-row-swatch" style={{ background: drawing.style.color }} aria-hidden />
                    <span className="drawing-row-copy">
                      <span className="drawing-row-title">{label}</span>
                      <span className="drawing-row-meta">
                        {drawingTypeLabel(drawing.type)}
                        {drawing.visible ? '' : ' · hidden'}
                        {drawing.locked ? ' · locked' : ''}
                      </span>
                    </span>
                    {drawing.locked && <LockSimple size={11} weight="bold" aria-hidden />}
                  </button>
                  <span className="drawing-row-actions">
                    <button
                      type="button"
                      className="tool-button"
                      aria-label={`${drawing.visible ? 'Hide' : 'Show'} ${label}`}
                      title={`${drawing.visible ? 'Hide' : 'Show'} ${label}`}
                      aria-pressed={drawing.visible}
                      onClick={() => onMutate((current) => toggleDrawingVisibility(current, drawing.id))}
                    >
                      {drawing.visible ? <Eye size={13} /> : <EyeSlash size={13} />}
                    </button>
                    <button
                      type="button"
                      className="tool-button"
                      aria-label={`${drawing.locked ? 'Unlock' : 'Lock'} ${label}`}
                      title={`${drawing.locked ? 'Unlock' : 'Lock'} ${label}`}
                      aria-pressed={drawing.locked}
                      onClick={() => onMutate((current) => toggleDrawingLocked(current, drawing.id))}
                    >
                      {drawing.locked ? <LockSimple size={13} weight="bold" /> : <LockSimpleOpen size={13} />}
                    </button>
                    <button
                      type="button"
                      className="tool-button"
                      aria-label={`Delete ${label}`}
                      title={drawing.locked ? 'Unlock to delete' : `Delete ${label}`}
                      disabled={drawing.locked}
                      onClick={() => {
                        onMutate((current) => removeDrawing(current, drawing.id));
                        if (drawing.id === selectedId) onSelect(null);
                      }}
                    >
                      <Trash size={13} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {selected ? (
          <DrawingInspector key={selected.id} drawing={selected} onMutate={onMutate} />
        ) : (
          <div className="drawing-inspector drawing-inspector-empty">
            <span className="field-hint">Select a drawing here or on the chart to edit its style.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function DrawingInspector({ drawing, onMutate }: { drawing: Drawing; onMutate: (mutate: DrawingMutator) => void }) {
  const locked = drawing.locked;
  const update = (patch: Partial<DrawingStyle>) =>
    onMutate((drawings) => setDrawingStyle(drawings, drawing.id, patch));

  return (
    <div className="drawing-inspector" role="group" aria-label={`${drawingLabel(drawing)} style`}>
      <div className="drawing-inspector-head">
        <div className="drawing-manager-heading">
          <span className="panel-title">Style</span>
          <span className="panel-sub">{drawingLabel(drawing)}</span>
        </div>
        {locked && <Tag tone="warn">Locked</Tag>}
      </div>
      {locked && <span className="field-hint">Unlock this drawing to change its style or text.</span>}

      <fieldset className="drawing-style-fields" disabled={locked}>
        <Field label="Color">
          <div className="drawing-swatches" role="group" aria-label="Drawing color">
            {PRESET_COLORS.map((color, index) => (
              <button
                key={color}
                type="button"
                className="drawing-swatch-button"
                style={{ background: color }}
                aria-label={`Color ${color}`}
                title={color}
                aria-pressed={hexColorForInput(drawing.style.color) === color}
                data-drawing-style-first={index === 0 ? '' : undefined}
                onClick={() => update({ color })}
              />
            ))}
            <input
              type="color"
              className="drawing-color-input"
              aria-label="Custom color"
              value={hexColorForInput(drawing.style.color)}
              onChange={(event) => update({ color: event.target.value })}
            />
          </div>
        </Field>

        {drawing.type !== 'text' && (
          <div className="drawing-style-grid">
            <Field label="Line width">
              <Select
                value={String(drawing.style.lineWidth)}
                onChange={(value) => update({ lineWidth: Number(value) })}
                options={WIDTH_OPTIONS}
              />
            </Field>
            <Field label="Line style">
              <Select
                value={drawing.style.lineStyle ?? 'solid'}
                onChange={(value) => update({ lineStyle: value })}
                options={LINE_OPTIONS}
              />
            </Field>
          </div>
        )}

        {drawing.type === 'rectangle' && (
          <Field label="Fill opacity">
            <Select
              value={String(drawing.style.fillOpacity ?? 0.12)}
              onChange={(value) => update({ fillOpacity: Number(value) })}
              options={FILL_OPTIONS}
            />
          </Field>
        )}

        {drawing.type === 'text' && (
          <>
            <Field label="Text">
              <DrawingTextControl
                key={`${drawing.id}:${drawing.text ?? ''}`}
                text={drawing.text ?? ''}
                disabled={locked}
                onCommit={(value) => onMutate((drawings) => setDrawingText(drawings, drawing.id, value))}
              />
            </Field>
            <Field label="Font size">
              <Select
                value={String(drawing.style.fontSize ?? 12)}
                onChange={(value) => update({ fontSize: Number(value) })}
                options={FONT_OPTIONS}
              />
            </Field>
          </>
        )}

        {drawing.type === 'fibonacci' && (
          <span className="field-hint">Fibonacci levels use the stored 0–100% scale for this drawing.</span>
        )}
      </fieldset>
    </div>
  );
}

function DrawingTextControl({
  text,
  disabled,
  onCommit,
}: {
  text: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const cancelRef = useRef(false);

  return (
    <TextInput
      value={draft}
      onChange={setDraft}
      disabled={disabled}
      placeholder="Label text"
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelRef.current = true;
          event.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false;
          setDraft(text);
          return;
        }
        const value = draft.trim();
        if (value.length === 0 || value === text) {
          setDraft(text);
          return;
        }
        onCommit(value);
      }}
    />
  );
}


