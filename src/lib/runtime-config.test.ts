import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  agentOutfitDirFor,
  agentRootDirFor,
  getRuntimeConfig,
  onRuntimeConfigChange,
  replaceRuntimeConfigOverrides,
  resetRuntimeConfigOverrides,
  setRuntimeConfigOverrides,
} from './runtime-config.js'

afterEach(() => {
  resetRuntimeConfigOverrides()
})

describe('runtime-config', () => {
  test('setRuntimeConfigOverrides merges overrides and notifies listeners', async () => {
    const initial = getRuntimeConfig()
    const homeDir = await mkdtemp(path.join(tmpdir(), 'shan-runtime-home-'))
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'shan-runtime-project-'))
    const seen: string[] = []
    const unsubscribe = onRuntimeConfigChange((config) => {
      seen.push(`${config.homeDir}::${config.projectRoot}`)
    })

    try {
      const afterHome = setRuntimeConfigOverrides({ homeDir })
      expect(afterHome.homeDir).toBe(homeDir)
      expect(afterHome.projectRoot).toBe(initial.projectRoot)

      const afterProject = setRuntimeConfigOverrides({ projectRoot })
      expect(afterProject.homeDir).toBe(homeDir)
      expect(afterProject.projectRoot).toBe(projectRoot)

      expect(agentRootDirFor('user', 'claude')).toBe(path.join(homeDir, '.claude'))
      expect(agentOutfitDirFor('project', 'codex')).toBe(path.join(projectRoot, '.codex', 'skills'))
      expect(seen).toEqual([`${homeDir}::${initial.projectRoot}`, `${homeDir}::${projectRoot}`])
    } finally {
      unsubscribe()
      await rm(homeDir, { recursive: true, force: true })
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('replaceRuntimeConfigOverrides replaces omitted values and unsubscribe stops future notifications', async () => {
    const initial = getRuntimeConfig()
    const homeDir = await mkdtemp(path.join(tmpdir(), 'shan-runtime-home-'))
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'shan-runtime-project-'))
    const notifications: string[] = []
    const unsubscribe = onRuntimeConfigChange((config) => {
      notifications.push(`${config.homeDir}::${config.projectRoot}`)
    })

    try {
      setRuntimeConfigOverrides({ homeDir, projectRoot })
      unsubscribe()

      const replaced = replaceRuntimeConfigOverrides({ projectRoot: initial.projectRoot })
      expect(replaced.homeDir).toBe(initial.homeDir)
      expect(replaced.projectRoot).toBe(initial.projectRoot)

      const reset = resetRuntimeConfigOverrides()
      expect(reset.homeDir).toBe(initial.homeDir)
      expect(reset.projectRoot).toBe(initial.projectRoot)
      expect(notifications).toEqual([`${homeDir}::${projectRoot}`])
    } finally {
      await rm(homeDir, { recursive: true, force: true })
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
