import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { getRuntimeConfig } from '../../lib/runtime-config.js'
import { buildLintContext } from './context.js'

beforeEach(async () => {
  const runtime = getRuntimeConfig()
  await rm(path.join(runtime.homeDir, '.claude'), { recursive: true, force: true })
  await rm(path.join(runtime.projectRoot, '.claude'), { recursive: true, force: true })
})

describe('buildLintContext', () => {
  test('returns empty settingsFiles when none exist', () => {
    const ctx = buildLintContext()
    expect(ctx.settingsFiles).toEqual([])
    expect(ctx.home).toBe(getRuntimeConfig().homeDir)
    expect(ctx.projectDir).toBe(getRuntimeConfig().projectRoot)
  })

  test('finds user settings.json', async () => {
    const homeDir = getRuntimeConfig().homeDir
    await mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await writeFile(path.join(homeDir, '.claude/settings.json'), '{"key": "value"}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(1)
    expect(ctx.settingsFiles[0]!.scope).toBe('user')
    expect(ctx.settingsFiles[0]!.data).toEqual({ key: 'value' })
  })

  test('finds project settings.json', async () => {
    const projectRoot = getRuntimeConfig().projectRoot
    await mkdir(path.join(projectRoot, '.claude'), { recursive: true })
    await writeFile(path.join(projectRoot, '.claude/settings.json'), '{"hooks": {}}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(1)
    expect(ctx.settingsFiles[0]!.scope).toBe('project')
  })

  test('finds project-local settings.json', async () => {
    const projectRoot = getRuntimeConfig().projectRoot
    await mkdir(path.join(projectRoot, '.claude'), { recursive: true })
    await writeFile(path.join(projectRoot, '.claude/settings.local.json'), '{"statusLine": {}}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(1)
    expect(ctx.settingsFiles[0]!.scope).toBe('project-local')
  })

  test('finds all three settings files', async () => {
    const runtime = getRuntimeConfig()
    await mkdir(path.join(runtime.homeDir, '.claude'), { recursive: true })
    await writeFile(path.join(runtime.homeDir, '.claude/settings.json'), '{}')
    await mkdir(path.join(runtime.projectRoot, '.claude'), { recursive: true })
    await writeFile(path.join(runtime.projectRoot, '.claude/settings.json'), '{}')
    await writeFile(path.join(runtime.projectRoot, '.claude/settings.local.json'), '{}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(3)
  })

  test('skips invalid JSON files', async () => {
    const homeDir = getRuntimeConfig().homeDir
    await mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await writeFile(path.join(homeDir, '.claude/settings.json'), 'not valid json{{{')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(0)
  })

  test('displayPath replaces home with ~', async () => {
    const homeDir = getRuntimeConfig().homeDir
    await mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await writeFile(path.join(homeDir, '.claude/settings.json'), '{}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles[0]!.displayPath).toStartWith('~')
    expect(ctx.settingsFiles[0]!.displayPath).not.toContain(homeDir)
  })

  test('displayPath keeps non-home paths as-is', async () => {
    const runtime = getRuntimeConfig()
    await mkdir(path.join(runtime.projectRoot, '.claude'), { recursive: true })
    await writeFile(path.join(runtime.projectRoot, '.claude/settings.json'), '{}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles[0]!.displayPath).not.toStartWith('~')
  })
})
