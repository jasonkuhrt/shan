import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry, AssistantEntry, UserEntry } from './transcript-schema.js'
import { analyzeTranscript } from './transcript-analyzer.js'

// ── Helpers ──────────────────────────────────────────────────────

const baseFields = {
  uuid: 'uuid-1',
  timestamp: '2024-01-01T00:00:00Z',
  parentUuid: null,
  sessionId: 'session-1',
}

const makeAssistant = (
  overrides: Partial<AssistantEntry> & { requestId?: string } = {},
): AssistantEntry => ({
  type: 'assistant' as const,
  message: {
    role: 'assistant' as const,
    content: [],
    ...(overrides.message ?? {}),
  },
  ...baseFields,
  ...overrides,
})

const makeUser = (overrides: Partial<UserEntry> = {}): UserEntry => ({
  type: 'user' as const,
  message: {
    role: 'user' as const,
    content: 'hello',
    ...(overrides.message ?? {}),
  },
  ...baseFields,
  ...overrides,
})

const makeProgress = (): TranscriptEntry => ({
  type: 'progress' as const,
  data: { type: 'hook' },
  timestamp: '2024-01-01T00:00:01Z',
  uuid: 'uuid-progress',
})

const makeSystem = (): TranscriptEntry => ({
  type: 'system' as const,
  ...baseFields,
  timestamp: '2024-01-01T00:00:02Z',
})

const makeFileHistory = (): TranscriptEntry => ({
  type: 'file-history-snapshot' as const,
  timestamp: '2024-01-01T00:00:03Z',
})

const makeQueueOperation = (): TranscriptEntry => ({
  type: 'queue-operation' as const,
  operation: 'enqueue',
  timestamp: '2024-01-01T00:00:04Z',
})

const makeSummary = (): TranscriptEntry => ({
  type: 'summary' as const,
  summary: 'A summary',
  timestamp: '2024-01-01T00:00:05Z',
})

// ── analyzeTranscript ────────────────────────────────────────────

