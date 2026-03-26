import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTranscript, ensureOutputDir, writeOutput } from './transcript-io.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// ── ensureOutputDir ──────────────────────────────────────────────

describe('ensureOutputDir', () => {
  test('creates .claude/transcripts directory and returns path', async () => {
    const originalCwd = process.cwd()
    const tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'shan-test-')))
    try {
      process.chdir(tmpDir)
      const outputDir = await run(ensureOutputDir())
      expect(outputDir).toBe(join(tmpDir, '.claude', 'transcripts'))
      // Directory was created - verify by writing a file into it
      await Bun.write(join(outputDir, 'test.txt'), 'hello')
      const content = await Bun.file(join(outputDir, 'test.txt')).text()
      expect(content).toBe('hello')
    } finally {
      process.chdir(originalCwd)
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('is idempotent - calling twice succeeds', async () => {
    const originalCwd = process.cwd()
    const tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'shan-test-')))
    try {
      process.chdir(tmpDir)
      const dir1 = await run(ensureOutputDir())
      const dir2 = await run(ensureOutputDir())
      expect(dir1).toBe(dir2)
    } finally {
      process.chdir(originalCwd)
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ── writeOutput ──────────────────────────────────────────────────

describe('writeOutput', () => {
  test('writes content to file and returns path', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'shan-test-'))
    try {
      const outputPath = await run(writeOutput(tmpDir, 'report.txt', 'Hello World'))
      expect(outputPath).toBe(join(tmpDir, 'report.txt'))
      const content = await readFile(outputPath, 'utf-8')
      expect(content).toBe('Hello World')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ── loadTranscript ───────────────────────────────────────────────

describe('loadTranscript', () => {
  test('loads and parses a JSONL transcript file', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'shan-test-'))
    try {
      const jsonlContent = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'u2',
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }),
      ].join('\n')

      const sessionPath = join(tmpDir, 'test-session-abc123.jsonl')
      await Bun.write(sessionPath, jsonlContent)

      const result = await run(loadTranscript(sessionPath))
      expect(result.sessionPath).toBe(sessionPath)
      expect(result.sessionId).toBe('test-session-abc123')
      expect(result.entries).toHaveLength(2)
      expect(result.entries[0]!.type).toBe('user')
      expect(result.entries[1]!.type).toBe('assistant')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('extracts session ID from path without .jsonl extension', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'shan-test-'))
    try {
      const sessionPath = join(tmpDir, 'my-session.jsonl')
      await Bun.write(
        sessionPath,
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'hi' },
        }),
      )
      const result = await run(loadTranscript(sessionPath))
      expect(result.sessionId).toBe('my-session')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
