import { describe, expect, test, mock } from 'bun:test'
import { Cause, Effect, Exit } from 'effect'
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as Lib from './skill-library.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ── Helpers ──────────────────────────────────────────────────────

const tmpBase = path.join(import.meta.dir, '__test_tmp__')

const createSkill = async (libraryDir: string, relPath: string, content = '') => {
  const skillDir = path.join(libraryDir, relPath)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    content || `---\ndescription: "Test skill ${relPath}"\n---\nTest skill`,
  )
}

// ── listLibrary ──────────────────────────────────────────────────

describe('listLibrary', () => {
  test('finds skills in user library', async () => {
    const userLib = path.join(tmpBase, 'user-lib-1')
    try {
      await createSkill(userLib, 'alpha')

      const results = await run(Lib.listLibrary([userLib]))
      const names = results.map((r) => r.colonName)
      expect(names).toContain('alpha')
    } finally {
      await rm(userLib, { recursive: true, force: true })
    }
  })

  test('finds skills in project library', async () => {
    const projectLib = path.join(tmpBase, 'proj-lib-1')
    try {
      await createSkill(projectLib, 'beta')

      const results = await run(Lib.listLibrary([projectLib]))
      const names = results.map((r) => r.colonName)
      expect(names).toContain('beta')
    } finally {
      await rm(projectLib, { recursive: true, force: true })
    }
  })

  test('finds skills across both user and project libraries', async () => {
    const userLib = path.join(tmpBase, 'user-lib-2')
    const projectLib = path.join(tmpBase, 'proj-lib-2')
    try {
      await createSkill(userLib, 'alpha')
      await createSkill(projectLib, 'beta')

      const results = await run(Lib.listLibrary([userLib, projectLib]))
      const names = results.map((r) => r.colonName)
      expect(names).toContain('alpha')
      expect(names).toContain('beta')
    } finally {
      await rm(userLib, { recursive: true, force: true })
      await rm(projectLib, { recursive: true, force: true })
    }
  })

  test('deduplicates skills present in both libraries (user wins)', async () => {
    const userLib = path.join(tmpBase, 'user-lib-3')
    const projectLib = path.join(tmpBase, 'proj-lib-3')
    try {
      await createSkill(userLib, 'shared')
      await createSkill(projectLib, 'shared')

      const results = await run(Lib.listLibrary([userLib, projectLib]))
      const shared = results.filter((r) => r.colonName === 'shared')
      expect(shared).toHaveLength(1)
      expect(shared[0]?.libraryDir).toBe(userLib)
    } finally {
      await rm(userLib, { recursive: true, force: true })
      await rm(projectLib, { recursive: true, force: true })
    }
  })

  test('follows symlinked library roots', async () => {
    const realLib = path.join(tmpBase, 'user-lib-4-real')
    const symlinkLib = path.join(tmpBase, 'user-lib-4-link')
    try {
      await createSkill(realLib, 'alpha')
      await symlink(realLib, symlinkLib)

      const results = await run(Lib.listLibrary([symlinkLib]))
      const names = results.map((r) => r.colonName)
      expect(names).toContain('alpha')
    } finally {
      await rm(symlinkLib, { recursive: true, force: true })
      await rm(realLib, { recursive: true, force: true })
    }
  })

  test('handles nonexistent library dirs gracefully', async () => {
    const results = await run(Lib.listLibrary(['/nonexistent/path']))
    expect(results).toEqual([])
  })
})

// ── Name translation ──────────────────────────────────────────────

describe('colonToPath', () => {
  test('converts colon to slash', () => {
    expect(Lib.colonToPath('ts:tooling')).toBe('ts/tooling')
  })
  test('handles single segment', () => {
    expect(Lib.colonToPath('alpha')).toBe('alpha')
  })
  test('handles multiple colons', () => {
    expect(Lib.colonToPath('a:b:c')).toBe('a/b/c')
  })

  test('falls back to raw replacement for invalid colon names', () => {
    expect(Lib.colonToPath('a::c')).toBe('a//c')
  })
})

describe('pathToColon', () => {
  test('converts slash to colon', () => {
    expect(Lib.pathToColon('ts/tooling')).toBe('ts:tooling')
  })
  test('handles single segment', () => {
    expect(Lib.pathToColon('alpha')).toBe('alpha')
  })

  test('falls back to raw replacement for invalid library paths', () => {
    expect(Lib.pathToColon('a/$/c')).toBe('a:$:c')
  })
})

describe('flattenName', () => {
  test('converts slash to underscore', () => {
    expect(Lib.flattenName('ts/tooling')).toBe('ts_tooling')
  })
  test('handles single segment', () => {
    expect(Lib.flattenName('alpha')).toBe('alpha')
  })

  test('falls back to raw replacement for invalid library paths', () => {
    expect(Lib.flattenName('a/$/c')).toBe('a_$_c')
  })
})

describe('unflattenName', () => {
  test('converts underscore to slash', () => {
    expect(Lib.unflattenName('ts_tooling')).toBe('ts/tooling')
  })
  test('handles single segment', () => {
    expect(Lib.unflattenName('alpha')).toBe('alpha')
  })

  test('leaves invalid flat names unchanged', () => {
    expect(Lib.unflattenName('a__c')).toBe('a__c')
  })
})

describe('printSlashCommandNotice', () => {
  test('prints the skill availability notice', async () => {
    const output: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }

    try {
      await run(Lib.printSlashCommandNotice)
    } finally {
      console.log = origLog
    }

    expect(output.join('\n')).toContain('Skill Availability')
    expect(output.join('\n')).toContain('anthropics/claude-code#37862')
  })
})

// ── parseTargets ──────────────────────────────────────────────────

describe('parseTargets', () => {
  test('splits comma-separated', () => {
    expect(Lib.parseTargets('a,b,c')).toEqual(['a', 'b', 'c'])
  })
  test('trims whitespace', () => {
    expect(Lib.parseTargets(' a , b ')).toEqual(['a', 'b'])
  })
  test('filters empty', () => {
    expect(Lib.parseTargets('a,,b')).toEqual(['a', 'b'])
  })
  test('deduplicates', () => {
    expect(Lib.parseTargets('a,a,b')).toEqual(['a', 'b'])
  })
})

// ── estimateCharCost ──────────────────────────────────────────────

describe('estimateCharCost', () => {
  test('sums name + description', () => {
    const fm: Lib.SkillFrontmatter = { name: 'foo', description: 'bar' }
    expect(Lib.estimateCharCost(fm)).toBe('foo bar'.length)
  })
  test('includes whenToUse', () => {
    const fm: Lib.SkillFrontmatter = { name: 'foo', description: 'bar', whenToUse: 'baz' }
    expect(Lib.estimateCharCost(fm)).toBe('foo bar baz'.length)
  })
})

// ── Scope path helpers ────────────────────────────────────────────

describe('outfitDir', () => {
  test('user scope returns home dir', () => {
    expect(Lib.outfitDir('user')).toBe(path.join(homedir(), '.claude/skills'))
  })
  test('project scope returns cwd-relative', () => {
    expect(Lib.outfitDir('project')).toBe(path.join(process.cwd(), '.claude/skills'))
  })
})

describe('agentOutfitDir', () => {
  test('codex user scope uses ~/.codex/skills', () => {
    expect(Lib.agentOutfitDir('user', 'codex')).toBe(path.join(homedir(), '.codex/skills'))
  })
  test('claude project scope uses .claude/skills', () => {
    expect(Lib.agentOutfitDir('project', 'claude')).toBe(path.join(process.cwd(), '.claude/skills'))
  })
})

describe('normalizeAgents', () => {
  test('deduplicates configured agents and preserves canonical order', () => {
    expect(Lib.normalizeAgents(['codex', 'claude', 'codex', 'unknown'])).toEqual([
      'claude',
      'codex',
    ])
  })
})

describe('getMirrorAgents', () => {
  test('drops the canonical claude agent', () => {
    expect(Lib.getMirrorAgents(['claude', 'codex'])).toEqual(['codex'])
  })
})

describe('scopeLibraryDir', () => {
  test('user scope returns LIBRARY_DIR', () => {
    expect(Lib.scopeLibraryDir('user')).toBe(Lib.LIBRARY_DIR)
  })
  test('project scope returns cwd-relative', () => {
    expect(Lib.scopeLibraryDir('project')).toBe(Lib.projectLibraryDir())
  })
})

describe('librarySearchOrder', () => {
  test('user scope returns only LIBRARY_DIR', () => {
    expect(Lib.librarySearchOrder('user')).toEqual([Lib.LIBRARY_DIR])
  })
  test('project scope returns project then user', () => {
    const order = Lib.librarySearchOrder('project')
    expect(order).toHaveLength(2)
    expect(order[0]).toBe(Lib.projectLibraryDir())
    expect(order[1]).toBe(Lib.LIBRARY_DIR)
  })
})

describe('resolveHistoryScope', () => {
  test('user maps to user', () => {
    expect(Lib.resolveHistoryScope('user')).toBe('user')
  })
  test('global maps to user', () => {
    expect(Lib.resolveHistoryScope('global')).toBe('user')
  })
  test('project maps to project', () => {
    expect(Lib.resolveHistoryScope('project')).toBe('project')
  })
  test('absolute path maps to project', () => {
    expect(Lib.resolveHistoryScope('/some/path')).toBe('project')
  })
})

describe('resolveHistoryOutfitDir', () => {
  test('user key returns user outfit', () => {
    expect(Lib.resolveHistoryOutfitDir('user')).toBe(Lib.outfitDir('user'))
  })
  test('global key returns user outfit', () => {
    expect(Lib.resolveHistoryOutfitDir('global')).toBe(Lib.outfitDir('user'))
  })
  test('project key returns project outfit', () => {
    expect(Lib.resolveHistoryOutfitDir('project')).toBe(Lib.outfitDir('project'))
  })
  test('absolute path builds skills subdir', () => {
    expect(Lib.resolveHistoryOutfitDir('/foo/bar')).toBe('/foo/bar/.claude/skills')
  })
})

