/**
 * Doctor aspect registry — each aspect has detect, optional fix, severity level.
 *
 * Aspects are pure detection + remediation functions operating on DoctorContext.
 */

import { Effect } from 'effect'
import {
  lstat,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  mkdir,
  writeFile,
} from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from './skill-library.js'
import * as SkillName from './skill-name.js'

// ── Types ────────────────────────────────────────────────────────────

export type Level = 'error' | 'warning' | 'info'

export interface DoctorFinding {
  readonly aspect: string
  readonly level: Level
  readonly message: string
  readonly fixable: boolean
  readonly fix?: () => Effect.Effect<string, unknown> // returns fix description
}

export interface DoctorContext {
  readonly scope: Lib.Scope
  readonly state: Lib.ShanState
  readonly library: Lib.SkillInfo[]
  readonly userLibraryDir: string
  readonly projectLibraryDir: string
  readonly userOutfit: Lib.OutfitEntry[]
  readonly userOutfitDir: string
  readonly projectOutfit: Lib.OutfitEntry[]
  readonly projectOutfitDir: string
  readonly gitignoreEntries: string[]
  readonly config: Lib.ShanConfig
  readonly configuredAgents: readonly Lib.Agent[]
}

export interface DoctorAspect {
  readonly name: string
  readonly description: string
  readonly level: Level
  readonly detect: (ctx: DoctorContext) => Effect.Effect<DoctorFinding[]>
}

// ── Helpers ──────────────────────────────────────────────────────────

const finding = (
  aspect: string,
  level: Level,
  message: string,
  fixable: boolean,
  fix?: () => Effect.Effect<string, unknown>,
): DoctorFinding => {
  const base = { aspect, level, message, fixable }
  return fix ? { ...base, fix } : base
}

const yamlQuote = (value: string): string =>
  /[:#{}&*!|>'"%@`,?]|\[|\]/.test(value)
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value

const checkSymlinkTarget = (target: string) =>
  Effect.tryPromise(async () => {
    const stat = await lstat(target)
    return stat.isDirectory()
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))

const checkDirectory = (target: string) =>
  Effect.tryPromise(async () => {
    const targetLstat = await lstat(target)
    if (targetLstat.isDirectory()) return true
    if (!targetLstat.isSymbolicLink()) return false

    const resolvedTarget = await realpath(target)
    const resolvedLstat = await lstat(resolvedTarget)
    return resolvedLstat.isDirectory()
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))

const getResolvedDirectory = (target: string) =>
  Effect.tryPromise(async () => {
    const resolvedTarget = await realpath(target)
    const resolvedLstat = await lstat(resolvedTarget)
    return resolvedLstat.isDirectory() ? resolvedTarget : null
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))

const directoriesShareBackingStore = (left: string, right: string) =>
  Effect.gen(function* () {
    const leftResolved = yield* getResolvedDirectory(left)
    if (!leftResolved) return false

    const rightResolved = yield* getResolvedDirectory(right)
    if (!rightResolved) return false

    return leftResolved === rightResolved
  })

const scopeTargets = <T>(ctx: DoctorContext, userTarget: T, projectTarget: T): T[] =>
  ctx.scope === 'user' ? [userTarget] : [projectTarget]

const agentMirror: DoctorAspect = {
  name: 'agent-mirror',
  description: 'Configured mirror agent outfit diverges from canonical outfit',
  level: 'warning',
  detect: (ctx) =>
    Effect.gen(function* () {
      const findings: DoctorFinding[] = []
      const mirrorAgents = Lib.getMirrorAgents(ctx.configuredAgents)
      if (mirrorAgents.length === 0) return findings

      for (const scope of scopeTargets(ctx, 'user' as const, 'project' as const)) {
        const canonicalDir = Lib.outfitDir(scope)
        const canonicalExists = yield* checkDirectory(canonicalDir)
        const canonicalResolved = canonicalExists ? yield* getResolvedDirectory(canonicalDir) : null

        for (const mirrorAgent of mirrorAgents) {
          const mirrorDir = Lib.agentOutfitDir(scope, mirrorAgent)
          const mirrorExists = yield* checkDirectory(mirrorDir)
          const mirrorStat = yield* Effect.tryPromise(() => lstat(mirrorDir)).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )

          if (!canonicalExists && !mirrorExists && !mirrorStat) continue

          if (canonicalResolved && mirrorExists) {
            const mirrorResolved = yield* getResolvedDirectory(mirrorDir)
            if (mirrorResolved === canonicalResolved) continue
          }

          const problem = !mirrorStat
            ? 'missing'
            : mirrorStat.isSymbolicLink()
              ? 'points elsewhere'
              : 'is not a symlink'

          findings.push(
            finding(
              'agent-mirror',
              'warning',
              `[${scope}] ${mirrorAgent} skills ${problem} (expected ${mirrorDir} → ${canonicalDir})`,
              true,
              () =>
                Lib.syncAgentMirrors(scope, ctx.config).pipe(
                  Effect.as(`reconciled ${mirrorAgent} skills mirror (${scope})`),
                ),
            ),
          )
        }
      }

      return findings
    }),
}

