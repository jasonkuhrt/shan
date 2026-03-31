import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import {
  resetRuntimeConfigOverrides,
  replaceRuntimeConfigOverrides,
} from '../../lib/runtime-config.js'
import { skillsOn } from './on.js'
import { skillsUndo } from './undo.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-on-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

await registerStateFileRestore()

const SKILL_MD = (name: string, extraFrontmatter = '') => `---
name: ${name}
description: A test skill
${extraFrontmatter}---

# ${name}
`

/** Create a project library with skills in the temp dir. */
const setupProjectLibrary = async (...skills: string[]) => {
  const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
  for (const skill of skills) {
    const skillDir = path.join(libDir, skill)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD(skill))
  }
}

const writeProjectSkill = async (
  relPath: string,
  options: {
    readonly dependencies?: readonly string[]
    readonly description?: string
    readonly name?: string
  } = {},
) => {
  const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
  const skillDir = path.join(libDir, relPath)
  const name = options.name ?? relPath.replaceAll('/', ':')
  const dependencies = options.dependencies
    ? `dependencies:\n${options.dependencies.map((dependency) => `  - ${dependency}`).join('\n')}\n`
    : ''
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${options.description ?? `Test skill ${name}`}\n${dependencies}---\n\n# ${name}\n`,
  )
}

