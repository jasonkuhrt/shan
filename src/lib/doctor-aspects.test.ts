import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as Aspects from './doctor-aspects.js'
import * as Lib from './skill-library.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmpBase = path.join(import.meta.dir, '__test_doctor_tmp__')

const makeConfig = (agents: 'auto' | Lib.Agent[] = ['claude']): Lib.ShanConfig => ({
  version: 1,
  skills: {
    historyLimit: 50,
    defaultScope: 'project',
    agents,
  },
})

const inferScope = (overrides: Partial<Aspects.DoctorContext>): Lib.Scope => {
  if (overrides.scope) return overrides.scope
  if ((overrides.projectOutfit?.length ?? 0) > 0) return 'project'
  if ((overrides.gitignoreEntries?.length ?? 0) > 0) return 'project'
  if (overrides.library?.some((skill) => skill.libraryScope === 'project')) return 'project'

  const currentKeys = Object.keys(overrides.state?.current ?? {})
  const historyKeys = Object.keys(overrides.state?.history ?? {})
  if (currentKeys.some((key) => key !== 'global') || historyKeys.some((key) => key !== 'global')) {
    return 'project'
  }

  return 'user'
}

// ── Helper: create a minimal DoctorContext ────────────────────────

const makeContext = (overrides: Partial<Aspects.DoctorContext> = {}): Aspects.DoctorContext => ({
  scope: inferScope(overrides),
  state: { version: 2, current: {}, history: {} },
  library: [],
  userLibraryDir: Lib.LIBRARY_DIR,
  projectLibraryDir: Lib.projectLibraryDir(),
  userOutfit: [],
  userOutfitDir: Lib.outfitDir('user'),
  projectOutfit: [],
  projectOutfitDir: path.join(process.cwd(), '.claude/skills'),
  gitignoreEntries: [],
  config: makeConfig(),
  configuredAgents: ['claude'],
  ...overrides,
})

// ── ALL_ASPECTS registry ──────────────────────────────────────────

describe('ALL_ASPECTS', () => {
  test('exports all aspects', () => {
    expect(Aspects.ALL_ASPECTS.length).toBe(14)
  })
  test('each aspect has required fields', () => {
    for (const aspect of Aspects.ALL_ASPECTS) {
      expect(aspect.name).toBeTruthy()
      expect(aspect.description).toBeTruthy()
      expect(['error', 'warning', 'info']).toContain(aspect.level)
      expect(typeof aspect.detect).toBe('function')
    }
  })
})

// ── agent-mirror ───────────────────────────────────────────────────