// ── Aspects ──────────────────────────────────────────────────────────

const brokenSymlink: DoctorAspect = {
  name: 'broken-symlink',
  description: "Outfit symlink target doesn't exist",
  level: 'error',
  detect: (ctx) =>
    Effect.gen(function* () {
      const findings: DoctorFinding[] = []
      for (const outfit of scopeTargets(
        ctx,
        { entries: ctx.userOutfit, label: 'user', scope: 'user' as Lib.Scope },
        { entries: ctx.projectOutfit, label: 'project', scope: 'project' as Lib.Scope },
      )) {
        for (const entry of outfit.entries) {
          if (entry.commitment !== 'pluggable') continue
          const target = entry.symlinkTarget ?? ''
          if (!target) {
            findings.push(
              finding(
                'broken-symlink',
                'error',
                `[${outfit.label}] ${entry.name} — no symlink target`,
                true,
                () =>
                  Effect.gen(function* () {
                    const linkPath = path.join(Lib.outfitDir(outfit.scope), entry.name)
                    yield* Effect.tryPromise(() => unlink(linkPath)).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                    return `removed broken symlink: ${entry.name}`
                  }),
              ),
            )
            continue
          }
          const exists = yield* checkSymlinkTarget(target)
          if (!exists) {
            findings.push(
              finding(
                'broken-symlink',
                'error',
                `[${outfit.label}] ${entry.name} → ${target}`,
                true,
                () =>
                  Effect.gen(function* () {
                    // Try git rename detection
                    const repointed = yield* tryGitRenameRepoint(entry.name, target, outfit.scope)
                    if (repointed) return repointed
                    // Fallback: remove the broken symlink
                    const linkPath = path.join(Lib.outfitDir(outfit.scope), entry.name)
                    yield* Effect.tryPromise(() => unlink(linkPath)).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                    return `removed broken symlink: ${entry.name}`
                  }),
              ),
            )
          }
        }
      }
      return findings
    }),
}

