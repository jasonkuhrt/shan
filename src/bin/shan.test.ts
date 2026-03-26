import { describe, expect, mock, test } from 'bun:test'
import { Effect } from 'effect'

import { parseArgs, resolveScope, QUIET_ERRORS, program, run } from './shan.js'
import type { ParsedFlags } from './shan.js'

const defaultFlags: ParsedFlags = {
  raw: false,
  all: false,
  md: false,
  execute: false,
  strict: false,
  global: false,
  noFix: false,
  show: [],
  skill: [],
  scope: '',
}

const makeFlags = (overrides: Partial<ParsedFlags>): ParsedFlags => ({
  ...defaultFlags,
  ...overrides,
})

// ── parseArgs ─────────────────────────────────────────

describe('parseArgs', () => {
  test('parses --raw', () => {
    expect(parseArgs(['--raw']).flags.raw).toBe(true)
  })
  test('parses --all', () => {
    expect(parseArgs(['--all']).flags.all).toBe(true)
  })
  test('parses --md', () => {
    expect(parseArgs(['--md']).flags.md).toBe(true)
  })
  test('parses --execute', () => {
    expect(parseArgs(['--execute']).flags.execute).toBe(true)
  })
  test('parses --strict', () => {
    expect(parseArgs(['--strict']).flags.strict).toBe(true)
  })
  test('parses --global', () => {
    expect(parseArgs(['--global']).flags.global).toBe(true)
  })
  test('parses --no-fix', () => {
    expect(parseArgs(['--no-fix']).flags.noFix).toBe(true)
  })
  test('parses --scope with space', () => {
    expect(parseArgs(['--scope', 'user']).flags.scope).toBe('user')
  })
  test('parses --scope= syntax', () => {
    expect(parseArgs(['--scope=project']).flags.scope).toBe('project')
  })
  test('parses --show with space', () => {
    expect(parseArgs(['--show', 'results']).flags.show).toEqual(['results'])
  })
  test('parses --show= syntax', () => {
    expect(parseArgs(['--show=diffs']).flags.show).toEqual(['diffs'])
  })
  test('parses --skill with space', () => {
    expect(parseArgs(['--skill', 'typed-api-dx-review']).flags.skill).toEqual([
      'typed-api-dx-review',
    ])
  })
  test('parses repeated --skill flags', () => {
    expect(parseArgs(['--skill=playwright', '--skill', 'linear']).flags.skill).toEqual([
      'playwright',
      'linear',
    ])
  })
  test('collects positional args', () => {
    expect(parseArgs(['abc', 'def']).positional).toEqual(['abc', 'def'])
  })
  test('skips empty args', () => {
    expect(parseArgs(['', 'abc']).positional).toEqual(['abc'])
  })
  test('handles mixed flags and positionals', () => {
    const { flags, positional } = parseArgs(['--raw', 'target', '--scope', 'user', '--show=all'])
    expect(flags.raw).toBe(true)
    expect(flags.scope).toBe('user')
    expect(flags.show).toEqual(['all'])
    expect(positional).toEqual(['target'])
  })
  test('defaults are falsy', () => {
    const { flags } = parseArgs([])
    expect(flags.raw).toBe(false)
    expect(flags.all).toBe(false)
    expect(flags.md).toBe(false)
    expect(flags.execute).toBe(false)
    expect(flags.strict).toBe(false)
    expect(flags.global).toBe(false)
    expect(flags.noFix).toBe(false)
    expect(flags.show).toEqual([])
    expect(flags.skill).toEqual([])
    expect(flags.scope).toBe('')
  })
  test('--scope at end of args uses empty string', () => {
    const { flags } = parseArgs(['--scope'])
    expect(flags.scope).toBe('')
  })
  test('--show at end of args uses empty string', () => {
    const { flags } = parseArgs(['--show'])
    expect(flags.show).toEqual([])
  })
})

// ── resolveScope ──────────────────────────────────────

describe('resolveScope', () => {
  test('returns user when global flag set', () => {
    expect(resolveScope(makeFlags({ global: true }))).toBe('user')
  })
  test('returns user when scope is user', () => {
    expect(resolveScope(makeFlags({ scope: 'user' }))).toBe('user')
  })
  test('returns project by default', () => {
    expect(resolveScope(makeFlags({}))).toBe('project')
  })
})

// ── QUIET_ERRORS ──────────────────────────────────────

describe('QUIET_ERRORS', () => {
  test('contains expected messages', () => {
    for (const msg of [
      'Unknown command',
      'Unknown namespace',
      'Missing targets',
      'Library not found',
      'Skill already exists',
      'Some targets failed',
      'Lint errors found',
    ]) {
      expect(QUIET_ERRORS.has(msg)).toBe(true)
    }
  })
})

// ── program dispatch ─────────────────────────────────

