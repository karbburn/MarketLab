import { describe, expect, it } from 'vitest';
import {
  COMMAND_SCORE,
  DATASET_SCORE,
  normaliseQuery,
  planPalette,
  scoreCommand,
  scoreDataset,
} from '../../src/lib/command-palette/search';
import type { CommandPaletteItem, DatasetPaletteItem } from '../../src/lib/command-palette/types';
import type { PalettePlan } from '../../src/lib/command-palette/search';

function dataset(id: string, label: string, extras: Partial<DatasetPaletteItem> = {}): DatasetPaletteItem {
  return {
    id: `dataset:${id}`,
    kind: 'dataset',
    group: 'datasets',
    label,
    names: [],
    datasetId: id,
    instrumentId: `inst_${id}`,
    ...extras,
  };
}

function command(label: string, extras: Partial<CommandPaletteItem> = {}): CommandPaletteItem {
  return {
    id: `command:${label}`,
    kind: 'command',
    group: 'actions',
    label,
    run: () => {},
    ...extras,
  };
}

const navigation = (label: string) => command(label, { group: 'navigation' });

/** The dataset ids in the plan's navigation order. */
function datasetIds(plan: PalettePlan): string[] {
  return plan.flat
    .filter((item): item is DatasetPaletteItem => item.kind === 'dataset')
    .map((item) => item.datasetId);
}

describe('normaliseQuery', () => {
  it('lower-cases, trims and collapses runs of whitespace', () => {
    expect(normaliseQuery('  AAPL   Daily ')).toBe('aapl daily');
    expect(normaliseQuery('\tMSFT\n')).toBe('msft');
    expect(normaliseQuery('   ')).toBe('');
    expect(normaliseQuery('')).toBe('');
  });
});

describe('scoreDataset', () => {
  const aapl = dataset('ds_aapl', 'AAPL', { names: ['Apple Inc.', 'AAPL - daily'], keywords: ['daily', 'user-csv'] });

  it('matches symbols case-insensitively', () => {
    expect(scoreDataset(aapl, normaliseQuery('aapl'))).toBe(DATASET_SCORE.symbolExact);
    expect(scoreDataset(aapl, normaliseQuery('  AaPl  '))).toBe(DATASET_SCORE.symbolExact);
  });

  it('ranks an exact symbol above a symbol prefix', () => {
    expect(scoreDataset(aapl, 'aapl') ?? 0).toBeGreaterThan(scoreDataset(aapl, 'aa') ?? 0);
  });

  it('searches names after the symbol, and ignores whitespace noise', () => {
    expect(scoreDataset(aapl, normaliseQuery('apple'))).toBe(DATASET_SCORE.namePrefix);
    expect(scoreDataset(aapl, normaliseQuery('inc.'))).toBe(DATASET_SCORE.nameContains);
    expect(scoreDataset(aapl, normaliseQuery('  anon  '))).toBeNull();
  });

  it('falls back to a multi-token match across every searchable field', () => {
    expect(scoreDataset(aapl, normaliseQuery('AApl   daily'))).toBe(DATASET_SCORE.keywordContains);
    expect(scoreDataset(aapl, normaliseQuery('aapl  weekly'))).toBeNull();
  });
});

describe('scoreCommand', () => {
  const downloadMany = command('Download many symbols', { keywords: ['batch', 'bulk', 'provider'] });

  it('ranks the label before keywords', () => {
    expect(scoreCommand(downloadMany, 'download')).toBe(COMMAND_SCORE.labelPrefix);
    expect(scoreCommand(downloadMany, 'many symbols')).toBe(COMMAND_SCORE.labelContains);
    expect(scoreCommand(downloadMany, 'bulk')).toBe(COMMAND_SCORE.keywordExact);
    expect(scoreCommand(downloadMany, 'bat')).toBe(COMMAND_SCORE.keywordPrefix);
  });

  it('matches a multi-word query when every token appears', () => {
    expect(scoreCommand(downloadMany, 'batch symbols')).toBe(COMMAND_SCORE.keywordContains);
    expect(scoreCommand(downloadMany, 'batch missing')).toBeNull();
  });
});

describe('planPalette dataset ranking', () => {
  const exact = dataset('ds_exact', 'AA');
  const prefix = dataset('ds_prefix', 'AAL');
  const namePrefix = dataset('ds_name_prefix', 'XYZ', { names: ['AA Holdings'] });
  const nameContains = dataset('ds_name_contains', 'QQQ', { names: ['The AA Fund'] });
  const symbolContains = dataset('ds_symbol_contains', 'BAAX');
  const keywordOnly = dataset('ds_keyword', 'MSFT', { names: ['Microsoft'], keywords: ['aa-tagged'] });

  it('orders exact symbol, symbol prefix, name, then broader substrings', () => {
    const plan = planPalette({
      query: 'aa',
      librarySize: 6,
      datasets: [keywordOnly, symbolContains, nameContains, namePrefix, prefix, exact],
      commands: [],
      recents: [],
    });
    expect(datasetIds(plan)).toEqual([
      'ds_exact',
      'ds_prefix',
      'ds_name_prefix',
      'ds_name_contains',
      'ds_symbol_contains',
      'ds_keyword',
    ]);
  });

  it('prefers the shorter label when two rows score the same', () => {
    const plan = planPalette({
      query: 'aa',
      librarySize: 2,
      datasets: [dataset('ds_long', 'AALX'), dataset('ds_short', 'AAL')],
      commands: [],
      recents: [],
    });
    expect(plan.flat.map((item) => item.label)).toEqual(['AAL', 'AALX']);
  });

  it('leaves out datasets that do not match at all', () => {
    const plan = planPalette({
      query: 'aapl',
      librarySize: 2,
      datasets: [dataset('ds_aapl', 'AAPL'), dataset('ds_spy', 'SPY', { names: ['SPDR S&P 500'] })],
      commands: [],
      recents: [],
    });
    expect(datasetIds(plan)).toEqual(['ds_aapl']);
  });
});

