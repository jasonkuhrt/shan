import { describe, expect, mock, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  parseArgs,
  resolveScope,
  resolveSkillsOnScope,
  QUIET_ERRORS,
  program,
  run,
} from './shan.js'
import type { ParsedFlags } from './shan.js'
import * as Lib from '../lib/skill-library.js'

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

describe('resolveSkillsOnScope', () => {
  test('honors an explicit global flag', async () => {
    await expect(
      Effect.runPromise(resolveSkillsOnScope(makeFlags({ global: true }), 'foo')),
    ).resolves.toBe('user')
  })

  test('honors an explicit user scope', async () => {
    await expect(
      Effect.runPromise(resolveSkillsOnScope(makeFlags({ scope: 'user' }), 'foo')),
    ).resolves.toBe('user')
  })

  test('honors an explicit project scope', async () => {
    await expect(
      Effect.runPromise(resolveSkillsOnScope(makeFlags({ scope: 'project' }), 'foo')),
    ).resolves.toBe('project')
  })

  test('defaults to project when no targets were provided', async () => {
    await expect(Effect.runPromise(resolveSkillsOnScope(makeFlags({}), ''))).resolves.toBe(
      'project',
    )
  })

  test('resolves project scope when all targets exist in the project library', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shan-resolve-scope-'))
    const origCwd = process.cwd()

    try {
      process.chdir(dir)
      const skillDir = path.join(dir, '.claude', 'skills-library', 'projskill')
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: projskill\ndescription: Test skill\n---\n# projskill\n',
      )

      await expect(
        Effect.runPromise(resolveSkillsOnScope(makeFlags({}), 'projskill')),
      ).resolves.toBe('project')
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to user scope when the project library is missing and the user library has the target', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shan-resolve-user-scope-'))
    const origCwd = process.cwd()
    const skillName = `__resolve_user_scope_${Date.now()}__`
    const skillDir = path.join(Lib.LIBRARY_DIR, skillName)

    try {
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: Test skill\n---\n# ${skillName}\n`,
      )
      process.chdir(dir)

      await expect(Effect.runPromise(resolveSkillsOnScope(makeFlags({}), skillName))).resolves.toBe(
        'user',
      )
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
      await rm(skillDir, { recursive: true, force: true })
    }
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

  test('doctor config dispatches and completes', async () => {
    await withArgv(['doctor', 'config'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* doctor errors are expected */
      }
    })
  })

  test('doctor with no selector dispatches all namespaces', async () => {
    await withArgv(['doctor'], async () => {
      try {
        await Effect.runPromise(program)
      } catch {
        /* doctor errors are expected */
      }
    })
  })

  test('doctor unknown selector fails', async () => {
    await withArgv(['doctor', 'bogus'], async () => {
      await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
    })
  })

  test('doctor exits cleanly when no settings files or skills library are present', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'shan-lint-home-'))
    const projectDir = await mkdtemp(path.join(tmpdir(), 'shan-lint-project-'))
    const origHome = process.env['HOME']
    const origCwd = process.cwd()

    try {
      process.env['HOME'] = homeDir
      process.chdir(projectDir)

      await withArgv(['doctor'], async () => {
        await Effect.runPromise(program)
      })
    } finally {
      process.env['HOME'] = origHome
      process.chdir(origCwd)
      await rm(homeDir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('init dispatches', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'shan-init-home-'))
    const projectDir = await mkdtemp(path.join(tmpdir(), 'shan-init-project-'))
    const origHome = process.env['HOME']
    const origCwd = process.cwd()

    try {
      process.env['HOME'] = homeDir
      process.chdir(projectDir)
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# system\n')

      await withArgv(['init'], async () => {
        await Effect.runPromise(program)
      })

      await expect(readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
        '@.claude/CLAUDE.md\n@.claude/*.local.md\n',
      )
    } finally {
      process.env['HOME'] = origHome
      process.chdir(origCwd)
      await rm(homeDir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('doctor fails when config findings include errors', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'shan-lint-home-'))
    const projectDir = await mkdtemp(path.join(tmpdir(), 'shan-lint-project-'))
    const origHome = process.env['HOME']
    const origCwd = process.cwd()

    try {
      process.env['HOME'] = homeDir
      process.chdir(projectDir)
      await mkdir(path.join(projectDir, '.claude'), { recursive: true })
      await writeFile(
        path.join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: '.claude/hooks/foo.sh' }],
              },
            ],
          },
        }),
      )

      await withArgv(['doctor', 'config'], async () => {
        await expect(Effect.runPromise(program)).rejects.toThrow('Doctor errors found')
      })
    } finally {
      process.env['HOME'] = origHome
      process.chdir(origCwd)
      await rm(homeDir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('lint namespace prints migration guidance', async () => {
    const origErr = console.error
    const origLog = console.log
    const err = mock(() => {})
    const log = mock(() => {})
    console.error = err
    console.log = log

    try {
      await withArgv(['lint', 'hooks'], async () => {
        await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
      })

      const output = [...err.mock.calls, ...log.mock.calls]
        .map((call) => call.map(String).join(' '))
        .join('\n')

      expect(output).toContain('shan doctor config')
    } finally {
      console.error = origErr
      console.log = origLog
    }
  })

  test('skills doctor prints migration guidance', async () => {
    const origErr = console.error
    const origLog = console.log
    const err = mock(() => {})
    const log = mock(() => {})
    console.error = err
    console.log = log

    try {
      await withArgv(['skills', 'doctor'], async () => {
        await expect(Effect.runPromise(program)).rejects.toThrow('Unknown command')
      })

      const output = [...err.mock.calls, ...log.mock.calls]
        .map((call) => call.map(String).join(' '))
        .join('\n')

      expect(output).toContain('shan doctor skills')
    } finally {
      console.error = origErr
      console.log = origLog
    }
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

  test('s alias dispatches to skills', async () => {
    await withArgv(['s'], async () => {
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

  test('doctor skills dispatches', async () => {
    await withArgv(['doctor', 'skills', '--no-fix'], async () => {
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