/** Try to detect a git rename and repoint the symlink. */
const tryGitRenameRepoint = (name: string, oldTarget: string, scope: Lib.Scope) =>
  Effect.gen(function* () {
    // Determine the git repo root for the old target
    const { execSync } = yield* Effect.tryPromise(() => import('node:child_process'))
    const repoRoot = yield* Effect.try(() =>
      execSync('git rev-parse --show-toplevel', {
        cwd: path.dirname(oldTarget),
        encoding: 'utf-8',
      }).trim(),
    ).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (!repoRoot) return null
    // Check committed renames
    const relOld = path.relative(repoRoot, oldTarget)
    const renameOutput = yield* Effect.try(() =>
      execSync('git log -1 --diff-filter=R -M --format="" --name-status', {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
    ).pipe(Effect.catchAll(() => Effect.succeed('')))
    // Find the line that renames the old path
    const renameLine = renameOutput.split('\n').find((l) => l.includes(`${relOld}/SKILL.md`))
    if (renameLine) {
      // Parse: R100\told/path\tnew/path
      const parts = renameLine.split('\t')
      if (parts.length >= 3) {
        const newRelPath = (parts[2] ?? '').replace(/\/SKILL\.md$/, '')
        const newAbsPath = path.join(repoRoot, newRelPath)
        const newExists = yield* checkSymlinkTarget(newAbsPath)
        if (newExists) {
          const linkPath = path.join(Lib.outfitDir(scope), name)
          yield* Effect.tryPromise(() => unlink(linkPath)).pipe(Effect.catchAll(() => Effect.void))
          yield* Effect.tryPromise(() => symlink(newAbsPath, linkPath))
          return `repointed ${name} → ${newAbsPath} (git rename detected)`
        }
      }
    }
    return null
  })

const stateDrift: DoctorAspect = {
  name: 'state-drift',
  description: "current state doesn't match filesystem",
  level: 'warning',
  detect: (ctx) =>
    Effect.gen(function* () {
      const findings: DoctorFinding[] = []
      for (const [scopeKey, scopeState] of Object.entries(ctx.state.current)) {
        if (ctx.scope === 'user' && scopeKey !== 'global') continue
        if (ctx.scope === 'project' && scopeKey !== process.cwd() && scopeKey !== 'project') {
          continue
        }
        const resolvedScope: Lib.Scope = scopeKey === 'global' ? 'user' : 'project'
        const outfitDir =
          scopeKey === 'global'
            ? Lib.outfitDir('user')
            : scopeKey === 'project'
              ? Lib.outfitDir('project')
              : path.join(scopeKey, '.claude/skills')
        for (const flatName of scopeState.installs) {
          const linkPath = path.join(outfitDir, flatName)
          const exists = yield* Effect.tryPromise(() => lstat(linkPath)).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (!exists) {
            findings.push(
              finding(
                'state-drift',
                'warning',
                `${flatName} in state[${scopeKey}] but no symlink`,
                true,
                () =>
                  Effect.gen(function* () {
                    // Try to recreate from the scope-appropriate library only.
                    // Never fall through to another scope's library — that would
                    // create a cross-scope install.
                    const libDir = Lib.scopeLibraryDir(resolvedScope)
                    const resolved = yield* findLibraryByFlatName(flatName, libDir)
                    if (resolved) {
                      yield* Effect.tryPromise(() =>
                        mkdir(path.dirname(linkPath), { recursive: true }),
                      )
                      yield* Effect.tryPromise(() => symlink(resolved, linkPath))
                      return `restored symlink: ${flatName} (${scopeKey})`
                    }
                    // Can't recreate in same scope — actually remove from state
                    const currentState = yield* Lib.loadState()
                    const updatedState = Lib.removeCurrentInstall(
                      currentState,
                      resolvedScope,
                      flatName,
                    )
                    yield* Lib.saveState(updatedState)
                    return `removed from state: ${flatName} (${scopeKey})`
                  }),
              ),
            )
          }
        }
      }
      return findings
    }),
}

/** Find a library entry by its flattened name. */
const findLibraryByFlatName = (flatName: string, libDir: string) =>
  Effect.gen(function* () {
    const parsed = SkillName.parseFlatName(flatName)
    if (parsed) {
      const candidate = path.join(libDir, SkillName.toLibraryRelPath(parsed))
      const exists = yield* checkSymlinkTarget(candidate)
      if (exists) return candidate
    }
    // Also try the flat name directly as a directory
    const direct = path.join(libDir, flatName)
    const directExists = yield* checkSymlinkTarget(direct)
    if (directExists) return direct
    return null
  })

const orphanedRouter: DoctorAspect = {
  name: 'orphaned-router',
  description: 'Generated router with no child skills equipped',
  level: 'warning',
  detect: (ctx) =>
    Effect.gen(function* () {
      const findings: DoctorFinding[] = []
      for (const outfit of scopeTargets(
        ctx,
        { entries: ctx.userOutfit, scope: 'user' as Lib.Scope, label: 'user' },
        { entries: ctx.projectOutfit, scope: 'project' as Lib.Scope, label: 'project' },
      )) {
        const routers = yield* Lib.detectGeneratedRouters(outfit.scope)
        for (const router of routers) {
          const hasChildren = outfit.entries.some(
            (entry) =>
              entry.commitment === 'pluggable' && SkillName.isFlatNameInGroup(entry.name, router),
          )
          if (!hasChildren) {
            const routerPath = path.join(Lib.outfitDir(outfit.scope), router)
            findings.push(
              finding(
                'orphaned-router',
                'warning',
                `[${outfit.label}] ${router}/ — no child skills equipped`,
                true,
                () =>
                  Effect.gen(function* () {
                    yield* Effect.tryPromise(() => rm(routerPath, { recursive: true, force: true }))
                    return `removed orphaned router: ${router} (${outfit.label})`
                  }),
              ),
            )
          }
        }
      }
      return findings
    }),
}

const staleGitignore: DoctorAspect = {
  name: 'stale-gitignore',
  description: 'Gitignore entries for unequipped skills',
  level: 'info',
  detect: (ctx) =>
    Effect.gen(function* () {
      if (ctx.scope !== 'project') return []
      const findings: DoctorFinding[] = []
      const projectPluggableNames = new Set(
        ctx.projectOutfit.filter((e) => e.commitment === 'pluggable').map((e) => e.name),
      )
      const projectRouters = yield* Lib.detectGeneratedRouters('project')
      const projectRouterNames = new Set(projectRouters)
      const mirrorEntries = new Set(
        Lib.getMirrorAgents(ctx.configuredAgents).map((agent) =>
          path
            .relative(process.cwd(), Lib.agentOutfitDir('project', agent))
            .split(path.sep)
            .join('/'),
        ),
      )

      for (const entry of ctx.gitignoreEntries) {
        if (mirrorEntries.has(entry)) continue
        const name = entry.replace('.claude/skills/', '')
        if (!projectPluggableNames.has(name) && !projectRouterNames.has(name)) {
          findings.push(
            finding(
              'stale-gitignore',
              'info',
              `${entry} — skill not equipped at project level`,
              true,
              () =>
                Effect.gen(function* () {
                  yield* Lib.manageGitignoreRemove(process.cwd(), [entry])
                  return `removed from gitignore: ${entry}`
                }),
            ),
          )
        }
      }
      return findings
    }),
}

// ── Mismatch classification helpers ──────────────────────────────

const stripSeparators = (value: string): string => {
  const parsed = SkillName.parseFrontmatterName(value)
  return parsed ? SkillName.stripSeparators(parsed) : value.replaceAll(/[:_-]/g, '')
}

export type MismatchClassification = 'separator_only' | 'namespace_relocation' | 'complete_rename'

export const classifyMismatch = (
  dirColonName: string,
  fmName: string,
  namespaceCensus: Map<string, number>,
): MismatchClassification => {
  const frontmatterName = SkillName.parseFrontmatterName(fmName)

  // SEPARATOR_ONLY: same string after stripping all separators, AND both names
  // already use colons (i.e. the author is just restructuring nesting within the
  // same namespace, not introducing a new colon-delimited level from scratch).
  if (
    stripSeparators(dirColonName) === stripSeparators(fmName) &&
    dirColonName.includes(':') &&
    fmName.includes(':')
  ) {
    return 'separator_only'
  }

  // NAMESPACE_RELOCATION: FM name uses a colon-prefix with an established namespace
  if (frontmatterName && SkillName.isNamespaced(frontmatterName)) {
    const fmPrefix = SkillName.topLevelName(frontmatterName)
    const count = namespaceCensus.get(fmPrefix) ?? 0
    if (count >= 2) {
      return 'namespace_relocation'
    }
  }

  return 'complete_rename'
}

export const buildNamespaceCensus = (library: Lib.SkillInfo[]): Map<string, number> => {
  const census = new Map<string, number>()
  for (const skill of library) {
    const name = SkillName.parseFrontmatterName(skill.colonName)
    if (!name) continue
    for (const prefix of SkillName.prefixes(name)) {
      census.set(prefix, (census.get(prefix) ?? 0) + 1)
    }
  }
  return census
}

const frontmatterMismatch: DoctorAspect = {
  name: 'frontmatter-mismatch',
  description: "Skill frontmatter name doesn't match directory",
  level: 'error',
  detect: (ctx) =>
    Effect.sync(() => {
      const findings: DoctorFinding[] = []
      const census = buildNamespaceCensus(ctx.library)

      for (const skill of ctx.library.filter((candidate) => candidate.libraryScope === ctx.scope)) {
        if (!skill.frontmatter) {
          findings.push(
            finding(
              'frontmatter-mismatch',
              'error',
              `${skill.colonName} — missing frontmatter`,
              false,
            ),
          )
          continue
        }
        const canonicalFmName = Lib.canonicalFrontmatterName(skill.frontmatter)
        if (!canonicalFmName) continue
        if (canonicalFmName === skill.colonName) continue
        const parsedFmName = SkillName.fromFrontmatterName(canonicalFmName)

        const classification = classifyMismatch(skill.colonName, canonicalFmName, census)

        if (classification === 'separator_only') {
          findings.push(
            finding(
              'frontmatter-mismatch',
              'error',
              `${skill.colonName} — name="${canonicalFmName}" (separator-only mismatch, will rename dir)`,
              true,
              () => fixMismatch(skill, parsedFmName, ctx),
            ),
          )
        } else if (classification === 'namespace_relocation') {
          const fmPrefix = SkillName.topLevelName(parsedFmName)
          const peerCount = census.get(fmPrefix) ?? 0
          findings.push(
            finding(
              'frontmatter-mismatch',
              'error',
              `${skill.colonName} — name="${canonicalFmName}" (${fmPrefix}: namespace has ${peerCount} peers, will rename dir)`,
              true,
              () => fixMismatch(skill, parsedFmName, ctx),
            ),
          )
        } else {
          // COMPLETE_RENAME or NAMESPACE_RELOCATION with insufficient peers
          if (SkillName.isNamespaced(parsedFmName)) {
            const fmPrefix = SkillName.topLevelName(parsedFmName)
            const peerCount = census.get(fmPrefix) ?? 0
            findings.push(
              finding(
                'frontmatter-mismatch',
                'error',
                `${skill.colonName} — name="${canonicalFmName}" (${fmPrefix}: namespace has ${peerCount} peers, needs >=2)`,
                false,
              ),
            )
          } else {
            findings.push(
              finding(
                'frontmatter-mismatch',
                'error',
                `${skill.colonName} — name="${canonicalFmName}" (complete rename, manual review needed)`,
                false,
              ),
            )
          }
        }
      }
      return findings
    }),
}

const corruptLibraryEntry: DoctorAspect = {
  name: 'corrupt-library-entry',
  description: 'Skill entry has invalid canonical frontmatter metadata',
  level: 'error',
  detect: (ctx) =>
    Effect.sync(() => {
      const findings: DoctorFinding[] = []

      for (const skill of ctx.library.filter((candidate) => candidate.libraryScope === ctx.scope)) {
        if (!skill.frontmatter) continue
        if (Lib.canonicalFrontmatterName(skill.frontmatter)) continue
        const repairedName = SkillName.parseObservedFrontmatterName(skill.frontmatter.name)

        if (repairedName) {
          const canonicalName = SkillName.toFrontmatterName(repairedName)
          findings.push(
            finding(
              'corrupt-library-entry',
              'error',
              `${skill.colonName} — name="${skill.frontmatter.name}" (invalid canonical skill name on disk, will rewrite frontmatter name to "${canonicalName}")`,
              true,
              () => fixCorruptLibraryEntry(skill, canonicalName),
            ),
          )
        } else {
          findings.push(
            finding(
              'corrupt-library-entry',
              'error',
              `${skill.colonName} — name="${skill.frontmatter.name}" (invalid canonical skill name on disk)`,
              false,
            ),
          )
        }
      }

      return findings
    }),
}

const fixCorruptLibraryEntry = (
  skill: Lib.SkillInfo,
  canonicalName: string,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    if (!skill.frontmatter) {
      return yield* Effect.fail(new Error(`missing frontmatter for ${skill.libraryRelPath}`))
    }

    const skillMdPath = path.join(skill.libraryDir, skill.libraryRelPath, 'SKILL.md')
    const content = yield* Effect.tryPromise(() => readFile(skillMdPath, 'utf-8'))
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match?.[1]) {
      return yield* Effect.fail(new Error(`missing frontmatter block in ${skillMdPath}`))
    }

    const lines = match[1].split('\n')
    const nameLineIndex = lines.findIndex((line) => line.trimStart().startsWith('name:'))
    if (nameLineIndex === -1) {
      return yield* Effect.fail(new Error(`missing frontmatter name field in ${skillMdPath}`))
    }

    const previousName = skill.frontmatter.name
    lines[nameLineIndex] = `name: ${yamlQuote(canonicalName)}`
    const nextContent = `---\n${lines.join('\n')}\n---${content.slice(match[0].length)}`

    yield* Effect.tryPromise(() => writeFile(skillMdPath, nextContent))

    return `rewrote frontmatter name: ${previousName} → ${canonicalName} (${skill.libraryRelPath})`
  })

