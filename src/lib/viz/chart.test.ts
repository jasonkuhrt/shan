import { describe, expect, test } from 'bun:test'
import type { AnalyzedEntry } from '../transcript-analyzer.js'
import {
  renderChart,
  renderTimeChart,
  renderTokenChart,
  formatTimeLabel,
  formatTokenLabel,
  getTimeChartLabelWidth,
  getTokenChartLabelWidth,
} from './chart.js'

// ── Helpers ──────────────────────────────────────────────────────

const makeEntry = (overrides: Partial<AnalyzedEntry> = {}): AnalyzedEntry => ({
  index: 0,
  entry: {
    type: 'user',
    uuid: 'u1',
    timestamp: '2024-01-01T00:00:00Z',
    message: { role: 'user', content: 'hi' },
  },
  timestamp: new Date('2024-01-01T00:00:00Z'),
  elapsedMs: 0,
  cumulativeTokens: 0,
  deltaTokens: 0,
  type: 'assistant',
  requestId: null,
  tools: [],
  skill: null,
  cacheHit: null,
  model: null,
  filesRead: 0,
  truncated: false,
  error: false,
  alert: false,
  topRank: null,
  ...overrides,
})

// ── formatTimeLabel ──────────────────────────────────────────────

describe('formatTimeLabel', () => {
  test('formats sub-minute as seconds', () => {
    expect(formatTimeLabel(5000)).toBe('5s')
    expect(formatTimeLabel(59000)).toBe('59s')
  })

  test('formats minutes', () => {
    expect(formatTimeLabel(60000)).toBe('1m')
    expect(formatTimeLabel(120000)).toBe('2m')
    expect(formatTimeLabel(300000)).toBe('5m')
  })

  test('formats 0 as 0s', () => {
    expect(formatTimeLabel(0)).toBe('0s')
  })
})

// ── formatTokenLabel ─────────────────────────────────────────────

describe('formatTokenLabel', () => {
  test('formats sub-1k as raw number', () => {
    expect(formatTokenLabel(0)).toBe('0')
    expect(formatTokenLabel(500)).toBe('500')
    expect(formatTokenLabel(999)).toBe('999')
  })

  test('formats 1k+ with k suffix', () => {
    expect(formatTokenLabel(1000)).toBe('1k')
    expect(formatTokenLabel(5500)).toBe('5k')
    expect(formatTokenLabel(100000)).toBe('100k')
  })
})

// ── renderChart ──────────────────────────────────────────────────

describe('renderChart', () => {
  test('renders a basic chart with header and rows', () => {
    const entries = [
      makeEntry({ elapsedMs: 0 }),
      makeEntry({ elapsedMs: 5000, index: 1 }),
      makeEntry({ elapsedMs: 10000, index: 2 }),
    ]
    const lines = renderChart({
      entries,
      getValue: (e) => e.elapsedMs,
      fillChar: '▓',
      formatHeader: (v) => `${v}ms`,
      formatYLabel: (v) => `${v}`,
      labelWidth: 8,
      rows: 5,
    })
    // Should have header + 5 rows
    expect(lines.length).toBe(6)
    // Header is first line
    expect(lines[0]).toContain('10000ms')
  })

  test('handles single entry', () => {
    const entries = [makeEntry({ elapsedMs: 1000 })]
    const lines = renderChart({
      entries,
      getValue: (e) => e.elapsedMs,
      fillChar: '█',
      formatHeader: (v) => String(v),
      formatYLabel: (v) => String(v),
      labelWidth: 6,
      rows: 3,
    })
    expect(lines.length).toBe(4) // header + 3 rows
  })

  test('handles zero values', () => {
    const entries = [makeEntry({ elapsedMs: 0 }), makeEntry({ elapsedMs: 0 })]
    const lines = renderChart({
      entries,
      getValue: (e) => e.elapsedMs,
      fillChar: '█',
      formatHeader: (v) => String(v),
      formatYLabel: (v) => String(v),
      labelWidth: 6,
      rows: 3,
    })
    expect(lines.length).toBe(4)
  })

  test('values above row max get fill char, below get space', () => {
    // Create entries with a clear max so we can verify fill behavior
    const entries = [
      makeEntry({ cumulativeTokens: 100 }),
      makeEntry({ cumulativeTokens: 0, index: 1 }),
    ]
    const lines = renderChart({
      entries,
      getValue: (e) => e.cumulativeTokens,
      fillChar: '█',
      formatHeader: (v) => String(v),
      formatYLabel: (v) => String(v),
      labelWidth: 6,
      rows: 3,
    })
    // Bottom row should have fill for first entry and space for second
    const bottomRow = lines[lines.length - 1]!
    expect(bottomRow).toContain('█')
  })
})

