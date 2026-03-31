/**
 * shan skills off [targets] [--scope user] [--strict]
 *
 * Turn off one or more skills or groups. Default behavior cascades through
 * active dependents; dependency cascades are opt-in.
 */

import { Console, Effect } from 'effect'
import { lstat, rm, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'
import * as SkillGraph from '../../lib/skill-graph.js'
import { getRuntimeConfig } from '../../lib/runtime-config.js'
import * as SkillName from '../../lib/skill-name.js'

export interface SkillsOffOptions {
  readonly cascadeDependencies?: boolean
  readonly failOnDependents?: boolean
  readonly scope: Lib.Scope
  readonly strict: boolean
}

interface ReportSection {
  readonly lines: readonly string[]
  readonly title: string
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

const cleanupUnusedRouters = (
  scope: Lib.Scope,
  remainingSkills: readonly SkillGraph.ActiveSkill[],
  removedRouterNames: string[],
) =>
  Effect.gen(function* () {
    const dir = Lib.outfitDir(scope)
    const activeNamespacedTopLevels = new Set(
      remainingSkills
        .filter((skill) => skill.scope === scope)
        .flatMap((skill) => {
          const parsed = SkillName.parseFrontmatterName(skill.colonName)
          return parsed && SkillName.isNamespaced(parsed) ? [SkillName.topLevelName(parsed)] : []
        }),
    )

    const removed: string[] = []

    for (const routerName of removedRouterNames) {
      if (activeNamespacedTopLevels.has(routerName)) continue
      const routerPath = path.join(dir, routerName)
      const exists = yield* Effect.tryPromise(async () => {
        const stat = await lstat(routerPath)
        return stat.isDirectory()
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (!exists) continue
      yield* Effect.tryPromise(() => rm(routerPath, { recursive: true }))
      removed.push(routerName)
    }

    return removed
  })

/** Remove a generated router directory when it matches a library namespace root. */
export const cleanupRouter = (outfitDir: string, groupName: string, scope: Lib.Scope) =>
  Effect.gen(function* () {
    const routerPath = path.join(outfitDir, groupName)
    const stat = yield* Effect.tryPromise(async () => {
      const next = await lstat(routerPath)
      return next
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) return

    for (const libraryDir of Lib.librarySearchOrder(scope)) {
      const libraryPath = path.join(libraryDir, groupName)
      const exists = yield* Effect.tryPromise(async () => {
        const next = await lstat(libraryPath)
        return next.isDirectory()
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (!exists) continue

      const nodeType = yield* Lib.getNodeType(libraryPath)
      if (nodeType === 'group' || nodeType === 'callable-group') {
        yield* Effect.tryPromise(() => rm(routerPath, { recursive: true })).pipe(
          Effect.catchAll(() => Effect.void),
        )
        return
      }
    }
  })

const collectTopLevelRouters = (skills: readonly SkillGraph.ActiveSkill[]): string[] =>
  [
    ...new Set(
      skills.flatMap((skill) => {
        const parsed = SkillName.parseFrontmatterName(skill.colonName)
        return parsed && SkillName.isNamespaced(parsed) ? [SkillName.topLevelName(parsed)] : []
      }),
    ),
  ].sort()

export const skillsOff = (targetInput: string, options: SkillsOffOptions) =>
  Effect.gen(function* () {
    if (targetInput) {
      const libraryExists = yield* Lib.libraryExists(options.scope)
      if (!libraryExists) {
        yield* Console.error('No skills library found.')
        return yield* Effect.fail(new Error('Library not found'))
      }
    }

    const cascadeDependencies = options.cascadeDependencies ?? false
    const failOnDependents = options.failOnDependents ?? false
    const activeGraph = yield* SkillGraph.loadActiveSkillGraph()
    const selectedLines: string[] = []
    const blockedLines: string[] = []
    const skippedLines: string[] = []
    const cascadedLines = new Set<string>()
    const removalSet = new Set<string>()
    const selectionSet = new Set<string>()

    const selectSkill = (
      skill: SkillGraph.ActiveSkill,
      reason: 'dependency' | 'dependent' | 'selected',
    ) => {
      if (skill.commitment === 'core') {
        blockedLines.push(
          `${SkillGraph.formatSkillRef(skill.scope, skill.colonName)} -> cannot turn off core skill`,
        )
        return
      }

      const label = SkillGraph.formatSkillRef(skill.scope, skill.colonName)
      if (reason === 'selected') {
        selectedLines.push(label)
        selectionSet.add(skill.id)
      } else {
        cascadedLines.add(`${label} <- ${reason}`)
      }
      removalSet.add(skill.id)
    }

    if (!targetInput) {
      for (const skill of activeGraph.skills.filter(
        (candidate) => candidate.scope === options.scope && candidate.commitment === 'pluggable',
      )) {
        selectSkill(skill, 'selected')
      }
      if (selectedLines.length === 0)
        skippedLines.push(`no pluggable skills active in ${options.scope}`)
    } else {
      const targets = Lib.parseTargets(targetInput)
      for (const target of targets) {
        const resolved = yield* Lib.resolveTarget(target, options.scope, false)
        if (!resolved) {
          blockedLines.push(`${SkillGraph.formatSkillRef(options.scope, target)} -> not found`)
          continue
        }

        for (const leaf of resolved.leaves) {
          const activeSkill = activeGraph.skills.find(
            (candidate) =>
              candidate.scope === options.scope && candidate.colonName === leaf.colonName,
          )
          if (!activeSkill) {
            skippedLines.push(
              `${SkillGraph.formatSkillRef(options.scope, leaf.colonName)} -> already off`,
            )
            continue
          }
          selectSkill(activeSkill, 'selected')
        }
      }
    }

    if (options.strict && skippedLines.length > 0) {
      blockedLines.push('strict mode treats skipped targets as errors')
    }

    let changed = true
    while (changed) {
      changed = false

      for (const skill of activeGraph.skills) {
        if (removalSet.has(skill.id)) continue
        const dependencyIds = activeGraph.dependencyLeafIdsBySkill.get(skill.id) ?? []
        const removedDependencies = dependencyIds.filter((dependencyId) =>
          removalSet.has(dependencyId),
        )
        if (removedDependencies.length === 0) continue

        const dependencyLabels = removedDependencies
          .map((dependencyId) => activeGraph.skillsById.get(dependencyId))
          .filter((dependency): dependency is SkillGraph.ActiveSkill => dependency !== undefined)
          .map((dependency) => SkillGraph.formatSkillRef(dependency.scope, dependency.colonName))
          .join(', ')

        if (failOnDependents) {
          blockedLines.push(
            `${SkillGraph.formatSkillRef(skill.scope, skill.colonName)} depends on ${dependencyLabels}`,
          )
          continue
        }

        if (skill.commitment === 'core') {
          blockedLines.push(
            `${SkillGraph.formatSkillRef(skill.scope, skill.colonName)} depends on ${dependencyLabels} and cannot be cascaded because it is core`,
          )
          continue
        }

        removalSet.add(skill.id)
        cascadedLines.add(`${SkillGraph.formatSkillRef(skill.scope, skill.colonName)} <- dependent`)
        changed = true
      }

      if (!cascadeDependencies) continue

      for (const skillIdValue of [...removalSet]) {
        const skill = activeGraph.skillsById.get(skillIdValue)
        if (!skill) continue

        for (const dependencyId of activeGraph.dependencyLeafIdsBySkill.get(skillIdValue) ?? []) {
          if (removalSet.has(dependencyId)) continue

          const dependency = activeGraph.skillsById.get(dependencyId)
          if (!dependency) continue

          if (dependency.commitment === 'core') {
            blockedLines.push(
              `${SkillGraph.formatSkillRef(skill.scope, skill.colonName)} requires core dependency ${SkillGraph.formatSkillRef(
                dependency.scope,
                dependency.colonName,
              )}`,
            )
            continue
          }

          removalSet.add(dependencyId)
          cascadedLines.add(
            `${SkillGraph.formatSkillRef(dependency.scope, dependency.colonName)} <- dependency`,
          )
          changed = true
        }
      }
    }

    const remainingSkills = activeGraph.skills.filter((skill) => !removalSet.has(skill.id))
    const finalGraph = yield* SkillGraph.buildActiveSkillGraph(remainingSkills)
    for (const issue of finalGraph.issues) {
      blockedLines.push(
        `${SkillGraph.formatSkillRef(issue.skill.scope, issue.skill.colonName)} -> ${issue.message}`,
      )
    }

    if (blockedLines.length > 0) {
      yield* printReport([
        sectionTree('selected', [...new Set(selectedLines)].sort()),
        sectionTree('blocked', [...new Set(blockedLines)].sort()),
        sectionTree('skipped', [...new Set(skippedLines)].sort()),
      ])
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    if (removalSet.size === 0) {
      yield* printReport([
        sectionTree('selected', [...new Set(selectedLines)].sort()),
        sectionTree('skipped', [...new Set(skippedLines)].sort()),
      ])
      return
    }

    const removedSkills = [...removalSet]
      .map((skillIdValue) => activeGraph.skillsById.get(skillIdValue))
      .filter((skill): skill is SkillGraph.ActiveSkill => skill !== undefined)
      .sort((left, right) =>
        left.scope === right.scope
          ? left.colonName.localeCompare(right.colonName)
          : left.scope.localeCompare(right.scope),
      )
    const affectedScopes = new Set<Lib.Scope>(removedSkills.map((skill) => skill.scope))
    const beforeSnapshots = new Map<
      Lib.Scope,
      { readonly generatedRouters: readonly string[]; readonly snapshot: readonly string[] }
    >()

    for (const scope of affectedScopes) {
      beforeSnapshots.set(scope, {
        generatedRouters: yield* Lib.detectGeneratedRouters(scope),
        snapshot: yield* Lib.snapshotOutfit(scope),
      })
    }

    const routersToCleanup = collectTopLevelRouters(removedSkills)

    const removedRoutersByScope = new Map<Lib.Scope, readonly string[]>()

    yield* Effect.gen(function* () {
      const gitignoreRemovals: string[] = []

      for (const skill of removedSkills) {
        const linkPath = path.join(Lib.outfitDir(skill.scope), skill.flatName)
        yield* Effect.tryPromise(() => unlink(linkPath))
        if (skill.scope === 'project') {
          gitignoreRemovals.push(`.claude/skills/${skill.flatName}`)
        }
      }

      for (const scope of affectedScopes) {
        const removedRouters = yield* cleanupUnusedRouters(scope, remainingSkills, routersToCleanup)
        removedRoutersByScope.set(scope, removedRouters)
      }

      if (gitignoreRemovals.length > 0) {
        yield* Lib.manageGitignoreRemove(getRuntimeConfig().projectRoot, gitignoreRemovals)
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
        kind: 'off',
        scope: options.scope,
        snapshots: [...affectedScopes].sort().map((scope) => ({
          afterGeneratedRouters: afterSnapshots.get(scope)?.generatedRouters ?? [],
          afterSnapshot: afterSnapshots.get(scope)?.snapshot ?? [],
          beforeGeneratedRouters: beforeSnapshots.get(scope)?.generatedRouters ?? [],
          beforeSnapshot: beforeSnapshots.get(scope)?.snapshot ?? [],
          scope,
        })),
        targets: targetInput ? Lib.parseTargets(targetInput) : [],
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

    const deactivatedLines = removedSkills.map((skill) =>
      SkillGraph.formatSkillRef(skill.scope, skill.colonName),
    )
    const removedRouters = [...affectedScopes].flatMap((scope) =>
      [...(removedRoutersByScope.get(scope) ?? [])].map(
        (routerName) => `router ${SkillGraph.formatSkillRef(scope, routerName)}`,
      ),
    )

    yield* printReport([
      sectionTree('selected', [...new Set(selectedLines)].sort()),
      sectionTree('deactivated', [...deactivatedLines, ...removedRouters]),
      sectionTree('cascaded', [...cascadedLines].sort()),
      sectionTree('skipped', [...new Set(skippedLines)].sort()),
    ])
    yield* Lib.printSlashCommandNotice
  })
