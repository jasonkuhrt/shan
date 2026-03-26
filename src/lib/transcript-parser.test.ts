import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { parseTranscriptEntries } from './transcript-parser.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const baseFields = { uuid: 'u1', timestamp: '2024-01-01T00:00:00Z' }

describe('parseTranscriptEntries', () => {
  test('parses user and assistant entries', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, ...baseFields }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
        ...baseFields,
      }),
    ].join('\n')

    const entries = await run(parseTranscriptEntries(lines))
    expect(entries).toHaveLength(2)
    expect(entries[0]!.type).toBe('user')
    expect(entries[1]!.type).toBe('assistant')
  })

  test('parses summary entries', async () => {
    const lines = JSON.stringify({ type: 'summary', summary: 'context here' })
    const entries = await run(parseTranscriptEntries(lines))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('summary')
  })

  test('skips empty lines', async () => {
    const lines = [
      '',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, ...baseFields }),
      '   ',
      JSON.stringify({ type: 'summary', summary: 'ctx' }),
      '',
    ].join('\n')

    const entries = await run(parseTranscriptEntries(lines))
    expect(entries).toHaveLength(2)
  })

  test('fails on invalid JSON', async () => {
    const lines = 'not valid json'
    await expect(run(parseTranscriptEntries(lines))).rejects.toThrow('Invalid JSON at line 1')
  })

  test('warns on unknown entry types but continues', async () => {
    const lines = [
      JSON.stringify({ type: 'unknown_thing', data: 123 }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, ...baseFields }),
    ].join('\n')

    const entries = await run(parseTranscriptEntries(lines))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('user')
  })

  test('handles single line input', async () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      ...baseFields,
    })
    const entries = await run(parseTranscriptEntries(line))
    expect(entries).toHaveLength(1)
  })
})
