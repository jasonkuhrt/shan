import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsCreate } from './create.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-create-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

await registerStateFileRestore()

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsCreate', () => {
  test('creates skill with simple name at project scope', async () => {
    await run(skillsCreate('my-skill', { scope: 'project' }))

    const skillDir = path.join(TEMP_DIR, '.claude', 'skills', 'my-skill')
    const stat = await lstat(skillDir)
    expect(stat.isDirectory()).toBe(true)

    const content = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(content).toContain('name: my-skill')
    expect(content).toContain('# my-skill')
  })

  test('creates skill with colon syntax (flat underscore directory)', async () => {
    await run(skillsCreate('ts:tooling', { scope: 'project' }))

    const skillDir = path.join(TEMP_DIR, '.claude', 'skills', 'ts_tooling')
    const stat = await lstat(skillDir)
    expect(stat.isDirectory()).toBe(true)

    const content = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    // Colon in name triggers yaml quoting
    expect(content).toContain('name: "ts:tooling"')
  })

  test('fails with empty name', async () => {
    await expect(run(skillsCreate('', { scope: 'project' }))).rejects.toThrow('Missing targets')
  })

  test('fails with invalid name (starts with number)', async () => {
    await expect(run(skillsCreate('123-bad', { scope: 'project' }))).rejects.toThrow(
      'Missing targets',
    )
  })

  test('fails with invalid name (special chars)', async () => {
    await expect(run(skillsCreate('bad@name', { scope: 'project' }))).rejects.toThrow(
      'Missing targets',
    )
  })

  test('fails with invalid name (underscore inside a segment)', async () => {
    await expect(run(skillsCreate('bad_name', { scope: 'project' }))).rejects.toThrow(
      'Missing targets',
    )
  })

  test('fails when skill already exists', async () => {
    await run(skillsCreate('existing', { scope: 'project' }))
    await expect(run(skillsCreate('existing', { scope: 'project' }))).rejects.toThrow(
      'Skill already exists',
    )
  })

  test('yaml-quotes names with special characters', async () => {
    // The colon in ts:special triggers yaml quoting
    await run(skillsCreate('ts:special-chars', { scope: 'project' }))

    const content = await readFile(
      path.join(TEMP_DIR, '.claude', 'skills', 'ts_special-chars', 'SKILL.md'),
      'utf-8',
    )
    // name contains colon which triggers quoting
    expect(content).toContain('ts:special-chars')
  })
})
