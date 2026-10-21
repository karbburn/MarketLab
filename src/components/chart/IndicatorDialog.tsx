import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CaretUp } from '@phosphor-icons/react';
import type { ChartConfig, IndicatorInstance } from '../../domain/types';
import { defaultParameters, getIndicatorDefinition, listIndicatorDefinitions } from '../../lib/indicators';
import {
  describeIndicatorInstance,
  parametersDifferFromStore,
  reorderIndicators,
  updateIndicatorParameters,
} from '../../lib/indicators/management';
import { createId } from '../../lib/id';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, Select, Tag } from '../ui';

export function IndicatorDialog({
  open,
  onClose,
  chart,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  chart: ChartConfig;
  workspaceId: string;
}) {
  const { actions } = useStore();
  const definitions = useMemo(() => listIndicatorDefinitions(), []);
  const [selectedType, setSelectedType] = useState(definitions[0]?.type ?? 'sma');
  const [draftParameters, setDraftParameters] = useState<Record<string, number>>(() => {
    const first = definitions[0];
    return first ? defaultParameters(first) : {};
  });
  // One instance is edited at a time; the draft holds the typed values until
  // they are applied or discarded. Nothing reaches the stored workspace until
  // Apply commits validated parameters.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<Record<string, number>>({});
  const editingRef = useRef<HTMLDivElement>(null);

  const definition = getIndicatorDefinition(selectedType) ?? definitions[0];

  // Every close path routes through here, so a half-open edit can never
  // survive into the next session of the dialog.
  const handleClose = () => {
    cancelEditing();
    onClose();
  };

  // The edit form is a valid NumberInput, so the existing chart shortcuts and
  // the dialog's own Escape-close stay untouched; Escape inside the editor
  // cancels the edit before the dialog's handler can see it.
  useEffect(() => {
    if (!editingId) return;
    const frame = requestAnimationFrame(() => editingRef.current?.querySelector<HTMLInputElement>('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingId]);

  const chooseType = (type: string) => {
    setSelectedType(type);
    const picked = getIndicatorDefinition(type);
    setDraftParameters(picked ? defaultParameters(picked) : {});
  };

  const addIndicator = () => {
    if (!definition) return;
    const instance: IndicatorInstance = {
      id: createId('ind'),
      type: definition.type,
      version: definition.version,
      parameters: { ...draftParameters },
      visible: true,
      placement: definition.placement,
      style: {},
    };
    void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, indicators: [...config.indicators, instance] }));
    onClose();
  };

  const startEditing = (instance: IndicatorInstance) => {
    if (!getIndicatorDefinition(instance.type)) return;
    setEditingId(instance.id);
    setEditingDraft({ ...instance.parameters });
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingDraft({});
  };

  const applyEdit = (instance: IndicatorInstance) => {
    const editDefinition = getIndicatorDefinition(instance.type);
    if (!editDefinition) {
      cancelEditing();
      return;
    }
    void actions.updateChart(workspaceId, chart.id, (config) => ({
      ...config,
      indicators: updateIndicatorParameters(config.indicators, instance.id, editDefinition, editingDraft),
    }));
    cancelEditing();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Indicators"
      wide
      footer={
        <>
          <button type="button" className="button ghost" onClick={handleClose}>
            Close
          </button>
          <button type="button" className="button primary" disabled={!definition} onClick={addIndicator}>
            Add to chart
          </button>
        </>
      }
    >
      <div className="page-split">
        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">{definition?.name ?? 'Indicator'}</span>
              <div style={{ flex: 1 }} />
              {definition && <Tag>{definition.placement === 'overlay' ? 'Overlays price' : 'Own pane'}</Tag>}
            </div>
            <div className="panel-body stack">
              {definition && (
                <>
                  <p className="panel-sub">{definition.description}</p>
                  <code className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {definition.formula}
                  </code>
                  {definition.parameters.length === 0 ? (
                    <span className="field-hint">This indicator has no parameters.</span>
                  ) : (
                    <div className="grid-3">
                      {definition.parameters.map((spec) => (
                        <Field key={spec.key} label={spec.label} hint={`${spec.min} to ${spec.max}`}>
                          <NumberInput
                            value={draftParameters[spec.key] ?? spec.defaultValue}
                            min={spec.min}
                            max={spec.max}
                            step={spec.step}
                            onChange={(value) =>
                              setDraftParameters((previous) => ({
                                ...previous,
                                [spec.key]: Number.isFinite(value) ? value : spec.defaultValue,
                              }))
                            }
                          />
                        </Field>
                      ))}
                    </div>
                  )}
                  <div className="row">
                    <button type="button" className="button ghost sm" onClick={() => setDraftParameters(defaultParameters(definition))}>
                      Reset to defaults
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">On this chart</span>
              <span className="panel-sub">{chart.indicators.length} instance(s)</span>
            </div>
            <div className="panel-body stack">
              {chart.indicators.length === 0 && <span className="field-hint">No indicators on this chart yet.</span>}
              <div role="list" style={{ display: 'grid', gap: 10 }}>
                {chart.indicators.map((instance, index) => {
                  const instanceDefinition = getIndicatorDefinition(instance.type);
                  const label = describeIndicatorInstance(instanceDefinition, instance);
                  const editing = editingId === instance.id && instanceDefinition !== undefined;
                  return (
                    <div key={instance.id} role="listitem" style={{ display: 'grid', gap: 6 }}>
                      <div className="spread">
                        <div style={{ display: 'grid', minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span>{label}</span>
                            <Tag>{instance.placement === 'overlay' ? 'Overlays price' : 'Own pane'}</Tag>
                            {!instanceDefinition && <Tag tone="warn">Unknown type</Tag>}
                          </span>
                          <span className="panel-sub mono">
                            {Object.entries(instance.parameters)
                              .map(([key, value]) => `${key}=${value}`)
                              .join('  ') || 'no parameters'}
                          </span>
                        </div>
                        <div className="row tight">
                          <button
                            type="button"
                            className="button ghost sm"
                            aria-label={instance.visible ? `Hide ${label}` : `Show ${label}`}
                            onClick={() =>
                              void actions.updateChart(workspaceId, chart.id, (config) => ({
                                ...config,
                                indicators: config.indicators.map((entry) =>
                                  entry.id === instance.id ? { ...entry, visible: !entry.visible } : entry,
                                ),
                              }))
                            }
                          >
                            {instance.visible ? 'Hide' : 'Show'}
                          </button>
                          {instanceDefinition && (
                            <button
                              type="button"
                              className="button ghost sm"
                              aria-label={`Edit ${label}`}
                              onClick={() => (editing ? cancelEditing() : startEditing(instance))}
                            >
                              {editing ? 'Cancel' : 'Edit'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="button ghost sm"
                            aria-label={`Move ${label} up`}
                            disabled={index === 0}
                            onClick={() =>
                              void actions.updateChart(workspaceId, chart.id, (config) => ({
                                ...config,
                                indicators: reorderIndicators(config.indicators, instance.id, 'up'),
                              }))
                            }
                          >
                            <CaretUp size={12} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="button ghost sm"
                            aria-label={`Move ${label} down`}
                            disabled={index === chart.indicators.length - 1}
                            onClick={() =>
                              void actions.updateChart(workspaceId, chart.id, (config) => ({
                                ...config,
                                indicators: reorderIndicators(config.indicators, instance.id, 'down'),
                              }))
                            }
                          >
                            <CaretDown size={12} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="button ghost sm"
                            aria-label={`Remove ${label}`}
                            onClick={() => {
                              if (editing) cancelEditing();
                              void actions.updateChart(workspaceId, chart.id, (config) => ({
                                ...config,
                                indicators: config.indicators.filter((entry) => entry.id !== instance.id),
                              }));
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {editing && instanceDefinition && (
                        <div
                          ref={editingRef}
                          className="indicator-edit"
                          role="group"
                          aria-label={`${label} parameter settings`}
                          onKeyDown={(event) => {
                            if (event.key !== 'Escape') return;
                            event.stopPropagation();
                            cancelEditing();
                          }}
                        >
                          {instanceDefinition.parameters.length === 0 ? (
                            <span className="field-hint">This indicator has no parameters.</span>
                          ) : (
                            <div className="grid-3">
                              {instanceDefinition.parameters.map((spec) => (
                                <Field key={spec.key} label={spec.label} hint={`${spec.min} to ${spec.max}`}>
                                  <NumberInput
                                    value={editingDraft[spec.key] ?? spec.defaultValue}
                                    min={spec.min}
                                    max={spec.max}
                                    step={spec.step}
                                    onChange={(value) =>
                                      setEditingDraft((previous) => ({
                                        ...previous,
                                        [spec.key]: Number.isFinite(value) ? value : spec.defaultValue,
                                      }))
                                    }
                                  />
                                </Field>
                              ))}
                            </div>
                          )}
                          <div className="row tight">
                            <button
                              type="button"
                              className="button primary sm"
                              disabled={!parametersDifferFromStore(instanceDefinition, instance.parameters, editingDraft)}
                              onClick={() => applyEdit(instance)}
                            >
                              Save parameters
                            </button>
                            <button type="button" className="button ghost sm" onClick={cancelEditing}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Library</span>
          </div>
          <div className="panel-body stack scroll-y">
            <Field label="Category filter">
              <Select
                value={selectedType}
                onChange={chooseType}
                options={definitions.map((entry) => ({ value: entry.type, label: `${entry.category}: ${entry.name}` }))}
              />
            </Field>
            <div className="stack">
              {definitions.map((entry) => (
                <button
                  key={entry.type}
                  type="button"
                  className={entry.type === selectedType ? 'nav-item active' : 'nav-item'}
                  onClick={() => chooseType(entry.type)}
                >
                  <span className="nav-item-label">
                    {entry.name}
                    <br />
                    <span className="panel-sub">{entry.category}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
