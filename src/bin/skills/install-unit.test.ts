import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsInstall } from './install.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-install-test-${Math.random().toString(36).slice(2, 8)}`)
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

describe('skillsInstall', () => {
  test('imports a skills.sh skill into shan-managed library and router layout', async () => {
    const fakeRunner = (_args: readonly string[]) =>
      Effect.gen(function* () {
        const importedDir = path.join(TEMP_DIR, '.claude', 'skills', 'ts-tooling')
        yield* Effect.tryPromise(() => mkdir(importedDir, { recursive: true }))
        yield* Effect.tryPromise(() =>
          writeFile(
            path.join(importedDir, 'SKILL.md'),
            '---\nname: ts:tooling\ndescription: Imported from skills.sh\n---\n# ts:tooling\n',
          ),
        )
        return { stdout: 'imported', stderr: '' }
      })

    await run(
      skillsInstall('local-source', {
        scope: 'project',
        all: false,
        skills: ['ts:tooling'],
        runCli: fakeRunner,
      }),
    )

    const librarySkillPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'ts', 'tooling')
    const libraryStat = await lstat(librarySkillPath)
    expect(libraryStat.isDirectory()).toBe(true)

    const outfitSkillPath = path.join(TEMP_DIR, '.claude', 'skills', 'ts_tooling')
    const outfitStat = await lstat(outfitSkillPath)
    expect(outfitStat.isSymbolicLink()).toBe(true)
    expect(await readlink(outfitSkillPath)).toBe(librarySkillPath)

    const routerPath = path.join(TEMP_DIR, '.claude', 'skills', 'ts', 'SKILL.md')
    const routerStat = await lstat(routerPath)
    expect(routerStat.isFile()).toBe(true)
  })
})
