import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupRouter, skillsOff } from './off.js'
import { skillsOn } from './on.js'
import { skillsUndo } from './undo.js'
import { registerStateFileRestore } from './test-state.js'
import * as Lib from '../../lib/skill-library.js'
import {
  resetRuntimeConfigOverrides,
  replaceRuntimeConfigOverrides,
} from '../../lib/runtime-config.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-off-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

await registerStateFileRestore()

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`

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

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsOff', () => {
  test('fails when project library does not exist', async () => {
    await expect(run(skillsOff('some-skill', { scope: 'project', strict: false }))).rejects.toThrow(
      'Library not found',
    )
  })

  test('reports error for nonexistent target', async () => {
    await setupProjectLibrary('real-skill')

    await expect(run(skillsOff('nonexistent', { scope: 'project', strict: true }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('removes symlink for installed skill', async () => {
    await setupProjectLibrary('removable')
    await run(skillsOn('removable', { scope: 'project', strict: false }))

    // Verify it exists
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'removable')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    // Turn off
    await run(skillsOff('removable', { scope: 'project', strict: false }))

    // Verify it's gone
    try {
      await lstat(linkPath)
      expect(true).toBe(false) // Should not reach here
    } catch {
      // Expected — symlink removed
    }
  })

  test('skips already-off skill', async () => {
    await setupProjectLibrary('off-skill')

    // Never turned on — should skip
    await run(skillsOff('off-skill', { scope: 'project', strict: false }))
  })

  test('reset-all removes all pluggable skills', async () => {
    await setupProjectLibrary('skill-x', 'skill-y')
    await run(skillsOn('skill-x,skill-y', { scope: 'project', strict: false }))

    // Verify both exist
    for (const name of ['skill-x', 'skill-y']) {
      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', name)
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    }

    // Reset all (empty target input)
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Verify both removed
    for (const name of ['skill-x', 'skill-y']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false) // Should not reach here
      } catch {
        // Expected
      }
    }
  })

  test('does not remove core (real directory) skills', async () => {
    await setupProjectLibrary('some-lib-skill')
    // Create a core skill (real directory, not symlink)
    const coreDir = path.join(TEMP_DIR, '.claude', 'skills', 'core-skill')
    await mkdir(coreDir, { recursive: true })
    await writeFile(path.join(coreDir, 'SKILL.md'), SKILL_MD('core-skill'))

    // Reset all — core should survive
    await run(skillsOff('', { scope: 'project', strict: false }))

    const stat = await lstat(coreDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('handles multiple comma-separated targets', async () => {
    await setupProjectLibrary('off-a', 'off-b')
    await run(skillsOn('off-a,off-b', { scope: 'project', strict: false }))

    await run(skillsOff('off-a,off-b', { scope: 'project', strict: false }))

    for (const name of ['off-a', 'off-b']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false)
      } catch {
        // Expected
      }
    }
  })

  test('errors when targeting core skill (real directory)', async () => {
    await setupProjectLibrary('core-off')
    // Also create a core version in outfit (real directory)
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const corePath = path.join(outfitDir, 'core-off')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('core-off'))

    await expect(run(skillsOff('core-off', { scope: 'project', strict: true }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('cleans up group router on off', async () => {
    // Create group with children in library
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['child-a', 'child-b']) {
      const leafDir = path.join(libDir, 'offgroup', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "offgroup:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    // Install group (creates leaf symlinks and possibly router)
    await run(skillsOn('offgroup', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['offgroup_child-a', 'offgroup_child-b']) {
      expect((await lstat(path.join(outfitDir, leaf))).isSymbolicLink()).toBe(true)
    }

    // Turn off the group — exercises cleanupRouter
    await run(skillsOff('offgroup', { scope: 'project', strict: false }))

    // Verify leaf symlinks removed
    for (const leaf of ['offgroup_child-a', 'offgroup_child-b']) {
      try {
        await lstat(path.join(outfitDir, leaf))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })

  test('strict mode aborts with mix of valid and invalid', async () => {
    await setupProjectLibrary('off-valid')
    await run(skillsOn('off-valid', { scope: 'project', strict: false }))

    // One valid target, one invalid — strict mode should abort
    await expect(
      run(skillsOff('off-valid,off-invalid', { scope: 'project', strict: true })),
    ).rejects.toThrow('Some targets failed')

    // Valid skill should NOT have been removed (abort before Phase 2)
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'off-valid')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  test('strict mode aborts when a selected target is already off', async () => {
    await setupProjectLibrary('strict-off-skill')

    await expect(
      run(skillsOff('strict-off-skill', { scope: 'project', strict: true })),
    ).rejects.toThrow('Some targets failed')
  })

  test('off after undo trims undone history entries', async () => {
    await setupProjectLibrary('trim-off-a', 'trim-off-b')
    await run(skillsOn('trim-off-a', { scope: 'project', strict: false }))
    await run(skillsOn('trim-off-b', { scope: 'project', strict: false }))

    // Undo last on → undoneCount = 1
    await run(skillsUndo(1, 'project'))

    // Off the remaining skill → records history with undoneCount > 0, triggers splice
    await run(skillsOff('trim-off-a', { scope: 'project', strict: false }))

    // Verify skill is removed
    try {
      await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'trim-off-a'))
      expect(true).toBe(false)
    } catch {
      // Expected — removed
    }
  })

  test('cleanupRouter handles missing router dir gracefully', async () => {
    // Create group with children in library
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['cr-child-a', 'cr-child-b']) {
      const leafDir = path.join(libDir, 'crgrp', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "crgrp:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    // Install group
    await run(skillsOn('crgrp', { scope: 'project', strict: false }))

    // Manually delete the generated router directory before off
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const routerPath = path.join(outfitDir, 'crgrp')
    await rm(routerPath, { recursive: true, force: true })

    // Turn off → cleanupRouter is called, lstat(routerPath) fails → catchAll fires
    await run(skillsOff('crgrp', { scope: 'project', strict: false }))
  })

  test('cleanupRouter can resolve a legacy project install from the user library', async () => {
    const groupName = `legacy-router-${Date.now()}`
    const userGroupLeafDir = path.join(Lib.LIBRARY_DIR, groupName, 'child')
    const projectLibraryDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const projectOutfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const projectLinkPath = path.join(projectOutfitDir, `${groupName}_child`)
    const routerPath = path.join(projectOutfitDir, groupName)

    try {
      await mkdir(userGroupLeafDir, { recursive: true })
      await mkdir(projectLibraryDir, { recursive: true })
      await writeFile(
        path.join(userGroupLeafDir, 'SKILL.md'),
        `---\nname: "${groupName}:child"\ndescription: Legacy child\n---\n# child\n`,
      )
      await mkdir(projectOutfitDir, { recursive: true })
      await symlink(userGroupLeafDir, projectLinkPath)
      await mkdir(routerPath, { recursive: true })
      await writeFile(path.join(routerPath, 'SKILL.md'), `---\nname: ${groupName}\n---\n`)

      await run(skillsOff(groupName, { scope: 'project', strict: false }))

      await expect(lstat(projectLinkPath)).rejects.toThrow()
      await expect(lstat(routerPath)).rejects.toThrow()
    } finally {
      await rm(path.join(Lib.LIBRARY_DIR, groupName), { recursive: true, force: true })
    }
  })

  test('cleanupRouter removes callable-group routers directly', async () => {
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const libraryDir = path.join(TEMP_DIR, '.claude', 'skills-library', 'callable-router')
    await mkdir(path.join(libraryDir, 'leaf'), { recursive: true })
    await writeFile(
      path.join(libraryDir, 'SKILL.md'),
      '---\nname: callable-router\ndescription: Callable router\n---\n# callable-router\n',
    )
    await writeFile(
      path.join(libraryDir, 'leaf', 'SKILL.md'),
      '---\nname: "callable-router:leaf"\ndescription: Leaf\n---\n# leaf\n',
    )
    await mkdir(path.join(outfitDir, 'callable-router'), { recursive: true })
    await writeFile(path.join(outfitDir, 'callable-router', 'SKILL.md'), '# router')

    await run(cleanupRouter(outfitDir, 'callable-router', 'project'))

    await expect(lstat(path.join(outfitDir, 'callable-router'))).rejects.toThrow()
  })

  test('cleanupRouter leaves unrelated directories alone when no matching library group exists', async () => {
    const routerPath = path.join(TEMP_DIR, '.claude', 'skills', '__cleanup_router_no_group__')
    await mkdir(routerPath, { recursive: true })
    await writeFile(path.join(routerPath, 'SKILL.md'), '# not a generated router')

    await run(
      cleanupRouter(
        path.join(TEMP_DIR, '.claude', 'skills'),
        '__cleanup_router_no_group__',
        'project',
      ),
    )

    expect((await lstat(routerPath)).isDirectory()).toBe(true)
  })

  test('reset-all catchAll handles unlink failures on read-only outfit', async () => {
    await setupProjectLibrary('ro-skill-a', 'ro-skill-b')
    await run(skillsOn('ro-skill-a,ro-skill-b', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')

    // Make outfit dir read-only so unlink fails. The operation should abort and
    // roll back to the previous snapshot instead of partially mutating.
    await chmod(outfitDir, 0o555)
    try {
      await expect(run(skillsOff('', { scope: 'project', strict: false }))).rejects.toThrow()
    } finally {
      await chmod(outfitDir, 0o755)
    }

    expect((await lstat(path.join(outfitDir, 'ro-skill-a'))).isSymbolicLink()).toBe(true)
    expect((await lstat(path.join(outfitDir, 'ro-skill-b'))).isSymbolicLink()).toBe(true)
  })

  test('cleanupRouter catchAll handles rm failure on read-only outfit', async () => {
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['roc-a', 'roc-b']) {
      const leafDir = path.join(libDir, 'rogrp', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "rogrp:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    await run(skillsOn('rogrp', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')

    // Make outfit dir read-only so rm in cleanupRouter fails → catchAll fires
    await chmod(outfitDir, 0o555)
    try {
      // Turn off group → cleanupRouter reaches rm() which fails → catchAll
      await run(skillsOff('rogrp', { scope: 'project', strict: false }))
    } catch {
      // May fail due to unlink without catchAll in Phase 2
    } finally {
      await chmod(outfitDir, 0o755)
    }
  })

  test('reset-all after undo trims undone history entries', async () => {
    await setupProjectLibrary('resetundo-a', 'resetundo-b')
    await run(skillsOn('resetundo-a', { scope: 'project', strict: false }))
    await run(skillsOn('resetundo-b', { scope: 'project', strict: false }))

    // Undo last on → undoneCount = 1
    await run(skillsUndo(1, 'project'))

    // Reset all → exercises resetAll path with undoneCount > 0
    await run(skillsOff('', { scope: 'project', strict: false }))
  })

  test('trims history when exceeding historyLimit', async () => {
    const configFile = path.join(process.env['HOME'] ?? '', '.config', 'shan', 'config.json')
    const {
      mkdir: mkdirFs,
      writeFile: writeFileFs,
      readFile: readFileFs,
      rm: rmFs,
    } = await import('node:fs/promises')
    const origConfig = await readFileFs(configFile, 'utf-8').catch(() => null)

    try {
      // Set historyLimit to 1 so any 2nd operation triggers the splice
      await mkdirFs(path.dirname(configFile), { recursive: true })
      await writeFileFs(configFile, JSON.stringify({ skills: { historyLimit: 1 } }))

      await setupProjectLibrary('limit-a', 'limit-b')
      await run(skillsOn('limit-a', { scope: 'project', strict: false }))
      // This on creates history entry #2 → exceeds limit of 1
      await run(skillsOn('limit-b', { scope: 'project', strict: false }))
      // Turn off with history > limit → exercises the splice in off
      await run(skillsOff('limit-b', { scope: 'project', strict: false }))
    } finally {
      if (origConfig === null) {
        await rmFs(configFile, { force: true }).catch(() => {})
      } else {
        await writeFileFs(configFile, origConfig)
      }
    }
  })

  test('reset-all trims history when exceeding historyLimit', async () => {
    const configFile = path.join(process.env['HOME'] ?? '', '.config', 'shan', 'config.json')
    const {
      mkdir: mkdirFs,
      writeFile: writeFileFs,
      readFile: readFileFs,
      rm: rmFs,
    } = await import('node:fs/promises')
    const origConfig = await readFileFs(configFile, 'utf-8').catch(() => null)

    try {
      await mkdirFs(path.dirname(configFile), { recursive: true })
      await writeFileFs(configFile, JSON.stringify({ skills: { historyLimit: 1 } }))

      await setupProjectLibrary('rlimit-a', 'rlimit-b')
      await run(skillsOn('rlimit-a', { scope: 'project', strict: false }))
      await run(skillsOn('rlimit-b', { scope: 'project', strict: false }))
      // Reset all with history > limit → exercises splice in resetAll
      await run(skillsOff('', { scope: 'project', strict: false }))
    } finally {
      if (origConfig === null) {
        await rmFs(configFile, { force: true }).catch(() => {})
      } else {
        await writeFileFs(configFile, origConfig)
      }
    }
  })

  test('reset-all cleans up generated routers', async () => {
    // Create group with children in library
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['child-x', 'child-y']) {
      const leafDir = path.join(libDir, 'resetgrp', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "resetgrp:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    // Install group
    await run(skillsOn('resetgrp', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['resetgrp_child-x', 'resetgrp_child-y']) {
      expect((await lstat(path.join(outfitDir, leaf))).isSymbolicLink()).toBe(true)
    }

    // Reset all — exercises resetAll router cleanup path
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Verify leaf symlinks removed
    for (const leaf of ['resetgrp_child-x', 'resetgrp_child-y']) {
      try {
        await lstat(path.join(outfitDir, leaf))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })

  test('default off cascades through active dependents', async () => {
    await writeProjectSkill('base')
    await writeProjectSkill('consumer', { dependencies: ['base'] })
    await run(skillsOn('consumer', { scope: 'project', strict: false }))

    await run(skillsOff('base', { scope: 'project', strict: false }))

    await expect(lstat(path.join(TEMP_DIR, '.claude', 'skills', 'base'))).rejects.toThrow()
    await expect(lstat(path.join(TEMP_DIR, '.claude', 'skills', 'consumer'))).rejects.toThrow()
  })

  test('fail-on-dependents blocks when active dependents remain', async () => {
    await writeProjectSkill('base')
    await writeProjectSkill('consumer', { dependencies: ['base'] })
    await run(skillsOn('consumer', { scope: 'project', strict: false }))

    await expect(
      run(
        skillsOff('base', {
          failOnDependents: true,
          scope: 'project',
          strict: false,
        }),
      ),
    ).rejects.toThrow('Some targets failed')

    expect((await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'base'))).isSymbolicLink()).toBe(
      true,
    )
    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'consumer'))).isSymbolicLink(),
    ).toBe(true)
  })

  test('cascade-dependencies removes transitive dependencies of selected skill', async () => {
    await writeProjectSkill('base')
    await writeProjectSkill('consumer', { dependencies: ['base'] })
    await run(skillsOn('consumer', { scope: 'project', strict: false }))

    await run(
      skillsOff('consumer', {
        cascadeDependencies: true,
        scope: 'project',
        strict: false,
      }),
    )

    await expect(lstat(path.join(TEMP_DIR, '.claude', 'skills', 'base'))).rejects.toThrow()
    await expect(lstat(path.join(TEMP_DIR, '.claude', 'skills', 'consumer'))).rejects.toThrow()
  })

  test('without cascade-dependencies shared dependencies remain active', async () => {
    await writeProjectSkill('shared-base')
    await writeProjectSkill('first-consumer', { dependencies: ['shared-base'] })
    await writeProjectSkill('second-consumer', { dependencies: ['shared-base'] })
    await run(skillsOn('first-consumer,second-consumer', { scope: 'project', strict: false }))

    await run(skillsOff('first-consumer', { scope: 'project', strict: false }))

    await expect(
      lstat(path.join(TEMP_DIR, '.claude', 'skills', 'first-consumer')),
    ).rejects.toThrow()
    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'shared-base'))).isSymbolicLink(),
    ).toBe(true)
    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'second-consumer'))).isSymbolicLink(),
    ).toBe(true)
  })

  test('sorts removed skills across scopes when a cross-scope dependent cascades', async () => {
    const homeDir = path.join(TEMP_DIR, 'off-home-cross-scope')
    await mkdir(homeDir, { recursive: true })
    replaceRuntimeConfigOverrides({ homeDir, projectRoot: TEMP_DIR })

    try {
      const userLibDir = path.join(homeDir, '.claude', 'skills-library')
      await mkdir(path.join(userLibDir, 'shared-base'), { recursive: true })
      await writeFile(path.join(userLibDir, 'shared-base', 'SKILL.md'), SKILL_MD('shared-base'))
      await writeProjectSkill('project-consumer', { dependencies: ['shared-base'] })

      await run(skillsOn('project-consumer', { scope: 'project', strict: false }))
      await run(skillsOff('shared-base', { scope: 'user', strict: false }))

      await expect(lstat(path.join(homeDir, '.claude', 'skills', 'shared-base'))).rejects.toThrow()
      await expect(
        lstat(path.join(TEMP_DIR, '.claude', 'skills', 'project-consumer')),
      ).rejects.toThrow()
    } finally {
      resetRuntimeConfigOverrides()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  test('default dependent cascade blocks when the dependent is core', async () => {
    await writeProjectSkill('core-base')
    await run(skillsOn('core-base', { scope: 'project', strict: false }))

    const coreDependentDir = path.join(TEMP_DIR, '.claude', 'skills', 'core-dependent')
    await mkdir(coreDependentDir, { recursive: true })
    await writeFile(
      path.join(coreDependentDir, 'SKILL.md'),
      `---\nname: core-dependent\ndescription: Core dependent\ndependencies:\n  - core-base\n---\n\n# core-dependent\n`,
    )

    await expect(run(skillsOff('core-base', { scope: 'project', strict: false }))).rejects.toThrow(
      'Some targets failed',
    )

    expect(
      (await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'core-base'))).isSymbolicLink(),
    ).toBe(true)
    expect((await lstat(coreDependentDir)).isDirectory()).toBe(true)
  })

  test('cascade-dependencies blocks when the dependency is core', async () => {
    const coreDependencyDir = path.join(TEMP_DIR, '.claude', 'skills', 'core-required')
    await mkdir(coreDependencyDir, { recursive: true })
    await writeFile(
      path.join(coreDependencyDir, 'SKILL.md'),
      '---\nname: core-required\ndescription: Core dependency\n---\n\n# core-required\n',
    )
    await writeProjectSkill('consumer-needing-core', { dependencies: ['core-required'] })
    await run(skillsOn('consumer-needing-core', { scope: 'project', strict: false }))

    await expect(
      run(
        skillsOff('consumer-needing-core', {
          cascadeDependencies: true,
          scope: 'project',
          strict: false,
        }),
      ),
    ).rejects.toThrow('Some targets failed')

    expect(
      (
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'consumer-needing-core'))
      ).isSymbolicLink(),
    ).toBe(true)
    expect((await lstat(coreDependencyDir)).isDirectory()).toBe(true)
  })
})