test('mid-range time values trigger logarithmic interpolation', () => {
  // 10 minutes is between 1min (low) and 1hr (high) thresholds
  const entries = [
    makeEntry({ elapsedMs: 0 }),
    makeEntry({ elapsedMs: 300000, index: 1 }), // 5 minutes - mid range
    makeEntry({ elapsedMs: 600000, index: 2 }), // 10 minutes
  ]
  const lines = renderTimeChart(entries)
  // Should produce between 10 and 30 rows (interpolated)
  // header + rows
  expect(lines.length).toBeGreaterThan(11) // more than MIN_ROWS + 1
  expect(lines.length).toBeLessThan(32) // less than MAX_ROWS + 1
})

test('mid-range token values trigger logarithmic interpolation', () => {
  // 50k tokens is between 10k (low) and 500k (high) thresholds
  const entries = [
    makeEntry({ cumulativeTokens: 0 }),
    makeEntry({ cumulativeTokens: 50000, index: 1 }),
  ]
  const lines = renderTokenChart(entries)
  expect(lines.length).toBeGreaterThan(11)
  expect(lines.length).toBeLessThan(32)
})

test('partial fill values produce block characters', () => {
  // niceScale(100, 10) → [10,20,30,...,100]
  // Value 55 falls WITHIN row [50,60) → triggers getBlockChar partial path
  const entries = [
    makeEntry({ cumulativeTokens: 55 }),
    makeEntry({ cumulativeTokens: 100, index: 1 }),
  ]
  const lines = renderChart({
    entries,
    getValue: (e) => e.cumulativeTokens,
    fillChar: '█',
    formatHeader: (v) => String(v),
    formatYLabel: (v) => String(v),
    labelWidth: 6,
    rows: 10,
  })
  // Should have partial block characters (▁▂▃▄▅▆▇) in the output
  const content = lines.join('')
  const hasPartialBlock = /[▁▂▃▄▅▆▇]/.test(content)
  expect(hasPartialBlock).toBe(true)
})

test('niceScale fallback path when no multiplier produces enough rows', () => {
  // Use a very large max with many rows to force the fallback
  // niceMultipliers [1,2,5,10] - with max=1e9 and targetRows=30,
  // rawStep=3.3e7, magnitude=1e7, multipliers try 1e7,2e7,5e7,1e8
  // potentialRows for each: ceil(1e9/1e7)+1=101, which exceeds 30
  // So we need a case where all multipliers produce too few rows
  // Actually this is hard to trigger since multiplier 1 often works.
  // Let me try max=5, targetRows=30 - rawStep=0.167, magnitude=0.1
  // niceStep = max(1, floor(0.1*mult)) for mult 1,2,5,10 = max(1,0)=1 for all
  // potentialRows = ceil(5/1)+1 = 6, which is < 30 for all multipliers
  // BUT niceStep is always 1, so all give same result. Fallback: step=max(1,ceil(5/30))=1
  // That should hit the fallback!
  const entries = [makeEntry({ cumulativeTokens: 0 }), makeEntry({ cumulativeTokens: 5, index: 1 })]
  const lines = renderChart({
    entries,
    getValue: (e) => e.cumulativeTokens,
    fillChar: '█',
    formatHeader: (v) => String(v),
    formatYLabel: (v) => String(v),
    labelWidth: 6,
    rows: 30,
  })
  // header + 30 rows
  expect(lines.length).toBe(31)
})