describe('analyzeTranscript', () => {
  test('empty transcript returns empty result', () => {
    const result = analyzeTranscript([])
    expect(result.entries).toEqual([])
    expect(result.topConsumers).toEqual([])
    expect(result.summary.totalEntries).toBe(0)
    expect(result.summary.totalTokens).toBe(0)
    expect(result.summary.finalElapsedMs).toBe(0)
    expect(result.summary.cacheHitRate).toBe(0)
  })

  test('classifies entry types correctly', () => {
    const entries: TranscriptEntry[] = [
      makeUser(),
      makeAssistant(),
      makeProgress(),
      makeSystem(),
      makeFileHistory(),
      makeQueueOperation(),
      makeSummary(),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries.map((e) => e.type)).toEqual([
      'user',
      'assistant',
      'progress',
      'system',
      'other',
      'other',
      'other',
    ])
  })

  test('counts user, progress, and request entries in summary', () => {
    const entries: TranscriptEntry[] = [
      makeUser(),
      makeAssistant({ requestId: 'req-1' }),
      makeProgress(),
      makeUser({ timestamp: '2024-01-01T00:00:10Z' }),
      makeAssistant({ requestId: 'req-2', timestamp: '2024-01-01T00:00:11Z' }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.summary.userCount).toBe(2)
    expect(result.summary.progressCount).toBe(1)
    expect(result.summary.requestCount).toBe(2)
    expect(result.summary.totalEntries).toBe(5)
  })

  test('accumulates tokens from usage across same requestId', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    // Only the first entry for a requestId gets deltaTokens
    expect(result.entries[0]!.deltaTokens).toBe(450) // 100+50+200+100
    expect(result.entries[1]!.deltaTokens).toBe(0) // duplicate requestId
    expect(result.summary.totalTokens).toBe(450)
  })

  test('tracks cumulative tokens across requests', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
      makeAssistant({
        requestId: 'req-2',
        timestamp: '2024-01-01T00:00:02Z',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.cumulativeTokens).toBe(150)
    expect(result.entries[1]!.cumulativeTokens).toBe(450)
  })

  test('handles assistant entries without requestId', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.deltaTokens).toBe(0)
    expect(result.entries[0]!.requestId).toBeNull()
  })

  test('computes elapsed time from first timestamp', () => {
    const entries: TranscriptEntry[] = [
      makeUser({ timestamp: '2024-01-01T00:00:00Z' }),
      makeAssistant({ timestamp: '2024-01-01T00:01:00Z' }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.elapsedMs).toBe(0)
    expect(result.entries[1]!.elapsedMs).toBe(60000)
    expect(result.summary.finalElapsedMs).toBe(60000)
  })

  test('elapsed never decreases (monotonic)', () => {
    const entries: TranscriptEntry[] = [
      makeUser({ timestamp: '2024-01-01T00:01:00Z' }),
      makeAssistant({ timestamp: '2024-01-01T00:00:30Z' }), // earlier timestamp
    ]
    const result = analyzeTranscript(entries)
    // Second entry should not go below first entry's elapsed
    expect(result.entries[1]!.elapsedMs).toBeGreaterThanOrEqual(result.entries[0]!.elapsedMs)
  })

  test('handles entries without timestamps', () => {
    const entry: TranscriptEntry = {
      type: 'summary' as const,
      summary: 'test',
      // no timestamp
    }
    const result = analyzeTranscript([entry])
    expect(result.entries[0]!.timestamp).toEqual(new Date(0))
    expect(result.entries[0]!.elapsedMs).toBe(0)
  })

  test('handles invalid timestamps', () => {
    const entries: TranscriptEntry[] = [makeUser({ timestamp: 'not-a-date' })]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.timestamp).toEqual(new Date(0))
  })

  // ── Model extraction ────────────────────────────────────────────

  test('extracts model from assistant entries', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: { role: 'assistant', content: [], model: 'claude-opus-4-20250514' },
      }),
      makeAssistant({
        requestId: 'req-2',
        timestamp: '2024-01-01T00:00:01Z',
        message: { role: 'assistant', content: [], model: 'claude-sonnet-4-20250514' },
      }),
      makeAssistant({
        requestId: 'req-3',
        timestamp: '2024-01-01T00:00:02Z',
        message: { role: 'assistant', content: [], model: 'claude-haiku-4-20250514' },
      }),
      makeAssistant({
        requestId: 'req-4',
        timestamp: '2024-01-01T00:00:03Z',
        message: { role: 'assistant', content: [], model: 'unknown-model' },
      }),
      makeAssistant({
        requestId: 'req-5',
        timestamp: '2024-01-01T00:00:04Z',
        message: { role: 'assistant', content: [] },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.model).toBe('opus')
    expect(result.entries[1]!.model).toBe('sonnet')
    expect(result.entries[2]!.model).toBe('haiku')
    expect(result.entries[3]!.model).toBeNull()
    expect(result.entries[4]!.model).toBeNull()
  })

  // ── Tool extraction ─────────────────────────────────────────────

  test('extracts tools from assistant content blocks', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
            { type: 'text', text: 'some text' },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.tools).toEqual(['Read', 'Bash'])
    expect(result.entries[0]!.filesRead).toBe(1)
  })

  test('counts multiple Read tool calls', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
            { type: 'tool_use', id: 't3', name: 'Read', input: {} },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.filesRead).toBe(3)
  })

  // ── Cache detection ─────────────────────────────────────────────

  test('detects cache hits from usage', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.cacheHit).toBe(true)
    expect(result.summary.cacheHitRate).toBe(1)
  })

  test('detects cache misses', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.cacheHit).toBe(false)
    expect(result.summary.cacheHitRate).toBe(0)
  })

  test('cacheHit is null for non-assistant entries', () => {
    const result = analyzeTranscript([makeUser()])
    expect(result.entries[0]!.cacheHit).toBeNull()
  })

  test('cache_creation_input_tokens are counted in delta', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
          },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.deltaTokens).toBe(350) // 100+200+50
  })

  // ── Truncation & Error detection ────────────────────────────────

  test('detects truncated tool results', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'some result [truncated] end',
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.truncated).toBe(true)
    expect(result.summary.truncatedCount).toBe(1)
  })

  test('non-truncated tool results', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'normal result',
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.truncated).toBe(false)
  })

  test('detects errors in tool results', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'error output',
              is_error: true,
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.error).toBe(true)
    expect(result.summary.errorCount).toBe(1)
  })

  test('no error for non-error tool results', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'ok',
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.error).toBe(false)
  })

  test('string content for user never detects truncation or error', () => {
    const entries: TranscriptEntry[] = [
      makeUser({ message: { role: 'user', content: 'just text' } }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.truncated).toBe(false)
    expect(result.entries[0]!.error).toBe(false)
  })

  // ── Alert detection ─────────────────────────────────────────────

  test('flags entries with deltaTokens >= 5000 as alerts', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 4000, output_tokens: 1000 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.alert).toBe(true)
    expect(result.summary.alertCount).toBe(1)
  })

  test('does not flag entries below 5000 tokens', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 2000, output_tokens: 1000 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.alert).toBe(false)
  })

  // ── Top consumers ───────────────────────────────────────────────

  test('ranks top consumers by deltaTokens descending', () => {
    const entries: TranscriptEntry[] = []
    for (let i = 0; i < 12; i++) {
      entries.push(
        makeAssistant({
          requestId: `req-${i}`,
          timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`,
          message: {
            role: 'assistant',
            content: [],
            usage: { input_tokens: (i + 1) * 100, output_tokens: 0 },
          },
        }),
      )
    }
    const result = analyzeTranscript(entries)
    expect(result.topConsumers).toHaveLength(9) // max 9
    expect(result.topConsumers[0]!.rank).toBe(1)
    expect(result.topConsumers[0]!.deltaTokens).toBe(1200) // highest
    expect(result.topConsumers[8]!.rank).toBe(9)
  })

  test('top consumers assigns topRank on analyzed entries', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.topRank).toBe(1)
    expect(result.topConsumers[0]!.rank).toBe(1)
    expect(result.topConsumers[0]!.index).toBe(0)
  })

  test('entries without deltaTokens have topRank null', () => {
    const result = analyzeTranscript([makeUser()])
    expect(result.entries[0]!.topRank).toBeNull()
  })

  // ── Skill extraction from user entries ──────────────────────────

  test('extracts skill from "Base directory for this skill:" pattern', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: 'Base directory for this skill: /path/to/skills/my-skill/src',
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill).toEqual({
      name: 'my-skill',
      isInitial: true,
      isProgressive: false,
    })
  })

  test('extracts skill from "### Skill:" pattern', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: '### Skill: deploy-helper\nSome instructions',
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill).toEqual({
      name: 'deploy-helper',
      isInitial: true,
      isProgressive: false,
    })
  })

  test('marks progressive skill when same skill appears again', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: { role: 'user', content: '### Skill: my-skill\nFirst' },
      }),
      makeUser({
        timestamp: '2024-01-01T00:00:01Z',
        message: { role: 'user', content: '### Skill: my-skill\nSecond' },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill!.isInitial).toBe(true)
    expect(result.entries[0]!.skill!.isProgressive).toBe(false)
    expect(result.entries[1]!.skill!.isInitial).toBe(false)
    expect(result.entries[1]!.skill!.isProgressive).toBe(true)
  })

  test('no skill detected for plain user messages', () => {
    const result = analyzeTranscript([makeUser()])
    expect(result.entries[0]!.skill).toBeNull()
  })

  test('extracts skill from user message with array content containing text blocks', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: [{ type: 'text', text: '### Skill: array-skill\nDetails' }],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill!.name).toBe('array-skill')
  })

  // ── Skill extraction from tool use ──────────────────────────────

  test('extracts skill invoked via Skill tool', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Skill',
              input: { skill: 'deploy-helper' },
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill).toEqual({
      name: 'deploy-helper',
      isInitial: true,
      isProgressive: false,
    })
  })

  test('unknown tool with non-object input returns null skill', () => {
    // Use an unknown tool name so decodeToolInput returns raw input
    // This exercises the extractSkillFromTool fallback branch
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    // Bash is not Skill, so no skill extraction
    expect(result.entries[0]!.skill).toBeNull()
  })

  test('Skill tool with missing skill field in input', () => {
    // Use an unknown tool name that matches 'Skill' in the tools array
    // but the actual tool_use block name is something unknown to schema
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Skill',
              input: { skill: 'valid-skill', args: 'some-args' },
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill!.name).toBe('valid-skill')
  })

  test('assistant entry inherits current skill context when no new skill invoked', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: { role: 'user', content: '### Skill: my-skill\nFirst' },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: { role: 'assistant', content: [] },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[1]!.skill).toEqual({
      name: 'my-skill',
      isInitial: false,
      isProgressive: true,
    })
  })

  // ── Model merging across same requestId ─────────────────────────

  test('model is taken from first entry with model in same request', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: { role: 'assistant', content: [] },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: { role: 'assistant', content: [], model: 'claude-sonnet-4-20250514' },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.model).toBe('sonnet')
  })

  // ── Skill merging across same requestId ─────────────────────────

  test('skill invoked is merged from subsequent chunks of same requestId', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: { role: 'assistant', content: [] },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Skill',
              input: { skill: 'merged-skill' },
            },
          ],
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill!.name).toBe('merged-skill')
  })

  // ── Duplicate requestId handling for cacheHit ───────────────────

  test('seen requestId entries get cacheHit from request data', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500 },
        },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: { role: 'assistant', content: [] },
      }),
    ]
    const result = analyzeTranscript(entries)
    // Second entry with same requestId gets cacheHit from the aggregated data
    expect(result.entries[1]!.cacheHit).toBe(true)
    expect(result.entries[1]!.deltaTokens).toBe(0) // no new delta
  })

  // ── Base directory skill without "skills" in path ───────────────

  test('base directory pattern without "skills" segment returns null', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: {
          role: 'user',
          content: 'Base directory for this skill: /path/without/skill-dir',
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.skill).toBeNull()
  })

  // ── Top consumers include correct fields ────────────────────────

  test('top consumer includes skill, model, and cacheHit', () => {
    const entries: TranscriptEntry[] = [
      makeUser({
        message: { role: 'user', content: '### Skill: test-skill\n' },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'test-skill' } }],
          model: 'claude-opus-4-20250514',
          usage: { input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 100 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.topConsumers.length).toBeGreaterThanOrEqual(1)
    const tc = result.topConsumers[0]!
    expect(tc.skill).toBe('test-skill')
    expect(tc.model).toBe('opus')
    expect(tc.cacheHit).toBe(true)
  })

  test('top consumer without skill shows null', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.topConsumers[0]!.skill).toBeNull()
  })

  // ── Cache hit rate with mixed results ───────────────────────────

  test('cache hit rate is ratio of hits to total requests', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500 },
        },
      }),
      makeAssistant({
        requestId: 'req-2',
        timestamp: '2024-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.summary.cacheHitRate).toBe(0.5)
  })

  // ── Assistant without usage ─────────────────────────────────────

  test('assistant entries without usage have zero tokens', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: { role: 'assistant', content: [] },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.deltaTokens).toBe(0)
  })

  // ── Cache hit detected across multiple chunks of same request ───

  test('cache hit detected from later chunk of same requestId', () => {
    const entries: TranscriptEntry[] = [
      makeAssistant({
        requestId: 'req-1',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
        },
      }),
      makeAssistant({
        requestId: 'req-1',
        timestamp: '2024-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500 },
        },
      }),
    ]
    const result = analyzeTranscript(entries)
    expect(result.entries[0]!.cacheHit).toBe(true) // aggregated across chunks
  })
})
