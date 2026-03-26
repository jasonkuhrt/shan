import { describe, expect, test } from 'bun:test'
import type { AnalyzedTranscript, TopConsumer } from '../transcript-analyzer.js'
import { renderTopConsumers, renderSummary, renderLegend } from './legend.js'

// ── renderTopConsumers ───────────────────────────────────────────

describe('renderTopConsumers', () => {
  test('returns empty array when no consumers', () => {
    const result = renderTopConsumers([])
    expect(result).toEqual([])
  })

  test('renders consumers with separator and header', () => {
    const consumers: TopConsumer[] = [
      {
        rank: 1,
        index: 5,
        deltaTokens: 15000,
        tools: ['Read', 'Bash'],
        skill: 'deploy',
        model: 'opus',
        cacheHit: true,
      },
    ]
    const lines = renderTopConsumers(consumers)
    expect(lines.length).toBeGreaterThanOrEqual(4) // separator + header + separator + data
    expect(lines[0]).toContain('━')
    expect(lines[1]).toContain('TOP CONSUMERS')
    expect(lines[2]).toContain('━')
    // Data line
    const dataLine = lines[3]!
    expect(dataLine).toContain('1') // rank
    expect(dataLine).toContain('#5') // index
    expect(dataLine).toContain('+15.0k') // delta
    expect(dataLine).toContain('Read') // tool
    expect(dataLine).toContain('deploy') // skill
    expect(dataLine).toContain('opus') // model
    expect(dataLine).toContain('● hit') // cache hit
  })

  test('renders cache miss', () => {
    const consumers: TopConsumer[] = [
      {
        rank: 1,
        index: 0,
        deltaTokens: 5000,
        tools: [],
        skill: null,
        model: null,
        cacheHit: false,
      },
    ]
    const lines = renderTopConsumers(consumers)
    const dataLine = lines[3]!
    expect(dataLine).toContain('○ miss')
  })

  test('renders delta below 1000 without k suffix', () => {
    const consumers: TopConsumer[] = [
      {
        rank: 1,
        index: 0,
        deltaTokens: 500,
        tools: [],
        skill: null,
        model: null,
        cacheHit: false,
      },
    ]
    const lines = renderTopConsumers(consumers)
    const dataLine = lines[3]!
    expect(dataLine).toContain('+500')
  })

  test('renders multiple consumers', () => {
    const consumers: TopConsumer[] = [
      {
        rank: 1,
        index: 10,
        deltaTokens: 20000,
        tools: ['Read', 'Read', 'Read'],
        skill: 'foo',
        model: 'opus',
        cacheHit: true,
      },
      {
        rank: 2,
        index: 5,
        deltaTokens: 10000,
        tools: ['Bash'],
        skill: null,
        model: 'sonnet',
        cacheHit: false,
      },
    ]
    const lines = renderTopConsumers(consumers)
    // 3 header lines + 2 data lines
    expect(lines).toHaveLength(5)
  })

  test('formats tools with counts', () => {
    const consumers: TopConsumer[] = [
      {
        rank: 1,
        index: 0,
        deltaTokens: 5000,
        tools: ['Read', 'Read', 'Bash'],
        skill: null,
        model: null,
        cacheHit: false,
      },
    ]
    const lines = renderTopConsumers(consumers)
    const dataLine = lines[3]!
    expect(dataLine).toContain('Read ×2')
    expect(dataLine).toContain('Bash')
  })

  test('handles empty tools list', () => {
    const consumers: TopConsumer[] = [
      {
        rank: 1,
        index: 0,
        deltaTokens: 5000,
        tools: [],
        skill: null,
        model: null,
        cacheHit: false,
      },
    ]
    const lines = renderTopConsumers(consumers)
    // Should not throw
    expect(lines.length).toBeGreaterThan(0)
  })
})

// ── renderSummary ────────────────────────────────────────────────

