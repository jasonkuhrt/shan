import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
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
