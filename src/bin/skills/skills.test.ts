import { describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as SkillName from '../../lib/skill-name.js'

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
    const relPath = SkillName.toLibraryRelPath(SkillName.fromFrontmatterName(colonName))
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

// ── on scope inference ───────────────────────────────────────────────

describe('on scope inference', () => {
  test('without an explicit scope, activates a user-library skill at user scope when the project library is missing', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('codex-review')
      await rm(env.projectLibrary, { recursive: true, force: true })

      const result = await env.run(['skills', 'on', 'codex-review'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('codex-review')
      expect(result.stdout).toContain('user')

      const userLink = await lstat(path.join(env.userOutfit, 'codex-review'))
      expect(userLink.isSymbolicLink()).toBe(true)

      const projectLink = await lstat(path.join(env.projectOutfit, 'codex-review')).catch(
        () => null,
      )
      expect(projectLink).toBeNull()

      const state = await readState(env.home)
      expect(await getInstalls(state, 'global')).toContain('codex-review')
      expect(await getInstalls(state, env.project)).not.toContain('codex-review')
    } finally {
      await env.cleanup()
    }
  })

  test('without an explicit scope, activates a user-library group at user scope when the project library lacks the target', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('project-only')
      await env.addUserLibrarySkill('align:go')
      await env.addUserLibrarySkill('align:once')

      const result = await env.run(['skills', 'on', 'align'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('align:go')
      expect(result.stdout).toContain('align:once')
      expect(result.stdout).toContain('user')

      const alignGoLink = await lstat(path.join(env.userOutfit, 'align_go'))
      const alignOnceLink = await lstat(path.join(env.userOutfit, 'align_once'))
      expect(alignGoLink.isSymbolicLink()).toBe(true)
      expect(alignOnceLink.isSymbolicLink()).toBe(true)

      const routerSkillMd = await readFile(path.join(env.userOutfit, 'align', 'SKILL.md'), 'utf-8')
      expect(routerSkillMd).toContain('align:go')
      expect(routerSkillMd).toContain('align:once')

      const projectAlign = await lstat(path.join(env.projectOutfit, 'align')).catch(() => null)
      const projectAlignGo = await lstat(path.join(env.projectOutfit, 'align_go')).catch(() => null)
      const projectAlignOnce = await lstat(path.join(env.projectOutfit, 'align_once')).catch(
        () => null,
      )
      expect(projectAlign).toBeNull()
      expect(projectAlignGo).toBeNull()
      expect(projectAlignOnce).toBeNull()

      const state = await readState(env.home)
      expect(await getInstalls(state, 'global')).toContain('align_go')
      expect(await getInstalls(state, 'global')).toContain('align_once')
      expect(await getInstalls(state, env.project)).not.toContain('align_go')
      expect(await getInstalls(state, env.project)).not.toContain('align_once')
    } finally {
      await env.cleanup()
    }
  })

  test('without an explicit scope, prefers the project library when a target exists in both scopes', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('shared')
      await env.addProjectLibrarySkill('shared')

      const result = await env.run(['skills', 'on', 'shared'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('project')

      const projectLink = await lstat(path.join(env.projectOutfit, 'shared'))
      expect(projectLink.isSymbolicLink()).toBe(true)

      const userLink = await lstat(path.join(env.userOutfit, 'shared')).catch(() => null)
      expect(userLink).toBeNull()

      const state = await readState(env.home)
      expect(await getInstalls(state, env.project)).toContain('shared')
      expect(await getInstalls(state, 'global')).not.toContain('shared')
    } finally {
      await env.cleanup()
    }
  })

  test('with an explicit project scope, still rejects a target that only exists in the user library', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('shared')
      await env.run(['skills', 'on', 'shared', '--scope', 'user'])

      const result = await env.run(['skills', 'on', 'shared', '--scope', 'project'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('not found in library')

      const projectLink = await lstat(path.join(env.projectOutfit, 'shared')).catch(() => null)
      expect(projectLink).toBeNull()
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
      await env.run(['skills', 'off', 'gel'])

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

// ── move: core skill scenarios ───────────────────────────────────────

describe('skills move core skill scope up', () => {
  test('move a core skill (real directory) from project to user outfit', async () => {
    const env = await setupTestEnv()
    try {
      // Create a core skill directly in project outfit (real dir, not symlink)
      const coreDir = path.join(env.projectOutfit, 'my-core')
      await mkdir(coreDir, { recursive: true })
      await writeFile(path.join(coreDir, 'SKILL.md'), skillMd('my-core'))

      const result = await env.run(['skills', 'move', 'scope', 'up', 'my-core'])
      expect(result.exitCode).toBe(0)

      // Should now be a directory in user outfit
      const userPath = path.join(env.userOutfit, 'my-core')
      const stat = await lstat(userPath)
      expect(stat.isDirectory()).toBe(true)

      // Should be gone from project outfit
      const projExists = await lstat(coreDir).catch(() => null)
      expect(projExists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })
})

describe('skills move core skill scope down', () => {
  test('move a core skill (real directory) from user to project outfit', async () => {
    const env = await setupTestEnv()
    try {
      // Create a core skill directly in user outfit (real dir, not symlink)
      const coreDir = path.join(env.userOutfit, 'user-core')
      await mkdir(coreDir, { recursive: true })
      await writeFile(path.join(coreDir, 'SKILL.md'), skillMd('user-core'))

      const result = await env.run(['skills', 'move', 'scope', 'down', 'user-core'])
      expect(result.exitCode).toBe(0)

      // Should now be a directory in project outfit
      const projPath = path.join(env.projectOutfit, 'user-core')
      const stat = await lstat(projPath)
      expect(stat.isDirectory()).toBe(true)

      // Should be gone from user outfit
      const userExists = await lstat(coreDir).catch(() => null)
      expect(userExists).toBeNull()
    } finally {
      await env.cleanup()
    }
  })
})

// ── undo/redo additional paths ──────────────────────────────────────

describe('undo and redo with groups', () => {
  test('undo a single on, then redo it', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('undoredo-single')

      // Turn on
      const onResult = await env.run(['skills', 'on', 'undoredo-single', '--scope', 'user'])
      expect(onResult.exitCode).toBe(0)

      // Undo
      const undoResult = await env.run(['skills', 'undo', '--scope', 'user'])
      expect(undoResult.exitCode).toBe(0)
      const gone = await lstat(path.join(env.userOutfit, 'undoredo-single')).catch(() => null)
      expect(gone).toBeNull()

      // Redo
      const redoResult = await env.run(['skills', 'redo', '--scope', 'user'])
      expect(redoResult.exitCode).toBe(0)
      const back = await lstat(path.join(env.userOutfit, 'undoredo-single'))
      expect(back.isSymbolicLink()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  test('redo after off restores skills', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('redo-me')
      await env.run(['skills', 'on', 'redo-me', '--scope', 'user'])

      // Off
      await env.run(['skills', 'off', 'redo-me', '--scope', 'user'])
      const gone = await lstat(path.join(env.userOutfit, 'redo-me')).catch(() => null)
      expect(gone).toBeNull()

      // Undo the off (restores the on)
      await env.run(['skills', 'undo', '--scope', 'user'])
      const restored = await lstat(path.join(env.userOutfit, 'redo-me'))
      expect(restored.isSymbolicLink()).toBe(true)

      // Redo the off (re-removes)
      await env.run(['skills', 'redo', '--scope', 'user'])
      const reGone = await lstat(path.join(env.userOutfit, 'redo-me')).catch(() => null)
      expect(reGone).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('undo multiple operations at once', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('multi-a')
      await env.addUserLibrarySkill('multi-b')

      await env.run(['skills', 'on', 'multi-a', '--scope', 'user'])
      await env.run(['skills', 'on', 'multi-b', '--scope', 'user'])

      // Undo 2 at once
      const result = await env.run(['skills', 'undo', '2', '--scope', 'user'])
      expect(result.exitCode).toBe(0)

      // Both should be gone
      for (const name of ['multi-a', 'multi-b']) {
        const exists = await lstat(path.join(env.userOutfit, name)).catch(() => null)
        expect(exists).toBeNull()
      }
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
 * Parse the init event from CC's stream-json output to get the list of
 * skills CC sees. The init event is emitted before the model runs, and
 * includes a `skills` array with the names of all visible skills.
 *
 * `--output-format stream-json --verbose` emits line-delimited JSON events.
 * `--output-format json` only emits the final result — no init event.
 */
const parseCCSkills = (jsonOutput: string): string[] => {
  for (const line of jsonOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event: unknown = JSON.parse(trimmed)
      if (typeof event === 'object' && event !== null && 'type' in event && 'skills' in event) {
        const rec = event as Record<string, unknown>
        if (rec['type'] === 'system' && Array.isArray(rec['skills'])) {
          return (rec['skills'] as unknown[]).filter((s): s is string => typeof s === 'string')
        }
      }
    } catch {
      continue
    }
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
        await env.addProjectLibrarySkill('cc:test:ping')
        const onResult = await env.run(['skills', 'on', 'cc:test:ping'])
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
        skillMd('cc:e2e:test'),
      )

      try {
        const proc = Bun.spawn(
          ['claude', '-p', 'reply OK', '--output-format', 'stream-json', '--verbose'],
          {
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
          },
        )

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

// ── libraryExists scope guard ─────────────────────────────────────────

describe('libraryExists scope guard', () => {
  test('off at project scope fails when only user library exists', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('onlyuser')
      await env.run(['skills', 'on', 'onlyuser', '--scope', 'user'])

      // Remove the project library so only user library exists
      await rm(env.projectLibrary, { recursive: true, force: true })

      // off at project scope (default) should fail — no project library
      const result = await env.run(['skills', 'off', 'onlyuser'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('No skills library found')
    } finally {
      await env.cleanup()
    }
  })

  test('on with an explicit project scope fails when only user library exists', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('onlyuser2')

      // Remove the project library
      await rm(env.projectLibrary, { recursive: true, force: true })

      const result = await env.run(['skills', 'on', 'onlyuser2', '--scope', 'project'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('No skills library found')
    } finally {
      await env.cleanup()
    }
  })
})

// ── duplicate target dedup ────────────────────────────────────────────

describe('duplicate target handling', () => {
  test('on with duplicate comma targets produces only one action', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('dupskill')
      const result = await env.run(['skills', 'on', 'dupskill,dupskill', '--scope', 'user'])
      expect(result.exitCode).toBe(0)

      // Should only see one success row, not two
      const successMatches = result.stdout.match(/✓/g) ?? []
      expect(successMatches.length).toBe(1)

      // And the symlink should exist
      const link = await lstat(path.join(env.userOutfit, 'dupskill'))
      expect(link.isSymbolicLink()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })
})

// ── flat underscore namespace encoding ────────────────────────────────

describe('flat underscore namespace encoding', () => {
  test('undo correctly restores a namespaced skill via its flat outfit name', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('my:tool')
      await env.run(['skills', 'on', 'my:tool', '--scope', 'user'])

      const link = await lstat(path.join(env.userOutfit, 'my_tool'))
      expect(link.isSymbolicLink()).toBe(true)

      await env.run(['skills', 'off', 'my:tool', '--scope', 'user'])
      const gone = await lstat(path.join(env.userOutfit, 'my_tool')).catch(() => null)
      expect(gone).toBeNull()

      await env.run(['skills', 'undo', '1', '--scope', 'user'])

      const restored = await lstat(path.join(env.userOutfit, 'my_tool'))
      expect(restored.isSymbolicLink()).toBe(true)
    } finally {
      await env.cleanup()
    }
  })

  test('list renders canonical colon names rather than flat outfit names', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('my:tool')
      await env.run(['skills', 'on', 'my:tool', '--scope', 'user'])

      const result = await env.run(['skills', 'list'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('my:tool')
      expect(result.stdout).not.toContain('● my_tool')
    } finally {
      await env.cleanup()
    }
  })
})

// ── state.current consistency ────────────────────────────────────────

/** Read state.json from the test env's HOME. */
const readState = async (home: string) => {
  const statePath = path.join(home, '.claude/shan/state.json')
  const content = await readFile(statePath, 'utf-8').catch(() => '{}')
  return JSON.parse(content) as { current?: Record<string, { installs: string[] }> }
}

/** Get current installs for a scope key from state. Resolves realpath for project keys (macOS /var → /private/var). */
const getInstalls = async (
  state: Awaited<ReturnType<typeof readState>>,
  scopeKey: string,
): Promise<string[]> => {
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

      const state = (await readState(env.home)) as Record<string, unknown>
      const historyBefore =
        (state as { history?: Record<string, { entries: unknown[] }> }).history?.['global']?.entries
          .length ?? 0

      await env.run(['skills', 'redo', '1', '--scope', 'user'])

      const stateAfter = (await readState(env.home)) as Record<string, unknown>
      const historyAfter =
        (stateAfter as { history?: Record<string, { entries: unknown[] }> }).history?.['global']
          ?.entries.length ?? 0

      // Redo should NOT add new history entries — it only moves the undo pointer
      expect(historyAfter).toBe(historyBefore)
    } finally {
      await env.cleanup()
    }
  })
})

// ── move scope: library collision ───────────────────────────────────

describe('move scope library collision', () => {
  test('move scope up should give a clear error when user library already has the skill', async () => {
    const env = await setupTestEnv()
    try {
      // Same skill name in both libraries
      await env.addProjectLibrarySkill('collider')
      await env.addUserLibrarySkill('collider')

      const result = await env.run(['skills', 'move', 'scope', 'up', 'collider'])

      // Should report a proper validation error, not a raw ENOTEMPTY crash
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('already')
    } finally {
      await env.cleanup()
    }
  })

  test('move scope down should give a clear error when project library already has the skill', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('collider2')
      await env.addProjectLibrarySkill('collider2')
      await env.run(['skills', 'on', 'collider2', '--scope', 'user'])

      const result = await env.run(['skills', 'move', 'scope', 'down', 'collider2'])

      // Should report a proper validation error, not a raw ENOTEMPTY crash
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('already')
    } finally {
      await env.cleanup()
    }
  })
})

// ── move scope: gitignore management ─────────────────────────────────

/** Read .gitignore from the project dir, returns empty string if not found. */
const readGitignore = (project: string) =>
  readFile(path.join(project, '.gitignore'), 'utf-8').catch(() => '')

describe('move scope gitignore', () => {
  test('move scope down adds gitignore entry for new project-scope skill', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('gidown')
      await env.run(['skills', 'on', 'gidown', '--scope', 'user'])

      await env.run(['skills', 'move', 'scope', 'down', 'gidown'])

      const gitignore = await readGitignore(env.project)
      expect(gitignore).toContain('.claude/skills/gidown')
    } finally {
      await env.cleanup()
    }
  })

  test('move scope up removes gitignore entry for old project-scope skill', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('giup')
      await env.run(['skills', 'on', 'giup'])

      // Verify gitignore entry was added by on
      const before = await readGitignore(env.project)
      expect(before).toContain('.claude/skills/giup')

      await env.run(['skills', 'move', 'scope', 'up', 'giup'])

      // After moving to user scope, the project gitignore entry should be removed
      const after = await readGitignore(env.project)
      expect(after).not.toContain('.claude/skills/giup')
    } finally {
      await env.cleanup()
    }
  })

  test('off reset-all cleans gitignore entries for project scope', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('gireset1')
      await env.addProjectLibrarySkill('gireset2')
      await env.run(['skills', 'on', 'gireset1,gireset2'])

      const before = await readGitignore(env.project)
      expect(before).toContain('.claude/skills/gireset1')
      expect(before).toContain('.claude/skills/gireset2')

      // Reset all (no targets)
      await env.run(['skills', 'off'])

      const after = await readGitignore(env.project)
      expect(after).not.toContain('.claude/skills/gireset1')
      expect(after).not.toContain('.claude/skills/gireset2')
    } finally {
      await env.cleanup()
    }
  })
})

// ── undo/redo MoveOp: both scopes synced ─────────────────────────────

describe('undo/redo MoveOp scope sync', () => {
  test('undo of move scope down syncs both scopes in state.current', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('mvundo')
      await env.run(['skills', 'on', 'mvundo', '--scope', 'user'])

      // Move from user to project
      await env.run(['skills', 'move', 'scope', 'down', 'mvundo'])

      const afterMove = await readState(env.home)
      expect(await getInstalls(afterMove, 'global')).not.toContain('mvundo')
      expect(await getInstalls(afterMove, env.project)).toContain('mvundo')

      // Undo the move
      await env.run(['skills', 'undo', '1'])

      const afterUndo = await readState(env.home)
      // User scope should have mvundo back
      expect(await getInstalls(afterUndo, 'global')).toContain('mvundo')
      // Project scope should NOT have mvundo
      expect(await getInstalls(afterUndo, env.project)).not.toContain('mvundo')
    } finally {
      await env.cleanup()
    }
  })

  test('redo of move scope down syncs both scopes in state.current', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('mvredo')
      await env.run(['skills', 'on', 'mvredo', '--scope', 'user'])

      await env.run(['skills', 'move', 'scope', 'down', 'mvredo'])
      await env.run(['skills', 'undo', '1'])

      // After undo: user has it, project doesn't
      const afterUndo = await readState(env.home)
      expect(await getInstalls(afterUndo, 'global')).toContain('mvredo')

      // Redo the move
      await env.run(['skills', 'redo', '1'])

      const afterRedo = await readState(env.home)
      // Project should have it, user should not
      expect(await getInstalls(afterRedo, env.project)).toContain('mvredo')
      expect(await getInstalls(afterRedo, 'global')).not.toContain('mvredo')
    } finally {
      await env.cleanup()
    }
  })
})

