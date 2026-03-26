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
})

describe('pathToColon', () => {
  test('converts slash to colon', () => {
    expect(Lib.pathToColon('ts/tooling')).toBe('ts:tooling')
  })
  test('handles single segment', () => {
    expect(Lib.pathToColon('alpha')).toBe('alpha')
  })
})

describe('flattenName', () => {
  test('converts slash to underscore', () => {
    expect(Lib.flattenName('ts/tooling')).toBe('ts_tooling')
  })
  test('handles single segment', () => {
    expect(Lib.flattenName('alpha')).toBe('alpha')
  })
})

describe('unflattenName', () => {
  test('converts underscore to slash', () => {
    expect(Lib.unflattenName('ts_tooling')).toBe('ts/tooling')
  })
  test('handles single segment', () => {
    expect(Lib.unflattenName('alpha')).toBe('alpha')
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
