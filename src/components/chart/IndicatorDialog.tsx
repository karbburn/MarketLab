import { useMemo, useState } from 'react';
import type { ChartConfig, IndicatorInstance } from '../../domain/types';
import { defaultParameters, getIndicatorDefinition, listIndicatorDefinitions } from '../../lib/indicators';
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

  const definition = getIndicatorDefinition(selectedType) ?? definitions[0];

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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Indicators"
      wide
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
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
              {chart.indicators.map((instance) => {
                const instanceDefinition = getIndicatorDefinition(instance.type);
                return (
                  <div key={instance.id} className="spread">
                    <div style={{ display: 'grid' }}>
                      <span>{instanceDefinition?.name ?? instance.type}</span>
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
                        onClick={() =>
                          void actions.updateChart(workspaceId, chart.id, (config) => ({
                            ...config,
                            indicators: config.indicators.map((entry) => (entry.id === instance.id ? { ...entry, visible: !entry.visible } : entry)),
                          }))
                        }
                      >
                        {instance.visible ? 'Hide' : 'Show'}
                      </button>
                      <button
                        type="button"
                        className="button ghost sm"
                        onClick={() =>
                          void actions.updateChart(workspaceId, chart.id, (config) => ({
                            ...config,
                            indicators: config.indicators.filter((entry) => entry.id !== instance.id),
                          }))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
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