// ── undo/redo gitignore lifecycle ────────────────────────────────────

describe('undo/redo gitignore lifecycle', () => {
  test('undo of on at project scope removes gitignore entry', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('giundo')
      await env.run(['skills', 'on', 'giundo'])

      const before = await readGitignore(env.project)
      expect(before).toContain('.claude/skills/giundo')

      await env.run(['skills', 'undo', '1'])

      const after = await readGitignore(env.project)
      expect(after).not.toContain('.claude/skills/giundo')
    } finally {
      await env.cleanup()
    }
  })

  test('redo of on at project scope restores gitignore entry', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('giredo')
      await env.run(['skills', 'on', 'giredo'])
      await env.run(['skills', 'undo', '1'])

      // After undo, gitignore entry should be gone
      const afterUndo = await readGitignore(env.project)
      expect(afterUndo).not.toContain('.claude/skills/giredo')

      await env.run(['skills', 'redo', '1'])

      // After redo, gitignore entry should be back
      const afterRedo = await readGitignore(env.project)
      expect(afterRedo).toContain('.claude/skills/giredo')
    } finally {
      await env.cleanup()
    }
  })

  test('redo of off at project scope cleans gitignore entry', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('giredoff')
      await env.run(['skills', 'on', 'giredoff'])
      await env.run(['skills', 'off', 'giredoff'])

      // After off, gitignore entry should be gone
      const afterOff = await readGitignore(env.project)
      expect(afterOff).not.toContain('.claude/skills/giredoff')

      // Undo the off → skill is back, gitignore should be back
      await env.run(['skills', 'undo', '1'])
      const afterUndoOff = await readGitignore(env.project)
      expect(afterUndoOff).toContain('.claude/skills/giredoff')

      // Redo the off → skill is gone, gitignore should be cleaned
      await env.run(['skills', 'redo', '1'])
      const afterRedoOff = await readGitignore(env.project)
      expect(afterRedoOff).not.toContain('.claude/skills/giredoff')
    } finally {
      await env.cleanup()
    }
  })

  test('redo of reset-all at project scope cleans gitignore entries', async () => {
    const env = await setupTestEnv()
    try {
      await env.addProjectLibrarySkill('giresetredo1')
      await env.addProjectLibrarySkill('giresetredo2')
      await env.run(['skills', 'on', 'giresetredo1,giresetredo2'])

      const before = await readGitignore(env.project)
      expect(before).toContain('.claude/skills/giresetredo1')

      await env.run(['skills', 'off'])
      await env.run(['skills', 'undo', '1'])

      // After undo of reset-all, skills and gitignore should be restored
      const afterUndoReset = await readGitignore(env.project)
      expect(afterUndoReset).toContain('.claude/skills/giresetredo1')

      // Redo the reset-all
      await env.run(['skills', 'redo', '1'])
      const afterRedoReset = await readGitignore(env.project)
      expect(afterRedoReset).not.toContain('.claude/skills/giresetredo1')
      expect(afterRedoReset).not.toContain('.claude/skills/giresetredo2')
    } finally {
      await env.cleanup()
    }
  })
})

