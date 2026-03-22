import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../../')

// ── Test environment ─────────────────────────────────────

interface TestEnv {
  home: string
  project: string
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  writeUserSettings: (data: Record<string, unknown>) => Promise<void>
  writeProjectSettings: (data: Record<string, unknown>) => Promise<void>
  writeProjectLocalSettings: (data: Record<string, unknown>) => Promise<void>
  cleanup: () => Promise<void>
}

const setupTestEnv = async (): Promise<TestEnv> => {
  const base = await mkdtemp(path.join(tmpdir(), 'shan-lint-test.'))
  const home = path.join(base, 'home')
  const project = path.join(base, 'project')

  await mkdir(path.join(home, '.claude'), { recursive: true })
  await mkdir(path.join(project, '.claude'), { recursive: true })

  const run = async (args: string[]) => {
    const proc = Bun.spawn(['bun', 'run', path.join(repoRoot, 'src/bin/shan.ts'), ...args], {
      cwd: project,
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }

  const writeSettings = async (filePath: string, data: Record<string, unknown>) => {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(data, null, 2))
  }

  return {
    home,
    project,
    run,
    writeUserSettings: (data) => writeSettings(path.join(home, '.claude', 'settings.json'), data),
    writeProjectSettings: (data) => writeSettings(path.join(project, '.claude', 'settings.json'), data),
    writeProjectLocalSettings: (data) => writeSettings(path.join(project, '.claude', 'settings.local.json'), data),
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

// ── Tests ────────────────────────────────────────────────

describe('shan lint hooks', () => {
  test('passes when no settings files exist', async () => {
    const env = await setupTestEnv()
    // Remove the default dirs so no settings files are found
    await rm(path.join(env.home, '.claude'), { recursive: true, force: true })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('no settings files found')
    } finally {
      await env.cleanup()
    }
  })

  test('passes with empty settings', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({})
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  test('passes with tilde-prefixed hook path', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/scripts/foo.sh', timeout: 5 }] }],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  test('passes with absolute hook path', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/hook.sh', timeout: 5 }] },
        ],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  test('passes with $CLAUDE_PROJECT_DIR hook path', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/foo.sh', timeout: 5 }] },
        ],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  test('passes with bare command name (PATH-resolved)', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'jq .foo', timeout: 5 }] }],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  test('passes with statusLine using tilde path', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({
      statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  // ── Error cases ──────────────────────────────────────

  test('errors on relative hook path (.claude/...)', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/scripts/foo.sh', timeout: 10 }] }],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(1)
      expect(stdout).toContain('no-relative-hook-path')
      expect(stdout).toContain('.claude/hooks/scripts/foo.sh')
      expect(stdout).toContain('Relative path breaks')
    } finally {
      await env.cleanup()
    }
  })

  test('errors on relative hook path (./scripts/...)', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/guard.sh', timeout: 5 }] },
        ],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(1)
      expect(stdout).toContain('no-relative-hook-path')
      expect(stdout).toContain('./scripts/guard.sh')
    } finally {
      await env.cleanup()
    }
  })

  test('errors on relative path as argument to interpreter', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/check.js', timeout: 10 }] }],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(1)
      expect(stdout).toContain('no-relative-hook-path')
      expect(stdout).toContain('.claude/hooks/check.js')
    } finally {
      await env.cleanup()
    }
  })

  test('errors on relative statusLine command', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({
      statusLine: { type: 'command', command: 'scripts/statusline.sh' },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(1)
      expect(stdout).toContain('no-relative-hook-path')
      expect(stdout).toContain('statusLine')
    } finally {
      await env.cleanup()
    }
  })

  // ── Output quality ───────────────────────────────────

  test('includes happy paths in error output', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/foo.sh', timeout: 5 }] }],
      },
    })
    try {
      const { stdout } = await env.run(['lint', 'hooks'])
      expect(stdout).toContain('Happy paths:')
      expect(stdout).toContain('$CLAUDE_PROJECT_DIR prefix')
      expect(stdout).toContain('~ home-relative path')
      expect(stdout).toContain('Absolute path')
    } finally {
      await env.cleanup()
    }
  })

  test('includes GitHub issue references in error output', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/foo.sh', timeout: 5 }] }],
      },
    })
    try {
      const { stdout } = await env.run(['lint', 'hooks'])
      expect(stdout).toContain('References:')
      expect(stdout).toContain('github.com/anthropics/claude-code/issues/3583')
      expect(stdout).toContain('github.com/anthropics/claude-code/issues/4198')
      expect(stdout).toContain('github.com/anthropics/claude-code/issues/22343')
      expect(stdout).toContain('docs.anthropic.com/en/docs/claude-code/hooks')
    } finally {
      await env.cleanup()
    }
  })

  test('shows user-scoped happy paths for user settings errors', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'hooks/scripts/foo.sh', timeout: 5 }] }],
      },
    })
    try {
      const { stdout } = await env.run(['lint', 'hooks'])
      expect(stdout).toContain('~ home-relative path')
      // User settings should NOT suggest $CLAUDE_PROJECT_DIR
      expect(stdout).not.toContain('$CLAUDE_PROJECT_DIR prefix')
    } finally {
      await env.cleanup()
    }
  })

  test('reports correct finding count with multiple errors', async () => {
    const env = await setupTestEnv()
    await env.writeProjectSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/a.sh', timeout: 5 }] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'scripts/b.sh', timeout: 5 }],
          },
        ],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(1)
      expect(stdout).toContain('2 errors')
    } finally {
      await env.cleanup()
    }
  })

  // ── Multiple file scopes ─────────────────────────────

  test('checks project-local settings too', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({})
    await env.writeProjectSettings({})
    await env.writeProjectLocalSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'local/hook.sh', timeout: 5 }] }],
      },
    })
    try {
      const { stdout, exitCode } = await env.run(['lint', 'hooks'])
      expect(exitCode).toBe(1)
      expect(stdout).toContain('no-relative-hook-path')
      expect(stdout).toContain('local/hook.sh')
    } finally {
      await env.cleanup()
    }
  })
})

describe('shan lint (bare)', () => {
  test('runs all rules when no subcommand given', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({})
    try {
      const { stdout, exitCode } = await env.run(['lint'])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('all clear')
    } finally {
      await env.cleanup()
    }
  })

  test('unknown lint subcommand errors', async () => {
    const env = await setupTestEnv()
    await env.writeUserSettings({})
    try {
      const { stderr, exitCode } = await env.run(['lint', 'nonexistent'])
      expect(exitCode).toBe(1)
      expect(stderr).toContain('Unknown lint command')
    } finally {
      await env.cleanup()
    }
  })
})