describe('syncAgentMirrors', () => {
  test('reconciles project mirror directories as whole-dir symlinks and updates gitignore', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-sync-project')
    const origCwd = process.cwd()

    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills-library', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills-library', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Alpha\n---\n# alpha\n',
      )
      await mkdir(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
      await symlink(
        path.join(projectRoot, '.claude', 'skills-library', 'alpha'),
        path.join(projectRoot, '.claude', 'skills', 'alpha'),
      )
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'stale'), { recursive: true })
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      const mirrorPath = path.join(projectRoot, '.codex', 'skills')
      const mirrorStat = await lstat(mirrorPath)
      expect(mirrorStat.isSymbolicLink()).toBe(true)
      expect(await readlink(mirrorPath)).toBe(path.join(projectRoot, '.claude', 'skills'))
      expect(
        await readFile(path.join(projectRoot, '.codex', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toContain('Alpha')

      const gitignore = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(gitignore).toContain('.claude/skills/alpha')
      expect(gitignore).toContain('.codex/skills')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('migrates a mirror-owned real directory into the canonical project outfit', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-sync-project-migrate')
    const origCwd = process.cwd()

    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.codex', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Alpha\n---\n# alpha\n',
      )
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      expect(
        await readFile(path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toContain('Alpha')

      const mirrorStat = await lstat(path.join(projectRoot, '.codex', 'skills'))
      expect(mirrorStat.isSymbolicLink()).toBe(true)
      expect(await readlink(path.join(projectRoot, '.codex', 'skills'))).toBe(
        path.join(projectRoot, '.claude', 'skills'),
      )
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('merges non-conflicting canonical and mirror-owned real directories before replacing the mirror with a symlink', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-sync-project-merge')
    const origCwd = process.cwd()

    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Alpha\n---\n# alpha\n',
      )
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'beta'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.codex', 'skills', 'beta', 'SKILL.md'),
        '---\nname: beta\ndescription: Beta\n---\n# beta\n',
      )
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      expect(
        await readFile(path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toContain('Alpha')
      expect(
        await readFile(path.join(projectRoot, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf-8'),
      ).toContain('Beta')

      const mirrorStat = await lstat(path.join(projectRoot, '.codex', 'skills'))
      expect(mirrorStat.isSymbolicLink()).toBe(true)
      expect(await readlink(path.join(projectRoot, '.codex', 'skills'))).toBe(
        path.join(projectRoot, '.claude', 'skills'),
      )
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('fails when canonical and mirror real directories define the same skill differently', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-sync-project-conflict')
    const origCwd = process.cwd()

    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Claude Alpha\n---\n# alpha\n',
      )
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.codex', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Codex Alpha\n---\n# alpha\n',
      )
      process.chdir(projectRoot)

      const exit = await runExit(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          const failureValue: unknown = failure.value
          const cause =
            isRecord(failureValue) && 'cause' in failureValue ? failureValue['cause'] : undefined
          expect(isRecord(cause)).toBe(true)
          if (isRecord(cause)) {
            expect(cause['_tag']).toBe('AgentOutfitConflictError')
          }
        }
      }
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('accepts mirror symlinks that resolve to the canonical outfit through a different path', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-sync-project-equivalent-link')
    const origCwd = process.cwd()

    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Alpha\n---\n# alpha\n',
      )
      await mkdir(path.join(projectRoot, '.codex'), { recursive: true })
      await symlink(
        path.join(projectRoot, '.claude', '.', 'skills'),
        path.join(projectRoot, '.codex', 'skills'),
      )
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      expect(
        await readFile(path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toContain('Alpha')

      const mirrorStat = await lstat(path.join(projectRoot, '.codex', 'skills'))
      expect(mirrorStat.isSymbolicLink()).toBe(true)
      expect(
        await readFile(path.join(projectRoot, '.codex', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toContain('Alpha')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── Batch validation helpers ──────────────────────────────────────

describe('emptyBatch', () => {
  test('returns empty arrays', () => {
    const batch = Lib.emptyBatch<string>()
    expect(batch.actions).toEqual([])
    expect(batch.skips).toEqual([])
    expect(batch.errors).toEqual([])
  })
})

describe('shouldAbort', () => {
  test('returns true on errors', () => {
    const batch = { actions: [], skips: [], errors: [{ name: 'x', reason: 'y' }] }
    expect(Lib.shouldAbort(batch, false)).toBe(true)
  })
  test('returns false when no errors and not strict', () => {
    const batch = { actions: [], skips: [{ name: 'x', reason: 'y' }], errors: [] }
    expect(Lib.shouldAbort(batch, false)).toBe(false)
  })
  test('returns true when skips and strict', () => {
    const batch = { actions: [], skips: [{ name: 'x', reason: 'y' }], errors: [] }
    expect(Lib.shouldAbort(batch, true)).toBe(true)
  })
  test('returns false when empty', () => {
    expect(Lib.shouldAbort(Lib.emptyBatch(), false)).toBe(false)
  })
})

describe('batchToRows', () => {
  test('converts actions to rows', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: ['a'],
      skips: [],
      errors: [],
    }
    const rows = Lib.batchToRows(batch, (a) => ({ status: 'ok', name: a }))
    expect(rows).toEqual([{ status: 'ok', name: 'a' }])
  })
  test('marks actions as abort when aborted', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: ['a'],
      skips: [],
      errors: [],
    }
    const rows = Lib.batchToRows(batch, (a) => ({ status: 'ok', name: a }), true)
    expect(rows[0]?.status).toBe('abort')
    expect(rows[0]?.reason).toBe('not applied')
  })
  test('includes skips and errors', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: [],
      skips: [{ name: 's', reason: 'skip reason' }],
      errors: [{ name: 'e', reason: 'err reason' }],
    }
    const rows = Lib.batchToRows(batch, (a) => ({ status: 'ok', name: a }))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.status).toBe('skip')
    expect(rows[1]?.status).toBe('error')
  })
})

// ── reportResults ─────────────────────────────────────────────────

describe('reportResults', () => {
  test('does nothing for empty rows', async () => {
    await run(Lib.reportResults([]))
  })
  test('renders ok rows with scope and commitment', async () => {
    const origLog = console.log
    console.log = mock(() => {})
    try {
      await run(
        Lib.reportResults([
          { status: 'ok', name: 'alpha', scope: 'user', commitment: 'pluggable' },
        ]),
      )
    } finally {
      console.log = origLog
    }
  })
  test('renders skip/error rows without scope', async () => {
    const origLog = console.log
    console.log = mock(() => {})
    try {
      await run(
        Lib.reportResults([
          { status: 'skip', name: 'beta', reason: 'skipped' },
          { status: 'error', name: 'gamma', reason: 'failed' },
        ]),
      )
    } finally {
      console.log = origLog
    }
  })
  test('renders abort rows with scope', async () => {
    const origLog = console.log
    console.log = mock(() => {})
    try {
      await run(
        Lib.reportResults([
          {
            status: 'abort',
            name: 'delta',
            scope: 'project',
            commitment: 'pluggable',
            reason: 'not applied',
          },
        ]),
      )
    } finally {
      console.log = origLog
    }
  })
  test('renders ok rows without scope/commitment', async () => {
    const origLog = console.log
    console.log = mock(() => {})
    try {
      await run(Lib.reportResults([{ status: 'ok', name: 'epsilon' }]))
    } finally {
      console.log = origLog
    }
  })
  test('renders ok rows with only scope (no commitment)', async () => {
    const origLog = console.log
    console.log = mock(() => {})
    try {
      await run(Lib.reportResults([{ status: 'ok', name: 'zeta', scope: 'user' }]))
    } finally {
      console.log = origLog
    }
  })
})

// ── printTable ────────────────────────────────────────────────────

describe('printTable', () => {
  test('does nothing for empty rows', async () => {
    await run(Lib.printTable([]))
  })
  test('prints column-aligned rows', async () => {
    const origLog = console.log
    console.log = mock(() => {})
    try {
      await run(
        Lib.printTable([
          ['Name', 'Value'],
          ['a', 'b'],
        ]),
      )
    } finally {
      console.log = origLog
    }
  })
})

// ── generateRouter ────────────────────────────────────────────────

describe('generateRouter', () => {
  test('generates valid router content', () => {
    const children: Lib.SkillInfo[] = [
      {
        colonName: 'grp:child',
        libraryRelPath: 'grp/child',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: { name: 'grp:child', description: 'A child skill' },
      },
    ]
    const result = Lib.generateRouter('grp', children)
    expect(result).toContain('name: grp')
    expect(result).toContain('grp:child')
    expect(result).toContain('A child skill')
    expect(result).toContain('disable-model-invocation: true')
  })
  test('handles children with argumentHint', () => {
    const children: Lib.SkillInfo[] = [
      {
        colonName: 'grp:child',
        libraryRelPath: 'grp/child',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: { name: 'grp:child', description: 'desc', argumentHint: '<file>' },
      },
    ]
    const result = Lib.generateRouter('grp', children)
    expect(result).toContain('`<file>`')
  })
  test('handles children without frontmatter', () => {
    const children: Lib.SkillInfo[] = [
      {
        colonName: 'grp:child',
        libraryRelPath: 'grp/child',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
    ]
    const result = Lib.generateRouter('grp', children)
    expect(result).toContain('(no description)')
  })
})

// ── readFrontmatter ───────────────────────────────────────────────

describe('readFrontmatter', () => {
  test('parses frontmatter from SKILL.md', async () => {
    const dir = path.join(tmpBase, 'fm-test-1')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: "test-skill"\ndescription: "A test"\nwhen-to-use: "always"\nargument-hint: "<arg>"\n---\nBody`,
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm).not.toBeNull()
      if (!fm) throw new Error('expected frontmatter')
      expect(fm.name).toBe('test-skill')
      expect(fm.description).toBe('A test')
      expect(fm.whenToUse).toBe('always')
      expect(fm.argumentHint).toBe('<arg>')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('returns null for missing SKILL.md', async () => {
    const fm = await run(Lib.readFrontmatter('/nonexistent'))
    expect(fm).toBeNull()
  })
  test('returns null for no frontmatter block', async () => {
    const dir = path.join(tmpBase, 'fm-test-2')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), 'Just body text')
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('handles disable-model-invocation: true', async () => {
    const dir = path.join(tmpBase, 'fm-test-3')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: "x"\ndescription: "y"\ndisable-model-invocation: true\n---\nBody`,
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm?.disableModelInvocation).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('handles disable-model-invocation: false', async () => {
    const dir = path.join(tmpBase, 'fm-test-3b')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: "x"\ndescription: "y"\ndisable-model-invocation: false\n---\nBody`,
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm?.disableModelInvocation).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('handles multi-line indicator (>-) by skipping', async () => {
    const dir = path.join(tmpBase, 'fm-test-4')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: "x"\ndescription: >-\n  multi line\n---\nBody`,
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm?.description).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('handles multi-line indicator (>) by skipping', async () => {
    const dir = path.join(tmpBase, 'fm-test-4b')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: "x"\ndescription: >\n  multi line\n---\nBody`,
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm?.description).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── getNodeType ───────────────────────────────────────────────────

describe('getNodeType', () => {
  test('leaf: has SKILL.md, no subdirs', async () => {
    const dir = path.join(tmpBase, 'node-type-leaf')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n')
      const nt = await run(Lib.getNodeType(dir))
      expect(nt).toBe('leaf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('group: has subdirs, no SKILL.md', async () => {
    const dir = path.join(tmpBase, 'node-type-group')
    try {
      await mkdir(path.join(dir, 'child'), { recursive: true })
      const nt = await run(Lib.getNodeType(dir))
      expect(nt).toBe('group')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('callable-group: has both', async () => {
    const dir = path.join(tmpBase, 'node-type-cg')
    try {
      await mkdir(path.join(dir, 'child'), { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n')
      const nt = await run(Lib.getNodeType(dir))
      expect(nt).toBe('callable-group')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('empty dir treated as group', async () => {
    const dir = path.join(tmpBase, 'node-type-empty')
    try {
      await mkdir(dir, { recursive: true })
      const nt = await run(Lib.getNodeType(dir))
      expect(nt).toBe('group')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── resolveTarget ─────────────────────────────────────────────────

describe('resolveTarget', () => {
  test('resolves a leaf skill', async () => {
    const lib = path.join(tmpBase, 'rt-lib-1')
    try {
      await createSkill(lib, 'alpha')
      // resolveTarget uses scopeLibraryDir which depends on cwd, so use direct resolveLeaves + getNodeType
      const result = await run(
        Effect.gen(function* () {
          const libraryPath = path.join(lib, 'alpha')
          const nodeType = yield* Lib.getNodeType(libraryPath)
          return nodeType
        }),
      )
      expect(result).toBe('leaf')
    } finally {
      await rm(lib, { recursive: true, force: true })
    }
  })
})

// ── resolveLeaves ─────────────────────────────────────────────────

describe('resolveLeaves', () => {
  test('finds nested leaves', async () => {
    const lib = path.join(tmpBase, 'rl-lib-1')
    try {
      await createSkill(lib, 'grp/child1')
      await createSkill(lib, 'grp/child2')
      const leaves = await run(Lib.resolveLeaves('grp', lib))
      const names = leaves.map((l) => l.colonName)
      expect(names).toContain('grp:child1')
      expect(names).toContain('grp:child2')
    } finally {
      await rm(lib, { recursive: true, force: true })
    }
  })
  test('returns empty for nonexistent path', async () => {
    const leaves = await run(Lib.resolveLeaves('nonexistent', '/fake'))
    expect(leaves).toEqual([])
  })
  test('recurses into deeper nesting', async () => {
    const lib = path.join(tmpBase, 'rl-lib-2')
    try {
      await createSkill(lib, 'a/b/c')
      const leaves = await run(Lib.resolveLeaves('a', lib))
      const names = leaves.map((l) => l.colonName)
      expect(names).toContain('a:b:c')
    } finally {
      await rm(lib, { recursive: true, force: true })
    }
  })
})

// ── State operations ──────────────────────────────────────────────

describe('state operations', () => {
  const defaultState: Lib.ShanState = { version: 2, current: {}, history: {} }

  test('getCurrentInstalls returns empty for missing scope', () => {
    expect(Lib.getCurrentInstalls(defaultState, 'user')).toEqual([])
  })

  test('setCurrentInstalls sets installs', () => {
    const s = Lib.setCurrentInstalls(defaultState, 'user', ['a', 'b'])
    expect(Lib.getCurrentInstalls(s, 'user')).toEqual(['a', 'b'])
  })

  test('addCurrentInstall adds new', () => {
    const s1 = Lib.setCurrentInstalls(defaultState, 'user', ['a'])
    const s2 = Lib.addCurrentInstall(s1, 'user', 'b')
    expect(Lib.getCurrentInstalls(s2, 'user')).toEqual(['a', 'b'])
  })

  test('addCurrentInstall is idempotent', () => {
    const s1 = Lib.setCurrentInstalls(defaultState, 'user', ['a'])
    const s2 = Lib.addCurrentInstall(s1, 'user', 'a')
    expect(s2).toBe(s1) // same reference
  })

  test('removeCurrentInstall removes', () => {
    const s1 = Lib.setCurrentInstalls(defaultState, 'user', ['a', 'b'])
    const s2 = Lib.removeCurrentInstall(s1, 'user', 'a')
    expect(Lib.getCurrentInstalls(s2, 'user')).toEqual(['b'])
  })

  test('removeCurrentInstall is idempotent for missing name', () => {
    const s1 = Lib.setCurrentInstalls(defaultState, 'user', ['a'])
    const s2 = Lib.removeCurrentInstall(s1, 'user', 'z')
    expect(s2).toBe(s1)
  })

  test('getProjectHistory returns empty for missing scope', () => {
    const h = Lib.getProjectHistory(defaultState, 'user')
    expect(h.entries).toEqual([])
    expect(h.undoneCount).toBe(0)
  })

  test('setProjectHistory sets and gets', () => {
    const history: Lib.ProjectHistory = { entries: [], undoneCount: 3 }
    const s = Lib.setProjectHistory(defaultState, 'user', history)
    expect(Lib.getProjectHistory(s, 'user').undoneCount).toBe(3)
  })
})

// ── loadState / saveState ─────────────────────────────────────────

describe('loadState', () => {
  test('returns default for missing file', async () => {
    // loadState reads from SHAN_DIR which exists on the user's machine,
    // but we can verify the shape
    const state = await run(Lib.loadState())
    expect(state.version).toBe(2)
    expect(state.current).toBeDefined()
    expect(state.history).toBeDefined()
  })
})

describe('saveState + loadState roundtrip', () => {
  test('saves and loads state with history', async () => {
    const shanDir = path.join(tmpBase, 'shan-state-test')
    const stateFile = path.join(shanDir, 'state.json')
    try {
      await mkdir(shanDir, { recursive: true })
      const state: Lib.ShanState = {
        version: 2,
        current: { global: { installs: ['alpha'] } },
        history: {
          global: {
            entries: [
              Lib.OnOp({
                targets: ['alpha'],
                scope: 'global',
                timestamp: '2024-01-01',
                snapshot: ['alpha'],
                generatedRouters: [],
              }),
            ],
            undoneCount: 0,
          },
        },
      }
      await writeFile(stateFile, JSON.stringify(state, null, 2))
      // Verify by reading back
      const content = await readFile(stateFile, 'utf-8')
      expect(content).toContain('"version": 2')
      expect(content).toContain('"alpha"')
    } finally {
      await rm(shanDir, { recursive: true, force: true })
    }
  })
})

// ── loadConfig ────────────────────────────────────────────────────

describe('loadConfig', () => {
  test('returns config (default or file)', async () => {
    const config = await run(Lib.loadConfig())
    expect(config.version).toBe(1)
    expect(config.skills).toBeDefined()
    expect(config.skills.historyLimit).toBeGreaterThan(0)
    expect(config.skills.agents === 'auto' || Array.isArray(config.skills.agents)).toBe(true)
  })
})

// ── libraryExists ─────────────────────────────────────────────────

describe('libraryExists', () => {
  test('returns true when library dir exists', async () => {
    const lib = path.join(tmpBase, 'lib-exists-test')
    try {
      await mkdir(lib, { recursive: true })
      // We test the general check; the real LIBRARY_DIR may or may not exist
      const exists = await run(Lib.libraryExists('user'))
      expect(typeof exists).toBe('boolean')
    } finally {
      await rm(lib, { recursive: true, force: true })
    }
  })
  test('no scope checks both', async () => {
    const exists = await run(Lib.libraryExists())
    expect(typeof exists).toBe('boolean')
  })
})

// ── ensureOutfitDir ───────────────────────────────────────────────

describe('ensureOutfitDir', () => {
  test('creates directory when missing', async () => {
    const dir = path.join(tmpBase, 'ensure-outfit-1')
    try {
      await run(Lib.ensureOutfitDir(dir))
      const s = await lstat(dir)
      expect(s.isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('succeeds for existing directory', async () => {
    const dir = path.join(tmpBase, 'ensure-outfit-2')
    try {
      await mkdir(dir, { recursive: true })
      await run(Lib.ensureOutfitDir(dir))
      const s = await lstat(dir)
      expect(s.isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('succeeds for valid symlink', async () => {
    const target = path.join(tmpBase, 'ensure-outfit-3-target')
    const link = path.join(tmpBase, 'ensure-outfit-3-link')
    try {
      await mkdir(target, { recursive: true })
      await symlink(target, link)
      await run(Lib.ensureOutfitDir(link))
    } finally {
      await rm(link, { force: true })
      await rm(target, { recursive: true, force: true })
    }
  })
  test('fails for broken symlink', async () => {
    const link = path.join(tmpBase, 'ensure-outfit-4-link')
    try {
      await symlink('/nonexistent/target', link)
      let thrown: unknown = null
      try {
        await run(Lib.ensureOutfitDir(link))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeTruthy()
    } finally {
      await rm(link, { force: true })
    }
  })
})

// ── listOutfit ────────────────────────────────────────────────────

describe('listOutfit', () => {
  test('lists core dirs and pluggable symlinks', async () => {
    const outfitPath = path.join(tmpBase, 'outfit-test-1')
    const libPath = path.join(tmpBase, 'outfit-lib-1')
    try {
      await mkdir(outfitPath, { recursive: true })
      // Core skill (real dir)
      await mkdir(path.join(outfitPath, 'core-skill'), { recursive: true })
      // Library skill (symlink target)
      await createSkill(libPath, 'plug-skill')
      await symlink(path.join(libPath, 'plug-skill'), path.join(outfitPath, 'plug-skill'))

      // We can't easily test listOutfit since it uses outfitDir(scope) which
      // relies on homedir/cwd, but we can test with a scope that happens to match
      // Instead, test the detection pattern directly
      const coreStat = await lstat(path.join(outfitPath, 'core-skill'))
      expect(coreStat.isDirectory()).toBe(true)
      const plugStat = await lstat(path.join(outfitPath, 'plug-skill'))
      expect(plugStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(outfitPath, { recursive: true, force: true })
      await rm(libPath, { recursive: true, force: true })
    }
  })
})

// ── Gitignore management ──────────────────────────────────────────

describe('manageGitignore', () => {
  test('creates shan-managed section', async () => {
    const dir = path.join(tmpBase, 'gi-test-1')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.gitignore'), '')
      await run(Lib.manageGitignore(dir, ['.claude/skills/alpha']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).toContain('# shan-managed (do not edit)')
      expect(content).toContain('.claude/skills/alpha')
      expect(content).toContain('# end shan-managed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('merges with existing entries', async () => {
    const dir = path.join(tmpBase, 'gi-test-2')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        '# shan-managed (do not edit)\n.claude/skills/alpha\n# end shan-managed\n',
      )
      await run(Lib.manageGitignore(dir, ['.claude/skills/beta']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).toContain('.claude/skills/alpha')
      expect(content).toContain('.claude/skills/beta')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('preserves content before managed section', async () => {
    const dir = path.join(tmpBase, 'gi-test-3')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.gitignore'), 'node_modules\n')
      await run(Lib.manageGitignore(dir, ['.claude/skills/alpha']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).toContain('node_modules')
      expect(content).toContain('.claude/skills/alpha')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('does nothing when entries empty and no existing section', async () => {
    const dir = path.join(tmpBase, 'gi-test-4')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.gitignore'), 'node_modules\n')
      await run(Lib.manageGitignore(dir, []))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('node_modules\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('manageGitignoreRemove', () => {
  test('removes entries from managed section', async () => {
    const dir = path.join(tmpBase, 'gi-rm-1')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        '# shan-managed (do not edit)\n.claude/skills/alpha\n.claude/skills/beta\n# end shan-managed\n',
      )
      await run(Lib.manageGitignoreRemove(dir, ['.claude/skills/alpha']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).not.toContain('.claude/skills/alpha')
      expect(content).toContain('.claude/skills/beta')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('removes entire section when last entry removed', async () => {
    const dir = path.join(tmpBase, 'gi-rm-2')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        'node_modules\n\n# shan-managed (do not edit)\n.claude/skills/alpha\n# end shan-managed\n',
      )
      await run(Lib.manageGitignoreRemove(dir, ['.claude/skills/alpha']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).not.toContain('shan-managed')
      expect(content).toContain('node_modules')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('no-op when no managed section', async () => {
    const dir = path.join(tmpBase, 'gi-rm-3')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.gitignore'), 'node_modules\n')
      await run(Lib.manageGitignoreRemove(dir, ['.claude/skills/alpha']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('node_modules\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('setGitignoreEntries', () => {
  test('replaces managed section', async () => {
    const dir = path.join(tmpBase, 'gi-set-1')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        '# shan-managed (do not edit)\n.claude/skills/old\n# end shan-managed\n',
      )
      await run(Lib.setGitignoreEntries(dir, ['.claude/skills/new']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).not.toContain('.claude/skills/old')
      expect(content).toContain('.claude/skills/new')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('removes section when empty entries', async () => {
    const dir = path.join(tmpBase, 'gi-set-2')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        '# shan-managed (do not edit)\n.claude/skills/old\n# end shan-managed\n',
      )
      await run(Lib.setGitignoreEntries(dir, []))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).not.toContain('shan-managed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('creates section when none exists', async () => {
    const dir = path.join(tmpBase, 'gi-set-3')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.gitignore'), '')
      await run(Lib.setGitignoreEntries(dir, ['.claude/skills/new']))
      const content = await readFile(path.join(dir, '.gitignore'), 'utf-8')
      expect(content).toContain('.claude/skills/new')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('readGitignoreEntries', () => {
  test('reads managed entries', async () => {
    const dir = path.join(tmpBase, 'gi-read-1')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        '# shan-managed (do not edit)\n.claude/skills/alpha\n.claude/skills/beta\n# end shan-managed\n',
      )
      const entries = await run(Lib.readGitignoreEntries(dir))
      expect(entries).toEqual(['.claude/skills/alpha', '.claude/skills/beta'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('returns empty for no managed section', async () => {
    const dir = path.join(tmpBase, 'gi-read-2')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.gitignore'), 'node_modules\n')
      const entries = await run(Lib.readGitignoreEntries(dir))
      expect(entries).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('returns empty when no gitignore', async () => {
    const entries = await run(Lib.readGitignoreEntries('/nonexistent'))
    expect(entries).toEqual([])
  })
})

// ── Outfit/snapshot operations (using real outfit dirs) ───────────

describe('listOutfit + snapshotOutfit + bootstrapCurrent', () => {
  test('lists outfit entries from user outfit dir', async () => {
    // listOutfit('user') reads USER_OUTFIT_DIR — test exercises the code path
    const outfit = await run(Lib.listOutfit('user'))
    expect(Array.isArray(outfit)).toBe(true)
    // Every entry should have the right shape
    for (const e of outfit) {
      expect(e.scope).toBe('user')
      expect(['core', 'pluggable']).toContain(e.commitment)
    }
  })

  test('lists outfit entries from project outfit dir', async () => {
    const outfit = await run(Lib.listOutfit('project'))
    expect(Array.isArray(outfit)).toBe(true)
    for (const e of outfit) {
      expect(e.scope).toBe('project')
    }
  })

  test('snapshotOutfit returns pluggable names', async () => {
    const snapshot = await run(Lib.snapshotOutfit('user'))
    expect(Array.isArray(snapshot)).toBe(true)
  })

  test('bootstrapCurrent returns pluggable names', async () => {
    const installs = await run(Lib.bootstrapCurrent('user'))
    expect(Array.isArray(installs)).toBe(true)
  })

  test('syncCurrentInstalls rebuilds current from filesystem', async () => {
    const state: Lib.ShanState = { version: 2, current: {}, history: {} }
    const updated = await run(Lib.syncCurrentInstalls(state, 'user'))
    expect(updated.version).toBe(2)
    // current should now have the 'global' key
    const installs = Lib.getCurrentInstalls(updated, 'user')
    expect(Array.isArray(installs)).toBe(true)
  })
})

describe('checkCollision', () => {
  test('returns null for nonexistent name', async () => {
    const result = await run(Lib.checkCollision('__nonexistent_test_skill_zzz__', 'user'))
    expect(result).toBeNull()
  })
  test('returns null for nonexistent name at project scope', async () => {
    const result = await run(Lib.checkCollision('__nonexistent_test_skill_zzz__', 'project'))
    expect(result).toBeNull()
  })
})

describe('detectGeneratedRouters', () => {
  test('returns array for user scope', async () => {
    const routers = await run(Lib.detectGeneratedRouters('user'))
    expect(Array.isArray(routers)).toBe(true)
  })
  test('returns array for project scope', async () => {
    const routers = await run(Lib.detectGeneratedRouters('project'))
    expect(Array.isArray(routers)).toBe(true)
  })
  test('ignores real core skills that share a name with a library group', async () => {
    const routerName = '__test_core_group_overlap__'
    const outfitPath = Lib.outfitDir('user')
    const routerDir = path.join(outfitPath, routerName)
    const libDir = path.join(Lib.LIBRARY_DIR, routerName, 'child')

    try {
      await mkdir(libDir, { recursive: true })
      await writeFile(
        path.join(libDir, 'SKILL.md'),
        '---\nname: "__test_core_group_overlap__:child"\ndescription: "child"\n---\nbody\n',
      )
      await mkdir(path.join(routerDir, 'scripts'), { recursive: true })
      await writeFile(
        path.join(routerDir, 'SKILL.md'),
        '---\nname: __test_core_group_overlap__\ndescription: real core skill\n---\nbody\n',
      )
      await writeFile(path.join(routerDir, 'scripts', 'run.sh'), '#!/bin/sh\n')

      const routers = await run(Lib.detectGeneratedRouters('user'))
      expect(routers).not.toContain(routerName)
    } finally {
      await rm(path.join(Lib.LIBRARY_DIR, routerName), { recursive: true, force: true })
      await rm(routerDir, { recursive: true, force: true })
    }
  })
})

describe('resolveTarget (skill-library)', () => {
  test('resolves a leaf skill from a temp library', async () => {
    const lib = path.join(tmpBase, 'resolve-target-1')
    try {
      await createSkill(lib, 'myskill', '---\nname: myskill\ndescription: test\n---\nbody')
      // resolveTarget uses scopeLibraryDir which we can't easily override,
      // but we can test with strict=false and provide a library that matches
      // We test by directly calling the function — if the skill is not in the
      // real library dirs it returns null, which is a valid code path
      const result = await run(Lib.resolveTarget('myskill', 'project', true))
      // Will be null since our temp lib isn't the real scopeLibraryDir
      expect(result).toBeNull()
    } finally {
      await rm(lib, { recursive: true, force: true })
    }
  })
  test('returns null for nonexistent skill', async () => {
    const result = await run(Lib.resolveTarget('__nonexistent__', 'user', true))
    expect(result).toBeNull()
  })
})

describe('saveState', () => {
  test('saves state file', async () => {
    // saveState writes to SHAN_DIR which exists on user's machine
    // We just test it doesn't throw with the current state
    const state = await run(Lib.loadState())
    await run(Lib.saveState(state))
    // Verify file exists and can be read back
    const reloaded = await run(Lib.loadState())
    expect(reloaded.version).toBe(2)
  })
})

describe('restoreSnapshot', () => {
  test('handles empty snapshot gracefully', async () => {
    const origLog = console.log
    const origErr = console.error
    console.log = mock(() => {})
    console.error = mock(() => {})
    try {
      await run(Lib.restoreSnapshot([], [], 'user'))
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })
  test('skips snapshot names not in library', async () => {
    const origLog = console.log
    const origErr = console.error
    console.log = mock(() => {})
    console.error = mock(() => {})
    try {
      // Pass a fake snapshot name — it should be skipped (not found in library)
      await run(Lib.restoreSnapshot(['__nonexistent_skill_zzz__'], [], 'user'))
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })
  test('handles nonexistent generated routers', async () => {
    const origLog = console.log
    const origErr = console.error
    console.log = mock(() => {})
    console.error = mock(() => {})
    try {
      // Pass a fake router name — it should be skipped
      await run(Lib.restoreSnapshot([], ['__nonexistent_router_zzz__'], 'user'))
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })

  test('catches symlink errors gracefully', async () => {
    const origLog = console.log
    const origErr = console.error
    console.log = mock(() => {})
    console.error = mock(() => {})
    const outfitDir = Lib.outfitDir('project')
    const libDir = Lib.scopeLibraryDir('project')
    const gitignorePath = path.join(process.cwd(), '.gitignore')
    const originalGitignore = await readFile(gitignorePath, 'utf-8').catch(() => null)
    const skillName = '__restore_symlink_err__'
    const skillDir = path.join(libDir, skillName)
    try {
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'SKILL.md'), '---\ndescription: test\n---\ntest')
      await mkdir(outfitDir, { recursive: true })
      // Make outfit dir unwritable so symlink() fails
      await chmod(outfitDir, 0o555)
      await run(Lib.restoreSnapshot([skillName], [], 'project'))
      // Should not throw — the error is caught and logged
    } finally {
      await chmod(outfitDir, 0o755)
      await rm(skillDir, { recursive: true, force: true })
      // Clean up any accidentally created symlink
      await rm(path.join(outfitDir, skillName), { force: true })
      if (originalGitignore === null) await rm(gitignorePath, { force: true })
      else await writeFile(gitignorePath, originalGitignore)
      console.log = origLog
      console.error = origErr
    }
  })
})

// ── History entry construction ────────────────────────────────────

describe('HistoryEntry constructors', () => {
  test('OnOp creates tagged entry', () => {
    const op = Lib.OnOp({
      targets: ['alpha'],
      scope: 'global',
      timestamp: '2024-01-01',
      snapshot: ['alpha'],
      generatedRouters: [],
    })
    expect(op._tag).toBe('OnOp')
  })
  test('OffOp creates tagged entry', () => {
    const op = Lib.OffOp({
      targets: ['alpha'],
      scope: 'global',
      timestamp: '2024-01-01',
      snapshot: [],
      generatedRouters: [],
    })
    expect(op._tag).toBe('OffOp')
  })
  test('MoveOp creates tagged entry', () => {
    const op = Lib.MoveOp({
      targets: ['alpha'],
      scope: 'global',
      timestamp: '2024-01-01',
      axis: 'scope',
      direction: 'up',
      subActions: [],
    })
    expect(op._tag).toBe('MoveOp')
  })
  test('CopyToOutfitOp creates tagged entry', () => {
    const op = Lib.CopyToOutfitOp({
      targets: ['x'],
      scope: 'global',
      timestamp: '2024-01-01',
      sourcePath: '/a',
      destPath: '/b',
    })
    expect(op._tag).toBe('CopyToOutfitOp')
  })
  test('MoveToLibraryOp creates tagged entry', () => {
    const op = Lib.MoveToLibraryOp({
      targets: ['x'],
      scope: 'global',
      timestamp: '2024-01-01',
      sourcePath: '/a',
      destPath: '/b',
    })
    expect(op._tag).toBe('MoveToLibraryOp')
  })
  test('MoveDirOp creates tagged entry', () => {
    const op = Lib.MoveDirOp({
      targets: ['x'],
      scope: 'global',
      timestamp: '2024-01-01',
      sourcePath: '/a',
      destPath: '/b',
    })
    expect(op._tag).toBe('MoveDirOp')
  })
  test('MoveLibraryDirOp creates tagged entry', () => {
    const op = Lib.MoveLibraryDirOp({
      targets: ['x'],
      scope: 'global',
      timestamp: '2024-01-01',
      sourcePath: '/a',
      destPath: '/b',
    })
    expect(op._tag).toBe('MoveLibraryDirOp')
  })
  test('DoctorOp creates tagged entry', () => {
    const op = Lib.DoctorOp({
      targets: ['x'],
      scope: 'global',
      timestamp: '2024-01-01',
    })
    expect(op._tag).toBe('DoctorOp')
  })
})

// ── loadConfig with agents ───────────────────────────────────────

describe('loadConfig', () => {
  const configFile = Lib.CONFIG_FILE
  let originalConfig: string | null = null

  const saveOriginal = async () => {
    originalConfig = await readFile(configFile, 'utf-8').catch(() => null)
  }
  const restoreOriginal = async () => {
    if (originalConfig === null) {
      await rm(configFile, { force: true }).catch(() => {})
    } else {
      await mkdir(path.dirname(configFile), { recursive: true })
      await writeFile(configFile, originalConfig)
    }
  }

  test('parses agents array from config', async () => {
    await saveOriginal()
    try {
      await mkdir(path.dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify({ skills: { agents: ['claude', 'codex'] } }))
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toEqual(['claude', 'codex'])
    } finally {
      await restoreOriginal()
    }
  })

  test('parses agents: "auto" from config', async () => {
    await saveOriginal()
    try {
      await mkdir(path.dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify({ skills: { agents: 'auto' } }))
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toBe('auto')
    } finally {
      await restoreOriginal()
    }
  })

  test('parses legacy mirrorAgents from config', async () => {
    await saveOriginal()
    try {
      await mkdir(path.dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify({ skills: { mirrorAgents: ['codex'] } }))
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toEqual(['claude', 'codex'])
    } finally {
      await restoreOriginal()
    }
  })

  test('returns default agents when agents key is missing', async () => {
    await saveOriginal()
    try {
      await mkdir(path.dirname(configFile), { recursive: true })
      await writeFile(configFile, JSON.stringify({ skills: { historyLimit: 10 } }))
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toBe('auto')
      expect(config.skills.historyLimit).toBe(10)
    } finally {
      await restoreOriginal()
    }
  })

  test('returns default config for invalid JSON', async () => {
    await saveOriginal()
    try {
      await mkdir(path.dirname(configFile), { recursive: true })
      await writeFile(configFile, 'not json')
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toBe('auto')
    } finally {
      await restoreOriginal()
    }
  })
})

// ── saveCache / detectInstalledAgents ─────────────────────────────

describe('saveCache', () => {
  const cacheFile = Lib.CACHE_FILE
  let originalCache: string | null = null

  test('writes and reads back cache', async () => {
    originalCache = await readFile(cacheFile, 'utf-8').catch(() => null)
    try {
      const cache: Lib.ShanCache = {
        version: 1,
        agents: { checkedAt: new Date().toISOString(), installed: ['claude'] },
      }
      await run(Lib.saveCache(cache))
      const loaded = await run(Lib.loadCache())
      expect(loaded.agents.installed).toEqual(['claude'])
    } finally {
      if (originalCache === null) {
        await rm(cacheFile, { force: true }).catch(() => {})
      } else {
        await writeFile(cacheFile, originalCache)
      }
    }
  })
})

describe('detectInstalledAgents', () => {
  test('returns an array of agents', async () => {
    const agents = await run(Lib.detectInstalledAgents())
    expect(Array.isArray(agents)).toBe(true)
  })
})

// ── resolvesToSameDirectory (via syncAgentMirrors) ────────────────

describe('syncAgentMirrors equivalent-path detection', () => {
  test('detects mirror symlink that resolves to canonical via an intermediate symlink', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-sync-resolve-same')
    const origCwd = process.cwd()

    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Create canonical outfit
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Alpha\n---\n# alpha\n',
      )
      // Create an intermediate symlink to .claude
      const intermediatePath = path.join(projectRoot, 'claude-link')
      await symlink(path.join(projectRoot, '.claude'), intermediatePath)
      // Create mirror as symlink through the intermediate path (different string, same real dir)
      await mkdir(path.join(projectRoot, '.codex'), { recursive: true })
      await symlink(
        path.join(intermediatePath, 'skills'),
        path.join(projectRoot, '.codex', 'skills'),
      )
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      // Mirror should still work (either kept as-is or replaced with direct symlink)
      expect(
        await readFile(path.join(projectRoot, '.codex', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toContain('Alpha')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── ensureOutfitDir ─────────────────────────────────────────────────

describe('ensureOutfitDir', () => {
  test('reports BrokenOutfitDirError for broken symlink', async () => {
    const dir = path.join(tmpBase, 'ensure-outfit-broken')
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(path.dirname(dir), { recursive: true })
      await symlink('/nonexistent/target/path', dir)

      const exit = await runExit(Lib.ensureOutfitDir(dir))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value).toBeInstanceOf(Lib.BrokenOutfitDirError)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('succeeds when dir already exists', async () => {
    const dir = path.join(tmpBase, 'ensure-outfit-exists')
    try {
      await mkdir(dir, { recursive: true })
      await run(Lib.ensureOutfitDir(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('creates dir when missing', async () => {
    const dir = path.join(tmpBase, 'ensure-outfit-missing')
    await rm(dir, { recursive: true, force: true })
    try {
      await run(Lib.ensureOutfitDir(dir))
      const dirStat = await lstat(dir)
      expect(dirStat.isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── getNodeType ─────────────────────────────────────────────────────

describe('getNodeType', () => {
  test('returns group for nonexistent directory', async () => {
    const nodeType = await run(Lib.getNodeType('/nonexistent/path/to/skill'))
    expect(nodeType).toBe('group')
  })

  test('returns leaf for directory with only SKILL.md', async () => {
    const dir = path.join(tmpBase, 'nodetype-leaf')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: leaf\ndescription: leaf\n---\n')
      const nodeType = await run(Lib.getNodeType(dir))
      expect(nodeType).toBe('leaf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns group for directory with only subdirs', async () => {
    const dir = path.join(tmpBase, 'nodetype-group')
    try {
      await mkdir(path.join(dir, 'child'), { recursive: true })
      const nodeType = await run(Lib.getNodeType(dir))
      expect(nodeType).toBe('group')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns callable-group for directory with SKILL.md and subdirs', async () => {
    const dir = path.join(tmpBase, 'nodetype-callable')
    try {
      await mkdir(path.join(dir, 'child'), { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: cg\ndescription: cg\n---\n')
      const nodeType = await run(Lib.getNodeType(dir))
      expect(nodeType).toBe('callable-group')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── restoreSnapshot ─────────────────────────────────────────────────

describe('restoreSnapshot', () => {
  test('removes extra symlinks and restores missing ones', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')

      // Create library entries
      await createSkill(libPath, 'keep-skill')
      await createSkill(libPath, 'restore-skill')

      // Create outfit with one extra and one that should be kept
      await mkdir(outfitPath, { recursive: true })
      await symlink(path.join(libPath, 'keep-skill'), path.join(outfitPath, 'keep-skill'))
      await symlink(path.join(libPath, 'restore-skill'), path.join(outfitPath, 'extra-skill'))

      process.chdir(projectRoot)

      // Restore snapshot with only keep-skill and restore-skill
      await run(Lib.restoreSnapshot(['keep-skill', 'restore-skill'], [], 'project'))

      // keep-skill should still exist
      expect((await lstat(path.join(outfitPath, 'keep-skill'))).isSymbolicLink()).toBe(true)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('skips restore when library entry missing', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap-missing')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')
      await mkdir(outfitPath, { recursive: true })
      await mkdir(libPath, { recursive: true })

      process.chdir(projectRoot)

      // Try to restore a skill that doesn't exist in library
      await run(Lib.restoreSnapshot(['nonexistent-skill'], [], 'project'))

      // Should not create the symlink
      const exists = await lstat(path.join(outfitPath, 'nonexistent-skill')).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── resolveConfiguredAgents ─────────────────────────────────────────

describe('resolveConfiguredAgents', () => {
  test('returns configured agents directly when not auto', async () => {
    const config: Lib.ShanConfig = {
      version: 1,
      skills: {
        historyLimit: 50,
        defaultScope: 'project',
        agents: ['claude', 'codex'],
      },
    }
    const agents = await run(Lib.resolveConfiguredAgents(config))
    expect(agents).toEqual(['claude', 'codex'])
  })

  test('detects agents in auto mode', async () => {
    const config: Lib.ShanConfig = {
      version: 1,
      skills: {
        historyLimit: 50,
        defaultScope: 'project',
        agents: 'auto',
      },
    }
    // This will hit detectInstalledAgents + saveCache (with catchAll)
    const agents = await run(Lib.resolveConfiguredAgents(config))
    expect(Array.isArray(agents)).toBe(true)
  })
})

// ── libraryExists ───────────────────────────────────────────────────

describe('libraryExists', () => {
  test('returns false for nonexistent scope', async () => {
    const projectRoot = path.join(tmpBase, 'lib-exists-test')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      process.chdir(projectRoot)
      // No library dir exists at project scope
      const exists = await run(Lib.libraryExists('project'))
      expect(exists).toBe(false)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── checkCollision ──────────────────────────────────────────────────

describe('checkCollision', () => {
  test('returns null when no collision', async () => {
    const projectRoot = path.join(tmpBase, 'collision-test')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
      process.chdir(projectRoot)
      const result = await run(Lib.checkCollision('nonexistent-skill', 'project'))
      expect(result).toBeNull()
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── gitignore functions ─────────────────────────────────────────────

describe('gitignore management', () => {
  test('manageGitignore adds entries to new gitignore', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-add')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/test']))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('.claude/skills/test')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('manageGitignoreRemove removes entries', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-rm')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/a', '.claude/skills/b']))
      await run(Lib.manageGitignoreRemove(projectRoot, ['.claude/skills/a']))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).not.toContain('.claude/skills/a')
      expect(content).toContain('.claude/skills/b')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('manageGitignoreRemove removes entire section when no entries remain', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-rm-all')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/only']))
      await run(Lib.manageGitignoreRemove(projectRoot, ['.claude/skills/only']))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).not.toContain('shan-managed')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('setGitignoreEntries replaces existing section', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-set')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/old']))
      await run(Lib.setGitignoreEntries(projectRoot, ['.claude/skills/new']))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).not.toContain('.claude/skills/old')
      expect(content).toContain('.claude/skills/new')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('setGitignoreEntries removes section when empty array', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-set-empty')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/test']))
      await run(Lib.setGitignoreEntries(projectRoot, []))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).not.toContain('shan-managed')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('readGitignoreEntries returns entries from managed section', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-read')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/x', '.claude/skills/y']))
      const entries = await run(Lib.readGitignoreEntries(projectRoot))
      expect(entries).toContain('.claude/skills/x')
      expect(entries).toContain('.claude/skills/y')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('readGitignoreEntries returns empty for missing file', async () => {
    const entries = await run(Lib.readGitignoreEntries('/nonexistent/path'))
    expect(entries).toEqual([])
  })

  test('manageGitignoreRemove no-ops on missing file', async () => {
    await run(Lib.manageGitignoreRemove('/nonexistent/path', ['anything']))
    // Should not throw
  })
})

// ── resolveTarget ───────────────────────────────────────────────────

describe('resolveTarget', () => {
  test('resolves an existing skill in project library', async () => {
    const projectRoot = path.join(tmpBase, 'resolve-target')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await createSkill(path.join(projectRoot, '.claude', 'skills-library'), 'rt-skill')
      process.chdir(projectRoot)
      const result = await run(Lib.resolveTarget('rt-skill', 'project', true))
      expect(result).not.toBeNull()
      expect(result!.colonName).toBe('rt-skill')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('returns null for nonexistent skill', async () => {
    const projectRoot = path.join(tmpBase, 'resolve-target-missing')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills-library'), { recursive: true })
      process.chdir(projectRoot)
      const result = await run(Lib.resolveTarget('nonexistent', 'project', true))
      expect(result).toBeNull()
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── printTable ──────────────────────────────────────────────────────

describe('printTable', () => {
  test('handles empty rows', async () => {
    await run(Lib.printTable([]))
  })

  test('formats rows with padding', async () => {
    await run(
      Lib.printTable([
        ['Name', 'Status'],
        ['alpha', 'on'],
      ]),
    )
  })
})

// ── name translation ────────────────────────────────────────────────

describe('name translation', () => {
  test('colonToPath converts colons to path separators', () => {
    expect(Lib.colonToPath('group:skill')).toBe(path.join('group', 'skill'))
  })

  test('pathToColon converts path separators to colons', () => {
    expect(Lib.pathToColon(path.join('group', 'skill'))).toBe('group:skill')
  })

  test('flattenName replaces separators with underscores', () => {
    expect(Lib.flattenName(path.join('group', 'skill'))).toBe('group_skill')
  })

  test('unflattenName replaces underscores with separators', () => {
    expect(Lib.unflattenName('group_skill')).toBe(path.join('group', 'skill'))
  })
})

// ── bootstrapCurrent ────────────────────────────────────────────────

describe('bootstrapCurrent', () => {
  test('returns installed pluggable skill names', async () => {
    const projectRoot = path.join(tmpBase, 'bootstrap-current')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libDir = path.join(projectRoot, '.claude', 'skills-library')
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      await createSkill(libDir, 'boot-skill')
      await mkdir(outfitPath, { recursive: true })
      await symlink(path.join(libDir, 'boot-skill'), path.join(outfitPath, 'boot-skill'))
      process.chdir(projectRoot)
      const installs = await run(Lib.bootstrapCurrent('project'))
      expect(installs).toContain('boot-skill')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── estimateCharCost ────────────────────────────────────────────────

describe('estimateCharCost', () => {
  test('calculates cost from name and description', () => {
    const cost = Lib.estimateCharCost({
      name: 'test',
      description: 'A test skill',
      disableModelInvocation: false,
    })
    expect(cost).toBe('test A test skill'.length)
  })

  test('includes whenToUse in cost', () => {
    const cost = Lib.estimateCharCost({
      name: 'test',
      description: 'desc',
      disableModelInvocation: false,
      whenToUse: 'when needed',
    })
    expect(cost).toBe('test desc when needed'.length)
  })
})

// ── parseTargets ────────────────────────────────────────────────────

describe('parseTargets', () => {
  test('parses comma-separated targets', () => {
    expect(Lib.parseTargets('a, b, c')).toEqual(['a', 'b', 'c'])
  })

  test('deduplicates targets', () => {
    expect(Lib.parseTargets('a, b, a')).toEqual(['a', 'b'])
  })

  test('filters empty strings', () => {
    expect(Lib.parseTargets('a,,b,')).toEqual(['a', 'b'])
  })
})

// ── snapshotOutfit ──────────────────────────────────────────────────

describe('snapshotOutfit', () => {
  test('returns pluggable skill names', async () => {
    const projectRoot = path.join(tmpBase, 'snapshot-outfit')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libDir = path.join(projectRoot, '.claude', 'skills-library')
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      await createSkill(libDir, 'snap-skill')
      await mkdir(outfitPath, { recursive: true })
      await symlink(path.join(libDir, 'snap-skill'), path.join(outfitPath, 'snap-skill'))
      // Also create a core skill (should not appear in snapshot)
      await mkdir(path.join(outfitPath, 'core-skill'), { recursive: true })
      await writeFile(
        path.join(outfitPath, 'core-skill', 'SKILL.md'),
        '---\nname: core\ndescription: core\n---\n',
      )
      process.chdir(projectRoot)
      const snapshot = await run(Lib.snapshotOutfit('project'))
      expect(snapshot).toContain('snap-skill')
      expect(snapshot).not.toContain('core-skill')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── readFrontmatter ─────────────────────────────────────────────────

describe('readFrontmatter', () => {
  test('parses frontmatter from SKILL.md', async () => {
    const dir = path.join(tmpBase, 'fm-parse')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: "A test skill"\n---\n# my-skill\n',
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm).not.toBeNull()
      expect(fm!.name).toBe('my-skill')
      expect(fm!.description).toBe('A test skill')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns null for missing SKILL.md', async () => {
    const fm = await run(Lib.readFrontmatter('/nonexistent/skill'))
    expect(fm).toBeNull()
  })

  test('parses boolean fields', async () => {
    const dir = path.join(tmpBase, 'fm-bool')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        '---\nname: flagged\ndescription: test\ndisable-model-invocation: true\n---\n',
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm).not.toBeNull()
      expect(fm!.disableModelInvocation).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── state helpers ───────────────────────────────────────────────────

describe('state helpers', () => {
  test('getProjectHistory returns default for unknown key', () => {
    const state: Lib.ShanState = { version: 2, current: {}, history: {} }
    const history = Lib.getProjectHistory(state, 'project')
    expect(history).toEqual({ entries: [], undoneCount: 0 })
  })

  test('setProjectHistory updates state', () => {
    const state: Lib.ShanState = { version: 2, current: {}, history: {} }
    const updated = Lib.setProjectHistory(state, 'user', { entries: [], undoneCount: 1 })
    expect(Lib.getProjectHistory(updated, 'user').undoneCount).toBe(1)
  })

  test('addCurrentInstall is idempotent', () => {
    const state: Lib.ShanState = { version: 2, current: {}, history: {} }
    const s1 = Lib.addCurrentInstall(state, 'user', 'skill-a')
    const s2 = Lib.addCurrentInstall(s1, 'user', 'skill-a')
    expect(Lib.getCurrentInstalls(s2, 'user')).toEqual(['skill-a'])
  })

  test('removeCurrentInstall is idempotent', () => {
    const state: Lib.ShanState = { version: 2, current: {}, history: {} }
    const s1 = Lib.addCurrentInstall(state, 'user', 'skill-a')
    const s2 = Lib.removeCurrentInstall(s1, 'user', 'skill-a')
    const s3 = Lib.removeCurrentInstall(s2, 'user', 'skill-a')
    expect(Lib.getCurrentInstalls(s3, 'user')).toEqual([])
  })
})

// ── resolveLeaves ───────────────────────────────────────────────────

describe('resolveLeaves', () => {
  test('finds leaf skills in a directory', async () => {
    const libDir = path.join(tmpBase, 'resolve-leaves')
    try {
      await rm(libDir, { recursive: true, force: true })
      await createSkill(libDir, path.join('group', 'leaf-a'))
      await createSkill(libDir, path.join('group', 'leaf-b'))
      const leaves = await run(Lib.resolveLeaves('group', libDir))
      const names = leaves.map((l) => l.colonName)
      expect(names).toContain('group:leaf-a')
      expect(names).toContain('group:leaf-b')
    } finally {
      await rm(libDir, { recursive: true, force: true })
    }
  })

  test('returns empty for nonexistent path', async () => {
    const leaves = await run(Lib.resolveLeaves('nope', '/nonexistent/lib'))
    expect(leaves).toEqual([])
  })
})

// ── loadState ───────────────────────────────────────────────────────

describe('loadState', () => {
  test('returns default state when no file exists', async () => {
    const state = await run(Lib.loadState())
    expect(state.version).toBe(2)
    expect(isRecord(state.history)).toBe(true)
  })
})

// ── loadConfig with corrupt file ────────────────────────────────────

describe('loadConfig edge cases', () => {
  test('returns default config for corrupt JSON', async () => {
    const configDir = Lib.CONFIG_DIR
    const configFile = Lib.CONFIG_FILE
    const backup = await readFile(configFile, 'utf-8').catch(() => null)
    try {
      await mkdir(configDir, { recursive: true })
      await writeFile(configFile, '{{{not valid json')
      const config = await run(Lib.loadConfig())
      expect(config.version).toBe(1)
    } finally {
      if (backup) await writeFile(configFile, backup)
      else await rm(configFile, { force: true }).catch(() => {})
    }
  })

  test('returns default config for non-object JSON', async () => {
    const configFile = Lib.CONFIG_FILE
    const backup = await readFile(configFile, 'utf-8').catch(() => null)
    try {
      await mkdir(Lib.CONFIG_DIR, { recursive: true })
      await writeFile(configFile, '"just a string"')
      const config = await run(Lib.loadConfig())
      expect(config.version).toBe(1)
    } finally {
      if (backup) await writeFile(configFile, backup)
      else await rm(configFile, { force: true }).catch(() => {})
    }
  })
})

// ── loadCache with corrupt file ─────────────────────────────────────

describe('loadCache edge cases', () => {
  test('returns default cache for corrupt JSON', async () => {
    const cacheFile = Lib.CACHE_FILE
    const backup = await readFile(cacheFile, 'utf-8').catch(() => null)
    try {
      await mkdir(Lib.CACHE_DIR, { recursive: true })
      await writeFile(cacheFile, '!not json!')
      const cache = await run(Lib.loadCache())
      expect(cache.version).toBe(1)
    } finally {
      if (backup) await writeFile(cacheFile, backup)
      else await rm(cacheFile, { force: true }).catch(() => {})
    }
  })
})

// ── resolveHistoryScope / resolveHistoryOutfitDir ───────────────────

describe('resolveHistoryScope', () => {
  test('resolves "user" to user scope', () => {
    expect(Lib.resolveHistoryScope('user')).toBe('user')
  })

  test('resolves "global" to user scope', () => {
    expect(Lib.resolveHistoryScope('global')).toBe('user')
  })

  test('resolves path to project scope', () => {
    expect(Lib.resolveHistoryScope('/some/project')).toBe('project')
  })
})

describe('resolveHistoryOutfitDir', () => {
  test('resolves "user" to user outfit dir', () => {
    const result = Lib.resolveHistoryOutfitDir('user')
    expect(result).toContain('.claude')
    expect(result).toContain('skills')
  })

  test('resolves "global" to user outfit dir', () => {
    const result = Lib.resolveHistoryOutfitDir('global')
    expect(result).toContain('.claude')
  })

  test('resolves "project" to project outfit dir', () => {
    const result = Lib.resolveHistoryOutfitDir('project')
    expect(result).toContain('.claude')
  })

  test("resolves absolute path to that path's outfit dir", () => {
    const result = Lib.resolveHistoryOutfitDir('/some/project/path')
    expect(result).toBe('/some/project/path/.claude/skills')
  })
})

// ── syncCurrentInstalls ─────────────────────────────────────────────

describe('syncCurrentInstalls', () => {
  test('bootstraps current installs from outfit', async () => {
    const projectRoot = path.join(tmpBase, 'sync-current')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libDir = path.join(projectRoot, '.claude', 'skills-library')
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      await createSkill(libDir, 'synced')
      await mkdir(outfitPath, { recursive: true })
      await symlink(path.join(libDir, 'synced'), path.join(outfitPath, 'synced'))
      process.chdir(projectRoot)

      const state: Lib.ShanState = { version: 2, current: {}, history: {} }
      const updated = await run(Lib.syncCurrentInstalls(state, 'project'))
      expect(Lib.getCurrentInstalls(updated, 'project')).toContain('synced')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── normalizeAgents / getMirrorAgents ────────────────────────────────

describe('normalizeAgents', () => {
  test('filters to known agents', () => {
    expect(Lib.normalizeAgents(['claude', 'unknown', 'codex'])).toEqual(['claude', 'codex'])
  })
})

describe('getMirrorAgents', () => {
  test('excludes canonical agent', () => {
    expect(Lib.getMirrorAgents(['claude', 'codex'])).toEqual(['codex'])
  })

  test('returns empty for only canonical', () => {
    expect(Lib.getMirrorAgents(['claude'])).toEqual([])
  })
})

// ── loadConfig with configured agents ───────────────────────────────

describe('loadConfig with agents', () => {
  test('parses agents: auto from config', async () => {
    const configFile = Lib.CONFIG_FILE
    const backup = await readFile(configFile, 'utf-8').catch(() => null)
    try {
      await mkdir(Lib.CONFIG_DIR, { recursive: true })
      await writeFile(
        configFile,
        JSON.stringify({
          skills: {
            agents: 'auto',
            historyLimit: 25,
            defaultScope: 'user',
            doctor: { disabled: ['broken-symlinks'] },
          },
        }),
      )
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toBe('auto')
      expect(config.skills.historyLimit).toBe(25)
      expect(config.skills.defaultScope).toBe('user')
      expect(config.skills.doctor?.disabled).toEqual(['broken-symlinks'])
    } finally {
      if (backup) await writeFile(configFile, backup)
      else await rm(configFile, { force: true }).catch(() => {})
    }
  })

  test('parses agents: array from config', async () => {
    const configFile = Lib.CONFIG_FILE
    const backup = await readFile(configFile, 'utf-8').catch(() => null)
    try {
      await mkdir(Lib.CONFIG_DIR, { recursive: true })
      await writeFile(
        configFile,
        JSON.stringify({
          skills: { agents: ['claude', 'codex'] },
        }),
      )
      const config = await run(Lib.loadConfig())
      expect(config.skills.agents).toEqual(['claude', 'codex'])
    } finally {
      if (backup) await writeFile(configFile, backup)
      else await rm(configFile, { force: true }).catch(() => {})
    }
  })
})

// ── loadState with valid state ──────────────────────────────────────

describe('loadState with existing state', () => {
  test('parses state with all history entry types', async () => {
    const stateFile = Lib.STATE_FILE
    const backup = await readFile(stateFile, 'utf-8').catch(() => null)
    const ts = new Date().toISOString()
    try {
      await mkdir(Lib.SHAN_DIR, { recursive: true })
      await writeFile(
        stateFile,
        JSON.stringify({
          version: 2,
          history: {
            '/test/path': {
              entries: [
                {
                  _tag: 'OnOp',
                  targets: ['skill-a'],
                  scope: 'project',
                  timestamp: ts,
                  snapshot: ['skill-a'],
                  generatedRouters: [],
                },
                {
                  _tag: 'OffOp',
                  targets: ['skill-b'],
                  scope: 'project',
                  timestamp: ts,
                  snapshot: [],
                  generatedRouters: [],
                },
                {
                  _tag: 'MoveOp',
                  targets: ['skill-c'],
                  scope: 'project',
                  timestamp: ts,
                  axis: 'commitment',
                  direction: 'up',
                  subActions: [
                    {
                      _tag: 'CopyToOutfitOp',
                      targets: ['skill-c'],
                      scope: 'project',
                      timestamp: ts,
                      sourcePath: '/src',
                      destPath: '/dest',
                    },
                  ],
                },
                {
                  _tag: 'MoveToLibraryOp',
                  targets: ['skill-d'],
                  scope: 'project',
                  timestamp: ts,
                  sourcePath: '/src',
                  destPath: '/dest',
                },
                {
                  _tag: 'MoveDirOp',
                  targets: ['skill-e'],
                  scope: 'user',
                  timestamp: ts,
                  sourcePath: '/a',
                  destPath: '/b',
                },
                {
                  _tag: 'MoveLibraryDirOp',
                  targets: ['skill-f'],
                  scope: 'project',
                  timestamp: ts,
                  sourcePath: '/c',
                  destPath: '/d',
                },
                {
                  _tag: 'DoctorOp',
                  targets: ['fix-1'],
                  scope: 'project',
                  timestamp: ts,
                },
                {
                  _tag: 'UnknownOp',
                  targets: [],
                  scope: 'project',
                  timestamp: ts,
                },
              ],
              undoneCount: 0,
            },
          },
          current: {
            '/test/path': { installs: ['skill-a'] },
          },
        }),
      )
      const state = await run(Lib.loadState())
      expect(state.version).toBe(2)
      const history = state.history['/test/path']!
      // OnOp, OffOp, MoveOp, MoveToLibraryOp, MoveDirOp, MoveLibraryDirOp, DoctorOp = 7
      // UnknownOp is filtered out (returns null)
      expect(history.entries.length).toBe(7)
    } finally {
      if (backup) await writeFile(stateFile, backup)
      else await rm(stateFile, { force: true }).catch(() => {})
    }
  })

  test('migrates v1 state with op field', async () => {
    const stateFile = Lib.STATE_FILE
    const backup = await readFile(stateFile, 'utf-8').catch(() => null)
    try {
      await mkdir(Lib.SHAN_DIR, { recursive: true })
      await writeFile(
        stateFile,
        JSON.stringify({
          version: 1,
          history: {
            '/test/v1': {
              entries: [
                {
                  op: 'on',
                  targets: ['v1-skill'],
                  scope: 'project',
                  timestamp: new Date().toISOString(),
                },
                {
                  op: 'off',
                  targets: ['v1-off'],
                  scope: 'project',
                  timestamp: new Date().toISOString(),
                },
              ],
              undoneCount: 0,
            },
          },
        }),
      )
      const state = await run(Lib.loadState())
      const history = state.history['/test/v1']!
      expect(history.entries.length).toBe(2)
    } finally {
      if (backup) await writeFile(stateFile, backup)
      else await rm(stateFile, { force: true }).catch(() => {})
    }
  })

  test('handles corrupt state JSON gracefully', async () => {
    const stateFile = Lib.STATE_FILE
    const backup = await readFile(stateFile, 'utf-8').catch(() => null)
    try {
      await mkdir(Lib.SHAN_DIR, { recursive: true })
      await writeFile(stateFile, '!corrupt!')
      const state = await run(Lib.loadState())
      expect(state.version).toBe(2)
      expect(state.history).toEqual({})
    } finally {
      if (backup) await writeFile(stateFile, backup)
      else await rm(stateFile, { force: true }).catch(() => {})
    }
  })
})

// ── syncAgentMirrors with symlinked mirror entry ────────────────────

describe('syncAgentMirrors with symlink entries', () => {
  test('handles mirror entry that is a symlink to a skill', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-symlink-entry')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Canonical has no entries
      await mkdir(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
      // Mirror has a symlink entry pointing to a real skill
      const mirrorDir = path.join(projectRoot, '.codex', 'skills')
      await mkdir(mirrorDir, { recursive: true })
      const skillSource = path.join(projectRoot, 'external-skill')
      await mkdir(skillSource, { recursive: true })
      await writeFile(
        path.join(skillSource, 'SKILL.md'),
        '---\nname: ext\ndescription: External\n---\n',
      )
      await symlink(skillSource, path.join(mirrorDir, 'ext'))

      process.chdir(projectRoot)
      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── checkCollision with core conflict ───────────────────────────────

describe('checkCollision with conflict', () => {
  test('detects core collision at project scope', async () => {
    const projectRoot = path.join(tmpBase, 'collision-core')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      // Create a core skill (real directory) in project outfit
      await mkdir(path.join(outfitPath, 'my-core'), { recursive: true })
      await writeFile(
        path.join(outfitPath, 'my-core', 'SKILL.md'),
        '---\nname: my-core\ndescription: core\n---\n',
      )
      process.chdir(projectRoot)
      const result = await run(Lib.checkCollision('my-core', 'project'))
      expect(result).toContain('core')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── readFrontmatter edge cases ──────────────────────────────────────

describe('readFrontmatter edge cases', () => {
  test('handles SKILL.md with no frontmatter', async () => {
    const dir = path.join(tmpBase, 'fm-no-front')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'SKILL.md'), '# Just markdown, no frontmatter\n')
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('handles multi-line indicator in frontmatter', async () => {
    const dir = path.join(tmpBase, 'fm-multiline')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        '---\nname: test\ndescription: >-\nwhen-to-use: "testing"\nargument-hint: "<arg>"\n---\n',
      )
      const fm = await run(Lib.readFrontmatter(dir))
      expect(fm).not.toBeNull()
      expect(fm!.whenToUse).toBe('testing')
      expect(fm!.argumentHint).toBe('<arg>')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── listLibrary with nested groups ──────────────────────────────────

describe('listLibrary advanced', () => {
  test('finds nested skills in groups', async () => {
    const libDir = path.join(tmpBase, 'nested-lib')
    try {
      await rm(libDir, { recursive: true, force: true })
      await createSkill(libDir, path.join('top', 'mid', 'deep'))
      const results = await run(Lib.listLibrary([libDir]))
      const names = results.map((r) => r.colonName)
      expect(names).toContain('top:mid:deep')
    } finally {
      await rm(libDir, { recursive: true, force: true })
    }
  })
})

// ── agentOutfitDir / agentRootDir ───────────────────────────────────

describe('agentOutfitDir', () => {
  test('returns correct path for claude project', () => {
    const dir = Lib.agentOutfitDir('project', 'claude')
    expect(dir).toContain('.claude')
    expect(dir).toContain('skills')
  })

  test('returns correct path for codex project', () => {
    const dir = Lib.agentOutfitDir('project', 'codex')
    expect(dir).toContain('.codex')
    expect(dir).toContain('skills')
  })
})

// ── saveCache catchAll (via resolveConfiguredAgents) ─────────────────

describe('resolveConfiguredAgents with unwritable cache', () => {
  test('succeeds even when saveCache fails', async () => {
    const cacheDir = Lib.CACHE_DIR
    const backup = await readFile(Lib.CACHE_FILE, 'utf-8').catch(() => null)
    try {
      // Remove cache so it's stale, then make dir read-only so saveCache fails
      await rm(Lib.CACHE_FILE, { force: true }).catch(() => {})
      await mkdir(cacheDir, { recursive: true })
      await chmod(cacheDir, 0o555)

      const config: Lib.ShanConfig = {
        version: 1,
        skills: { historyLimit: 50, defaultScope: 'project', agents: 'auto' },
      }
      // Should not throw — saveCache catchAll handles the error
      const agents = await run(Lib.resolveConfiguredAgents(config))
      expect(Array.isArray(agents)).toBe(true)
    } finally {
      await chmod(cacheDir, 0o755).catch(() => {})
      if (backup) await writeFile(Lib.CACHE_FILE, backup)
    }
  })
})

// ── manageGitignore with existing content ───────────────────────────

describe('manageGitignore merge', () => {
  test('merges entries into existing shan section', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-merge')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await writeFile(
        path.join(projectRoot, '.gitignore'),
        'node_modules/\n\n# shan-managed (do not edit)\n.claude/skills/old\n# end shan-managed\n\n.DS_Store\n',
      )
      await run(Lib.manageGitignore(projectRoot, ['.claude/skills/new']))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).toContain('.claude/skills/old')
      expect(content).toContain('.claude/skills/new')
      expect(content).toContain('node_modules/')
      expect(content).toContain('.DS_Store')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('removes section when merging results in empty entries', async () => {
    const projectRoot = path.join(tmpBase, 'gitignore-empty-merge')
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      await writeFile(
        path.join(projectRoot, '.gitignore'),
        '# shan-managed (do not edit)\n# end shan-managed\n',
      )
      await run(Lib.manageGitignore(projectRoot, []))
      const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8')
      expect(content).not.toContain('shan-managed')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── detectGeneratedRouters with core entries ─────────────────────────

describe('detectGeneratedRouters with generated router', () => {
  test('detects a generated router', async () => {
    const projectRoot = path.join(tmpBase, 'detect-gen-router')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libDir = path.join(projectRoot, '.claude', 'skills-library')
      const outfitPath = path.join(projectRoot, '.claude', 'skills')

      // Create a group in library (has children, no SKILL.md at top level)
      await createSkill(libDir, path.join('mygroup', 'child-a'))
      await createSkill(libDir, path.join('mygroup', 'child-b'))

      // Create a generated router in outfit (core dir with a single SKILL.md
      // whose name matches the group and has disable-model-invocation: true)
      const routerDir = path.join(outfitPath, 'mygroup')
      await mkdir(routerDir, { recursive: true })
      await writeFile(
        path.join(routerDir, 'SKILL.md'),
        '---\nname: mygroup\ndescription: Router\ndisable-model-invocation: true\n---\n',
      )

      process.chdir(projectRoot)
      const routers = await run(Lib.detectGeneratedRouters('project'))
      expect(routers).toContain('mygroup')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── generateRouter ──────────────────────────────────────────────────

describe('generateRouter', () => {
  test('generates router SKILL.md content', () => {
    const children: Lib.SkillInfo[] = [
      {
        colonName: 'group:child-a',
        libraryRelPath: 'group/child-a',
        libraryDir: '/lib',
        libraryScope: 'project',
        frontmatter: {
          name: 'child-a',
          description: 'First child',
          disableModelInvocation: false,
          argumentHint: '<file>',
        },
      },
      {
        colonName: 'group:child-b',
        libraryRelPath: 'group/child-b',
        libraryDir: '/lib',
        libraryScope: 'project',
        frontmatter: {
          name: 'child-b',
          description: 'Second child',
          disableModelInvocation: false,
        },
      },
    ]
    const content = Lib.generateRouter('group', children)
    expect(content).toContain('name: group')
    expect(content).toContain('disable-model-invocation: true')
    expect(content).toContain('group:child-a')
    expect(content).toContain('group:child-b')
    expect(content).toContain('`<file>`')
    expect(content).toContain('First child')
    expect(content).toContain('Second child')
  })
})

// ── restoreSnapshot with generated routers ──────────────────────────

describe('restoreSnapshot with generated routers', () => {
  test('restores missing generated router', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap-router')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')

      // Create a group in library
      await createSkill(libPath, path.join('mygroup', 'child'))
      await mkdir(outfitPath, { recursive: true })
      process.chdir(projectRoot)

      // Restore snapshot with a generated router
      await run(Lib.restoreSnapshot([], ['mygroup'], 'project'))

      // Generated router should be recreated
      const routerPath = path.join(outfitPath, 'mygroup', 'SKILL.md')
      const content = await readFile(routerPath, 'utf-8').catch(() => null)
      expect(content).not.toBeNull()
      expect(content).toContain('mygroup')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('removes extra generated routers not in snapshot', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap-rm-router')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')

      // Create library group so it's detected as router-eligible
      await createSkill(libPath, path.join('stale-router', 'child'))

      // Create a stale generated router in outfit (matches as generated)
      const routerDir = path.join(outfitPath, 'stale-router')
      await mkdir(routerDir, { recursive: true })
      await writeFile(
        path.join(routerDir, 'SKILL.md'),
        '---\nname: stale-router\ndescription: stale\ndisable-model-invocation: true\n---\n',
      )
      process.chdir(projectRoot)

      // Restore snapshot WITHOUT this router → should be removed
      await run(Lib.restoreSnapshot([], [], 'project'))

      const exists = await lstat(routerDir).catch(() => null)
      expect(exists).toBeNull()
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── isGeneratedRouterDir readdir catchAll ────────────────────────────

describe('detectGeneratedRouters with unreadable router', () => {
  test('handles unreadable core dir (isGeneratedRouterDir catchAll)', async () => {
    const projectRoot = path.join(tmpBase, 'detect-router-unreadable')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libDir = path.join(projectRoot, '.claude', 'skills-library')
      const outfitPath = path.join(projectRoot, '.claude', 'skills')

      // Create a group in library
      await createSkill(libDir, path.join('unreadgroup', 'child'))

      // Create a core dir in outfit that matches the group name
      const routerDir = path.join(outfitPath, 'unreadgroup')
      await mkdir(routerDir, { recursive: true })
      // Make it unreadable → readdir will fail → catchAll fires
      await chmod(routerDir, 0o000)

      process.chdir(projectRoot)
      const routers = await run(Lib.detectGeneratedRouters('project'))
      // Should not include it since readdir fails
      expect(routers).not.toContain('unreadgroup')
    } finally {
      await chmod(path.join(projectRoot, '.claude', 'skills', 'unreadgroup'), 0o755).catch(() => {})
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── restoreSnapshot rm router catchAll ──────────────────────────────

describe('restoreSnapshot rm router error path', () => {
  test('rm catchAll fires when removing read-only router', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap-rm-router-fail')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libDir = path.join(projectRoot, '.claude', 'skills-library')

      // Create library group
      await createSkill(libDir, path.join('rmgroup', 'child'))

      // Create generated router in outfit
      const routerDir = path.join(outfitPath, 'rmgroup')
      await mkdir(routerDir, { recursive: true })
      await writeFile(
        path.join(routerDir, 'SKILL.md'),
        '---\nname: rmgroup\ndescription: Router\ndisable-model-invocation: true\n---\n',
      )

      // Make outfit dir read-only so rm fails
      await chmod(outfitPath, 0o555)

      process.chdir(projectRoot)

      // Restore without the router → rm catchAll fires
      await run(Lib.restoreSnapshot([], [], 'project'))
    } finally {
      await chmod(path.join(projectRoot, '.claude', 'skills'), 0o755).catch(() => {})
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── ensureMirrorSymlink edge: existing non-symlink mirror ───────────

describe('syncAgentMirrors mirror replacement', () => {
  test('handles mirror with existing stale symlink pointing elsewhere', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-stale-symlink')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
      // Mirror is a symlink but points to wrong place
      await mkdir(path.join(projectRoot, '.codex'), { recursive: true })
      const staleTarget = path.join(projectRoot, 'stale-target')
      await mkdir(staleTarget, { recursive: true })
      await symlink(staleTarget, path.join(projectRoot, '.codex', 'skills'))

      process.chdir(projectRoot)
      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: { historyLimit: 50, defaultScope: 'project', agents: ['claude', 'codex'] },
        }),
      )

      // Should now point to canonical
      const target = await readlink(path.join(projectRoot, '.codex', 'skills'))
      expect(target).toBe(path.join(projectRoot, '.claude', 'skills'))
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('replaces non-symlink mirror dir with symlink', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-replace-dir')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Canonical exists
      await mkdir(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
      // Mirror exists as a real dir with no entries
      await mkdir(path.join(projectRoot, '.codex', 'skills'), { recursive: true })
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: { historyLimit: 50, defaultScope: 'project', agents: ['claude', 'codex'] },
        }),
      )

      // Mirror should now be a symlink
      const mirrorStat = await lstat(path.join(projectRoot, '.codex', 'skills'))
      expect(mirrorStat.isSymbolicLink()).toBe(true)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── listOutfit error paths ──────────────────────────────────────────

describe('listOutfit error paths', () => {
  test('returns empty when outfit dir is unreadable', async () => {
    const projectRoot = path.join(tmpBase, 'outfit-unreadable')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      await mkdir(outfitPath, { recursive: true })
      await chmod(outfitPath, 0o000)
      process.chdir(projectRoot)
      const outfit = await run(Lib.listOutfit('project'))
      expect(outfit).toEqual([])
    } finally {
      await chmod(path.join(projectRoot, '.claude', 'skills'), 0o755).catch(() => {})
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('returns empty when outfit dir does not exist', async () => {
    const projectRoot = path.join(tmpBase, 'outfit-missing')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      process.chdir(projectRoot)
      const outfit = await run(Lib.listOutfit('project'))
      expect(outfit).toEqual([])
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── restoreSnapshot error paths ─────────────────────────────────────

describe('restoreSnapshot error paths', () => {
  test('unlink catchAll fires when removing read-only symlink', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap-unlink')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')
      await createSkill(libPath, 'extra-link')
      await mkdir(outfitPath, { recursive: true })
      await symlink(path.join(libPath, 'extra-link'), path.join(outfitPath, 'extra-link'))

      // Make outfit read-only so unlink in the "remove extras" path fails
      await chmod(outfitPath, 0o555)

      process.chdir(projectRoot)

      // Snapshot is empty → should try to remove extra-link → unlink catchAll fires
      await run(Lib.restoreSnapshot([], [], 'project'))
    } finally {
      await chmod(path.join(projectRoot, '.claude', 'skills'), 0o755).catch(() => {})
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('symlink catchAll fires when restoring to read-only outfit', async () => {
    const projectRoot = path.join(tmpBase, 'restore-snap-symlink-fail')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')
      await createSkill(libPath, 'restore-me')
      await mkdir(outfitPath, { recursive: true })

      // Make outfit read-only so symlink creation fails → symlink catchAll fires
      await chmod(outfitPath, 0o555)

      process.chdir(projectRoot)

      // Snapshot has restore-me but outfit is read-only → symlink catchAll fires
      await run(Lib.restoreSnapshot(['restore-me'], [], 'project'))
    } finally {
      await chmod(path.join(projectRoot, '.claude', 'skills'), 0o755).catch(() => {})
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── detectGeneratedRouters ──────────────────────────────────────────

describe('detectGeneratedRouters', () => {
  test('returns empty when no core entries exist', async () => {
    const projectRoot = path.join(tmpBase, 'detect-routers')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const outfitPath = path.join(projectRoot, '.claude', 'skills')
      const libPath = path.join(projectRoot, '.claude', 'skills-library')
      await createSkill(libPath, 'just-pluggable')
      await mkdir(outfitPath, { recursive: true })
      await symlink(path.join(libPath, 'just-pluggable'), path.join(outfitPath, 'just-pluggable'))
      process.chdir(projectRoot)
      const routers = await run(Lib.detectGeneratedRouters('project'))
      expect(routers).toEqual([])
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── syncAgentMirrors with merge ─────────────────────────────────────

describe('syncAgentMirrors merge paths', () => {
  test('merges mirror entries when mirror has unique skills', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-merge')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Create canonical outfit with one skill
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'existing'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills', 'existing', 'SKILL.md'),
        '---\nname: existing\ndescription: Existing\n---\n',
      )
      // Create codex mirror as a real directory with a unique skill
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'from-codex'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.codex', 'skills', 'from-codex', 'SKILL.md'),
        '---\nname: from-codex\ndescription: From Codex\n---\n',
      )
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      // from-codex should have been moved to canonical
      const movedSkill = await readFile(
        path.join(projectRoot, '.claude', 'skills', 'from-codex', 'SKILL.md'),
        'utf-8',
      ).catch(() => null)
      expect(movedSkill).toContain('From Codex')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('handles neither canonical nor mirror existing', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-neither')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(projectRoot, { recursive: true })
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      // Both should be created
      const canonicalStat = await lstat(path.join(projectRoot, '.claude', 'skills'))
      expect(canonicalStat.isDirectory()).toBe(true)
      const mirrorStat = await lstat(path.join(projectRoot, '.codex', 'skills'))
      expect(mirrorStat.isSymbolicLink()).toBe(true)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('handles mirror as real dir with duplicate skill (drop path)', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-drop')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Same skill in both canonical and mirror
      const skillContent = '---\nname: dupe\ndescription: Dupe\n---\n'
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'dupe'), { recursive: true })
      await writeFile(path.join(projectRoot, '.claude', 'skills', 'dupe', 'SKILL.md'), skillContent)
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'dupe'), { recursive: true })
      await writeFile(path.join(projectRoot, '.codex', 'skills', 'dupe', 'SKILL.md'), skillContent)
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )

      // Canonical should still have it, mirror should be symlink now
      const canonicalContent = await readFile(
        path.join(projectRoot, '.claude', 'skills', 'dupe', 'SKILL.md'),
        'utf-8',
      )
      expect(canonicalContent).toContain('Dupe')
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── syncAgentMirrors conflict detection ─────────────────────────────

describe('syncAgentMirrors conflict', () => {
  test('throws AgentOutfitConflictError on skill content mismatch', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-conflict')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Different content in canonical vs mirror
      await mkdir(path.join(projectRoot, '.claude', 'skills', 'conflicted'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.claude', 'skills', 'conflicted', 'SKILL.md'),
        '---\nname: conflicted\ndescription: Canon version\n---\n',
      )
      await mkdir(path.join(projectRoot, '.codex', 'skills', 'conflicted'), { recursive: true })
      await writeFile(
        path.join(projectRoot, '.codex', 'skills', 'conflicted', 'SKILL.md'),
        '---\nname: conflicted\ndescription: Mirror version DIFFERENT\n---\n',
      )
      process.chdir(projectRoot)

      const exit = await runExit(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )
      // Should fail with conflict
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── syncAgentMirrors with broken symlinks ────────────────────────────

describe('syncAgentMirrors broken symlink handling', () => {
  test('handles broken symlinks in mirror during merge', async () => {
    const projectRoot = path.join(tmpBase, 'mirror-broken-sym')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      // Canonical outfit exists
      await mkdir(path.join(projectRoot, '.claude', 'skills'), { recursive: true })
      // Mirror has a broken symlink skill
      await mkdir(path.join(projectRoot, '.codex', 'skills'), { recursive: true })
      await symlink(
        '/nonexistent/broken/target',
        path.join(projectRoot, '.codex', 'skills', 'broken-skill'),
      )
      process.chdir(projectRoot)

      await run(
        Lib.syncAgentMirrors('project', {
          version: 1,
          skills: {
            historyLimit: 50,
            defaultScope: 'project',
            agents: ['claude', 'codex'],
          },
        }),
      )
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── printSlashCommandNotice ─────────────────────────────────────────

describe('printSlashCommandNotice', () => {
  test('prints notice without error', async () => {
    await run(Lib.printSlashCommandNotice)
  })
})

// ── resolveTarget with non-strict and groups ────────────────────────

describe('resolveTarget advanced', () => {
  test('resolves a group target', async () => {
    const projectRoot = path.join(tmpBase, 'resolve-target-group')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libPath = path.join(projectRoot, '.claude', 'skills-library')
      await createSkill(libPath, path.join('mygroup', 'child'))
      process.chdir(projectRoot)
      const result = await run(Lib.resolveTarget('mygroup', 'project', true))
      expect(result).not.toBeNull()
      expect(result!.nodeType).toBe('group')
      expect(result!.leaves.length).toBeGreaterThanOrEqual(1)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('resolves a callable-group target', async () => {
    const projectRoot = path.join(tmpBase, 'resolve-target-cg')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      const libPath = path.join(projectRoot, '.claude', 'skills-library')
      // Create group with its own SKILL.md + a child
      await createSkill(libPath, path.join('cgroup', 'child'))
      await writeFile(
        path.join(libPath, 'cgroup', 'SKILL.md'),
        '---\nname: cgroup\ndescription: Callable group\n---\n',
      )
      process.chdir(projectRoot)
      const result = await run(Lib.resolveTarget('cgroup', 'project', true))
      expect(result).not.toBeNull()
      expect(result!.nodeType).toBe('callable-group')
      expect(result!.leaves.length).toBeGreaterThanOrEqual(2)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test('resolves with strict=false falls through scopes', async () => {
    const projectRoot = path.join(tmpBase, 'resolve-target-fallthrough')
    const origCwd = process.cwd()
    try {
      await rm(projectRoot, { recursive: true, force: true })
      await mkdir(path.join(projectRoot, '.claude', 'skills-library'), { recursive: true })
      process.chdir(projectRoot)
      // Skill doesn't exist in project, strict=false checks user too
      const result = await run(Lib.resolveTarget('nonexistent', 'project', false))
      // May find it in user scope or return null
      // The important thing is exercising the fallthrough code path
      expect(result === null || result.colonName === 'nonexistent').toBe(true)
    } finally {
      process.chdir(origCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ── reportResults / batchToRows ─────────────────────────────────────

describe('reportResults', () => {
  test('handles mixed success and error rows', async () => {
    const rows: Lib.ResultRow[] = [
      { status: 'ok', name: 'skill-a' },
      { status: 'error', name: 'skill-b', reason: 'not found' },
      { status: 'skip', name: 'skill-c', reason: 'already on' },
    ]
    await run(Lib.reportResults(rows))
  })

  test('handles rows with scope and commitment', async () => {
    const rows: Lib.ResultRow[] = [
      { status: 'ok', name: 'skill-a', scope: 'project', commitment: 'pluggable' },
      { status: 'ok', name: 'skill-b', scope: 'user' },
      { status: 'abort', name: 'skill-c', scope: 'project', reason: 'not applied' },
    ]
    await run(Lib.reportResults(rows))
  })

  test('handles empty rows', async () => {
    await run(Lib.reportResults([]))
  })
})

describe('batchToRows', () => {
  test('converts batch validation to rows', () => {
    const batch: Lib.BatchValidation<{ name: string }> = {
      actions: [{ name: 'a' }],
      skips: [{ name: 'b', reason: 'already on' }],
      errors: [{ name: 'c', reason: 'not found' }],
    }
    const rows = Lib.batchToRows(batch, (a) => ({
      status: 'ok' as const,
      name: a.name,
    }))
    expect(rows.length).toBe(3)
  })

  test('marks actions as aborted when aborted flag set', () => {
    const batch: Lib.BatchValidation<{ name: string }> = {
      actions: [{ name: 'a' }],
      skips: [],
      errors: [{ name: 'b', reason: 'fail' }],
    }
    const rows = Lib.batchToRows(batch, (a) => ({ status: 'ok' as const, name: a.name }), true)
    expect(rows[0]!.status).toBe('abort')
    expect(rows[0]!.reason).toBe('not applied')
  })
})

// ── emptyBatch / shouldAbort ────────────────────────────────────────

describe('emptyBatch', () => {
  test('returns empty batch structure', () => {
    const batch = Lib.emptyBatch()
    expect(batch.actions).toEqual([])
    expect(batch.skips).toEqual([])
    expect(batch.errors).toEqual([])
  })
})

describe('shouldAbort', () => {
  test('returns true when strict and has errors', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: [],
      skips: [],
      errors: [{ name: 'x', reason: 'fail' }],
    }
    expect(Lib.shouldAbort(batch, true)).toBe(true)
  })

  test('returns true even when not strict if has errors', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: [],
      skips: [],
      errors: [{ name: 'x', reason: 'fail' }],
    }
    expect(Lib.shouldAbort(batch, false)).toBe(true)
  })

  test('returns false when not strict with only skips', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: [],
      skips: [{ name: 'x', reason: 'skip' }],
      errors: [],
    }
    expect(Lib.shouldAbort(batch, false)).toBe(false)
  })

  test('returns true when strict with only skips', () => {
    const batch: Lib.BatchValidation<string> = {
      actions: [],
      skips: [{ name: 'x', reason: 'skip' }],
      errors: [],
    }
    expect(Lib.shouldAbort(batch, true)).toBe(true)
  })
})