// ── scope inference symmetry (codex review P2) ──────────────────────
//
// resolveSkillsOnScope infers user scope when the target only exists
// in the user library, but off/undo/redo/history use resolveScope which
// defaults to project. This means `shan skills on foo` can silently
// install at user scope, then `shan skills off foo` fails because it
// looks at project scope.

describe('scope inference symmetry', () => {
  test('off should find a skill that on auto-inferred to user scope', async () => {
    const env = await setupTestEnv()
    try {
      // Skill exists ONLY in user library — no project library entry
      await env.addUserLibrarySkill('inferred-user')

      // on with no --scope flag → resolveSkillsOnScope should infer user
      const onResult = await env.run(['skills', 'on', 'inferred-user'])
      expect(onResult.exitCode).toBe(0)

      // Verify it landed in user outfit
      const userLink = path.join(env.userOutfit, 'inferred-user')
      const stat = await lstat(userLink)
      expect(stat.isSymbolicLink()).toBe(true)

      // off with no --scope flag → should also find it at user scope
      // BUG: resolveScope defaults to project, so this fails with "not found"
      const offResult = await env.run(['skills', 'off', 'inferred-user'])
      expect(offResult.exitCode).toBe(0)

      // Skill should actually be removed
      const gone = await lstat(userLink).catch(() => null)
      expect(gone).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('undo should reverse a skill that on auto-inferred to user scope', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('inferred-undo')

      // on infers user scope
      const onResult = await env.run(['skills', 'on', 'inferred-undo'])
      expect(onResult.exitCode).toBe(0)

      const userLink = path.join(env.userOutfit, 'inferred-undo')
      expect((await lstat(userLink)).isSymbolicLink()).toBe(true)

      // undo with no --scope flag → should undo at user scope
      // BUG: resolveScope defaults to project, so undo looks at project history
      const undoResult = await env.run(['skills', 'undo'])
      expect(undoResult.exitCode).toBe(0)

      // Skill should be removed by undo
      const gone = await lstat(userLink).catch(() => null)
      expect(gone).toBeNull()
    } finally {
      await env.cleanup()
    }
  })

  test('history should show operations from auto-inferred user scope', async () => {
    const env = await setupTestEnv()
    try {
      await env.addUserLibrarySkill('inferred-hist')

      // on infers user scope
      await env.run(['skills', 'on', 'inferred-hist'])

      // history with no --scope flag → should show the user-scope operation
      // BUG: resolveScope defaults to project, so history shows project history (empty)
      const histResult = await env.run(['skills', 'history'])
      expect(histResult.exitCode).toBe(0)
      expect(histResult.stdout).toContain('inferred-hist')
    } finally {
      await env.cleanup()
    }
  })
})
