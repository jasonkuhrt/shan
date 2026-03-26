import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
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
  test('fails when source is missing', async () => {
    await expect(
      run(
        skillsInstall('', {
          scope: 'project',
          all: false,
          skills: ['ts:tooling'],
        }),
      ),
    ).rejects.toThrow('Missing targets')
  })

  test('fails when neither --all nor --skill selectors were provided', async () => {
    await expect(
      run(
        skillsInstall('local-source', {
          scope: 'project',
          all: false,
          skills: [],
        }),
      ),
    ).rejects.toThrow('Missing targets')
  })

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

  test('prints importer output and exits cleanly when no new skills were added', async () => {
    const output: string[] = []
    const errors: string[] = []
    const origLog = console.log
    const origErr = console.error
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }

    try {
      await run(
        skillsInstall('local-source', {
          scope: 'project',
          all: false,
          skills: ['ts:tooling'],
          runCli: () => Effect.succeed({ stdout: 'imported stdout', stderr: 'imported stderr' }),
        }),
      )
    } finally {
      console.log = origLog
      console.error = origErr
    }

    expect(output.join('\n')).toContain('imported stdout')
    expect(output.join('\n')).toContain('No new skills were imported.')
    expect(errors.join('\n')).toContain('imported stderr')
  })

  test('uses wildcard import when --all is enabled', async () => {
    const seenArgs: string[][] = []

    await run(
      skillsInstall('local-source', {
        scope: 'project',
        all: true,
        skills: [],
        runCli: (args) =>
          Effect.gen(function* () {
            seenArgs.push([...args])
            const importedDir = path.join(TEMP_DIR, '.claude', 'skills', 'alpha')
            yield* Effect.tryPromise(() => mkdir(importedDir, { recursive: true }))
            yield* Effect.tryPromise(() =>
              writeFile(
                path.join(importedDir, 'SKILL.md'),
                '---\nname: alpha\ndescription: Imported alpha\n---\n# alpha\n',
              ),
            )
            return { stdout: '', stderr: '' }
          }),
      }),
    )

    expect(seenArgs).toEqual([
      ['add', 'local-source', '--agent', 'claude-code', '--copy', '--skill', '*'],
    ])

    const librarySkillPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'alpha')
    const libraryStat = await lstat(librarySkillPath)
    expect(libraryStat.isDirectory()).toBe(true)
  })

  test('uses the default npx runner when runCli is omitted', async () => {
    const binDir = path.join(TEMP_DIR, 'bin')
    const npxPath = path.join(binDir, 'npx')
    const argsLogPath = path.join(TEMP_DIR, 'fake-npx-args.txt')
    const fakeImportedDir = path.join(TEMP_DIR, '.claude', 'skills', 'remote-tooling')
    const output: string[] = []
    const errors: string[] = []
    const origPath = process.env['PATH'] ?? ''
    const origLog = console.log
    const origErr = console.error

    await mkdir(binDir, { recursive: true })
    await writeFile(
      npxPath,
      `#!/bin/sh
printf '%s\n' "$@" > "${argsLogPath}"
mkdir -p "${fakeImportedDir}"
cat > "${path.join(fakeImportedDir, 'SKILL.md')}" <<'EOF'
---
name: remote:tooling
description: Imported from fake npx
---
# remote:tooling
EOF
printf 'default runner stdout\n'
printf 'default runner stderr\n' >&2
`,
    )
    await chmod(npxPath, 0o755)

    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }

    try {
      process.env['PATH'] = `${binDir}:${origPath}`
      await run(
        skillsInstall('remote-source', {
          scope: 'project',
          all: false,
          skills: ['remote:tooling'],
        }),
      )
    } finally {
      process.env['PATH'] = origPath
      console.log = origLog
      console.error = origErr
    }

    expect(await readFile(argsLogPath, 'utf-8')).toContain('remote-source')
    expect(output.join('\n')).toContain('default runner stdout')
    expect(errors.join('\n')).toContain('default runner stderr')

    const librarySkillPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'remote', 'tooling')
    expect((await lstat(librarySkillPath)).isDirectory()).toBe(true)
  })

  test('passes --global to the skills CLI when installing at user scope', async () => {
    const seenArgs: string[][] = []

    await run(
      skillsInstall('local-source', {
        scope: 'user',
        all: false,
        skills: ['user:skill'],
        runCli: (args) =>
          Effect.sync(() => {
            seenArgs.push([...args])
            return { stdout: '', stderr: '' }
          }),
      }),
    )

    expect(seenArgs).toEqual([
      [
        'add',
        'local-source',
        '--agent',
        'claude-code',
        '--copy',
        '--global',
        '--skill',
        'user:skill',
      ],
    ])
  })

  test('fails when the normalized imported path is already occupied', async () => {
    const occupiedPath = path.join(TEMP_DIR, '.claude', 'skills', 'ts_tooling')
    await mkdir(occupiedPath, { recursive: true })

    await expect(
      run(
        skillsInstall('local-source', {
          scope: 'project',
          all: false,
          skills: ['ts:tooling'],
          runCli: () =>
            Effect.gen(function* () {
              const importedDir = path.join(TEMP_DIR, '.claude', 'skills', 'ts-tooling')
              yield* Effect.tryPromise(() => mkdir(importedDir, { recursive: true }))
              yield* Effect.tryPromise(() =>
                writeFile(
                  path.join(importedDir, 'SKILL.md'),
                  '---\nname: ts:tooling\ndescription: Imported from skills.sh\n---\n# ts:tooling\n',
                ),
              )
              return { stdout: '', stderr: '' }
            }),
        }),
      ),
    ).rejects.toThrow('Imported skill path already exists: ts_tooling')
  })
})
