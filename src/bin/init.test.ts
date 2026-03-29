import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { detectSystemClaudeRuleBasename, shanInitWith } from './init.js'

const withInitEnv = async (fn: (ctx: { homeDir: string; projectDir: string }) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'shan-init-home-'))
  const projectDir = await mkdtemp(path.join(tmpdir(), 'shan-init-project-'))
  const origHome = process.env['HOME']
  const origCwd = process.cwd()

  try {
    process.env['HOME'] = homeDir
    process.chdir(projectDir)
    await fn({ homeDir, projectDir })
  } finally {
    process.env['HOME'] = origHome
    process.chdir(origCwd)
    await rm(homeDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  }
}

describe('detectSystemClaudeRuleBasename', () => {
  test('prefers uppercase when both Claude rule files exist', async () => {
    await withInitEnv(async ({ homeDir }) => {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# upper\n')
      await writeFile(path.join(homeDir, '.claude', 'claude.md'), '# lower\n')

      await expect(Effect.runPromise(detectSystemClaudeRuleBasename(homeDir))).resolves.toBe(
        'CLAUDE.md',
      )
    })
  })

  test('falls back to lowercase when only lowercase exists', async () => {
    await withInitEnv(async ({ homeDir }) => {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'claude.md'), '# lower\n')

      await expect(Effect.runPromise(detectSystemClaudeRuleBasename(homeDir))).resolves.toBe(
        'claude.md',
      )
    })
  })

  test('defaults to uppercase when no system Claude rule files exist', async () => {
    await withInitEnv(async ({ homeDir }) => {
      await expect(Effect.runPromise(detectSystemClaudeRuleBasename(homeDir))).resolves.toBe(
        'CLAUDE.md',
      )
    })
  })
})

describe('shanInit', () => {
  test('scaffolds Heartbeat-style files from uppercase system config', async () => {
    await withInitEnv(async ({ homeDir, projectDir }) => {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# system\n')

      await Effect.runPromise(shanInitWith({ homeDir, projectRoot: projectDir }))

      await expect(readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
        '@.claude/CLAUDE.md\n@.claude/*.local.md\n',
      )
      await expect(
        readFile(path.join(projectDir, '.claude', 'CLAUDE.md'), 'utf8'),
      ).resolves.toContain('Project Instructions')
      await expect(
        readFile(path.join(projectDir, '.claude', 'CLAUDE.local.md'), 'utf8'),
      ).resolves.toContain('Local Overlay')
    })
  })

  test('uses lowercase naming when the system config is lowercase', async () => {
    await withInitEnv(async ({ homeDir, projectDir }) => {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'claude.md'), '# system\n')

      await Effect.runPromise(shanInitWith({ homeDir, projectRoot: projectDir }))

      await expect(readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
        '@.claude/claude.md\n@.claude/*.local.md\n',
      )
      await expect(
        readFile(path.join(projectDir, '.claude', 'claude.md'), 'utf8'),
      ).resolves.toContain('local claude.md convention')
      await expect(
        readFile(path.join(projectDir, '.claude', 'claude.local.md'), 'utf8'),
      ).resolves.toContain('Local Overlay')
    })
  })

  test('preserves existing files and only creates missing ones', async () => {
    await withInitEnv(async ({ homeDir, projectDir }) => {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# system\n')
      await mkdir(path.join(projectDir, '.claude'), { recursive: true })
      await writeFile(path.join(projectDir, 'AGENTS.md'), 'existing agents\n')
      await writeFile(path.join(projectDir, '.claude', 'CLAUDE.md'), 'existing claude\n')

      await Effect.runPromise(shanInitWith({ homeDir, projectRoot: projectDir }))

      await expect(readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
        'existing agents\n',
      )
      await expect(readFile(path.join(projectDir, '.claude', 'CLAUDE.md'), 'utf8')).resolves.toBe(
        'existing claude\n',
      )
      await expect(
        readFile(path.join(projectDir, '.claude', 'CLAUDE.local.md'), 'utf8'),
      ).resolves.toContain('Local Overlay')
    })
  })

  test('leaves the project unchanged when all scaffolded files already exist', async () => {
    await withInitEnv(async ({ homeDir, projectDir }) => {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true })
      await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# system\n')
      await mkdir(path.join(projectDir, '.claude'), { recursive: true })
      await writeFile(path.join(projectDir, 'AGENTS.md'), 'existing agents\n')
      await writeFile(path.join(projectDir, '.claude', 'CLAUDE.md'), 'existing claude\n')
      await writeFile(path.join(projectDir, '.claude', 'CLAUDE.local.md'), 'existing local\n')

      await Effect.runPromise(shanInitWith({ homeDir, projectRoot: projectDir }))

      await expect(readFile(path.join(projectDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
        'existing agents\n',
      )
      await expect(readFile(path.join(projectDir, '.claude', 'CLAUDE.md'), 'utf8')).resolves.toBe(
        'existing claude\n',
      )
      await expect(
        readFile(path.join(projectDir, '.claude', 'CLAUDE.local.md'), 'utf8'),
      ).resolves.toBe('existing local\n')
    })
  })
})