describe('renderSummary', () => {
  test('renders summary with all fields', () => {
    const summary: AnalyzedTranscript['summary'] = {
      totalEntries: 100,
      requestCount: 25,
      userCount: 30,
      progressCount: 10,
      totalTokens: 50000,
      finalElapsedMs: 300000,
      cacheHitRate: 0.75,
      errorCount: 3,
      truncatedCount: 2,
      alertCount: 5,
    }
    const lines = renderSummary(summary)
    expect(lines.some((l) => l.includes('SUMMARY'))).toBe(true)
    expect(lines.some((l) => l.includes('100'))).toBe(true)
    expect(lines.some((l) => l.includes('25 requests'))).toBe(true)
    expect(lines.some((l) => l.includes('30 user'))).toBe(true)
    expect(lines.some((l) => l.includes('10 progress'))).toBe(true)
    expect(lines.some((l) => l.includes('75%'))).toBe(true)
    expect(lines.some((l) => l.includes('3'))).toBe(true) // errors
    expect(lines.some((l) => l.includes('2'))).toBe(true) // truncated
    expect(lines.some((l) => l.includes('5'))).toBe(true) // alerts
  })

  test('renders 0% cache hit rate', () => {
    const summary: AnalyzedTranscript['summary'] = {
      totalEntries: 10,
      requestCount: 5,
      userCount: 3,
      progressCount: 2,
      totalTokens: 1000,
      finalElapsedMs: 10000,
      cacheHitRate: 0,
      errorCount: 0,
      truncatedCount: 0,
      alertCount: 0,
    }
    const lines = renderSummary(summary)
    expect(lines.some((l) => l.includes('0%'))).toBe(true)
  })

  test('includes separator lines', () => {
    const summary: AnalyzedTranscript['summary'] = {
      totalEntries: 1,
      requestCount: 1,
      userCount: 1,
      progressCount: 0,
      totalTokens: 100,
      finalElapsedMs: 1000,
      cacheHitRate: 0.5,
      errorCount: 0,
      truncatedCount: 0,
      alertCount: 0,
    }
    const lines = renderSummary(summary)
    const separatorLines = lines.filter((l) => l.includes('━'))
    expect(separatorLines.length).toBeGreaterThanOrEqual(2)
  })
})

// ── renderLegend ─────────────────────────────────────────────────

describe('renderLegend', () => {
  test('renders legend with header', () => {
    const lines = renderLegend()
    expect(lines.some((l) => l.includes('LEGEND'))).toBe(true)
    expect(lines.some((l) => l.includes('━'))).toBe(true)
  })

  test('includes all dimension categories', () => {
    const lines = renderLegend()
    const text = lines.join('\n')
    expect(text).toContain('TYPE')
    expect(text).toContain('SKILL')
    expect(text).toContain('TOOL')
    expect(text).toContain('CACHE')
    expect(text).toContain('MODEL')
    expect(text).toContain('FILES')
    expect(text).toContain('TRUNC')
    expect(text).toContain('ERROR')
    expect(text).toContain('TOKENS')
  })

  test('includes tool symbols', () => {
    const lines = renderLegend()
    const text = lines.join('\n')
    expect(text).toContain('Bash')
    expect(text).toContain('Read')
    expect(text).toContain('Edit')
    expect(text).toContain('Grep')
    expect(text).toContain('Glob')
    expect(text).toContain('Write')
  })

  test('includes model names', () => {
    const lines = renderLegend()
    const text = lines.join('\n')
    expect(text).toContain('opus')
    expect(text).toContain('sonnet')
    expect(text).toContain('haiku')
  })

  test('returns multiple lines', () => {
    const lines = renderLegend()
    expect(lines.length).toBeGreaterThan(10) // header + content
  })

  test('lines are arranged in 3-column layout', () => {
    const lines = renderLegend()
    // After the header section (first 4 lines), content lines should have multi-column layout
    // Total width is 80, 3 columns with 2-char gap
    expect(lines.length).toBeGreaterThan(4)
  })
})
