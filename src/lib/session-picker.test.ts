import { describe, expect, test, mock, afterEach } from 'bun:test'
import { Effect } from 'effect'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getRuntimeConfig } from './runtime-config.js'

// Mock @clack/prompts before importing session-picker
const selectMock = mock((..._args: unknown[]) => Promise.resolve<unknown>('selected-value'))
const isCancelMock = mock((..._args: unknown[]) => false)

await mock.module('@clack/prompts', () => ({
  select: selectMock,
  isCancel: isCancelMock,
}))

// Now import the module under test
const { pickSession } = await import('./session-picker.js')

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runFail = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(Effect.flip(effect))

// ── pickSession ──────────────────────────────────────────────────

describe('pickSession', () => {
  const originalIsTTY = process.stdin.isTTY
  const originalStdoutTTY = process.stdout.isTTY

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, writable: true })
    selectMock.mockClear()
    isCancelMock.mockClear()
  })

  test('fails when not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    const error = await runFail(pickSession())
    expect(error.message).toContain('Interactive session picker requires a TTY')
  })

  test('fails when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true })

    const error = await runFail(pickSession())
    expect(error.message).toContain('Interactive session picker requires a TTY')
  })

  test('fails when no sessions found (scoped)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    // Use a temp directory that won't have any sessions
    const tmpDir = await mkdtemp(join(tmpdir(), 'shan-pick-'))
    try {
      const error = await runFail(pickSession({ directory: tmpDir }))
      expect(error.message).toContain('No sessions found')
      expect(error.message).toContain('--all')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('fails when no sessions found with all flag includes correct message', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    // Use a unique nonexistent directory so no sessions will be found
    const tmpDir = await mkdtemp(join(tmpdir(), 'shan-pick-'))
    try {
      // Scoped to a nonexistent project dir - will find no sessions
      const error = await runFail(
        pickSession({ directory: join(tmpDir, 'nonexistent-project-zzz') }),
      )
      expect(error.message).toContain('No sessions found')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('handles selection cancellation', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    selectMock.mockImplementation(() => Promise.resolve(Symbol('cancel')))
    isCancelMock.mockImplementation(() => true)

    const error = await runFail(pickSession())
    // Either "Selection cancelled" or "No sessions found" depending on whether sessions exist
    expect(error.message).toMatch(/cancelled|No sessions/)
  })

  test('formats multi-project session labels and reports cancellation after discovery', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    const claudeProjectsDir = getRuntimeConfig().paths.claudeProjectsDir
    const now = Date.now()
    const sessionFixtures = [
      {
        project: join('shared-root-one', 'alpha'),
        id: 'yesterday-session',
        size: 2 * 1024,
        daysAgo: 1,
      },
      {
        project: join('shared-root-two', 'beta'),
        id: 'days-session',
        size: 512,
        daysAgo: 3,
      },
      {
        project: join('shared-root-three', 'gamma'),
        id: 'weeks-session',
        size: 1536,
        daysAgo: 10,
      },
      {
        project: join('shared-root-four', 'delta'),
        id: 'months-session',
        size: 2 * 1024 * 1024,
        daysAgo: 45,
      },
    ] as const

    try {
      for (const fixture of sessionFixtures) {
        const dir = join(claudeProjectsDir, fixture.project)
        const file = join(dir, `${fixture.id}.jsonl`)
        const timestamp = new Date(now - fixture.daysAgo * 24 * 60 * 60 * 1000)

        await mkdir(dir, { recursive: true })
        await writeFile(file, Buffer.alloc(fixture.size, 'x'))
        await utimes(file, timestamp, timestamp)
      }

      selectMock.mockImplementation(() => Promise.resolve(Symbol('cancel')))
      isCancelMock.mockImplementation(() => true)

      const error = await runFail(pickSession({ all: true }))
      expect(error.message).toContain('Selection cancelled')

      const [firstCall] = selectMock.mock.calls
      const args = firstCall?.[0] as
        | { message: string; options: Array<{ label: string; value: string }> }
        | undefined

      expect(args).toBeDefined()
      expect(args?.message).toContain('~/.claude/projects/shared-root-')

      const labels = (args?.options ?? []).map((option) => option.label).join('\n')
      expect(labels).toContain('2KB')
      expect(labels).toContain('2.0MB')
      expect(labels).toContain('yesterday')
      expect(labels).toContain('3d ago')
      expect(labels).toContain('1w ago')
      expect(labels).toContain('1mo ago')
    } finally {
      for (const fixture of sessionFixtures) {
        await rm(join(claudeProjectsDir, fixture.project), { recursive: true, force: true })
      }
    }
  })

  test('returns selected session path on success', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    // Create a session file in the claude projects dir for a known directory
    const tmpDir = await mkdtemp(join(tmpdir(), 'shan-pick-'))
    const projectDirName = tmpDir.replace(/[/.]/g, '-')
    const claudeProjectDir = join(getRuntimeConfig().paths.claudeProjectsDir, projectDirName)

    try {
      await mkdir(claudeProjectDir, { recursive: true })
      const sessionPath = join(claudeProjectDir, 'test-session.jsonl')
      await writeFile(sessionPath, '{}')

      const expectedPath = '/selected/session.jsonl'
      selectMock.mockImplementation(() => Promise.resolve(expectedPath))
      isCancelMock.mockImplementation(() => false)

      const result = await run(pickSession({ directory: tmpDir }))
      expect(result).toBe(expectedPath)
    } finally {
      await rm(claudeProjectDir, { recursive: true, force: true })
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