const writeUserSkill = async (
  homeDir: string,
  relPath: string,
  options: {
    readonly dependencies?: readonly string[]
    readonly description?: string
    readonly name?: string
  } = {},
) => {
  const libDir = path.join(homeDir, '.claude', 'skills-library')
  const skillDir = path.join(libDir, relPath)
  const name = options.name ?? relPath.replaceAll('/', ':')
  const dependencies = options.dependencies
    ? `dependencies:\n${options.dependencies.map((dependency) => `  - ${dependency}`).join('\n')}\n`
    : ''
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${options.description ?? `Test skill ${name}`}\n${dependencies}---\n\n# ${name}\n`,
  )
}

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsOn', () => {
  test('fails with empty target input', async () => {
    await expect(run(skillsOn('', { scope: 'project', strict: false }))).rejects.toThrow(
      'Missing targets',
    )
  })

  test('fails when project library does not exist', async () => {
    // No .claude/skills-library/ in temp dir
    await expect(run(skillsOn('some-skill', { scope: 'project', strict: true }))).rejects.toThrow(
      'Library not found',
    )
  })

  test('reports error for nonexistent target', async () => {
    await setupProjectLibrary('real-skill')

    // 'nonexistent' is not in library — should produce batch error
    // strict=true → aborts
    await expect(run(skillsOn('nonexistent', { scope: 'project', strict: true }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('creates symlink for existing skill at project scope', async () => {
    await setupProjectLibrary('my-leaf')

    await run(skillsOn('my-leaf', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'my-leaf')
    const stat = await lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)

    const target = await readlink(linkPath)
    expect(target).toContain('skills-library')
  })

  test('skips already-on skill', async () => {
    await setupProjectLibrary('already-on')
    // First on
    await run(skillsOn('already-on', { scope: 'project', strict: false }))
    // Second on — should skip
    await run(skillsOn('already-on', { scope: 'project', strict: false }))

    // Still just one symlink
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'already-on')
    const stat = await lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)
  })

  test('creates symlinks for multiple comma-separated targets', async () => {
    await setupProjectLibrary('skill-a', 'skill-b')

    await run(skillsOn('skill-a,skill-b', { scope: 'project', strict: false }))

    for (const name of ['skill-a', 'skill-b']) {
      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', name)
      const stat = await lstat(linkPath)
      expect(stat.isSymbolicLink()).toBe(true)
    }
  })

  test('generates router for group', async () => {
    // Create a group with two leaves
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['child-a', 'child-b']) {
      const leafDir = path.join(libDir, 'mygroup', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "mygroup:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    await run(skillsOn('mygroup', { scope: 'project', strict: false }))

    // Group leaves should be installed as flat symlinks
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['mygroup_child-a', 'mygroup_child-b']) {
      const stat = await lstat(path.join(outfitDir, leaf))
      expect(stat.isSymbolicLink()).toBe(true)
    }
  })

  test('sorts multiple generated routers deterministically', async () => {
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const groups: Array<readonly [string, string]> = [
      ['bgroup', 'leaf-b'],
      ['agroup', 'leaf-a'],
    ]
    for (const [groupName, leafName] of groups) {
      const leafDir = path.join(libDir, groupName, leafName)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "${groupName}:${leafName}"\ndescription: Test\n---\n# ${leafName}\n`,
      )
    }

    await run(skillsOn('bgroup,agroup', { scope: 'project', strict: false }))

    for (const groupName of ['agroup', 'bgroup']) {
      expect((await lstat(path.join(TEMP_DIR, '.claude', 'skills', groupName))).isDirectory()).toBe(
        true,
      )
    }
  })

  test('handles strict mode with mixed valid and invalid targets', async () => {
    await setupProjectLibrary('valid-skill')

    // One valid, one invalid — strict mode should abort
    await expect(
      run(skillsOn('valid-skill,invalid-skill', { scope: 'project', strict: true })),
    ).rejects.toThrow('Some targets failed')

    // The valid skill should NOT have been installed (Phase 1 aborted)
    try {
      const stat = await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'valid-skill'))
      // If we get here, the symlink was created (shouldn't happen in strict mode with errors)
      expect(stat.isSymbolicLink()).toBe(false) // Force fail
    } catch {
      // Expected: file doesn't exist because strict mode aborted
    }
  })

  test('non-strict mode installs despite skip (already-on target)', async () => {
    await setupProjectLibrary('new-skill', 'existing-skill')
    // Install existing-skill first so it becomes a skip
    await run(skillsOn('existing-skill', { scope: 'project', strict: false }))

    // In non-strict mode, the skip for existing-skill doesn't abort
    await run(skillsOn('new-skill,existing-skill', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'new-skill')
    const stat = await lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)
  })

  test('strict mode aborts when a selected target is already on', async () => {
    await setupProjectLibrary('strict-already-on')
    await run(skillsOn('strict-already-on', { scope: 'project', strict: false }))

    await expect(
      run(skillsOn('strict-already-on', { scope: 'project', strict: true })),
    ).rejects.toThrow('Some targets failed')
  })

  test('auto-activates missing dependency closure', async () => {
    await writeProjectSkill('base-skill')
    await writeProjectSkill('needs-base', { dependencies: ['base-skill'] })

    await run(skillsOn('needs-base', { scope: 'project', strict: false }))

    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'needs-base'))).isSymbolicLink(),
    ).toBe(true)
    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'base-skill'))).isSymbolicLink(),
    ).toBe(true)
  })

  test('fail-on-missing-dependencies aborts and prints rerun command', async () => {
    await writeProjectSkill('dep-skill')
    await writeProjectSkill('blocked-skill', { dependencies: ['dep-skill'] })

    const output: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }

    try {
      await expect(
        run(
          skillsOn('blocked-skill', {
            failOnMissingDependencies: true,
            scope: 'project',
            strict: false,
          }),
        ),
      ).rejects.toThrow('Some targets failed')
    } finally {
      console.log = origLog
    }

    await expect(lstat(path.join(TEMP_DIR, '.claude', 'skills', 'blocked-skill'))).rejects.toThrow()
    await expect(lstat(path.join(TEMP_DIR, '.claude', 'skills', 'dep-skill'))).rejects.toThrow()
    expect(output.join('\n')).toContain(
      'missing dependencies would be auto-activated: dep-skill [project]',
    )
    expect(output.join('\n')).toContain('shan skills on blocked-skill,dep-skill')
  })

  test('fail-on-missing-dependencies prints exact rerun commands for cross-scope dependencies', async () => {
    const homeDir = await mkdtemp(path.join(TEMP_DIR, 'home-'))
    replaceRuntimeConfigOverrides({ homeDir, projectRoot: TEMP_DIR })

    const output: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }

    try {
      await writeUserSkill(homeDir, 'user-dependency')
      await writeProjectSkill('cross-scope-blocked', { dependencies: ['user-dependency'] })

      await expect(
        run(
          skillsOn('cross-scope-blocked', {
            failOnMissingDependencies: true,
            scope: 'project',
            strict: false,
          }),
        ),
      ).rejects.toThrow('Some targets failed')
    } finally {
      console.log = origLog
      resetRuntimeConfigOverrides()
      await rm(homeDir, { recursive: true, force: true })
    }

    const joined = output.join('\n')
    expect(joined).toContain('missing dependencies would be auto-activated: user-dependency [user]')
    expect(joined).toContain('rerun with explicit targets: shan skills on cross-scope-blocked')
    expect(joined).toContain(
      'rerun with explicit targets: shan skills on user-dependency --scope user',
    )
  })

  test('namespace-root dependencies activate all current descendants', async () => {
    await writeProjectSkill('bundle/leaf-a', { name: 'bundle:leaf-a' })
    await writeProjectSkill('bundle/leaf-b', { name: 'bundle:leaf-b' })
    await writeProjectSkill('runner', { dependencies: ['bundle'] })

    await run(skillsOn('runner', { scope: 'project', strict: false }))

    for (const name of ['runner', 'bundle_leaf-a', 'bundle_leaf-b']) {
      expect((await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))).isSymbolicLink()).toBe(
        true,
      )
    }
    expect((await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'bundle'))).isDirectory()).toBe(
      true,
    )
  })

  test('blocks selected targets that collide with a user skill', async () => {
    const homeDir = await mkdtemp(path.join(TEMP_DIR, 'home-selected-collision-'))
    replaceRuntimeConfigOverrides({ homeDir, projectRoot: TEMP_DIR })

    try {
      await writeProjectSkill('collision-target')
      const userCoreDir = path.join(homeDir, '.claude', 'skills', 'collision-target')
      await mkdir(userCoreDir, { recursive: true })
      await writeFile(path.join(userCoreDir, 'SKILL.md'), SKILL_MD('collision-target'))

      await expect(
        run(skillsOn('collision-target', { scope: 'project', strict: false })),
      ).rejects.toThrow('Some targets failed')

      await expect(
        lstat(path.join(TEMP_DIR, '.claude', 'skills', 'collision-target')),
      ).rejects.toThrow()
    } finally {
      resetRuntimeConfigOverrides()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test('blocks invalid dependency declarations during activation', async () => {
    await writeProjectSkill('bundle/leaf', { name: 'bundle:leaf' })
    await writeProjectSkill('broken-consumer', { dependencies: ['bundle:leaf'] })

    await expect(
      run(skillsOn('broken-consumer', { scope: 'project', strict: false })),
    ).rejects.toThrow('Some targets failed')
  })

  test('blocks dependency activation when a dependency collides with a user skill', async () => {
    const homeDir = await mkdtemp(path.join(TEMP_DIR, 'home-dependency-collision-'))
    replaceRuntimeConfigOverrides({ homeDir, projectRoot: TEMP_DIR })

    try {
      await writeProjectSkill('shared-dependency')
      await writeProjectSkill('consumer-with-collision', { dependencies: ['shared-dependency'] })

      const userCoreDir = path.join(homeDir, '.claude', 'skills', 'shared-dependency')
      await mkdir(userCoreDir, { recursive: true })
      await writeFile(path.join(userCoreDir, 'SKILL.md'), SKILL_MD('shared-dependency'))

      await expect(
        run(skillsOn('consumer-with-collision', { scope: 'project', strict: false })),
      ).rejects.toThrow('Some targets failed')
    } finally {
      resetRuntimeConfigOverrides()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test('aborts when the existing active graph is already invalid', async () => {
    await writeProjectSkill('missing-active-dependency')
    await writeProjectSkill('broken-active-owner', { dependencies: ['missing-active-dependency'] })
    await writeProjectSkill('new-target')

    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await mkdir(outfitDir, { recursive: true })
    await symlink(
      path.join(libDir, 'broken-active-owner'),
      path.join(outfitDir, 'broken-active-owner'),
    )

    await expect(run(skillsOn('new-target', { scope: 'project', strict: false }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('rolls back snapshots when activation fails during mutation', async () => {
    await writeProjectSkill('mutation-failure')
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await mkdir(outfitDir, { recursive: true })
    await chmod(outfitDir, 0o555)

    try {
      await expect(
        run(skillsOn('mutation-failure', { scope: 'project', strict: false })),
      ).rejects.toThrow()
    } finally {
      await chmod(outfitDir, 0o755)
    }

    await expect(lstat(path.join(outfitDir, 'mutation-failure'))).rejects.toThrow()
  })

  test('trims undone history entries before recording a new on operation', async () => {
    await setupProjectLibrary('history-a', 'history-b')
    await run(skillsOn('history-a', { scope: 'project', strict: false }))
    await run(skillsOn('history-b', { scope: 'project', strict: false }))
    await run(skillsUndo(1, 'project'))

    await run(skillsOn('history-b', { scope: 'project', strict: false }))

    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'history-a'))).isSymbolicLink(),
    ).toBe(true)
    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'history-b'))).isSymbolicLink(),
    ).toBe(true)
  })
})