describe('planPalette empty query', () => {
  const recents = [dataset('ds_spy', 'SPY')];

  it('shows recently used datasets and every command, and no dataset list', () => {
    const plan = planPalette({
      query: '   ',
      librarySize: 2,
      datasets: [dataset('ds_aapl', 'AAPL'), dataset('ds_spy', 'SPY')],
      commands: [navigation('Chart workspace'), command('Import a CSV file')],
      recents,
    });
    expect(plan.sections.map((section) => section.group)).toEqual(['recent', 'navigation', 'actions']);
    expect(plan.flat.map((item) => item.id)).toEqual(['dataset:ds_spy', 'command:Chart workspace', 'command:Import a CSV file']);
    expect(plan.emptyMessage).toBeNull();
  });

  it('keeps the declared command order rather than ranking it', () => {
    const plan = planPalette({
      query: '',
      librarySize: 0,
      datasets: [],
      commands: [navigation('Data'), navigation('Backtest'), command('Export a JSON backup')],
      recents: [],
    });
    expect(plan.sections.map((section) => section.group)).toEqual(['navigation', 'actions']);
    expect(plan.flat.map((item) => item.label)).toEqual(['Data', 'Backtest', 'Export a JSON backup']);
  });
});

describe('planPalette empty states', () => {
  it('reports a single no-results message when nothing matches', () => {
    const plan = planPalette({
      query: 'zzz',
      librarySize: 1,
      datasets: [dataset('ds_aapl', 'AAPL')],
      commands: [command('Import a CSV file')],
      recents: [],
    });
    expect(plan.flat).toEqual([]);
    expect(plan.sections).toEqual([]);
    expect(plan.emptyMessage).toBe('No results for “zzz”.');
  });

  it('notes that no dataset matched while a command still did', () => {
    const plan = planPalette({
      query: 'import',
      librarySize: 3,
      datasets: [dataset('ds_aapl', 'AAPL')],
      commands: [command('Import a CSV file')],
      recents: [],
    });
    const datasets = plan.sections.find((section) => section.group === 'datasets');
    expect(datasets?.items).toEqual([]);
    expect(datasets?.note).toBe('No matching datasets.');
    expect(plan.flat.map((item) => item.id)).toEqual(['command:Import a CSV file']);
    expect(plan.commandsNote).toBeNull();
  });

  it('explains an empty library instead of listing nothing', () => {
    const plan = planPalette({
      query: 'theme',
      librarySize: 0,
      datasets: [],
      commands: [command('Switch to light theme')],
      recents: [],
    });
    expect(plan.sections.find((section) => section.group === 'datasets')?.note).toBe(
      'No datasets in the local library yet.',
    );
    expect(plan.flat.map((item) => item.id)).toEqual(['command:Switch to light theme']);
  });

  it('notes that no command matched while a dataset still did', () => {
    const plan = planPalette({
      query: 'aapl',
      librarySize: 1,
      datasets: [dataset('ds_aapl', 'AAPL')],
      commands: [command('Import a CSV file')],
      recents: [],
    });
    expect(plan.flat.map((item) => item.id)).toEqual(['dataset:ds_aapl']);
    expect(plan.commandsNote).toBe('No matching commands.');
  });
});

describe('planPalette mixed results', () => {
  it('orders datasets, then navigation, then actions', () => {
    const plan = planPalette({
      query: 'a',
      librarySize: 1,
      datasets: [dataset('ds_aapl', 'AAPL')],
      commands: [navigation('Chart workspace'), navigation('Quant lab'), command('Import a CSV file')],
      recents: [],
    });
    expect(plan.sections.map((section) => section.group)).toEqual(['datasets', 'navigation', 'actions']);
    expect(plan.flat.map((item) => item.id)).toEqual([
      'dataset:ds_aapl',
      'command:Chart workspace',
      'command:Quant lab',
      'command:Import a CSV file',
    ]);
  });

  it('keeps the flat order identical to the rendered order', () => {
    const plan = planPalette({
      query: 'data',
      librarySize: 1,
      datasets: [dataset('ds_data', 'DATA', { names: ['Data Co'] })],
      commands: [navigation('Data'), command('Download market data')],
      recents: [],
    });
    const rendered = plan.sections.flatMap((section) => section.items.map((item) => item.id));
    expect(plan.flat.map((item) => item.id)).toEqual(rendered);
  });
});
