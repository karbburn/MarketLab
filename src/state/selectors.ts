import type { Bar, Dataset, Instrument, Workspace } from '../domain/types';
import type { AppState } from './store';

export interface DatasetView {
  dataset: Dataset;
  instrument: Instrument | undefined;
  bars: Bar[];
}

export function instrumentIndex(instruments: readonly Instrument[]): Map<string, Instrument> {
  return new Map(instruments.map((instrument) => [instrument.id, instrument]));
}

export function datasetViews(
  state: Pick<AppState, 'instruments' | 'datasets' | 'barsByDataset'>,
): DatasetView[] {
  const instruments = instrumentIndex(state.instruments);
  return state.datasets.map((dataset) => ({
    dataset,
    instrument: instruments.get(dataset.instrumentId),
    bars: state.barsByDataset[dataset.id] ?? [],
  }));
}

export function datasetView(state: AppState, datasetId: string | undefined): DatasetView | null {
  if (!datasetId) return null;
  const dataset = state.datasets.find((entry) => entry.id === datasetId);
  if (!dataset) return null;
  return {
    dataset,
    instrument: state.instruments.find((entry) => entry.id === dataset.instrumentId),
    bars: state.barsByDataset[dataset.id] ?? [],
  };
}

export function activeWorkspace(state: AppState): Workspace | null {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? state.workspaces[0] ?? null;
}

export function datasetLabel(dataset: Dataset, instrument: Instrument | undefined): string {
  const symbol = instrument?.symbol ?? dataset.instrumentId;
  return `${symbol} - ${dataset.frequency}`;
}

export function sessionCount(state: AppState): number {
  return Object.values(state.barsByDataset).reduce((total, bars) => total + bars.length, 0);
}

export function hasSyntheticData(state: AppState): boolean {
  return state.datasets.some((dataset) => dataset.sourceKind === 'bundled-sample');
}