const fixMismatch = (
  skill: Lib.SkillInfo,
  fmName: SkillName.SkillName,
  ctx: DoctorContext,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const newRelPath = SkillName.toLibraryRelPath(fmName)
    const newDir = path.join(skill.libraryDir, newRelPath)
    const oldDir = path.join(skill.libraryDir, skill.libraryRelPath)

    // Fail if target already exists
    const targetExists = yield* Effect.tryPromise(async () => {
      const stat = await lstat(newDir)
      return stat.isDirectory()
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (targetExists) {
      return yield* Effect.fail(new Error(`target directory already exists: ${newDir}`))
    }

    // Create parent directories if needed
    yield* Effect.tryPromise(() => mkdir(path.dirname(newDir), { recursive: true }))

    // Atomic rename
    yield* Effect.tryPromise(() => rename(oldDir, newDir))

    // Repoint outfit symlinks that target the old dir
    const allOutfitEntries = [
      ...ctx.userOutfit.map((e) => ({ entry: e })),
      ...ctx.projectOutfit.map((e) => ({ entry: e })),
    ]
    for (const { entry } of allOutfitEntries) {
      if (entry.commitment !== 'pluggable' || !entry.symlinkTarget) continue
      if (entry.symlinkTarget === oldDir || entry.symlinkTarget.startsWith(oldDir + '/')) {
        const newTarget = newDir + entry.symlinkTarget.slice(oldDir.length)
        // entry.dir is the full path to the symlink itself
        const linkPath = entry.dir
        yield* Effect.tryPromise(() => unlink(linkPath)).pipe(Effect.catchAll(() => Effect.void))
        yield* Effect.tryPromise(() => symlink(newTarget, linkPath))
      }
    }

    // Update state if the flattened name changed
    const parsedOldRelPath = SkillName.parseLibraryRelPath(skill.libraryRelPath)
    const oldFlat = parsedOldRelPath
      ? SkillName.toFlatName(parsedOldRelPath)
      : skill.libraryRelPath.split(path.sep).join('_')
    const newFlat = Lib.flattenName(newRelPath)
    if (oldFlat !== newFlat) {
      const currentState = yield* Lib.loadState()
      let updated = Lib.removeCurrentInstall(currentState, skill.libraryScope, oldFlat)
      updated = Lib.addCurrentInstall(updated, skill.libraryScope, newFlat)
      yield* Lib.saveState(updated)
    }

    return `renamed ${skill.colonName} → ${SkillName.toFrontmatterName(fmName)} (dir: ${skill.libraryRelPath} → ${newRelPath})`
  })

const nameConflict: DoctorAspect = {
  name: 'name-conflict',
  description: 'Library skill collides with core skill in outfit',
  level: 'error',
  detect: (ctx) =>
    Effect.sync(() => {
      const findings: DoctorFinding[] = []
      const userCoreNames = new Set(
        ctx.userOutfit.filter((e) => e.commitment === 'core').map((e) => e.name),
      )
      const projectCoreNames = new Set(
        ctx.projectOutfit.filter((e) => e.commitment === 'core').map((e) => e.name),
      )

      for (const skill of ctx.library.filter((candidate) => candidate.libraryScope === ctx.scope)) {
        const flat = Lib.observedFlatNameFromLibraryRelPath(skill.libraryRelPath)
        if (userCoreNames.has(flat)) {
          findings.push(
            finding(
              'name-conflict',
              'error',
              `"${skill.colonName}" (→ ${flat}) collides with user core skill`,
              false,
            ),
          )
        }
        if (projectCoreNames.has(flat)) {
          findings.push(
            finding(
              'name-conflict',
              'error',
              `"${skill.colonName}" (→ ${flat}) collides with project core skill`,
              false,
            ),
          )
        }
      }
      return findings
    }),
}

const duplicateName: DoctorAspect = {
  name: 'duplicate-name',
  description: 'Multiple library paths produce same flattened name',
  level: 'error',
  detect: (ctx) =>
    Effect.sync(() => {
      const findings: DoctorFinding[] = []
      const flatNames = new Map<string, string[]>()
      for (const skill of ctx.library.filter((candidate) => candidate.libraryScope === ctx.scope)) {
        const flat = Lib.observedFlatNameFromLibraryRelPath(skill.libraryRelPath)
        const existing = flatNames.get(flat) ?? []
        existing.push(skill.colonName)
        flatNames.set(flat, existing)
      }
      for (const [flat, names] of flatNames) {
        if (names.length > 1) {
          findings.push(
            finding('duplicate-name', 'error', `"${flat}" produced by: ${names.join(', ')}`, false),
          )
        }
      }
      return findings
    }),
}

const orphanedScope: DoctorAspect = {
  name: 'orphaned-scope',
  description: "Project path in state doesn't exist on disk",
  level: 'info',
  detect: (ctx) =>
    Effect.gen(function* () {
      if (ctx.scope !== 'user') return []
      const findings: DoctorFinding[] = []
      for (const key of Object.keys(ctx.state.history)) {
        if (key === 'global') continue
        const pathExists = yield* Effect.tryPromise(async () => {
          const stat = await lstat(key)
          return stat.isDirectory()
        }).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!pathExists) {
          findings.push(
            finding('orphaned-scope', 'info', `state references: ${key}`, true, () =>
              Effect.gen(function* () {
                const state = yield* Lib.loadState()
                delete state.history[key]
                if (state.current[key]) delete state.current[key]
                yield* Lib.saveState(state)
                return `pruned scope: ${key}`
              }),
            ),
          )
        }
      }
      return findings
    }),
}

