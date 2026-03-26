import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// Create temp dirs and resolve canonical paths (macOS /var → /private/var)
const RAW_BASE = path.join(tmpdir(), `shan-ctx-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(path.join(RAW_BASE, 'home'), { recursive: true })
await mkdir(path.join(RAW_BASE, 'project'), { recursive: true })
const TEMP_HOME = realpathSync(path.join(RAW_BASE, 'home'))
const TEMP_PROJECT = realpathSync(path.join(RAW_BASE, 'project'))

// Bun's os.homedir() ignores runtime HOME changes, so we mock the module
await mock.module('node:os', () => ({
  homedir: () => TEMP_HOME,
}))

const origCwd = process.cwd()

// Dynamic import so context.js gets the mocked os.homedir
const { buildLintContext } = await import('./context.js')

beforeEach(async () => {
  // Clean .claude dirs from both locations
  await rm(path.join(TEMP_HOME, '.claude'), { recursive: true, force: true })
  await rm(path.join(TEMP_PROJECT, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_PROJECT)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('buildLintContext', () => {
  test('returns empty settingsFiles when none exist', () => {
    const ctx = buildLintContext()
    expect(ctx.settingsFiles).toEqual([])
    expect(ctx.home).toBe(TEMP_HOME)
    expect(ctx.projectDir).toBe(TEMP_PROJECT)
  })

  test('finds user settings.json', async () => {
    await mkdir(path.join(TEMP_HOME, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_HOME, '.claude/settings.json'), '{"key": "value"}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(1)
    expect(ctx.settingsFiles[0]!.scope).toBe('user')
    expect(ctx.settingsFiles[0]!.data).toEqual({ key: 'value' })
  })

  test('finds project settings.json', async () => {
    await mkdir(path.join(TEMP_PROJECT, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_PROJECT, '.claude/settings.json'), '{"hooks": {}}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(1)
    expect(ctx.settingsFiles[0]!.scope).toBe('project')
  })

  test('finds project-local settings.json', async () => {
    await mkdir(path.join(TEMP_PROJECT, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_PROJECT, '.claude/settings.local.json'), '{"statusLine": {}}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(1)
    expect(ctx.settingsFiles[0]!.scope).toBe('project-local')
  })

  test('finds all three settings files', async () => {
    await mkdir(path.join(TEMP_HOME, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_HOME, '.claude/settings.json'), '{}')
    await mkdir(path.join(TEMP_PROJECT, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_PROJECT, '.claude/settings.json'), '{}')
    await writeFile(path.join(TEMP_PROJECT, '.claude/settings.local.json'), '{}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(3)
  })

  test('skips invalid JSON files', async () => {
    await mkdir(path.join(TEMP_HOME, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_HOME, '.claude/settings.json'), 'not valid json{{{')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles.length).toBe(0)
  })

  test('displayPath replaces home with ~', async () => {
    await mkdir(path.join(TEMP_HOME, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_HOME, '.claude/settings.json'), '{}')

    const ctx = buildLintContext()
    expect(ctx.settingsFiles[0]!.displayPath).toStartWith('~')
    expect(ctx.settingsFiles[0]!.displayPath).not.toContain(TEMP_HOME)
  })

  test('displayPath keeps non-home paths as-is', async () => {
    await mkdir(path.join(TEMP_PROJECT, '.claude'), { recursive: true })
    await writeFile(path.join(TEMP_PROJECT, '.claude/settings.json'), '{}')

    const ctx = buildLintContext()
    // TEMP_PROJECT is not under TEMP_HOME, so displayPath keeps the full path
    expect(ctx.settingsFiles[0]!.displayPath).not.toStartWith('~')
  })
})
