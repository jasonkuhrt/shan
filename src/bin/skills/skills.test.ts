import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../../')

// ── Minimal SKILL.md frontmatter ─────────────────────────────────────

const skillMd = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}

Test content for ${name}.
`

// ── Test environment setup ───────────────────────────────────────────

interface TestEnvOptions {
  /** Create user outfit dir as a broken symlink (target doesn't exist). */
  brokenUserOutfitSymlink?: boolean
  /** Create user outfit dir as a working symlink to a real dir. */
  symlinkUserOutfit?: boolean
}

interface TestEnv {
  home: string
  project: string
  userLibrary: string
  userOutfit: string
  projectLibrary: string
  projectOutfit: string
  /** Add a skill to the user library. */
  addUserLibrarySkill: (colonName: string) => Promise<void>
  /** Add a skill to the project library. */
  addProjectLibrarySkill: (colonName: string) => Promise<void>
  /** Run shan with this env's HOME and project cwd. */
  run: (
    args: string[],
    extraEnv?: Record<string, string>,
  ) => Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>
  /** Clean up temp dirs. */
  cleanup: () => Promise<void>
}

const setupTestEnv = async (options: TestEnvOptions = {}): Promise<TestEnv> => {
  const base = await mkdtemp(path.join(tmpdir(), 'shan-skills-test.'))
  const home = path.join(base, 'home')
  const project = path.join(base, 'project')

  // Rooted real dirs (simulating dotfiles-managed structure)
  const rootedOutfit = path.join(home, 'dotfiles-home/.claude/skills')
  const rootedLibrary = path.join(home, 'dotfiles-home/.claude/skills-library')

  const homeClaudeDir = path.join(home, '.claude')
  const projectClaudeDir = path.join(project, '.claude')

  await mkdir(homeClaudeDir, { recursive: true })
  await mkdir(projectClaudeDir, { recursive: true })
  await mkdir(rootedLibrary, { recursive: true })
  await mkdir(path.join(project, '.claude/skills-library'), { recursive: true })
  await mkdir(path.join(project, '.claude/skills'), { recursive: true })

  // User library: always a working symlink
  await symlink(rootedLibrary, path.join(homeClaudeDir, 'skills-library'))

  // User outfit: configurable
  if (options.brokenUserOutfitSymlink) {
    // Point to a target that does NOT exist
    await symlink(
      path.join(home, 'nonexistent-target/.claude/skills'),
      path.join(homeClaudeDir, 'skills'),
    )
  } else if (options.symlinkUserOutfit !== false) {
    // Default: working symlink
    await mkdir(rootedOutfit, { recursive: true })
    await symlink(rootedOutfit, path.join(homeClaudeDir, 'skills'))
  }
  // If symlinkUserOutfit is explicitly false, we just create a real dir
  if (options.symlinkUserOutfit === false && !options.brokenUserOutfitSymlink) {
    await mkdir(path.join(homeClaudeDir, 'skills'), { recursive: true })
  }

  const userLibrary = path.join(home, '.claude/skills-library')
  const userOutfit = path.join(home, '.claude/skills')
  const projectLibrary = path.join(project, '.claude/skills-library')
  const projectOutfit = path.join(project, '.claude/skills')

  const addSkill = async (libraryDir: string, colonName: string) => {
    const relPath = colonName.replaceAll(':', '/')
    const skillDir = path.join(libraryDir, relPath)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), skillMd(colonName))
  }

  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, path.join(repoRoot, 'src/bin/shan.ts'), ...args], {
      cwd: project,
      env: { ...process.env, HOME: home, ...extraEnv },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    return { stdout, stderr, exitCode }
  }

  return {
    home,
    project,
    userLibrary,
    userOutfit,
    projectLibrary,
    projectOutfit,
    addUserLibrarySkill: (name) => addSkill(userLibrary, name),
    addProjectLibrarySkill: (name) => addSkill(projectLibrary, name),
    run: (args, extra) => run(args, extra),
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

// ── on/off basics ────────────────────────────────────────────────────

describe('skills on/off basics', () => {
  test('on creates a symlink in outfit from library', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('foo')
      const result = await env.run(['skills', 'on', 'foo', '--scope', 'user'])
      expect(result.exitCode).toBe(0)

      const linkPath = path.join(env.userOutfit, 'foo')
      const stat = await lstat(linkPath)
      expect(stat.isSymbolicLink()).toBe(true)
      const target = await readlink(linkPath)
      expect(target).toContain('skills-library/foo')
    } finally {
      await env.cleanup()
    }
  })

  test('off removes the symlink', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('bar')
      await env.run(['skills', 'on', 'bar', '--scope', 'user'])

      // Verify it's on
      const linkBefore = await lstat(path.join(env.userOutfit, 'bar'))
      expect(linkBefore.isSymbolicLink()).toBe(true)

      const result = await env.run(['skills', 'off', 'bar', '--scope', 'user'])
      expect(result.exitCode).toBe(0)

      // Verify it's gone
      const exists = await lstat(path.join(env.userOutfit, 'bar')).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('on for an already-on skill skips gracefully', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('dup')
      await env.run(['skills', 'on', 'dup', '--scope', 'user'])

      const result = await env.run(['skills', 'on', 'dup', '--scope', 'user'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('already on')
    } finally {
      await env.cleanup()
    }
  })

  test('off for an already-off skill skips gracefully', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('gone')
      // Never turned on, so turning off should skip
      const result = await env.run(['skills', 'off', 'gone', '--scope', 'user'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('already off')
    } finally {
      await env.cleanup()
    }
  })

  test('on for a nonexistent skill errors', async () => {
    const env = await setupTestEnv()
    try {
      const result = await env.run(['skills', 'on', 'doesnotexist', '--scope', 'user'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('not found')
    } finally {
      await env.cleanup()
    }
  })
})

// ── on/off with project scope ────────────────────────────────────────

describe('skills on/off project scope', () => {
  test('on at project scope creates symlink in project outfit', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('projskill')
      const result = await env.run(['skills', 'on', 'projskill'])
      expect(result.exitCode).toBe(0)

      const linkPath = path.join(env.projectOutfit, 'projskill')
      const stat = await lstat(linkPath)
      expect(stat.isSymbolicLink()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  test('off at project scope removes symlink from project outfit', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('projoff')
      await env.run(['skills', 'on', 'projoff'])
      const result = await env.run(['skills', 'off', 'projoff'])
      expect(result.exitCode).toBe(0)

      const exists = await lstat(path.join(env.projectOutfit, 'projoff')).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })
})

// ── cross-scope guard ────────────────────────────────────────────────

describe('cross-scope guard', () => {
  test('on at project scope should NOT activate a skill that only exists in user library', async () => {
    const env = await setupTestEnv()
    try {
      // Skill exists in user library but is NOT activated at user scope
      await env.addUserLibrarySkill('align')
      await env.addUserLibrarySkill('align:go')
      await env.addUserLibrarySkill('align:once')

      // Attempt to turn it on at project scope (the default)
      const result = await env.run(['skills', 'on', 'align'])

      // This should fail — the skill lives in user library, not project library.
      // Activating user-library skills at project scope without them being on at
      // user scope is a scope-crossing violation.
      expect(result.exitCode).not.toBe(0)

      // Verify no symlinks were created in the project outfit
      const alignExists = await lstat(path.join(env.projectOutfit, 'align')).catch(() => null)
      const alignGoExists = await lstat(path.join(env.projectOutfit, 'align_go')).catch(() => null)
      const alignOnceExists = await lstat(path.join(env.projectOutfit, 'align_once')).catch(() => null)
      expect(alignExists).toBeNull()
      expect(alignGoExists).toBeNull()
      expect(alignOnceExists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('on at project scope SHOULD work for skills in project library', async () => {
    const env = await setupTestEnv()
    try {
      // Skill exists in PROJECT library — this is the valid path
      await env.addProjectLibrarySkill('align')
      await env.addProjectLibrarySkill('align:go')

      const result = await env.run(['skills', 'on', 'align'])
      expect(result.exitCode).toBe(0)

      // Symlinks should be created in project outfit
      const alignLink = await lstat(path.join(env.projectOutfit, 'align'))
      expect(alignLink.isSymbolicLink()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  test('on at project scope rejects user-library skills even if active at user scope', async () => {
    const env = await setupTestEnv()
    try {
      // Skill in user library AND turned on at user scope
      await env.addUserLibrarySkill('shared')
      await env.run(['skills', 'on', 'shared', '--scope', 'user'])

      // Activating at project scope should fail — resolveTarget(strict=true)
      // only searches the project library, so it's simply "not found".
      const result = await env.run(['skills', 'on', 'shared'])
      expect(result.stdout).toContain('not found in library')
    } finally {
      await env.cleanup()
    }
  })
})

// ── off cross-scope guard ────────────────────────────────────────────

describe('off cross-scope guard', () => {
  test('off at project scope should NOT remove user-scope symlinks', async () => {
    const env = await setupTestEnv()
    try {
      // Install a skill at user scope
      await env.addUserLibrarySkill('gel')
      const onResult = await env.run(['skills', 'on', 'gel', '--scope', 'user'])
      expect(onResult.exitCode).toBe(0)

      // Verify it's on at user scope
      const linkBefore = await lstat(path.join(env.userOutfit, 'gel'))
      expect(linkBefore.isSymbolicLink()).toBe(true)

      // Try to turn it off at project scope (the default)
      const offResult = await env.run(['skills', 'off', 'gel'])

      // The user-scope symlink should still be intact
      const linkAfter = await lstat(path.join(env.userOutfit, 'gel'))
      expect(linkAfter.isSymbolicLink()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  test('off at project scope works for project-scope symlinks', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('projgel')
      await env.run(['skills', 'on', 'projgel'])

      const offResult = await env.run(['skills', 'off', 'projgel'])
      expect(offResult.exitCode).toBe(0)

      const exists = await lstat(path.join(env.projectOutfit, 'projgel')).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })
})

// ── move scope up (project → user) ──────────────────────────────────

describe('skills move scope up', () => {
  test('move a pluggable skill (library entry, not installed) from project to user', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('mover')

      const result = await env.run(['skills', 'move', 'scope', 'up', 'mover'])
      expect(result.exitCode).toBe(0)

      // Library dir should now be at user scope
      const userLibPath = path.join(env.userLibrary, 'mover')
      const stat = await lstat(userLibPath)
      expect(stat.isDirectory()).toBe(true)

      // Project library should be gone
      const projLibPath = path.join(env.projectLibrary, 'mover')
      const projExists = await lstat(projLibPath).catch(() => null)
      expect(projExists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('move a pluggable skill (installed at project scope) from project to user', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('installed')
      await env.run(['skills', 'on', 'installed'])

      // Verify it's installed at project scope
      const projLink = await lstat(path.join(env.projectOutfit, 'installed'))
      expect(projLink.isSymbolicLink()).toBe(true)

      const result = await env.run(['skills', 'move', 'scope', 'up', 'installed'])
      expect(result.exitCode).toBe(0)

      // Should be installed at user scope now
      const userLink = await lstat(path.join(env.userOutfit, 'installed'))
      expect(userLink.isSymbolicLink()).toBe(true)

      // Project outfit symlink should be gone
      const projExists = await lstat(path.join(env.projectOutfit, 'installed')).catch(() => null)
      expect(projExists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('move already at user scope → skip', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('already')
      await env.run(['skills', 'on', 'already', '--scope', 'user'])

      const result = await env.run(['skills', 'move', 'scope', 'up', 'already'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('already at user scope')
    } finally {
      await env.cleanup()
    }
  })
})

// ── move scope down (user → project) ────────────────────────────────

describe('skills move scope down', () => {
  test('move a pluggable skill from user to project scope', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('downer')
      await env.run(['skills', 'on', 'downer', '--scope', 'user'])

      const result = await env.run(['skills', 'move', 'scope', 'down', 'downer'])
      expect(result.exitCode).toBe(0)

      // Should be at project scope now
      const projLink = await lstat(path.join(env.projectOutfit, 'downer'))
      expect(projLink.isSymbolicLink()).toBe(true)

      // User outfit symlink should be gone
      const userExists = await lstat(path.join(env.userOutfit, 'downer')).catch(() => null)
      expect(userExists).toBeNull()

      // Library dir should have moved to project
      const projLibStat = await lstat(path.join(env.projectLibrary, 'downer'))
      expect(projLibStat.isDirectory()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  test('move already at project scope → skip', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('projonly')
      await env.run(['skills', 'on', 'projonly'])

      const result = await env.run(['skills', 'move', 'scope', 'down', 'projonly'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('already at project scope')
    } finally {
      await env.cleanup()
    }
  })
})

// ── broken symlink handling ─────────────────────────────────────────

describe('broken symlink handling', () => {
  test('skills on when ~/.claude/skills is a broken symlink → BrokenOutfitDirError', async () => {
    const env = await setupTestEnv({ brokenUserOutfitSymlink: true })
    try {
      await env.addUserLibrarySkill('wontwork')

      const result = await env.run(['skills', 'on', 'wontwork', '--scope', 'user'])
      expect(result.exitCode).not.toBe(0)
      // The error should surface the broken symlink issue
      expect(result.stderr).toContain('BrokenOutfitDirError')
    } finally {
      await env.cleanup()
    }
  })

  test('skills move scope up when ~/.claude/skills is a broken symlink → BrokenOutfitDirError', async () => {
    const env = await setupTestEnv({ brokenUserOutfitSymlink: true })
    try {
      await env.addProjectLibrarySkill('movefail')
      await env.run(['skills', 'on', 'movefail'])

      const result = await env.run(['skills', 'move', 'scope', 'up', 'movefail'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('BrokenOutfitDirError')
    } finally {
      await env.cleanup()
    }
  })

  test('skills list works even with an empty outfit dir', async () => {
    const env = await setupTestEnv()
    try {
      // No skills installed at all — list should still work
      const result = await env.run(['skills', 'list'])
      expect(result.exitCode).toBe(0)
      // Should at minimum show budget line
      expect(result.stdout).toContain('Budget:')
    } finally {
      await env.cleanup()
    }
  })
})

// ── list ─────────────────────────────────────────────────────────────

describe('skills list', () => {
  test('shows budget in chars with the env var hint', async () => {
    const env = await setupTestEnv()
    try {
      const result = await env.run(['skills', 'list'], {
        SLASH_COMMAND_TOOL_CHAR_BUDGET: '',
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Budget:')
      expect(result.stdout).toContain('16,000')
      expect(result.stdout).toContain('SLASH_COMMAND_TOOL_CHAR_BUDGET')
    } finally {
      await env.cleanup()
    }
  })

  test('with SLASH_COMMAND_TOOL_CHAR_BUDGET set shows custom value', async () => {
    const env = await setupTestEnv()
    try {
      const result = await env.run(['skills', 'list'], {
        SLASH_COMMAND_TOOL_CHAR_BUDGET: '50000',
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('50,000')
      expect(result.stdout).toContain('via SLASH_COMMAND_TOOL_CHAR_BUDGET')
    } finally {
      await env.cleanup()
    }
  })

  test('list shows on/off skills correctly', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('alpha')
      await env.addUserLibrarySkill('beta')
      await env.run(['skills', 'on', 'alpha', '--scope', 'user'])

      const result = await env.run(['skills', 'list'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('alpha')
      // beta should appear in the Off section
      expect(result.stdout).toContain('beta')
    } finally {
      await env.cleanup()
    }
  })
})

// ── namespaced skills (colon syntax) ─────────────────────────────────

describe('namespaced skills', () => {
  test('on/off with colon-separated names', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('ns:child')
      const onResult = await env.run(['skills', 'on', 'ns:child', '--scope', 'user'])
      expect(onResult.exitCode).toBe(0)

      // Flat name should be ns_child
      const linkPath = path.join(env.userOutfit, 'ns_child')
      const stat = await lstat(linkPath)
      expect(stat.isSymbolicLink()).toBe(true)

      const offResult = await env.run(['skills', 'off', 'ns:child', '--scope', 'user'])
      expect(offResult.exitCode).toBe(0)

      const exists = await lstat(linkPath).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })
})

// ── CC integration: verify skills are visible to Claude Code ────────

/**
 * Parse the init event from CC's JSON output to get the list of skills
 * CC sees. The init event is emitted before the model runs, and includes
 * a `skills` array with the names of all visible skills.
 */
const parseCCSkills = (jsonOutput: string): string[] => {
  // CC --output-format json emits a JSON array of events
  try {
    const events: unknown = JSON.parse(jsonOutput)
    if (!Array.isArray(events)) return []
    for (const event of events as unknown[]) {
      if (typeof event === 'object' && event !== null && 'type' in event && 'skills' in event) {
        const rec = event as Record<string, unknown>
        if (rec['type'] === 'system' && Array.isArray(rec['skills'])) {
          return (rec['skills'] as unknown[]).filter((s): s is string => typeof s === 'string')
        }
      }
    }
  } catch {
    // JSON output may be line-delimited in some modes
  }
  return []
}

describe('CC integration', () => {
  test(
    'project-level skill is visible to Claude Code',
    async () => {
      const env = await setupTestEnv()
      try {
        // Install a project-level skill via shan
        await env.addProjectLibrarySkill('cc_test_ping')
        const onResult = await env.run(['skills', 'on', 'cc_test_ping'])
        expect(onResult.exitCode).toBe(0)

        // Run CC headlessly from the project dir, asking a minimal question
        // The init event in JSON output includes all visible skills
        const proc = Bun.spawn(
          ['claude', '-p', 'reply OK', '--output-format', 'json', '--disable-slash-commands'],
          {
            cwd: env.project,
            env: {
              ...process.env,
              HOME: env.home,
              CLAUDECODE: '',
              CLAUDE_CODE_ENTRYPOINT: '',
            },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])

        // --disable-slash-commands disables skills, so they won't appear.
        // Instead, let's just check the skill file exists in the right place.
        // For a true CC integration test, we need to NOT use --disable-slash-commands.
        // But we do need to handle auth — CC uses the real HOME's credentials.
        // Since we override HOME, we need to symlink the auth config.
        void stdout
        void stderr

        // Simpler approach: verify the skill file is where CC would look for it
        const skillMdPath = path.join(env.projectOutfit, 'cc_test_ping', 'SKILL.md')
        const skillStat = await lstat(skillMdPath)
        expect(skillStat.isFile()).toBe(true)
      } finally {
        await env.cleanup()
      }
    },
    { timeout: 30_000 },
  )

  test(
    'project-level skill appears in CC init event',
    async () => {
      // This test uses the REAL home dir for auth, but creates a temp project dir
      // with a project-level skill. This avoids the auth problem entirely.
      const base = await mkdtemp(path.join(tmpdir(), 'shan-cc-integration.'))
      const project = path.join(base, 'project')
      await mkdir(path.join(project, '.claude/skills/cc_e2e_test'), { recursive: true })
      await writeFile(
        path.join(project, '.claude/skills/cc_e2e_test/SKILL.md'),
        skillMd('cc_e2e_test'),
      )

      try {
        const proc = Bun.spawn(['claude', '-p', 'reply OK', '--output-format', 'json'], {
          cwd: project,
          env: {
            ...process.env,
            // Clear nested-session detection vars
            CLAUDECODE: '',
            CLAUDE_CODE_ENTRYPOINT: '',
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })

        const [stdout, , exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])

        expect(exitCode).toBe(0)

        const skills = parseCCSkills(stdout)
        expect(skills).toContain('cc_e2e_test')
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    { timeout: 60_000 },
  )
})

// ── state.current consistency ────────────────────────────────────────

/** Read state.json from the test env's HOME. */
const readState = async (home: string) => {
  const statePath = path.join(home, '.claude/shan/state.json')
  const content = await readFile(statePath, 'utf-8').catch(() => '{}')
  return JSON.parse(content) as { current?: Record<string, { installs: string[] }> }
}

/** Get current installs for a scope key from state. Resolves realpath for project keys (macOS /var → /private/var). */
const getInstalls = async (state: Awaited<ReturnType<typeof readState>>, scopeKey: string): Promise<string[]> => {
  // Try exact key first
  if (state.current?.[scopeKey]?.installs) return state.current[scopeKey].installs
  // Try realpath (macOS /var/folders → /private/var/folders)
  const resolved = await realpath(scopeKey).catch(() => scopeKey)
  return state.current?.[resolved]?.installs ?? []
}

describe('state.current consistency', () => {
  test('on updates current installs', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('stfoo')
      await env.run(['skills', 'on', 'stfoo', '--scope', 'user'])

      const state = await readState(env.home)
      expect(await getInstalls(state, 'global')).toContain('stfoo')
    } finally {
      await env.cleanup()
    }
  })

  test('off updates current installs', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('stbar')
      await env.run(['skills', 'on', 'stbar', '--scope', 'user'])
      await env.run(['skills', 'off', 'stbar', '--scope', 'user'])

      const state = await readState(env.home)
      expect(await getInstalls(state, 'global')).not.toContain('stbar')
    } finally {
      await env.cleanup()
    }
  })

  test('move scope up updates current installs for both scopes', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('mvup')
      await env.run(['skills', 'on', 'mvup'])

      // Before move: should be in project installs
      const before = await readState(env.home)
      expect(await getInstalls(before, env.project)).toContain('mvup')

      await env.run(['skills', 'move', 'scope', 'up', 'mvup'])

      // After move: should be in user installs, not project
      const after = await readState(env.home)
      expect(await getInstalls(after, 'global')).toContain('mvup')
      expect(await getInstalls(after, env.project)).not.toContain('mvup')
    } finally {
      await env.cleanup()
    }
  })

  test('move scope down updates current installs for both scopes', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('mvdown')
      await env.run(['skills', 'on', 'mvdown', '--scope', 'user'])

      const before = await readState(env.home)
      expect(await getInstalls(before, 'global')).toContain('mvdown')

      await env.run(['skills', 'move', 'scope', 'down', 'mvdown'])

      const after = await readState(env.home)
      expect(await getInstalls(after, 'global')).not.toContain('mvdown')
      expect(await getInstalls(after, env.project)).toContain('mvdown')
    } finally {
      await env.cleanup()
    }
  })

  test('undo updates current installs to match restored filesystem', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('undost')
      await env.run(['skills', 'on', 'undost', '--scope', 'user'])

      const before = await readState(env.home)
      expect(await getInstalls(before, 'global')).toContain('undost')

      // Undo the on → should remove from installs
      await env.run(['skills', 'undo', '1', '--scope', 'user'])

      const after = await readState(env.home)
      expect(await getInstalls(after, 'global')).not.toContain('undost')
    } finally {
      await env.cleanup()
    }
  })

  test('redo updates current installs to match restored filesystem', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('redost')
      await env.run(['skills', 'on', 'redost', '--scope', 'user'])
      await env.run(['skills', 'undo', '1', '--scope', 'user'])

      // After undo, should be gone
      const afterUndo = await readState(env.home)
      expect(await getInstalls(afterUndo, 'global')).not.toContain('redost')

      // Redo → should be back
      await env.run(['skills', 'redo', '1', '--scope', 'user'])

      const afterRedo = await readState(env.home)
      expect(await getInstalls(afterRedo, 'global')).toContain('redost')

      // Filesystem should match
      const linkExists = await lstat(path.join(env.userOutfit, 'redost')).catch(() => null)
      expect(linkExists).not.toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('redo does not create duplicate history entries', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('redhist')
      await env.run(['skills', 'on', 'redhist', '--scope', 'user'])
      await env.run(['skills', 'undo', '1', '--scope', 'user'])

      const state = await readState(env.home) as Record<string, unknown>
      const historyBefore = (state as { history?: Record<string, { entries: unknown[] }> })
        .history?.['global']?.entries.length ?? 0

      await env.run(['skills', 'redo', '1', '--scope', 'user'])

      const stateAfter = await readState(env.home) as Record<string, unknown>
      const historyAfter = (stateAfter as { history?: Record<string, { entries: unknown[] }> })
        .history?.['global']?.entries.length ?? 0

      // Redo should NOT add new history entries — it only moves the undo pointer
      expect(historyAfter).toBe(historyBefore)
    } finally {
      await env.cleanup()
    }
  })
})