const shadow: DoctorAspect = {
  name: 'shadow',
  description: 'Project library skill shadows user library skill',
  level: 'info',
  detect: (ctx) =>
    Effect.gen(function* () {
      if (ctx.scope !== 'project') return []
      const findings: DoctorFinding[] = []
      const projLibDir = ctx.projectLibraryDir
      const sharedLibrary = yield* directoriesShareBackingStore(ctx.userLibraryDir, projLibDir)
      if (sharedLibrary) return findings

      const projLibExists = yield* checkDirectory(projLibDir)
      if (!projLibExists) return findings

      for (const skill of ctx.library) {
        if (skill.libraryScope !== 'user') continue
        // Check if project library has same relative path
        const projPath = path.join(projLibDir, skill.libraryRelPath)
        const projExists = yield* checkSymlinkTarget(projPath)
        if (projExists) {
          findings.push(
            finding(
              'shadow',
              'info',
              `${skill.colonName} — project library shadows user library`,
              false,
            ),
          )
        }
      }
      return findings
    }),
}

const staleShadow: DoctorAspect = {
  name: 'stale-shadow',
  description: 'Symlink points to user library when project library has same name',
  level: 'warning',
  detect: (ctx) =>
    Effect.gen(function* () {
      if (ctx.scope !== 'project') return []
      const findings: DoctorFinding[] = []
      const projLibDir = ctx.projectLibraryDir
      const sharedLibrary = yield* directoriesShareBackingStore(ctx.userLibraryDir, projLibDir)
      if (sharedLibrary) return findings

      for (const entry of ctx.projectOutfit) {
        if (entry.commitment !== 'pluggable' || !entry.symlinkTarget) continue
        // If this symlink points to user library, check if project library has it
        if (!entry.symlinkTarget.startsWith(ctx.userLibraryDir)) continue
        const relPath = entry.symlinkTarget.slice(ctx.userLibraryDir.length + 1)
        const projPath = path.join(projLibDir, relPath)
        const projExists = yield* checkSymlinkTarget(projPath)
        if (projExists) {
          const linkPath = path.join(ctx.projectOutfitDir, entry.name)
          findings.push(
            finding(
              'stale-shadow',
              'warning',
              `[project] ${entry.name} → user library (project library has same skill)`,
              true,
              () =>
                Effect.gen(function* () {
                  yield* Effect.tryPromise(() => unlink(linkPath)).pipe(
                    Effect.catchAll(() => Effect.void),
                  )
                  yield* Effect.tryPromise(() => symlink(projPath, linkPath))
                  return `repointed: ${entry.name} → project library`
                }),
            ),
          )
        }
      }
      return findings
    }),
}

