import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsList } from './list.js'
import { skillsOn } from './on.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-list-test-${Math.random().toString(36).slice(2, 8)}`)
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

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsList', () => {
  test('runs with empty project outfit', async () => {
    // No skills installed — just ensure it doesn't crash
    await run(skillsList())
  })

  test('shows pluggable skills at project scope', async () => {
    await setupProjectLibrary('list-skill-a', 'list-skill-b')
    await run(skillsOn('list-skill-a,list-skill-b', { scope: 'project', strict: false }))

    // Should complete without error
    await run(skillsList())
  })

  test('shows core skills in outfit', async () => {
    // Create a core skill (real directory)
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const coreDir = path.join(outfitDir, 'my-core')
    await mkdir(coreDir, { recursive: true })
    await writeFile(path.join(coreDir, 'SKILL.md'), SKILL_MD('my-core'))

    await run(skillsList())
  })

  test('prefers frontmatter names when rendering core skills', async () => {
    const output: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }

    try {
      const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
      const coreDir = path.join(outfitDir, 'git_sync')
      await mkdir(coreDir, { recursive: true })
      await writeFile(
        path.join(coreDir, 'SKILL.md'),
        '---\nname: "git:sync"\ndescription: Test skill git:sync\n---\n# git:sync\n',
      )

      await run(skillsList())
    } finally {
      console.log = origLog
    }

    expect(output.join('\n')).toContain('Core (project):\n  ● git:sync')
  })

  test('shows off skills from library', async () => {
    // Skills in library but not installed
    await setupProjectLibrary('off-skill-1', 'off-skill-2')

    await run(skillsList())
  })

  test('renders legacy flat library dirs in canonical colon form', async () => {
    const output: string[] = []
    const origLog = console.log
    const canonicalName = 'zzlegacy:test-entry'
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }

    try {
      const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
      const skillDir = path.join(libDir, 'zzlegacy_test-entry')
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: "zzlegacy:test-entry"\ndescription: Test skill zzlegacy:test-entry\n---\n# zzlegacy:test-entry\n',
      )

      await run(skillsList())
    } finally {
      console.log = origLog
    }

    expect(output.join('\n')).toContain('zzlegacy: test-entry')
    expect(output.join('\n')).not.toContain(canonicalName.replace(':', '_'))
  })

  test('does not render corrupted library entries as off skills', async () => {
    const output: string[] = []
    const origLog = console.log
    const corruptDisplayName = 'zzcorrupt:test-entry'
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }

    try {
      const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
      const skillDir = path.join(libDir, 'zzcorrupt_test-entry')
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: "zzcorrupt_test-entry"\ndescription: Test skill zzcorrupt_test-entry\n---\n# zzcorrupt_test-entry\n',
      )

      await run(skillsList())
    } finally {
      console.log = origLog
    }

    expect(output.join('\n')).not.toContain(corruptDisplayName)
    expect(output.join('\n')).not.toContain('  zzcorrupt_test-entry')
  })

  test('respects SLASH_COMMAND_TOOL_CHAR_BUDGET', async () => {
    const origBudget = process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']
    process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET'] = '50000'

    try {
      await setupProjectLibrary('budget-skill')
      await run(skillsOn('budget-skill', { scope: 'project', strict: false }))
      await run(skillsList())
    } finally {
      if (origBudget !== undefined) {
        process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET'] = origBudget
      } else {
        delete process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']
      }
    }
  })

  test('handles invalid SLASH_COMMAND_TOOL_CHAR_BUDGET gracefully', async () => {
    const origBudget = process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']
    process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET'] = 'not-a-number'

    try {
      await run(skillsList())
    } finally {
      if (origBudget !== undefined) {
        process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET'] = origBudget
      } else {
        delete process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']
      }
    }
  })

  test('shows grouped off skills with namespace prefix', async () => {
    // Create a group with multiple leaves
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['leaf-a', 'leaf-b']) {
      const leafDir = path.join(libDir, 'ns', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "ns:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    await run(skillsList())
  })

  test('handles skill with disableModelInvocation', async () => {
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const skillDir = path.join(libDir, 'disabled-model')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: disabled-model\ndescription: Test\ndisable-model-invocation: true\n---\n# disabled-model\n`,
    )
    await run(skillsOn('disabled-model', { scope: 'project', strict: false }))

    await run(skillsList())
  })
})