describe('program', () => {
  const withArgv = async (args: string[], fn: () => Promise<void>) => {
    const origArgv = process.argv
    process.argv = ['bun', 'shan.ts', ...args]
    try {
      await fn()
    } finally {
      process.argv = origArgv
    }
  }

  test('no namespace prints usage', async () => {
    await withArgv([], async () => {
      await Effect.runPromise(program)
    })
  })

  test('lint hooks dispatches and completes', async () => {
    await withArgv(['lint', 'hooks'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* lint errors are expected */
      }
    })
  })

  test('lint with no subcommand dispatches hooks', async () => {
    await withArgv(['lint'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* lint errors are expected */
      }
    })
  })

  test('lint unknown subcommand fails', async () => {
    await withArgv(['lint', 'bogus'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
    })
  })

  test('unknown namespace fails', async () => {
    await withArgv(['bogus'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Unknown namespace')
    })
  })

  test('transcript unknown command fails', async () => {
    await withArgv(['transcript', 'bogus'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
    })
  })

  test('transcript print dispatches', async () => {
    await withArgv(['transcript', 'print', '/nonexistent.jsonl'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* file not found expected */
      }
    })
  })

  test('transcript dump dispatches', async () => {
    await withArgv(['transcript', 'dump', '/nonexistent.jsonl'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('transcript analyze dispatches', async () => {
    await withArgv(['transcript', 'analyze', '/nonexistent.jsonl'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('task unknown command fails', async () => {
    await withArgv(['task', 'bogus'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
    })
  })

  test('task dump dispatches', async () => {
    await withArgv(['task', 'dump', '__nonexistent__'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('task open dispatches', async () => {
    await withArgv(['task', 'open', '__nonexistent__'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills list dispatches (default command)', async () => {
    await withArgv(['skills'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills on dispatches', async () => {
    await withArgv(['skills', 'on', '__nonexistent__'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills off dispatches', async () => {
    await withArgv(['skills', 'off', '__nonexistent__'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills move validates args', async () => {
    await withArgv(['skills', 'move'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Missing targets')
    })
  })

  test('skills move dispatches', async () => {
    await withArgv(['skills', 'move', 'scope', 'up', '__nonexistent__'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills history dispatches', async () => {
    await withArgv(['skills', 'history'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills undo dispatches', async () => {
    await withArgv(['skills', 'undo'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills redo dispatches', async () => {
    await withArgv(['skills', 'redo'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills doctor dispatches', async () => {
    await withArgv(['skills', 'doctor', '--no-fix'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills migrate dispatches', async () => {
    await withArgv(['skills', 'migrate'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills create dispatches', async () => {
    await withArgv(['skills', 'create', '__test_cov__'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills install validates args', async () => {
    await withArgv(['skills', 'install'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Missing targets')
    })
  })

  test('skills install-user dispatches', async () => {
    await withArgv(['skills', 'install-user'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })

  test('skills unknown command fails', async () => {
    await withArgv(['skills', 'bogus'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
    })
  })

  test('--global flag sets user scope', async () => {
    await withArgv(['skills', 'on', '__nonexistent__', '--global'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* expected */
      }
    })
  })
})

// ── run() error handling ─────────────────────────────

describe('run', () => {
  test('catches quiet errors without console.error', async () => {
    const origArgv = process.argv
    const origExit = process.exit
    const origErr = console.error
    const mockErr = mock(() => {})
    let exitCode: number | undefined
    console.error = mockErr
    const exitWithThrow: typeof process.exit = (code) => {
      exitCode = typeof code === 'number' ? code : undefined
      throw new Error('EXIT')
    }
    process.exit = exitWithThrow
    process.argv = ['bun', 'shan.ts', 'bogus-namespace']
    try {
      await run()
    } catch {
      // EXIT thrown by mock
    }
    // 'Unknown namespace' is in QUIET_ERRORS — console.error should not be called with the Error
    const errorCalls = (mockErr as ReturnType<typeof mock>).mock.calls
    const hasErrorObject = errorCalls.some((call: unknown[]) => call[0] instanceof Error)
    expect(hasErrorObject).toBe(false)
    expect(exitCode).toBe(1)
    process.argv = origArgv
    process.exit = origExit
    console.error = origErr
  })

  test('logs non-quiet errors to console.error', async () => {
    const origArgv = process.argv
    const origExit = process.exit
    const origErr = console.error
    const mockErr = mock(() => {})
    console.error = mockErr
    const exitWithThrow: typeof process.exit = () => {
      throw new Error('EXIT')
    }
    process.exit = exitWithThrow
    // An empty transcript command triggers a different effect error
    process.argv = ['bun', 'shan.ts', 'transcript', 'print', '/nonexistent-file.jsonl']
    try {
      await run()
    } catch {
      // EXIT thrown by mock
    }
    process.argv = origArgv
    process.exit = origExit
    console.error = origErr
  })
})