const crossScopeInstall: DoctorAspect = {
  name: 'cross-scope-install',
  description: 'Outfit symlink crosses scope boundary',
  level: 'error',
  detect: (ctx) =>
    Effect.gen(function* () {
      const findings: DoctorFinding[] = []
      const sharedLibrary =
        ctx.scope === 'project'
          ? yield* directoriesShareBackingStore(ctx.userLibraryDir, ctx.projectLibraryDir)
          : false

      // Check user outfit → should only point into user library
      if (ctx.scope === 'user') {
        for (const entry of ctx.userOutfit) {
          if (entry.commitment !== 'pluggable' || !entry.symlinkTarget) continue
          if (entry.symlinkTarget.startsWith(ctx.userLibraryDir)) continue // correct: user → user library
          if (entry.symlinkTarget.includes('.claude/skills-library/')) {
            const linkPath = path.join(ctx.userOutfitDir, entry.name)
            findings.push(
              finding(
                'cross-scope-install',
                'error',
                `[user] ${entry.name} → ${entry.symlinkTarget}`,
                true,
                () =>
                  Effect.gen(function* () {
                    yield* Effect.tryPromise(() => unlink(linkPath)).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                    return `removed cross-scope symlink: ${entry.name}`
                  }),
              ),
            )
          }
        }
      }

      // Check project outfit → should only point into project library
      if (ctx.scope === 'project') {
        for (const entry of ctx.projectOutfit) {
          if (entry.commitment !== 'pluggable' || !entry.symlinkTarget) continue
          // If symlink points into user library, it's a cross-scope install
          if (entry.symlinkTarget.startsWith(ctx.userLibraryDir) && !sharedLibrary) {
            const linkPath = path.join(ctx.projectOutfitDir, entry.name)
            findings.push(
              finding(
                'cross-scope-install',
                'error',
                `[project] ${entry.name} → ${entry.symlinkTarget}`,
                true,
                () =>
                  Effect.gen(function* () {
                    yield* Effect.tryPromise(() => unlink(linkPath)).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                    return `removed cross-scope symlink: ${entry.name} (project → user library)`
                  }),
              ),
            )
          }
        }
      }

      return findings
    }),
}