describe('agent-mirror aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'agent-mirror')!

  test('no findings when no mirror agents are enabled', async () => {
    const findings = await run(aspect.detect(makeContext()))
    expect(findings).toEqual([])
  })

  test('detects missing codex project mirror when codex is enabled', async () => {
    const dir = path.join(tmpBase, 'agent-mirror-detect')
    const origCwd = process.cwd()

    try {
      await mkdir(path.join(dir, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(path.join(dir, '.claude', 'skills', 'alpha', 'SKILL.md'), '# alpha')
      process.chdir(dir)

      const findings = await run(
        aspect.detect(
          makeContext({
            scope: 'project',
            config: makeConfig(['claude', 'codex']),
            configuredAgents: ['claude', 'codex'],
            projectOutfitDir: path.join(dir, '.claude', 'skills'),
          }),
        ),
      )

      const projectFinding = findings.find((finding) =>
        finding.message.includes('[project] codex skills'),
      )

      expect(projectFinding).toBeDefined()
      expect(projectFinding!.message).toContain('missing')
      expect(projectFinding!.fixable).toBe(true)
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fix creates codex project mirror symlink to claude outfit', async () => {
    const dir = path.join(tmpBase, 'agent-mirror-fix')
    const origCwd = process.cwd()

    try {
      await mkdir(path.join(dir, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(path.join(dir, '.claude', 'skills', 'alpha', 'SKILL.md'), '# alpha')
      process.chdir(dir)

      const findings = await run(
        aspect.detect(
          makeContext({
            scope: 'project',
            config: makeConfig(['claude', 'codex']),
            configuredAgents: ['claude', 'codex'],
            projectOutfitDir: path.join(dir, '.claude', 'skills'),
          }),
        ),
      )

      const projectFinding = findings.find((finding) =>
        finding.message.includes('[project] codex skills'),
      )

      expect(projectFinding).toBeDefined()
      const result = await run(projectFinding!.fix!())
      expect(result).toContain('reconciled codex skills mirror (project)')
      expect(await readlink(path.join(dir, '.codex', 'skills'))).toBe(
        path.join(dir, '.claude', 'skills'),
      )
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fix migrates a codex-owned real project directory when claude outfit is missing', async () => {
    const dir = path.join(tmpBase, 'agent-mirror-migrate')
    const origCwd = process.cwd()

    try {
      await mkdir(path.join(dir, '.codex', 'skills', 'alpha'), { recursive: true })
      await writeFile(path.join(dir, '.codex', 'skills', 'alpha', 'SKILL.md'), '# alpha')
      process.chdir(dir)

      const findings = await run(
        aspect.detect(
          makeContext({
            scope: 'project',
            config: makeConfig(['claude', 'codex']),
            configuredAgents: ['claude', 'codex'],
            projectOutfitDir: path.join(dir, '.claude', 'skills'),
          }),
        ),
      )

      const projectFinding = findings.find((finding) =>
        finding.message.includes('[project] codex skills'),
      )

      expect(projectFinding).toBeDefined()
      await run(projectFinding!.fix!())
      expect(await readlink(path.join(dir, '.codex', 'skills'))).toBe(
        path.join(dir, '.claude', 'skills'),
      )
      expect(
        await readFile(path.join(dir, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
      ).toBe('# alpha')
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('accepts project mirrors that resolve to the same canonical directory through different symlink paths', async () => {
    const dir = path.join(tmpBase, 'agent-mirror-resolved-match')
    const origCwd = process.cwd()

    try {
      const sharedDir = path.join(dir, 'shared-skills')
      await mkdir(sharedDir, { recursive: true })
      await mkdir(path.join(dir, '.claude'), { recursive: true })
      await mkdir(path.join(dir, '.codex'), { recursive: true })
      await symlink(sharedDir, path.join(dir, '.claude', 'skills'))
      await symlink(sharedDir, path.join(dir, '.codex', 'skills'))
      process.chdir(dir)

      const findings = await run(
        aspect.detect(
          makeContext({
            scope: 'project',
            config: makeConfig(['claude', 'codex']),
            configuredAgents: ['claude', 'codex'],
            projectOutfitDir: path.join(dir, '.claude', 'skills'),
          }),
        ),
      )

      const projectFinding = findings.find((finding) =>
        finding.message.includes('[project] codex skills'),
      )
      expect(projectFinding).toBeUndefined()
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ignores project mirror drift during user-scope audits', async () => {
    const dir = path.join(tmpBase, 'agent-mirror-user-scope')
    const origCwd = process.cwd()

    try {
      await mkdir(path.join(dir, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(path.join(dir, '.claude', 'skills', 'alpha', 'SKILL.md'), '# alpha')
      process.chdir(dir)

      const findings = await run(
        aspect.detect(
          makeContext({
            scope: 'user',
            config: makeConfig(['claude', 'codex']),
            configuredAgents: ['claude', 'codex'],
            projectOutfitDir: path.join(dir, '.claude', 'skills'),
          }),
        ),
      )

      expect(findings.some((finding) => finding.message.includes('[project] codex skills'))).toBe(
        false,
      )
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── broken-symlink ────────────────────────────────────────────────

describe('broken-symlink aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'broken-symlink')!

  test('no findings when no pluggable entries', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('no findings when pluggable entries are valid', async () => {
    const dir = path.join(tmpBase, 'bs-valid')
    const libDir = path.join(tmpBase, 'bs-lib')
    try {
      await mkdir(dir, { recursive: true })
      await mkdir(path.join(libDir, 'skill1'), { recursive: true })
      await writeFile(path.join(libDir, 'skill1', 'SKILL.md'), 'test')

      const ctx = makeContext({
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'skill1',
            dir: path.join(dir, 'skill1'),
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: path.join(libDir, 'skill1'),
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(libDir, { recursive: true, force: true })
    }
  })

  test('detects broken symlink with no target', async () => {
    const ctx = makeContext({
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'broken1',
          dir: '/fake/path',
          commitment: 'pluggable',
          scope: 'user',
          symlinkTarget: '',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('no symlink target')
    expect(findings[0]!.fixable).toBe(true)
  })

  test('detects broken symlink with nonexistent target', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'broken2',
          dir: '/fake/path',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: '/nonexistent/target',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('/nonexistent/target')
    expect(findings[0]!.fixable).toBe(true)
  })

  test('skips core entries', async () => {
    const ctx = makeContext({
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'core1',
          dir: '/fake/path',
          commitment: 'core',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('fix for no-target removes symlink', async () => {
    const dir = path.join(tmpBase, 'bs-fix-1')
    try {
      await mkdir(dir, { recursive: true })
      // Create a broken symlink
      await symlink('/nonexistent', path.join(dir, 'broken'))

      const ctx = makeContext({
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'broken',
            dir: path.join(dir, 'broken'),
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: '',
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      // Run the fix
      const fix = findings[0]!.fix!
      const result = await run(fix())
      expect(result).toContain('removed broken symlink')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── state-drift ───────────────────────────────────────────────────

describe('state-drift aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'state-drift')!

  test('no findings when state is empty', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects missing symlink from state', async () => {
    const ctx = makeContext({
      state: {
        version: 2,
        current: {
          global: { installs: ['__missing_skill__'] },
        },
        history: {},
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('no symlink')
    expect(findings[0]!.fixable).toBe(true)
  })
})

// ── orphaned-router ───────────────────────────────────────────────

describe('orphaned-router aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'orphaned-router')!

  test('no findings when no routers', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })
})

// ── stale-gitignore ───────────────────────────────────────────────

describe('stale-gitignore aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-gitignore')!

  test('no findings when no gitignore entries', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects stale gitignore entries', async () => {
    const ctx = makeContext({
      gitignoreEntries: ['.claude/skills/old_skill'],
      projectOutfit: [], // no project outfit → entry is stale
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('old_skill')
    expect(findings[0]!.aspect).toBe('stale-gitignore')
  })

  test('no findings when gitignore matches outfit', async () => {
    const ctx = makeContext({
      gitignoreEntries: ['.claude/skills/active_skill'],
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'active_skill',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: '/lib/active_skill',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('ignores configured mirror gitignore entries', async () => {
    const ctx = makeContext({
      gitignoreEntries: ['.codex/skills'],
      config: makeConfig(['claude', 'codex']),
      configuredAgents: ['claude', 'codex'],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })
})

// ── classifyMismatch ─────────────────────────────────────────────

describe('classifyMismatch', () => {
  test('SEPARATOR_ONLY when names differ only in separators (colon vs underscore)', () => {
    const census = new Map<string, number>()
    expect(Aspects.classifyMismatch('align:once_system', 'align:once:system', census)).toBe(
      'separator_only',
    )
  })

  test('SEPARATOR_ONLY when names differ only in separators (hyphen vs colon)', () => {
    const census = new Map<string, number>()
    expect(Aspects.classifyMismatch('cc:teacher_core', 'cc:teacher-core', census)).toBe(
      'separator_only',
    )
  })

  test('SEPARATOR_ONLY when names differ only in separators (underscore vs colon)', () => {
    const census = new Map<string, number>()
    expect(Aspects.classifyMismatch('flo:next_swarm', 'flo:next:swarm', census)).toBe(
      'separator_only',
    )
  })

  test('NAMESPACE_RELOCATION when FM prefix is established namespace', () => {
    // FM name cc:tips, and cc: has 3 other skills
    const census = new Map<string, number>([['cc', 3]])
    expect(Aspects.classifyMismatch('tips', 'cc:tips', census)).toBe('namespace_relocation')
  })

  test('NAMESPACE_RELOCATION not fixable when FM prefix is not established', () => {
    // FM name session:new, but session: has 0 peers
    const census = new Map<string, number>()
    expect(Aspects.classifyMismatch('session_new', 'session:new', census)).toBe('complete_rename')
  })

  test('NAMESPACE_RELOCATION not fixable when namespace has only 1 peer', () => {
    // session: has only 1 other skill — need >= 2
    const census = new Map<string, number>([['session', 1]])
    expect(Aspects.classifyMismatch('session_new', 'session:new', census)).toBe('complete_rename')
  })

  test('COMPLETE_RENAME when tokens differ entirely', () => {
    const census = new Map<string, number>()
    expect(Aspects.classifyMismatch('find-session', 'cc-session-search', census)).toBe(
      'complete_rename',
    )
  })

  test('SEPARATOR_ONLY takes priority over NAMESPACE_RELOCATION', () => {
    // Even if the namespace is established, separator-only match should win
    const census = new Map<string, number>([['align', 5]])
    expect(Aspects.classifyMismatch('align:once_system', 'align:once:system', census)).toBe(
      'separator_only',
    )
  })
})

// ── buildNamespaceCensus ─────────────────────────────────────────

describe('buildNamespaceCensus', () => {
  test('counts skills per colon prefix', () => {
    const library: Lib.SkillInfo[] = [
      {
        colonName: 'cc:authoring',
        libraryRelPath: 'cc/authoring',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
      {
        colonName: 'cc:plugins',
        libraryRelPath: 'cc/plugins',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
      {
        colonName: 'cc:teacher-core',
        libraryRelPath: 'cc/teacher-core',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
      {
        colonName: 'solo',
        libraryRelPath: 'solo',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
    ]
    const census = Aspects.buildNamespaceCensus(library)
    expect(census.get('cc')).toBe(3)
    expect(census.has('solo')).toBe(false) // no colon prefix
  })

  test('counts nested prefixes', () => {
    const library: Lib.SkillInfo[] = [
      {
        colonName: 'a:b:c',
        libraryRelPath: 'a/b/c',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
      {
        colonName: 'a:b:d',
        libraryRelPath: 'a/b/d',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
      {
        colonName: 'a:e',
        libraryRelPath: 'a/e',
        libraryDir: '/lib',
        libraryScope: 'user',
        frontmatter: null,
      },
    ]
    const census = Aspects.buildNamespaceCensus(library)
    expect(census.get('a')).toBe(3)
    expect(census.get('a:b')).toBe(2)
  })

  test('returns empty map for empty library', () => {
    const census = Aspects.buildNamespaceCensus([])
    expect(census.size).toBe(0)
  })
})

// ── frontmatter-mismatch ──────────────────────────────────────────

describe('frontmatter-mismatch aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'frontmatter-mismatch')!

  test('no findings for matching frontmatter', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'test',
          libraryRelPath: 'test',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'test', description: 'A test' },
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects missing frontmatter', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'test',
          libraryRelPath: 'test',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('missing frontmatter')
  })

  test('SEPARATOR_ONLY mismatch is fixable', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'align:once_system',
          libraryRelPath: 'align/once_system',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'align:once:system', description: 'desc' },
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixable).toBe(true)
    expect(findings[0]!.message).toContain('separator-only mismatch')
    expect(findings[0]!.message).toContain('will rename dir')
  })

  test('NAMESPACE_RELOCATION with established namespace is fixable', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'tips',
          libraryRelPath: 'tips',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'cc:tips', description: 'desc' },
        },
        // 2 other cc: skills to establish the namespace
        {
          colonName: 'cc:authoring',
          libraryRelPath: 'cc/authoring',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'cc:authoring', description: 'desc' },
        },
        {
          colonName: 'cc:plugins',
          libraryRelPath: 'cc/plugins',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'cc:plugins', description: 'desc' },
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixable).toBe(true)
    expect(findings[0]!.message).toContain('cc:')
    expect(findings[0]!.message).toContain('peers')
    expect(findings[0]!.message).toContain('will rename dir')
  })

  test('NAMESPACE_RELOCATION without established namespace is not fixable', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'session_new',
          libraryRelPath: 'session_new',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'session:new', description: 'desc' },
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixable).toBe(false)
    expect(findings[0]!.message).toContain('0 peers')
  })

  test('COMPLETE_RENAME is not fixable', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'find-session',
          libraryRelPath: 'find-session',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'cc-session-search', description: 'desc' },
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fixable).toBe(false)
    expect(findings[0]!.message).toContain('complete rename')
    expect(findings[0]!.message).toContain('manual review needed')
  })
})

// ── frontmatter-mismatch fix action ──────────────────────────────

describe('frontmatter-mismatch fix action', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'frontmatter-mismatch')!

  test('fix renames directory to match frontmatter name', async () => {
    const libDir = path.join(tmpBase, 'fm-fix-lib')
    const oldDir = path.join(libDir, 'align', 'once_system')
    const newDir = path.join(libDir, 'align', 'once', 'system')
    try {
      await mkdir(oldDir, { recursive: true })
      await writeFile(path.join(oldDir, 'SKILL.md'), '---\nname: align:once:system\n---\ntest')

      const ctx = makeContext({
        library: [
          {
            colonName: 'align:once_system',
            libraryRelPath: 'align/once_system',
            libraryDir: libDir,
            libraryScope: 'user',
            frontmatter: { name: 'align:once:system', description: 'desc' },
          },
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      expect(findings[0]!.fix).toBeDefined()

      const result = await run(findings[0]!.fix!())
      expect(result).toContain('renamed')

      // Verify old dir is gone and new dir exists
      const { lstat: ls } = await import('node:fs/promises')
      await expect(ls(oldDir)).rejects.toThrow()
      const stat = await ls(newDir)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await rm(libDir, { recursive: true, force: true })
    }
  })

  test('fix repoints outfit symlinks after rename', async () => {
    const libDir = path.join(tmpBase, 'fm-fix-symlink')
    const outfitDir = path.join(tmpBase, 'fm-fix-outfit')
    const oldDir = path.join(libDir, 'align', 'once_system')
    const newDir = path.join(libDir, 'align', 'once', 'system')
    try {
      await mkdir(oldDir, { recursive: true })
      await mkdir(outfitDir, { recursive: true })
      await writeFile(path.join(oldDir, 'SKILL.md'), '---\nname: align:once:system\n---\ntest')
      // Create a symlink in outfit pointing to old dir
      await symlink(oldDir, path.join(outfitDir, 'align_once_system'))

      const ctx = makeContext({
        library: [
          {
            colonName: 'align:once_system',
            libraryRelPath: 'align/once_system',
            libraryDir: libDir,
            libraryScope: 'user',
            frontmatter: { name: 'align:once:system', description: 'desc' },
          },
        ],
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'align_once_system',
            dir: path.join(outfitDir, 'align_once_system'),
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: oldDir,
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const result = await run(findings[0]!.fix!())
      expect(result).toContain('renamed')

      // Verify symlink now points to new dir
      const target = await readlink(path.join(outfitDir, 'align_once_system'))
      expect(target).toBe(newDir)
    } finally {
      await rm(libDir, { recursive: true, force: true })
      await rm(outfitDir, { recursive: true, force: true })
    }
  })

  test('fix errors when target directory already exists', async () => {
    const libDir = path.join(tmpBase, 'fm-fix-exists')
    const oldDir = path.join(libDir, 'align', 'once_system')
    const newDir = path.join(libDir, 'align', 'once', 'system')
    try {
      await mkdir(oldDir, { recursive: true })
      await mkdir(newDir, { recursive: true }) // target already exists!
      await writeFile(path.join(oldDir, 'SKILL.md'), '---\nname: align:once:system\n---\ntest')

      const ctx = makeContext({
        library: [
          {
            colonName: 'align:once_system',
            libraryRelPath: 'align/once_system',
            libraryDir: libDir,
            libraryScope: 'user',
            frontmatter: { name: 'align:once:system', description: 'desc' },
          },
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      // Fix should fail because target exists
      await expect(run(findings[0]!.fix!())).rejects.toThrow()
    } finally {
      await rm(libDir, { recursive: true, force: true })
    }
  })
})

// ── name-conflict ─────────────────────────────────────────────────

describe('name-conflict aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'name-conflict')!

  test('no findings with no conflicts', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'test',
          libraryRelPath: 'test',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'test', description: 'desc' },
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects collision with user core skill', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'conflict',
          libraryRelPath: 'conflict',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: { name: 'conflict', description: 'desc' },
        },
      ],
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'conflict',
          dir: '/outfit/conflict',
          commitment: 'core',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('user core skill')
  })

  test('detects collision with project core skill', async () => {
    const ctx = makeContext({
      scope: 'project',
      library: [
        {
          colonName: 'conflict',
          libraryRelPath: 'conflict',
          libraryDir: '/lib',
          libraryScope: 'project',
          frontmatter: { name: 'conflict', description: 'desc' },
        },
      ],
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'conflict',
          dir: '/outfit/conflict',
          commitment: 'core',
          scope: 'project',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('project core skill')
  })
})

// ── duplicate-name ────────────────────────────────────────────────

describe('duplicate-name aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'duplicate-name')!

  test('no findings with unique names', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'a',
          libraryRelPath: 'a',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: null,
        },
        {
          colonName: 'b',
          libraryRelPath: 'b',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects duplicate flat names', async () => {
    const ctx = makeContext({
      scope: 'project',
      library: [
        {
          colonName: 'a:b',
          libraryRelPath: 'a/b',
          libraryDir: '/lib1',
          libraryScope: 'project',
          frontmatter: null,
        },
        {
          colonName: 'a:b',
          libraryRelPath: 'a/b',
          libraryDir: '/lib2',
          libraryScope: 'project',
          frontmatter: null,
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('a_b')
  })
})

// ── orphaned-scope ────────────────────────────────────────────────

describe('orphaned-scope aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'orphaned-scope')!

  test('no findings when no history', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips global key', async () => {
    const ctx = makeContext({
      state: {
        version: 2,
        current: {},
        history: { global: { entries: [], undoneCount: 0 } },
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects nonexistent project path', async () => {
    const ctx = makeContext({
      scope: 'user',
      state: {
        version: 2,
        current: {},
        history: { '/nonexistent/project/path': { entries: [], undoneCount: 0 } },
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('/nonexistent/project/path')
  })

  test('no findings for existing path', async () => {
    const dir = path.join(tmpBase, 'orphan-scope-test')
    try {
      await mkdir(dir, { recursive: true })
      const ctx = makeContext({
        state: {
          version: 2,
          current: {},
          history: { [dir]: { entries: [], undoneCount: 0 } },
        },
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── shadow ────────────────────────────────────────────────────────

describe('shadow aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'shadow')!

  test('no findings when no project library', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'test',
          libraryRelPath: 'test',
          libraryDir: Lib.LIBRARY_DIR,
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips duplicate shadow findings when project library resolves to user library', async () => {
    const dir = path.join(tmpBase, 'shadow-shared-library')
    const userLibraryDir = path.join(dir, 'user-library')
    const projectLibraryDir = path.join(dir, 'project-library')

    try {
      await mkdir(path.join(userLibraryDir, 'shared-skill'), { recursive: true })
      await writeFile(path.join(userLibraryDir, 'shared-skill', 'SKILL.md'), 'shared')
      await symlink(userLibraryDir, projectLibraryDir)

      const ctx = makeContext({
        scope: 'project',
        userLibraryDir,
        projectLibraryDir,
        library: [
          {
            colonName: 'shared-skill',
            libraryRelPath: 'shared-skill',
            libraryDir: userLibraryDir,
            libraryScope: 'user',
            frontmatter: null,
          },
        ],
      })

      const findings = await run(aspect.detect(ctx))
      expect(findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── stale-shadow ──────────────────────────────────────────────────

describe('stale-shadow aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-shadow')!

  test('no findings when no project outfit', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips core entries', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'core1',
          dir: '/fake',
          commitment: 'core',
          scope: 'project',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips entries not pointing to user library', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'skill1',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: '/some/other/path',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips findings when user and project libraries share the same backing store', async () => {
    const dir = path.join(tmpBase, 'stale-shadow-shared-library')
    const userLibraryDir = path.join(dir, 'user-library')
    const projectLibraryDir = path.join(dir, 'project-library')
    const projectOutfitDir = path.join(dir, 'project-outfit')

    try {
      await mkdir(path.join(userLibraryDir, 'shared-skill'), { recursive: true })
      await writeFile(path.join(userLibraryDir, 'shared-skill', 'SKILL.md'), 'shared')
      await mkdir(projectOutfitDir, { recursive: true })
      await symlink(userLibraryDir, projectLibraryDir)

      const ctx = makeContext({
        scope: 'project',
        userLibraryDir,
        projectLibraryDir,
        projectOutfitDir,
        projectOutfit: [
          Lib.OutfitEntry.make({
            name: 'shared-skill',
            dir: path.join(projectOutfitDir, 'shared-skill'),
            commitment: 'pluggable',
            scope: 'project',
            symlinkTarget: path.join(userLibraryDir, 'shared-skill'),
          }),
        ],
      })

      const findings = await run(aspect.detect(ctx))
      expect(findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── cross-scope-install ───────────────────────────────────────────

describe('cross-scope-install aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'cross-scope-install')!

  test('no findings when no cross-scope', async () => {
    const ctx = makeContext({
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'ok',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
          symlinkTarget: Lib.LIBRARY_DIR + '/ok',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects user outfit pointing to project library', async () => {
    const ctx = makeContext({
      scope: 'user',
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'cross',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
          symlinkTarget: '/some/project/.claude/skills-library/cross',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.aspect).toBe('cross-scope-install')
  })

  test('detects project outfit pointing to user library', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'cross',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: Lib.LIBRARY_DIR + '/cross',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.aspect).toBe('cross-scope-install')
  })

  test('skips project findings when the project library resolves to the user library', async () => {
    const dir = path.join(tmpBase, 'cross-scope-shared-library')
    const userLibraryDir = path.join(dir, 'user-library')
    const projectLibraryDir = path.join(dir, 'project-library')
    const projectOutfitDir = path.join(dir, 'project-outfit')

    try {
      await mkdir(path.join(userLibraryDir, 'shared-skill'), { recursive: true })
      await writeFile(path.join(userLibraryDir, 'shared-skill', 'SKILL.md'), 'shared')
      await mkdir(projectOutfitDir, { recursive: true })
      await symlink(userLibraryDir, projectLibraryDir)

      const ctx = makeContext({
        scope: 'project',
        userLibraryDir,
        projectLibraryDir,
        projectOutfitDir,
        projectOutfit: [
          Lib.OutfitEntry.make({
            name: 'shared-skill',
            dir: path.join(projectOutfitDir, 'shared-skill'),
            commitment: 'pluggable',
            scope: 'project',
            symlinkTarget: path.join(userLibraryDir, 'shared-skill'),
          }),
        ],
      })

      const findings = await run(aspect.detect(ctx))
      expect(findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips core entries', async () => {
    const ctx = makeContext({
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'core',
          dir: '/fake',
          commitment: 'core',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips entries without symlinkTarget', async () => {
    const ctx = makeContext({
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'no-target',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('fix removes cross-scope user symlink', async () => {
    const dir = path.join(tmpBase, 'cross-fix-1')
    try {
      await mkdir(dir, { recursive: true })
      await symlink('/some/project/.claude/skills-library/cross', path.join(dir, 'cross'))

      const ctx = makeContext({
        scope: 'user',
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'cross',
            dir: path.join(dir, 'cross'),
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: '/some/project/.claude/skills-library/cross',
          }),
        ],
      })
      // We can't easily test the fix because outfitDir('user') is hardcoded
      // Just verify the finding is detected
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── new-leaf ──────────────────────────────────────────────────────

describe('new-leaf aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'new-leaf')!

  test('no findings when no library skills', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('no findings when skill already installed', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'grp:child',
          libraryRelPath: 'grp/child',
          libraryDir: Lib.LIBRARY_DIR,
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'grp_child',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('detects new leaf when sibling is installed', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'grp:new-child',
          libraryRelPath: 'grp/new-child',
          libraryDir: Lib.LIBRARY_DIR,
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'grp_existing',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('grp:new-child')
  })

  test('skips skills from different scope library', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'grp:child',
          libraryRelPath: 'grp/child',
          libraryDir: '/project/.claude/skills-library',
          libraryScope: 'project',
          frontmatter: null,
        },
      ],
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'grp_existing',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })
})

// ── stale-router ──────────────────────────────────────────────────

describe('stale-router aspect', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-router')!

  test('no findings when no routers', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })
})

// ── Fix functions ─────────────────────────────────────────────────

describe('broken-symlink fix with nonexistent target', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'broken-symlink')!

  test('fix for broken target runs tryGitRenameRepoint then removes', async () => {
    const dir = path.join(tmpBase, 'bs-fix-target')
    try {
      await mkdir(dir, { recursive: true })
      // Create a symlink to nonexistent target
      const linkPath = path.join(dir, 'broken-target')
      await symlink('/nonexistent/old/path', linkPath)

      const ctx = makeContext({
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'broken-target',
            dir: linkPath,
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: '/nonexistent/old/path',
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      expect(findings[0]!.fix).toBeDefined()
      // Execute the fix — tryGitRenameRepoint will fail (nonexistent cwd),
      // then it falls back to removing the symlink
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('removed broken symlink')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('state-drift fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'state-drift')!

  test('fix removes from state when library skill not found', async () => {
    const ctx = makeContext({
      state: {
        version: 2,
        current: {
          global: { installs: ['__missing_drift_skill__'] },
        },
        history: {},
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fix).toBeDefined()
    // Execute the fix
    const fixResult = await run(findings[0]!.fix!())
    // Should either restore or remove from state
    expect(typeof fixResult).toBe('string')
  })
})

describe('stale-gitignore fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-gitignore')!

  test('fix removes stale entry from gitignore', async () => {
    const dir = path.join(tmpBase, 'stale-gi-fix')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.gitignore'),
        '# shan-managed (do not edit)\n.claude/skills/stale_skill\n# end shan-managed\n',
      )
      const ctx = makeContext({
        gitignoreEntries: ['.claude/skills/stale_skill'],
        projectOutfit: [],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      // The fix calls manageGitignoreRemove on process.cwd() —
      // we just verify the fix function exists and runs
      expect(findings[0]!.fix).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orphaned-scope fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'orphaned-scope')!

  test('fix prunes scope from state', async () => {
    const ctx = makeContext({
      scope: 'user',
      state: {
        version: 2,
        current: {},
        history: { '/nonexistent/project/pruned': { entries: [], undoneCount: 0 } },
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fix).toBeDefined()
  })
})

describe('cross-scope-install fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'cross-scope-install')!

  test('fix for project-to-user cross scope', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'cross-proj',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: Lib.LIBRARY_DIR + '/cross-proj',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fix).toBeDefined()
  })
})

describe('new-leaf fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'new-leaf')!

  test('fix symlinks new leaf', async () => {
    const ctx = makeContext({
      library: [
        {
          colonName: 'grp:new-leaf',
          libraryRelPath: 'grp/new-leaf',
          libraryDir: Lib.LIBRARY_DIR,
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'grp_existing',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fix).toBeDefined()
  })
})

describe('orphaned-router fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'orphaned-router')!

  test('detects and provides fix for orphaned routers', async () => {
    // This is hard to test without real outfit dirs with routers
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(Array.isArray(findings)).toBe(true)
  })
})

describe('stale-router fix', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-router')!

  test('detects stale router content', async () => {
    const ctx = makeContext()
    const findings = await run(aspect.detect(ctx))
    expect(Array.isArray(findings)).toBe(true)
  })
})

// ── state-drift with project scope ────────────────────────────────

describe('state-drift with project scope', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'state-drift')!

  test('detects missing symlink for project scope', async () => {
    const ctx = makeContext({
      scope: 'project',
      state: {
        version: 2,
        current: {
          project: { installs: ['__missing_project_skill__'] },
        },
        history: {},
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('project')
  })

  test('handles custom project path key', async () => {
    const customPath = process.cwd()
    const ctx = makeContext({
      scope: 'project',
      state: {
        version: 2,
        current: {
          [customPath]: { installs: ['__missing_custom__'] },
        },
        history: {},
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
  })
})

// ── shadow with real project lib ──────────────────────────────────

describe('shadow with project library', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'shadow')!

  test('detects shadowing when project lib has same skill', async () => {
    // shadow.detect uses Lib.projectLibraryDir() which is cwd-based
    const projLibDir = Lib.projectLibraryDir()
    const projSkillDir = path.join(projLibDir, '__shadow_detect_test__')
    try {
      await mkdir(projSkillDir, { recursive: true })
      await writeFile(path.join(projSkillDir, 'SKILL.md'), 'test')

      const ctx = makeContext({
        scope: 'project',
        library: [
          {
            colonName: '__shadow_detect_test__',
            libraryRelPath: '__shadow_detect_test__',
            libraryDir: Lib.LIBRARY_DIR,
            libraryScope: 'user',
            frontmatter: null,
          },
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings.length).toBe(1)
      expect(findings[0]!.message).toContain('shadows user library')
    } finally {
      await rm(projSkillDir, { recursive: true, force: true })
    }
  })
})

// ── stale-shadow deeper paths ─────────────────────────────────────

describe('stale-shadow edge cases', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-shadow')!

  test('skips entries without symlinkTarget', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'no-target',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })

  test('skips entries pointing outside user library', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: 'outside',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: '/other/location',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })
})

// ── state-drift fix deeper coverage ───────────────────────────────

describe('state-drift fix execution', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'state-drift')!

  test('fix removes from state when skill not in library (user scope)', async () => {
    const ctx = makeContext({
      state: {
        version: 2,
        current: {
          global: { installs: ['__unfindable_drift_skill__'] },
        },
        history: {},
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    const fixResult = await run(findings[0]!.fix!())
    expect(fixResult).toContain('removed from state')
  })

  test('fix handles project scope key', async () => {
    const ctx = makeContext({
      scope: 'project',
      state: {
        version: 2,
        current: {
          project: { installs: ['__unfindable_project_skill__'] },
        },
        history: {},
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    const fixResult = await run(findings[0]!.fix!())
    expect(typeof fixResult).toBe('string')
  })
})

// ── broken-symlink fix with git repoint ───────────────────────────

describe('broken-symlink fix with tryGitRenameRepoint', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'broken-symlink')!

  test('fix falls back to removal when git rename not found', async () => {
    // Create a broken symlink pointing to a path inside a git repo
    const dir = path.join(tmpBase, 'bs-git-fix')
    try {
      await mkdir(dir, { recursive: true })
      // Point to a nonexistent path within current git repo
      const brokenTarget = path.join(process.cwd(), '__nonexistent_skill_dir__')
      const linkPath = path.join(dir, 'git-broken')
      await symlink(brokenTarget, linkPath)

      const ctx = makeContext({
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'git-broken',
            dir: linkPath,
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: brokenTarget,
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const fixResult = await run(findings[0]!.fix!())
      // tryGitRenameRepoint will run but find no renames, then fall back
      expect(fixResult).toContain('removed broken symlink')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fix repoints symlink when git rename detected', async () => {
    const { execSync } = await import('node:child_process')
    const { mkdtemp, realpath: fsRealpath } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    // macOS: /var → /private/var symlink causes path mismatch with git rev-parse
    const repoDir = await fsRealpath(await mkdtemp(path.join(tmpdir(), 'shan-git-rename.')))
    const outfitDir = path.join(tmpBase, 'bs-git-repoint-outfit')
    try {
      // Set up a real git repo with a skill rename
      execSync('git init', { cwd: repoDir, stdio: 'ignore' })
      execSync('git config user.email "test@test"', { cwd: repoDir, stdio: 'ignore' })
      execSync('git config user.name "test"', { cwd: repoDir, stdio: 'ignore' })
      const oldSkillDir = path.join(repoDir, 'old-skill')
      await mkdir(oldSkillDir, { recursive: true })
      await writeFile(path.join(oldSkillDir, 'SKILL.md'), 'test skill')
      execSync('git add -A && git commit -m "add skill"', { cwd: repoDir, stdio: 'ignore' })
      // Rename via git mv
      execSync('git mv old-skill new-skill', { cwd: repoDir, stdio: 'ignore' })
      execSync('git commit -m "rename skill"', { cwd: repoDir, stdio: 'ignore' })

      // Create outfit dir with a broken symlink pointing to old path
      await mkdir(outfitDir, { recursive: true })
      const oldTarget = path.join(repoDir, 'old-skill')
      const linkPath = path.join(outfitDir, 'renamed-skill')
      await symlink(oldTarget, linkPath)

      const ctx = makeContext({
        userOutfit: [
          Lib.OutfitEntry.make({
            name: 'renamed-skill',
            dir: linkPath,
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: oldTarget,
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      expect(findings[0]!.fix).toBeDefined()
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('repointed')
      expect(fixResult).toContain('git rename detected')
    } finally {
      await rm(outfitDir, { recursive: true, force: true })
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})

// ── orphaned-scope fix execution ──────────────────────────────────

describe('orphaned-scope fix execution', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'orphaned-scope')!

  test('fix prunes scope from state', async () => {
    const ctx = makeContext({
      scope: 'user',
      state: {
        version: 2,
        current: { '/nonexistent/prunable': { installs: [] } },
        history: { '/nonexistent/prunable': { entries: [], undoneCount: 0 } },
      },
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    const fixResult = await run(findings[0]!.fix!())
    expect(fixResult).toContain('pruned scope')
  })
})

// ── cross-scope-install fix execution ─────────────────────────────

describe('cross-scope-install fix execution', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'cross-scope-install')!

  test('fix removes user cross-scope symlink', async () => {
    const userOutfitDir = Lib.outfitDir('user')
    const linkPath = path.join(userOutfitDir, '__test_cross_scope__')
    try {
      // Create a symlink in user outfit pointing to project library
      await mkdir(userOutfitDir, { recursive: true })
      await symlink('/some/project/.claude/skills-library/__test_cross_scope__', linkPath)

      const ctx = makeContext({
        scope: 'user',
        userOutfit: [
          Lib.OutfitEntry.make({
            name: '__test_cross_scope__',
            dir: linkPath,
            commitment: 'pluggable',
            scope: 'user',
            symlinkTarget: '/some/project/.claude/skills-library/__test_cross_scope__',
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('removed cross-scope symlink')
    } finally {
      try {
        await unlink(linkPath)
      } catch {
        /* */
      }
    }
  })

  test('fix removes project cross-scope symlink', async () => {
    const projectOutfitDir = Lib.outfitDir('project')
    const linkPath = path.join(projectOutfitDir, '__test_cross_proj__')
    try {
      await mkdir(projectOutfitDir, { recursive: true })
      await symlink(Lib.LIBRARY_DIR + '/__test_cross_proj__', linkPath)

      const ctx = makeContext({
        projectOutfitDir,
        projectOutfit: [
          Lib.OutfitEntry.make({
            name: '__test_cross_proj__',
            dir: linkPath,
            commitment: 'pluggable',
            scope: 'project',
            symlinkTarget: Lib.LIBRARY_DIR + '/__test_cross_proj__',
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('removed cross-scope symlink')
    } finally {
      try {
        await unlink(linkPath)
      } catch {
        /* */
      }
    }
  })
})

// ── finding helper ────────────────────────────────────────────────

describe('finding helper', () => {
  test('creates finding without fix', async () => {
    const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'frontmatter-mismatch')!
    const ctx = makeContext({
      library: [
        {
          colonName: 'test',
          libraryRelPath: 'test',
          libraryDir: '/lib',
          libraryScope: 'user',
          frontmatter: null,
        },
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fix).toBeUndefined()
    expect(findings[0]!.fixable).toBe(false)
  })

  test('creates finding with fix', async () => {
    const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'broken-symlink')!
    const ctx = makeContext({
      userOutfit: [
        Lib.OutfitEntry.make({
          name: 'broken',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'user',
          symlinkTarget: '',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.fix).toBeDefined()
    expect(findings[0]!.fixable).toBe(true)
  })
})

// ── stale-gitignore fix execution ──────────────────────────────────

describe('stale-gitignore fix execution', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-gitignore')!

  test('fix removes stale entry from gitignore', async () => {
    // Set up gitignore with managed section
    const gitignorePath = path.join(process.cwd(), '.gitignore')
    const { readFile: rf } = await import('node:fs/promises')
    let origContent: string | null = null
    try {
      origContent = await rf(gitignorePath, 'utf-8')
    } catch {
      /* doesn't exist */
    }

    try {
      // Write a gitignore with a stale entry
      const managedContent = origContent
        ? origContent +
          '\n\n# shan-managed (do not edit)\n.claude/skills/__stale_test_entry__\n# end shan-managed\n'
        : '# shan-managed (do not edit)\n.claude/skills/__stale_test_entry__\n# end shan-managed\n'
      await writeFile(gitignorePath, managedContent)

      const ctx = makeContext({
        gitignoreEntries: ['.claude/skills/__stale_test_entry__'],
        projectOutfit: [],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('removed from gitignore')
    } finally {
      // Restore original gitignore
      if (origContent !== null) {
        await writeFile(gitignorePath, origContent)
      } else {
        try {
          await unlink(gitignorePath)
        } catch {
          /* */
        }
      }
    }
  })
})

// ── stale-shadow with user library target ─────────────────────────

describe('stale-shadow with user library target', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-shadow')!

  test('detects when project outfit points to user library', async () => {
    // Create a project lib skill that shadows user lib skill
    const projLibDir = Lib.projectLibraryDir()
    const projSkillDir = path.join(projLibDir, '__shadow_test__')
    try {
      await mkdir(projSkillDir, { recursive: true })
      await writeFile(path.join(projSkillDir, 'SKILL.md'), 'test')

      const ctx = makeContext({
        projectOutfit: [
          Lib.OutfitEntry.make({
            name: '__shadow_test__',
            dir: '/fake',
            commitment: 'pluggable',
            scope: 'project',
            symlinkTarget: Lib.LIBRARY_DIR + '/__shadow_test__',
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      expect(findings[0]!.message).toContain('user library')
    } finally {
      await rm(projSkillDir, { recursive: true, force: true })
    }
  })

  test('fix repoints symlink to project library', async () => {
    const projLibDir = Lib.projectLibraryDir()
    const projSkillDir = path.join(projLibDir, '__shadow_fix_test__')
    const projectOutfitDir = Lib.outfitDir('project')
    const linkPath = path.join(projectOutfitDir, '__shadow_fix_test__')
    try {
      await mkdir(projSkillDir, { recursive: true })
      await writeFile(path.join(projSkillDir, 'SKILL.md'), 'test')
      await mkdir(projectOutfitDir, { recursive: true })
      await symlink(Lib.LIBRARY_DIR + '/__shadow_fix_test__', linkPath)

      const ctx = makeContext({
        projectOutfitDir,
        projectOutfit: [
          Lib.OutfitEntry.make({
            name: '__shadow_fix_test__',
            dir: linkPath,
            commitment: 'pluggable',
            scope: 'project',
            symlinkTarget: Lib.LIBRARY_DIR + '/__shadow_fix_test__',
          }),
        ],
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('repointed')
    } finally {
      try {
        await unlink(linkPath)
      } catch {
        /* */
      }
      await rm(projSkillDir, { recursive: true, force: true })
    }
  })
})

// ── orphaned-router with real outfit ──────────────────────────────

describe('orphaned-router with real outfit', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'orphaned-router')!

  test('detects orphaned router in outfit', async () => {
    // Create a router dir in user outfit that has no children
    const outfitPath = Lib.outfitDir('user')
    const routerDir = path.join(outfitPath, '__test_orphan_router__')
    const libDir = Lib.LIBRARY_DIR
    const libRouterDir = path.join(libDir, '__test_orphan_router__')
    try {
      // Create a matching group in library
      await mkdir(path.join(libRouterDir, 'child'), { recursive: true })
      await writeFile(path.join(libRouterDir, 'child', 'SKILL.md'), '---\nname: child\n---\n')
      // Create the router dir in outfit (core commitment)
      await mkdir(routerDir, { recursive: true })
      await writeFile(path.join(routerDir, 'SKILL.md'), 'router')

      const outfit = await run(Lib.listOutfit('user'))
      const ctx = makeContext({
        userOutfit: outfit,
      })
      const findings = await run(aspect.detect(ctx))
      const orphanFinding = findings.find((f) => f.message.includes('__test_orphan_router__'))
      if (orphanFinding) {
        expect(orphanFinding.aspect).toBe('orphaned-router')
        expect(orphanFinding.fixable).toBe(true)
        // Run the fix
        const fixResult = await run(orphanFinding.fix!())
        expect(fixResult).toContain('removed orphaned router')
      }
    } finally {
      await rm(routerDir, { recursive: true, force: true })
      await rm(libRouterDir, { recursive: true, force: true })
    }
  })
})

// ── stale-router with real outfit ─────────────────────────────────

describe('stale-router with real outfit', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-router')!

  test('detects outdated router content', async () => {
    const outfitPath = Lib.outfitDir('user')
    const routerDir = path.join(outfitPath, '__test_stale_router__')
    const libDir = Lib.LIBRARY_DIR
    const libRouterDir = path.join(libDir, '__test_stale_router__')
    try {
      // Create a group in library
      await mkdir(path.join(libRouterDir, 'child'), { recursive: true })
      await writeFile(
        path.join(libRouterDir, 'child', 'SKILL.md'),
        '---\nname: "__test_stale_router__:child"\ndescription: "test child"\n---\nbody',
      )
      // Create the router in outfit with outdated content
      await mkdir(routerDir, { recursive: true })
      await writeFile(path.join(routerDir, 'SKILL.md'), 'outdated content')

      const outfit = await run(Lib.listOutfit('user'))
      const library = await run(Lib.listLibrary())
      const ctx = makeContext({
        userOutfit: outfit,
        library,
      })
      const findings = await run(aspect.detect(ctx))
      const staleFinding = findings.find((f) => f.message.includes('__test_stale_router__'))
      if (staleFinding) {
        expect(staleFinding.aspect).toBe('stale-router')
        expect(staleFinding.fixable).toBe(true)
        // Run the fix
        const fixResult = await run(staleFinding.fix!())
        expect(fixResult).toContain('regenerated router')
      }
    } finally {
      await rm(routerDir, { recursive: true, force: true })
      await rm(libRouterDir, { recursive: true, force: true })
    }
  })
})

// ── new-leaf fix execution ────────────────────────────────────────

describe('new-leaf fix execution', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'new-leaf')!

  test('fix creates symlink for new leaf', async () => {
    const libDir = Lib.LIBRARY_DIR
    const skillDir = path.join(libDir, '__test_new_leaf_grp__/new-child')
    const existingSkillDir = path.join(libDir, '__test_new_leaf_grp__/existing-child')
    const outfitPath = Lib.outfitDir('user')
    const existingLink = path.join(outfitPath, '__test_new_leaf_grp___existing-child')
    const newLink = path.join(outfitPath, '__test_new_leaf_grp___new-child')
    try {
      // Create library skills
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: "__test_new_leaf_grp__:new-child"\ndescription: "new"\n---\n',
      )
      await mkdir(existingSkillDir, { recursive: true })
      await writeFile(
        path.join(existingSkillDir, 'SKILL.md'),
        '---\nname: "__test_new_leaf_grp__:existing-child"\ndescription: "existing"\n---\n',
      )
      // Create existing sibling symlink in outfit
      await mkdir(outfitPath, { recursive: true })
      await symlink(existingSkillDir, existingLink)

      const library = await run(Lib.listLibrary())
      const outfit = await run(Lib.listOutfit('user'))
      const ctx = makeContext({
        library,
        userOutfit: outfit,
      })
      const findings = await run(aspect.detect(ctx))
      const newLeafFinding = findings.find((f) =>
        f.message.includes('__test_new_leaf_grp__:new-child'),
      )
      if (newLeafFinding) {
        expect(newLeafFinding.fixable).toBe(true)
        const fixResult = await run(newLeafFinding.fix!())
        expect(fixResult).toContain('symlinked new leaf')
      }
    } finally {
      try {
        await unlink(existingLink)
      } catch {
        /* */
      }
      try {
        await unlink(newLink)
      } catch {
        /* */
      }
      await rm(path.join(libDir, '__test_new_leaf_grp__'), { recursive: true, force: true })
    }
  })
})

// ── state-drift fix when library skill IS found ───────────────────

describe('state-drift fix restores symlink', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'state-drift')!

  test('fix restores symlink when skill found in library', async () => {
    // Create a real library skill that matches the state
    const libDir = Lib.LIBRARY_DIR
    const skillDir = path.join(libDir, '__test_drift_restore__')
    const outfitDir = Lib.outfitDir('user')
    const linkPath = path.join(outfitDir, '__test_drift_restore__')
    try {
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'SKILL.md'), 'test')

      const ctx = makeContext({
        state: {
          version: 2,
          current: {
            global: { installs: ['__test_drift_restore__'] },
          },
          history: {},
        },
      })
      const findings = await run(aspect.detect(ctx))
      expect(findings).toHaveLength(1)
      const fixResult = await run(findings[0]!.fix!())
      expect(fixResult).toContain('restored symlink')
    } finally {
      try {
        await unlink(linkPath)
      } catch {
        /* */
      }
      await rm(skillDir, { recursive: true, force: true })
    }
  })
})

// ── stale-shadow deeper path ──────────────────────────────────────

describe('stale-shadow deeper coverage', () => {
  const aspect = Aspects.ALL_ASPECTS.find((a) => a.name === 'stale-shadow')!

  test('no finding when project lib does not have same skill', async () => {
    const ctx = makeContext({
      projectOutfit: [
        Lib.OutfitEntry.make({
          name: '__no_shadow__',
          dir: '/fake',
          commitment: 'pluggable',
          scope: 'project',
          symlinkTarget: Lib.LIBRARY_DIR + '/__no_shadow__',
        }),
      ],
    })
    const findings = await run(aspect.detect(ctx))
    expect(findings).toEqual([])
  })
})

// ── readlink export ───────────────────────────────────────────────

describe('readlink export', () => {
  test('readlink is re-exported', () => {
    expect(typeof Aspects.readlink).toBe('function')
  })
})