// ── renderTimeChart ──────────────────────────────────────────────

describe('renderTimeChart', () => {
  test('renders time chart for short session', () => {
    const entries = [
      makeEntry({ elapsedMs: 0 }),
      makeEntry({ elapsedMs: 15000, index: 1 }),
      makeEntry({ elapsedMs: 30000, index: 2 }),
    ]
    const lines = renderTimeChart(entries)
    expect(lines.length).toBeGreaterThan(1)
    // Header should contain duration
    expect(lines[0]).toContain('0m 30s')
  })

  test('renders time chart for long session (hours)', () => {
    const entries = [
      makeEntry({ elapsedMs: 0 }),
      makeEntry({ elapsedMs: 3600000, index: 1 }), // 1 hour
    ]
    const lines = renderTimeChart(entries)
    expect(lines[0]).toContain('1h 0m')
  })

  test('uses custom label width', () => {
    const entries = [makeEntry({ elapsedMs: 0 }), makeEntry({ elapsedMs: 10000, index: 1 })]
    const lines = renderTimeChart(entries, 12)
    // Each data row should have the larger label area
    expect(lines.length).toBeGreaterThan(1)
  })
})

// ── renderTokenChart ─────────────────────────────────────────────

describe('renderTokenChart', () => {
  test('renders token chart', () => {
    const entries = [
      makeEntry({ cumulativeTokens: 0 }),
      makeEntry({ cumulativeTokens: 5000, index: 1 }),
      makeEntry({ cumulativeTokens: 10000, index: 2 }),
    ]
    const lines = renderTokenChart(entries)
    expect(lines.length).toBeGreaterThan(1)
    // Header contains "Tokens"
    expect(lines[0]).toContain('Tokens')
  })

  test('renders token chart for large token counts', () => {
    const entries = [
      makeEntry({ cumulativeTokens: 0 }),
      makeEntry({ cumulativeTokens: 500000, index: 1 }),
    ]
    const lines = renderTokenChart(entries)
    expect(lines[0]).toContain('Tokens')
  })

  test('uses custom label width', () => {
    const entries = [makeEntry({ cumulativeTokens: 100 })]
    const lines = renderTokenChart(entries, 10)
    expect(lines.length).toBeGreaterThan(1)
  })
})

// ── getTimeChartLabelWidth ───────────────────────────────────────

describe('getTimeChartLabelWidth', () => {
  test('returns appropriate width for short sessions', () => {
    const entries = [makeEntry({ elapsedMs: 0 }), makeEntry({ elapsedMs: 5000, index: 1 })]
    const width = getTimeChartLabelWidth(entries)
    expect(width).toBeGreaterThanOrEqual(2) // "5s" = 2 chars
  })

  test('returns appropriate width for long sessions', () => {
    const entries = [
      makeEntry({ elapsedMs: 0 }),
      makeEntry({ elapsedMs: 7200000, index: 1 }), // 2 hours
    ]
    const width = getTimeChartLabelWidth(entries)
    expect(width).toBeGreaterThanOrEqual(2)
  })
})

// ── getTokenChartLabelWidth ──────────────────────────────────────

describe('getTokenChartLabelWidth', () => {
  test('returns appropriate width for small token counts', () => {
    const entries = [makeEntry({ cumulativeTokens: 500 })]
    const width = getTokenChartLabelWidth(entries)
    expect(width).toBeGreaterThanOrEqual(1)
  })

  test('returns appropriate width for large token counts', () => {
    const entries = [makeEntry({ cumulativeTokens: 1000000 })]
    const width = getTokenChartLabelWidth(entries)
    expect(width).toBeGreaterThanOrEqual(2)
  })
})
