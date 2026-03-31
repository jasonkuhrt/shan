/**
 * shan skills on <targets> [--scope user] [--strict] [--fail-on-missing-dependencies]
 *
 * Turn on one or more skills or groups. Creates symlinks in outfit → library,
 * auto-activating the full missing dependency closure unless the caller opts out.
 */

import { Console, Effect } from 'effect'
import { lstat, mkdir, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'
import * as SkillGraph from '../../lib/skill-graph.js'
import { getRuntimeConfig } from '../../lib/runtime-config.js'
import * as SkillName from '../../lib/skill-name.js'

export interface SkillsOnOptions {
  readonly failOnMissingDependencies?: boolean
  readonly scope: Lib.Scope
  readonly strict: boolean
}

interface ActivationAction {
  readonly flatName: string
  readonly leaf: Lib.SkillInfo
  readonly linkPath: string
  readonly reason: 'dependency' | 'selected'
  readonly sourcePath: string
}

interface RouterAction {
  readonly groupName: string
  readonly leaves: readonly Lib.SkillInfo[]
  readonly libraryDir: string
  readonly reason: 'dependency' | 'selected'
  readonly routerPath: string
  readonly scope: Lib.Scope
}

interface ReportSection {
  readonly lines: readonly string[]
  readonly title: string
}

const makeVirtualActiveSkill = (leaf: Lib.SkillInfo): SkillGraph.ActiveSkill => ({
  colonName: leaf.colonName,
  commitment: 'pluggable',
  flatName: Lib.flattenName(leaf.libraryRelPath),
  frontmatter: leaf.frontmatter,
  frontmatterIssues: leaf.frontmatterIssues ?? [],
  id: SkillGraph.skillId(leaf.libraryScope, leaf.colonName),
  scope: leaf.libraryScope,
  sourceKind: 'library',
  sourcePath: path.join(leaf.libraryDir, leaf.libraryRelPath),
})

const rerunCommands = (
  targets: readonly string[],
  options: Pick<SkillsOnOptions, 'scope'>,
  extraTargetsByScope: ReadonlyMap<Lib.Scope, readonly string[]>,
): readonly string[] => {
  const commands: string[] = []
  const orderedScopes: readonly Lib.Scope[] =
    options.scope === 'project' ? ['project', 'user'] : ['user']

  for (const scope of orderedScopes) {
    const scopedTargets =
      scope === options.scope
        ? [...new Set([...targets, ...(extraTargetsByScope.get(scope) ?? [])])].sort()
        : [...new Set(extraTargetsByScope.get(scope) ?? [])].sort()
    if (scopedTargets.length === 0) continue

    const scopeFlag = scope === 'user' ? ' --scope user' : ''
    commands.push(`shan skills on ${scopedTargets.join(',')}${scopeFlag}`)
  }

  return commands
}

const sectionTree = (title: string, lines: readonly string[]): ReportSection => ({
  lines,
  title,
})

const printReport = (sections: readonly ReportSection[]) =>
  Effect.gen(function* () {
    for (const [index, section] of sections.entries()) {
      if (section.lines.length === 0) continue
      yield* Console.log(`${section.title}:`)
      for (const [lineIndex, line] of section.lines.entries()) {
        yield* Console.log(`  ${lineIndex === section.lines.length - 1 ? '\\-' : '|-'} ${line}`)
      }
      if (index < sections.length - 1) yield* Console.log('')
    }
  })

const formatSelectedTarget = (target: string, resolved: Lib.ResolvedTarget): string => {
  const leafRefs = resolved.leaves
    .map((leaf) => SkillGraph.formatSkillRef(leaf.libraryScope, leaf.colonName))
    .join(', ')
  return `${SkillGraph.formatSkillRef(resolved.libraryScope, target)} -> ${leafRefs}`
}

const gatherRouterCandidates = (
  selectedTargets: readonly Lib.ResolvedTarget[],
  activationActions: ReadonlyMap<string, ActivationAction>,
) => {
  const candidates = new Map<string, RouterAction>()

  const addCandidate = (
    groupName: string,
    libraryDir: string,
    scope: Lib.Scope,
    reason: 'dependency' | 'selected',
  ) => {
    const key = `${scope}:${groupName}`
    if (candidates.has(key)) return
    candidates.set(key, {
      groupName,
      leaves: [],
      libraryDir,
      reason,
      routerPath: path.join(Lib.outfitDir(scope), groupName),
      scope,
    })
  }

  for (const resolved of selectedTargets) {
    const parsed = SkillName.parseFrontmatterName(resolved.colonName)
    if (!parsed || SkillName.isNamespaced(parsed)) continue
    if (resolved.nodeType !== 'group') continue
    addCandidate(resolved.colonName, resolved.libraryDir, resolved.libraryScope, 'selected')
  }

  for (const action of activationActions.values()) {
    const parsed = SkillName.parseFrontmatterName(action.leaf.colonName)
    if (!parsed || !SkillName.isNamespaced(parsed)) continue
    addCandidate(
      SkillName.topLevelName(parsed),
      action.leaf.libraryDir,
      action.leaf.libraryScope,
      action.reason,
    )
  }

  return candidates
}

const finalizeRouterActions = (routerCandidates: ReadonlyMap<string, RouterAction>) =>
  Effect.gen(function* () {
    const actions: RouterAction[] = []

    for (const router of routerCandidates.values()) {
      const resolved = yield* Lib.resolveTarget(router.groupName, router.scope, true)
      if (resolved?.nodeType !== 'group') continue

      const collision = yield* Lib.checkCollision(router.groupName, router.scope)
      if (collision) continue

      const routerExists = yield* Effect.tryPromise(async () => {
        await lstat(router.routerPath)
        return true
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (routerExists) continue

      actions.push({ ...router, leaves: resolved.leaves })
    }

    return actions.sort((left, right) =>
      left.scope === right.scope
        ? left.groupName.localeCompare(right.groupName)
        : left.scope.localeCompare(right.scope),
    )
  })

export const skillsOn = (targetInput: string, options: SkillsOnOptions) =>
  Effect.gen(function* () {
    const failOnMissingDependencies = options.failOnMissingDependencies ?? false

    if (!targetInput) {
      yield* Console.error(
        'Usage: shan skills on <targets> [--scope user] [--strict] [--fail-on-missing-dependencies]',
      )
      yield* Console.error('  Targets: comma-separated skill/group names using colon syntax')
      yield* Console.error('  Example: shan skills on dispatch,skills:list')
      return yield* Effect.fail(new Error('Missing targets'))
    }

    const exists = yield* Lib.libraryExists(options.scope)
    if (!exists) {
      yield* Console.error('No skills library found. Run the migration first to create one.')
      return yield* Effect.fail(new Error('Library not found'))
    }

    const targets = Lib.parseTargets(targetInput)
    const activeGraph = yield* SkillGraph.loadActiveSkillGraph()
    const selectedTargets: Lib.ResolvedTarget[] = []
    const selectedLines: string[] = []
    const skippedLines: string[] = []
    const blockedLines: string[] = []
    const cascadedByOwner = new Map<string, Set<string>>()
    const activationActions = new Map<string, ActivationAction>()
    const queued = new Set<string>()
    const queue: Lib.SkillInfo[] = []
    const missingDependencyLeaves = new Map<Lib.Scope, Set<string>>()

    for (const target of targets) {
      const resolved = yield* Lib.resolveTarget(target, options.scope, true)
      if (!resolved) {
        blockedLines.push(`${SkillGraph.formatSkillRef(options.scope, target)} -> not found`)
        continue
      }

      selectedTargets.push(resolved)
      selectedLines.push(formatSelectedTarget(target, resolved))

      for (const leaf of resolved.leaves) {
        const id = SkillGraph.skillId(leaf.libraryScope, leaf.colonName)
        const flatName = Lib.flattenName(leaf.libraryRelPath)
        const linkPath = path.join(Lib.outfitDir(leaf.libraryScope), flatName)
        const alreadyExists = yield* Effect.tryPromise(async () => {
          await lstat(linkPath)
          return true
        }).pipe(Effect.catchAll(() => Effect.succeed(false)))

        const collision = alreadyExists
          ? null
          : yield* Lib.checkCollision(flatName, leaf.libraryScope)
        if (collision) {
          blockedLines.push(
            `${SkillGraph.formatSkillRef(leaf.libraryScope, leaf.colonName)} -> ${collision}`,
          )
          continue
        }

        if (!alreadyExists) {
          activationActions.set(id, {
            flatName,
            leaf,
            linkPath,
            reason: 'selected',
            sourcePath: path.join(leaf.libraryDir, leaf.libraryRelPath),
          })
        } else {
          skippedLines.push(
            `${SkillGraph.formatSkillRef(leaf.libraryScope, leaf.colonName)} -> already on`,
          )
        }

        if (!queued.has(id)) {
          queued.add(id)
          queue.push(leaf)
        }
      }
    }

    while (queue.length > 0) {
      const owner = queue.shift()
      if (!owner) continue

      const ownerLabel = SkillGraph.formatSkillRef(owner.libraryScope, owner.colonName)

      for (const dependency of owner.frontmatter?.dependencies ?? []) {
        const resolved = yield* SkillGraph.resolveDependencyTarget(
          dependency,
          owner.libraryScope,
          activeGraph.skills,
        )
        if (resolved.issue) {
          blockedLines.push(`${ownerLabel} -> ${resolved.issue.message}`)
          continue
        }

        if (resolved.resolution.sourceKind === 'active-core') {
          continue
        }

        const concreteTarget = yield* Lib.resolveTarget(
          dependency,
          resolved.resolution.resolvedInScope,
          true,
        )
        if (!concreteTarget) {
          blockedLines.push(`${ownerLabel} -> dependency "${dependency}" not found`)
          continue
        }

        for (const leaf of concreteTarget.leaves) {
          const dependencyId = SkillGraph.skillId(leaf.libraryScope, leaf.colonName)
          const dependencyLabel = SkillGraph.formatSkillRef(leaf.libraryScope, leaf.colonName)
          const alreadyActive = activeGraph.skillsById.has(dependencyId)
          const alreadyPlanned = activationActions.has(dependencyId)

          if (alreadyActive || alreadyPlanned) continue

          if (failOnMissingDependencies) {
            let missingInScope = missingDependencyLeaves.get(leaf.libraryScope)
            if (!missingInScope) {
              missingInScope = new Set()
              missingDependencyLeaves.set(leaf.libraryScope, missingInScope)
            }
            missingInScope.add(leaf.colonName)
            let cascaded = cascadedByOwner.get(ownerLabel)
            if (!cascaded) {
              cascaded = new Set()
              cascadedByOwner.set(ownerLabel, cascaded)
            }
            cascaded.add(dependencyLabel)
            continue
          }

          const flatName = Lib.flattenName(leaf.libraryRelPath)
          const collision = yield* Lib.checkCollision(flatName, leaf.libraryScope)
          if (collision) {
            blockedLines.push(`${ownerLabel} -> ${dependencyLabel}: ${collision}`)
            continue
          }

          activationActions.set(dependencyId, {
            flatName,
            leaf,
            linkPath: path.join(Lib.outfitDir(leaf.libraryScope), flatName),
            reason: 'dependency',
            sourcePath: path.join(leaf.libraryDir, leaf.libraryRelPath),
          })

          let cascaded = cascadedByOwner.get(ownerLabel)
          if (!cascaded) {
            cascaded = new Set()
            cascadedByOwner.set(ownerLabel, cascaded)
          }
          cascaded.add(dependencyLabel)

          if (!queued.has(dependencyId)) {
            queued.add(dependencyId)
            queue.push(leaf)
          }
        }
      }
    }

    if (missingDependencyLeaves.size > 0) {
      const missingDependencyLabels = [...missingDependencyLeaves.entries()]
        .flatMap(([scope, names]) =>
          [...names].map((name) => SkillGraph.formatSkillRef(scope, name)),
        )
        .sort()
      const rerun = rerunCommands(
        targets,
        options,
        new Map(
          [...missingDependencyLeaves.entries()].map(([scope, names]) => [
            scope,
            [...names].sort(),
          ]),
        ),
      )
      yield* printReport([
        sectionTree('selected', selectedLines),
        sectionTree('blocked', [
          `missing dependencies would be auto-activated: ${missingDependencyLabels.join(', ')}`,
          ...rerun.map((command) => `rerun with explicit targets: ${command}`),
        ]),
        sectionTree('skipped', skippedLines.sort()),
      ])
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    if (options.strict && skippedLines.length > 0) {
      yield* printReport([
        sectionTree('selected', selectedLines),
        sectionTree('blocked', ['strict mode treats skipped targets as errors']),
        sectionTree('skipped', skippedLines.sort()),
      ])
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    const finalSkills = [
      ...activeGraph.skills,
      ...[...activationActions.values()].map((action) => makeVirtualActiveSkill(action.leaf)),
    ]
    const finalGraph = yield* SkillGraph.buildActiveSkillGraph(finalSkills)
    const graphIssues = finalGraph.issues.map(
      (issue) =>
        `${SkillGraph.formatSkillRef(issue.skill.scope, issue.skill.colonName)} -> ${issue.message}`,
    )
    if (blockedLines.length > 0 || graphIssues.length > 0) {
      yield* printReport([
        sectionTree('selected', selectedLines),
        sectionTree('blocked', [...blockedLines, ...graphIssues].sort()),
        sectionTree('skipped', skippedLines.sort()),
      ])
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    const routerActions = yield* finalizeRouterActions(
      gatherRouterCandidates(selectedTargets, activationActions),
    )
    const activatedLines = [...activationActions.values()]
      .filter((action) => action.reason === 'selected')
      .map((action) => SkillGraph.formatSkillRef(action.leaf.libraryScope, action.leaf.colonName))
    const cascadedLines = [...cascadedByOwner.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([owner, leaves]) => `${owner} -> ${[...leaves].sort().join(', ')}`)
    const routerLines = routerActions.map(
      (router) => `router ${SkillGraph.formatSkillRef(router.scope, router.groupName)}`,
    )

    if (activationActions.size === 0 && routerActions.length === 0) {
      yield* printReport([
        sectionTree('selected', selectedLines),
        sectionTree('skipped', skippedLines.length > 0 ? skippedLines.sort() : ['no changes']),
      ])
      return
    }

    const affectedScopes = new Set<Lib.Scope>([
      ...[...activationActions.values()].map((action) => action.leaf.libraryScope),
      ...routerActions.map((router) => router.scope),
    ])
    const beforeSnapshots = new Map<
      Lib.Scope,
      { readonly generatedRouters: readonly string[]; readonly snapshot: readonly string[] }
    >()

    for (const scope of affectedScopes) {
      yield* Lib.ensureOutfitDir(Lib.outfitDir(scope))
      beforeSnapshots.set(scope, {
        generatedRouters: yield* Lib.detectGeneratedRouters(scope),
        snapshot: yield* Lib.snapshotOutfit(scope),
      })
    }

    const applyMutation = Effect.gen(function* () {
      const gitignoreEntries: string[] = []

      for (const action of activationActions.values()) {
        yield* Effect.tryPromise(() => symlink(action.sourcePath, action.linkPath))
        if (action.leaf.libraryScope === 'project') {
          gitignoreEntries.push(`.claude/skills/${action.flatName}`)
        }
      }

      for (const router of routerActions) {
        const content = Lib.generateRouter(router.groupName, [...router.leaves])
        yield* Effect.tryPromise(() => mkdir(router.routerPath, { recursive: true }))
        yield* Effect.tryPromise(() => writeFile(path.join(router.routerPath, 'SKILL.md'), content))
        if (router.scope === 'project') {
          gitignoreEntries.push(`.claude/skills/${router.groupName}`)
        }
      }

      if (gitignoreEntries.length > 0) {
        yield* Lib.manageGitignore(getRuntimeConfig().projectRoot, gitignoreEntries)
      }
    }).pipe(
      Effect.tapError(() =>
        Effect.forEach([...affectedScopes], (scope) => {
          const snapshot = beforeSnapshots.get(scope)
          if (!snapshot) return Effect.void
          return Lib.restoreSnapshot(snapshot.snapshot, snapshot.generatedRouters, scope)
        }),
      ),
    )

    yield* applyMutation

    const afterSnapshots = new Map<
      Lib.Scope,
      { readonly generatedRouters: readonly string[]; readonly snapshot: readonly string[] }
    >()
    for (const scope of affectedScopes) {
      afterSnapshots.set(scope, {
        generatedRouters: yield* Lib.detectGeneratedRouters(scope),
        snapshot: yield* Lib.snapshotOutfit(scope),
      })
    }

    const state = yield* Lib.loadState()
    const config = yield* Lib.loadConfig()
    let updatedState = state
    for (const scope of affectedScopes) {
      updatedState = yield* Lib.syncCurrentInstalls(updatedState, scope)
    }

    const history = Lib.getProjectHistory(updatedState, options.scope)
    if (history.undoneCount > 0) {
      history.entries.splice(history.entries.length - history.undoneCount)
      history.undoneCount = 0
    }
    history.entries.push(
      Lib.GraphOp({
        kind: 'on',
        scope: options.scope,
        snapshots: [...affectedScopes].sort().map((scope) => ({
          afterGeneratedRouters: afterSnapshots.get(scope)?.generatedRouters ?? [],
          afterSnapshot: afterSnapshots.get(scope)?.snapshot ?? [],
          beforeGeneratedRouters: beforeSnapshots.get(scope)?.generatedRouters ?? [],
          beforeSnapshot: beforeSnapshots.get(scope)?.snapshot ?? [],
          scope,
        })),
        targets,
        timestamp: new Date().toISOString(),
      }),
    )
    if (history.entries.length > config.skills.historyLimit) {
      history.entries.splice(0, history.entries.length - config.skills.historyLimit)
    }
    updatedState = Lib.setProjectHistory(updatedState, options.scope, history)
    yield* Lib.saveState(updatedState)
    yield* Lib.syncAgentMirrors('user', config)
    yield* Lib.syncAgentMirrors('project', config)

    yield* printReport([
      sectionTree('selected', selectedLines),
      sectionTree('activated', [...activatedLines.sort(), ...routerLines]),
      sectionTree('cascaded', cascadedLines),
      sectionTree('skipped', skippedLines.sort()),
    ])
    yield* Lib.printSlashCommandNotice
  })
