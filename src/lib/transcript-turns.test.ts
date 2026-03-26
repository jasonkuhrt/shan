import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry, UserEntry } from './transcript-schema.js'
import { collapseIntoTurns, buildToolResultMap } from './transcript-turns.js'

const baseFields = { uuid: 'u1', timestamp: '2024-01-01T00:00:00Z' }

const userEntry = (content: UserEntry['message']['content']): TranscriptEntry => ({
  type: 'user',
  message: { role: 'user', content },
  ...baseFields,
})

const assistantEntry = (text: string): TranscriptEntry => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
  ...baseFields,
})

const summaryEntry = (): TranscriptEntry => ({
  type: 'summary',
  summary: 'context...',
})

const toolResultOnlyUser = (toolUseId: string): TranscriptEntry =>
  userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: 'result' }])

// ── collapseIntoTurns ───────────────────────────────────────────

describe('collapseIntoTurns', () => {
  test('returns empty for empty input', () => {
    expect(collapseIntoTurns([])).toEqual([])
  })

  test('groups a single user entry into a user turn', () => {
    const turns = collapseIntoTurns([userEntry('hello')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('user')
    expect(turns[0]!.entries).toHaveLength(1)
  })

  test('groups a single assistant entry into a claude turn', () => {
    const turns = collapseIntoTurns([assistantEntry('hi')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('claude')
  })

  test('creates a summary turn', () => {
    const turns = collapseIntoTurns([summaryEntry()])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('summary')
    expect(turns[0]!.entries).toHaveLength(1)
  })

  test('merges sequential assistant entries into one claude turn', () => {
    const turns = collapseIntoTurns([assistantEntry('a'), assistantEntry('b')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('claude')
    expect(turns[0]!.entries).toHaveLength(2)
  })

  test('folds tool_result-only user entries into claude turn', () => {
    const turns = collapseIntoTurns([
      assistantEntry('calling tool'),
      toolResultOnlyUser('tu_1'),
      assistantEntry('got result'),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('claude')
    expect(turns[0]!.entries).toHaveLength(3)
  })

  test('tool_result-only user entry without prior claude turn becomes a user turn', () => {
    const turns = collapseIntoTurns([toolResultOnlyUser('tu_1')])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('user')
  })

  test('real user entry after claude turn starts new user turn', () => {
    const turns = collapseIntoTurns([assistantEntry('hi'), userEntry('thanks')])
    expect(turns).toHaveLength(2)
    expect(turns[0]!.type).toBe('claude')
    expect(turns[1]!.type).toBe('user')
  })

  test('summary pushes current turn and resets', () => {
    const turns = collapseIntoTurns([userEntry('hi'), summaryEntry(), assistantEntry('hello')])
    expect(turns).toHaveLength(3)
    expect(turns[0]!.type).toBe('user')
    expect(turns[1]!.type).toBe('summary')
    expect(turns[2]!.type).toBe('claude')
  })

  test('skips non-conversation entries (system, progress, etc.)', () => {
    const systemEntry: TranscriptEntry = { type: 'system', ...baseFields }
    const progressEntry: TranscriptEntry = { type: 'progress', data: { type: 'hook' } }
    const fileHistoryEntry: TranscriptEntry = { type: 'file-history-snapshot' }
    const queueEntry: TranscriptEntry = {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2024-01-01T00:00:00Z',
    }
    const turns = collapseIntoTurns([
      systemEntry,
      progressEntry,
      fileHistoryEntry,
      queueEntry,
      userEntry('hi'),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.type).toBe('user')
  })

  test('user entry with string content is a real user turn', () => {
    const turns = collapseIntoTurns([assistantEntry('hi'), userEntry('text message')])
    expect(turns).toHaveLength(2)
    expect(turns[1]!.type).toBe('user')
  })

  test('user entry with mixed content (not all tool_result) is a real user turn', () => {
    const mixed = userEntry([
      { type: 'text', text: 'info' },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'result' },
    ])
    const turns = collapseIntoTurns([assistantEntry('hi'), mixed])
    expect(turns).toHaveLength(2)
    expect(turns[1]!.type).toBe('user')
  })

  test('user entry with empty array content is a real user turn', () => {
    const empty = userEntry([])
    const turns = collapseIntoTurns([assistantEntry('hi'), empty])
    expect(turns).toHaveLength(2)
    expect(turns[1]!.type).toBe('user')
  })

  test('assistant entry after user turn starts new claude turn', () => {
    const turns = collapseIntoTurns([userEntry('hi'), assistantEntry('hello')])
    expect(turns).toHaveLength(2)
    expect(turns[0]!.type).toBe('user')
    expect(turns[1]!.type).toBe('claude')
  })
})

// ── buildToolResultMap ──────────────────────────────────────────

describe('buildToolResultMap', () => {
  test('returns empty map for empty entries', () => {
    const map = buildToolResultMap([])
    expect(map.size).toBe(0)
  })

  test('extracts tool_result blocks from user entries', () => {
    const entries: TranscriptEntry[] = [
      userEntry([
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'result1' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'result2' },
      ]),
    ]
    const map = buildToolResultMap(entries)
    expect(map.size).toBe(2)
    expect(map.get('tu_1')!.content).toBe('result1')
    expect(map.get('tu_2')!.content).toBe('result2')
  })

  test('skips non-user entries', () => {
    const entries: TranscriptEntry[] = [assistantEntry('hi')]
    const map = buildToolResultMap(entries)
    expect(map.size).toBe(0)
  })

  test('skips user entries with string content', () => {
    const entries: TranscriptEntry[] = [userEntry('just text')]
    const map = buildToolResultMap(entries)
    expect(map.size).toBe(0)
  })

  test('skips non-tool_result blocks in user content', () => {
    const entries: TranscriptEntry[] = [
      userEntry([
        { type: 'text', text: 'info' },
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'result' },
      ]),
    ]
    const map = buildToolResultMap(entries)
    expect(map.size).toBe(1)
    expect(map.has('tu_1')).toBe(true)
  })

  test('handles multiple user entries', () => {
    const entries: TranscriptEntry[] = [
      userEntry([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'r1' }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'tu_2', content: 'r2' }]),
    ]
    const map = buildToolResultMap(entries)
    expect(map.size).toBe(2)
  })
})