const newLeaf: DoctorAspect = {
  name: 'new-leaf',
  description: 'Installed group has new leaf skills not yet symlinked',
  level: 'warning',
  detect: (ctx) =>
    Effect.sync(() => {
      const findings: DoctorFinding[] = []
      for (const outfit of scopeTargets(
        ctx,
        { entries: ctx.userOutfit, scope: 'user' as Lib.Scope, label: 'user' },
        { entries: ctx.projectOutfit, scope: 'project' as Lib.Scope, label: 'project' },
      )) {
        // Find all installed group prefixes
        const installedNames = new Set(
          outfit.entries.filter((e) => e.commitment === 'pluggable').map((e) => e.name),
        )

        // For each library skill, check if its parent group is installed but this leaf isn't
        for (const skill of ctx.library) {
          const parsedSkillName = SkillName.parseLibraryRelPath(skill.libraryRelPath)
          if (!parsedSkillName) continue
          const flat = Lib.flattenName(skill.libraryRelPath)
          if (installedNames.has(flat)) continue // already installed

          // Skip skills from a different scope's library — never create cross-scope installs
          if (skill.libraryScope !== outfit.scope) continue

          // Check if any parent group prefix is installed
          const hasSibling = SkillName.prefixes(parsedSkillName).some((groupPrefix) => {
            const siblingPrefix = SkillName.flatGroupPrefix(groupPrefix)
            return [...installedNames].some(
              (installedName) => installedName !== flat && installedName.startsWith(siblingPrefix),
            )
          })
          if (hasSibling) {
            const linkPath = path.join(Lib.outfitDir(outfit.scope), flat)
            const relPath = skill.libraryRelPath
            const libPath = path.join(skill.libraryDir, relPath)
            findings.push(
              finding(
                'new-leaf',
                'warning',
                `[${outfit.label}] ${skill.colonName} — group has siblings installed`,
                true,
                () =>
                  Effect.gen(function* () {
                    yield* Effect.tryPromise(() =>
                      mkdir(path.dirname(linkPath), { recursive: true }),
                    )
                    yield* Effect.tryPromise(() => symlink(libPath, linkPath))
                    return `symlinked new leaf: ${skill.colonName} (${outfit.label})`
                  }),
              ),
            )
          }
        }
      }
      return findings
    }),
}

