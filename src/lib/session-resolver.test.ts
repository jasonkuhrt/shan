import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolveSessionPath, extractSessionId } from './session-resolver.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runFail = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(Effect.flip(effect))

// ── resolveSessionPath ───────────────────────────────────────────

describe('resolveSessionPath', () => {
  test('absolute path is returned as-is', async () => {
    const result = await run(resolveSessionPath('/absolute/path/to/session.jsonl'))
    expect(result).toBe('/absolute/path/to/session.jsonl')
  })

  test('home-relative path expands tilde', async () => {
    const result = await run(resolveSessionPath('~/some/session.jsonl'))
    expect(result).toBe(`${homedir()}/some/session.jsonl`)
  })

  test('relative .jsonl path resolves against cwd', async () => {
    const result = await run(resolveSessionPath('./data/session.jsonl'))
    expect(result).toBe(resolve(process.cwd(), './data/session.jsonl'))
  })

  test('relative .jsonl path without leading dot resolves against cwd', async () => {
    const result = await run(resolveSessionPath('data/session.jsonl'))
    expect(result).toBe(resolve(process.cwd(), 'data/session.jsonl'))
  })

  test('session ID prefix that does not match fails', async () => {
    const error = await runFail(resolveSessionPath('nonexistent-prefix-zzzzz-99999'))
    expect(error.message).toContain('No session found matching')
  })

  test('session ID prefix finds matching file in ~/.claude/projects', async () => {
    // Create a temporary session file in ~/.claude/projects for prefix search
    const uniqueId = `shan-test-resolver-${Date.now()}`
    const projectDir = join(homedir(), '.claude', 'projects', 'shan-test-resolver')
    const sessionPath = join(projectDir, `${uniqueId}.jsonl`)

    try {
      await mkdir(projectDir, { recursive: true })
      await writeFile(sessionPath, '{}')

      const result = await run(resolveSessionPath(uniqueId))
      expect(result).toBe(sessionPath)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})

// ── extractSessionId ─────────────────────────────────────────────

describe('extractSessionId', () => {
  test('extracts ID from path with .jsonl extension', () => {
    expect(extractSessionId('/path/to/abc123.jsonl')).toBe('abc123')
  })

  test('returns filename as-is when no .jsonl extension', () => {
    expect(extractSessionId('/path/to/abc123')).toBe('abc123')
  })

  test('handles just a filename', () => {
    expect(extractSessionId('session.jsonl')).toBe('session')
  })
})
