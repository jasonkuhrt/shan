import { describe, expect, test } from 'bun:test'
import type { AnalyzedEntry, SkillInfo } from '../transcript-analyzer.js'
import { renderDimensions, getDimensionLabelWidth } from './dimensions.js'

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

// ── getDimensionLabelWidth ───────────────────────────────────────

describe('getDimensionLabelWidth', () => {
  test('returns max dimension name length', () => {
    const width = getDimensionLabelWidth()
    // Longest dimension name is "skill" or "alert" or "error" or "trunc" or "model" or "cache" or "files" = 5
    expect(width).toBe(5)
  })
})

// ── renderDimensions ─────────────────────────────────────────────

describe('renderDimensions', () => {
  test('produces 10 dimension rows', () => {
    const entries = [makeEntry()]
    const lines = renderDimensions(entries)
    // 10 dimensions: type, skill, tool, cache, model, files, trunc, error, alert, top
    expect(lines).toHaveLength(10)
  })

  test('type dimension shows correct symbols', () => {
    const entries = [
      makeEntry({ type: 'user' }),
      makeEntry({ type: 'assistant', index: 1 }),
      makeEntry({ type: 'progress', index: 2 }),
      makeEntry({ type: 'system', index: 3 }),
      makeEntry({ type: 'other', index: 4 }),
    ]
    const lines = renderDimensions(entries)
    const typeLine = lines.find((l) => l.trimStart().startsWith('type'))!
    expect(typeLine).toContain('◦') // user
    expect(typeLine).toContain('●') // assistant
    expect(typeLine).toContain('·') // progress/system/other
  })

  test('skill dimension shows correct symbols', () => {
    const initialSkill: SkillInfo = { name: 'test', isInitial: true, isProgressive: false }
    const progressiveSkill: SkillInfo = { name: 'test', isInitial: false, isProgressive: true }
    const otherSkill: SkillInfo = { name: 'test', isInitial: false, isProgressive: false }

    const entries = [
      makeEntry({ skill: initialSkill }),
      makeEntry({ skill: progressiveSkill, index: 1 }),
      makeEntry({ skill: otherSkill, index: 2 }),
      makeEntry({ skill: null, index: 3 }),
    ]
    const lines = renderDimensions(entries)
    const skillLine = lines.find((l) => l.trimStart().startsWith('skill'))!
    expect(skillLine).toContain('◆') // initial
    expect(skillLine).toContain('╰') // progressive
    expect(skillLine).toContain('◇') // other
  })

  test('tool dimension shows first tool symbol', () => {
    const entries = [
      makeEntry({ tools: ['Bash'] }),
      makeEntry({ tools: ['Read'], index: 1 }),
      makeEntry({ tools: ['WebFetch'], index: 2 }),
      makeEntry({ tools: ['Grep'], index: 3 }),
      makeEntry({ tools: ['Edit'], index: 4 }),
      makeEntry({ tools: ['Glob'], index: 5 }),
      makeEntry({ tools: ['Task'], index: 6 }),
      makeEntry({ tools: ['Write'], index: 7 }),
      makeEntry({ tools: [], index: 8 }),
      makeEntry({ tools: ['UnknownTool'], index: 9 }),
    ]
    const lines = renderDimensions(entries)
    const toolLine = lines.find((l) => l.trimStart().startsWith('tool'))!
    expect(toolLine).toContain('▢') // Bash
    expect(toolLine).toContain('▤') // Read
    expect(toolLine).toContain('▣') // WebFetch
    expect(toolLine).toContain('▥') // Grep
    expect(toolLine).toContain('▦') // Edit
    expect(toolLine).toContain('▧') // Glob
    expect(toolLine).toContain('▨') // Task
    expect(toolLine).toContain('▩') // Write
  })

  test('cache dimension shows hit, miss, none', () => {
    const entries = [
      makeEntry({ cacheHit: true }),
      makeEntry({ cacheHit: false, index: 1 }),
      makeEntry({ cacheHit: null, index: 2 }),
    ]
    const lines = renderDimensions(entries)
    const cacheLine = lines.find((l) => l.trimStart().startsWith('cache'))!
    expect(cacheLine).toContain('●') // hit
    expect(cacheLine).toContain('○') // miss
  })

  test('model dimension shows correct symbols', () => {
    const entries = [
      makeEntry({ model: 'opus' }),
      makeEntry({ model: 'sonnet', index: 1 }),
      makeEntry({ model: 'haiku', index: 2 }),
      makeEntry({ model: null, index: 3 }),
    ]
    const lines = renderDimensions(entries)
    const modelLine = lines.find((l) => l.trimStart().startsWith('model'))!
    expect(modelLine).toContain('◈') // opus
    expect(modelLine).toContain('◇') // sonnet
    expect(modelLine).toContain('◦') // haiku
  })

  test('files dimension shows count or + for 10+', () => {
    const entries = [
      makeEntry({ filesRead: 0 }),
      makeEntry({ filesRead: 1, index: 1 }),
      makeEntry({ filesRead: 5, index: 2 }),
      makeEntry({ filesRead: 9, index: 3 }),
      makeEntry({ filesRead: 10, index: 4 }),
      makeEntry({ filesRead: 15, index: 5 }),
    ]
    const lines = renderDimensions(entries)
    const filesLine = lines.find((l) => l.trimStart().startsWith('files'))!
    expect(filesLine).toContain('1')
    expect(filesLine).toContain('5')
    expect(filesLine).toContain('9')
    expect(filesLine).toContain('+')
  })

  test('trunc dimension shows dagger for truncated', () => {
    const entries = [makeEntry({ truncated: true }), makeEntry({ truncated: false, index: 1 })]
    const lines = renderDimensions(entries)
    const truncLine = lines.find((l) => l.trimStart().startsWith('trunc'))!
    expect(truncLine).toContain('†')
  })

  test('error dimension shows cross for errors', () => {
    const entries = [makeEntry({ error: true }), makeEntry({ error: false, index: 1 })]
    const lines = renderDimensions(entries)
    const errorLine = lines.find((l) => l.trimStart().startsWith('error'))!
    expect(errorLine).toContain('×')
  })

  test('alert dimension shows double exclamation for alerts', () => {
    const entries = [makeEntry({ alert: true }), makeEntry({ alert: false, index: 1 })]
    const lines = renderDimensions(entries)
    const alertLine = lines.find((l) => l.trimStart().startsWith('alert'))!
    expect(alertLine).toContain('‼')
  })

  test('top dimension shows rank number', () => {
    const entries = [
      makeEntry({ topRank: 1 }),
      makeEntry({ topRank: 9, index: 1 }),
      makeEntry({ topRank: null, index: 2 }),
    ]
    const lines = renderDimensions(entries)
    const topLine = lines.find((l) => l.trimStart().startsWith('top'))!
    expect(topLine).toContain('1')
    expect(topLine).toContain('9')
  })

  test('uses custom label width', () => {
    const entries = [makeEntry()]
    const lines = renderDimensions(entries, 12)
    // Labels should be padded to 12-1=11 chars + 1 space
    for (const line of lines) {
      // Each line starts with padded label
      expect(line.length).toBeGreaterThanOrEqual(12)
    }
  })
})