const staleRouter: DoctorAspect = {
  name: 'stale-router',
  description: 'Auto-generated router child list outdated',
  level: 'warning',
  detect: (ctx) =>
    Effect.gen(function* () {
      const findings: DoctorFinding[] = []
      for (const outfit of scopeTargets(
        ctx,
        { scope: 'user' as Lib.Scope, label: 'user' },
        { scope: 'project' as Lib.Scope, label: 'project' },
      )) {
        const routers = yield* Lib.detectGeneratedRouters(outfit.scope)
        for (const routerName of routers) {
          const routerDir = path.join(Lib.outfitDir(outfit.scope), routerName)
          const skillMdPath = path.join(routerDir, 'SKILL.md')
          const currentContent = yield* Effect.tryPromise(() =>
            readFile(skillMdPath, 'utf-8'),
          ).pipe(Effect.catchAll(() => Effect.succeed('')))
          if (!currentContent) continue

          // Get current library children for this group
          const children = ctx.library.filter((skill) => {
            const parsedName = SkillName.parseFrontmatterName(skill.colonName)
            return parsedName ? SkillName.isUnderTopLevelGroup(parsedName, routerName) : false
          })
          const expected = Lib.generateRouter(routerName, children)

          if (currentContent !== expected) {
            findings.push(
              finding(
                'stale-router',
                'warning',
                `[${outfit.label}] ${routerName}/ — children changed`,
                true,
                () =>
                  Effect.gen(function* () {
                    yield* Effect.tryPromise(() => writeFile(skillMdPath, expected))
                    return `regenerated router: ${routerName} (${outfit.label})`
                  }),
              ),
            )
          }
        }
      }
      return findings
    }),
}

// ── Registry ─────────────────────────────────────────────────────────

export const ALL_ASPECTS: readonly DoctorAspect[] = [
  agentMirror,
  brokenSymlink,
  stateDrift,
  newLeaf,
  orphanedRouter,
  staleGitignore,
  orphanedScope,
  corruptLibraryEntry,
  frontmatterMismatch,
  nameConflict,
  duplicateName,
  shadow,
  staleShadow,
  crossScopeInstall,
  staleRouter,
]

// ── Exports for readlink ─────────────────────────────────────────────

export { readlink }
