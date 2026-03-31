/**
 * shan skills move <axis> <direction> <targets> [--scope user] [--strict]
 *
 * Migrate skills between scopes (user/project) or commitments (core/pluggable).
 * Two-phase execution: validate all, abort on error, then execute.
 *
 * Axes:
 *   scope up       — project → user
 *   scope down     — user → project
 *   commitment up  — pluggable → core
 *   commitment down — core → pluggable
 */

import { Console, Effect } from 'effect'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'
import * as SkillGraph from '../../lib/skill-graph.js'
import { getRuntimeConfig } from '../../lib/runtime-config.js'

export type MoveAxis = 'scope' | 'commitment'
export type MoveDirection = 'up' | 'down'

export interface SkillsMoveOptions {
  readonly cascadeDependencies?: boolean
  readonly scope: Lib.Scope
  readonly strict: boolean
}

interface MoveTarget {
  readonly colonName: string
  readonly id: string
  readonly scope: Lib.Scope
}

/** Validated move action ready for Phase 2. */
interface ValidatedMove {
  readonly colonName: string
  readonly flatName: string
  readonly scope: Lib.Scope
  readonly execute: () => Effect.Effect<void, unknown>
  readonly subActions: Lib.HistoryEntry[]
}

const ignoreError = () => Effect.void
const returnFalse = () => Effect.succeed(false)
const returnNull = () => Effect.succeed<null>(null)

const sortMoveTargets = (targets: Iterable<MoveTarget>): MoveTarget[] =>
  [...targets].sort((left, right) =>
    left.scope === right.scope
      ? left.colonName.localeCompare(right.colonName)
      : left.scope.localeCompare(right.scope),
  )

const GENERIC_EFFECT_ERROR_MESSAGES = new Set([
  'An unknown error occurred in Effect.tryPromise',
  'An unknown error occurred in Effect',
])

const hasOwnKey = <K extends string>(value: object, key: K): value is Record<K, unknown> =>
  Object.prototype.hasOwnProperty.call(value, key)

const renderMoveError = (error: unknown): string => {
  if (typeof error === 'string' && error.length > 0) return error

  if (typeof error === 'object' && error !== null) {
    for (const key of ['error', 'cause']) {
      const nested = hasOwnKey(error, key) ? error[key] : undefined
      const nestedMessage = renderMoveError(nested)
      if (nestedMessage.length > 0 && !GENERIC_EFFECT_ERROR_MESSAGES.has(nestedMessage)) {
        return nestedMessage
      }
    }

    const message = hasOwnKey(error, 'message') ? error.message : undefined
    if (
      typeof message === 'string' &&
      message.length > 0 &&
      !GENERIC_EFFECT_ERROR_MESSAGES.has(message)
    ) {
      return message
    }

    const reason = hasOwnKey(error, 'reason') ? error.reason : undefined
    if (typeof reason === 'string' && reason.length > 0) return reason
  }

  if (error instanceof Error && error.message.length > 0) return error.message
  if (error === null || error === undefined) return ''
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return error.toString()
  }
  if (typeof error === 'symbol') return error.toString()
  return ''
}

const collectMoveDependencyClosure = (
  axis: MoveAxis,
  direction: MoveDirection,
  initialTargets: readonly string[],
  activeGraph: SkillGraph.ActiveSkillGraph,
  options: SkillsMoveOptions,
) =>
  Effect.gen(function* () {
    const requestedTargets = new Set<string>()
    const requiredTargets = new Map<string, MoveTarget>()
    const blockedLines: string[] = []
    const cascadedTargets = new Map<string, MoveTarget>()
    const queue: Array<{
      readonly colonName: string
      readonly frontmatter: Lib.SkillFrontmatter | null
      readonly scope: Lib.Scope
    }> = []
    const visited = new Set<string>()

    const enqueueLibraryTarget = (resolved: Lib.ResolvedTarget, requested: boolean) => {
      for (const leaf of resolved.leaves) {
        const id = SkillGraph.skillId(leaf.libraryScope, leaf.colonName)
        requiredTargets.set(id, {
          colonName: leaf.colonName,
          id,
          scope: leaf.libraryScope,
        })
        if (requested) requestedTargets.add(id)
        if (visited.has(id)) continue
        visited.add(id)
        queue.push({
          colonName: leaf.colonName,
          frontmatter: leaf.frontmatter,
          scope: leaf.libraryScope,
        })
      }
    }

    const enqueueActiveTarget = (skill: SkillGraph.ActiveSkill, requested: boolean) => {
      requiredTargets.set(skill.id, {
        colonName: skill.colonName,
        id: skill.id,
        scope: skill.scope,
      })
      if (requested) requestedTargets.add(skill.id)
      if (visited.has(skill.id)) return
      visited.add(skill.id)
      queue.push({ colonName: skill.colonName, frontmatter: skill.frontmatter, scope: skill.scope })
    }

    const enqueueInitialTargetInScope = (
      target: string,
      scope: Lib.Scope,
      requested: boolean,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const resolvedLibraryTarget = yield* Lib.resolveTarget(target, scope, true)
        if (resolvedLibraryTarget) {
          enqueueLibraryTarget(resolvedLibraryTarget, requested)
          return true
        }

        const activeSkill = activeGraph.skills.find(
          (skill) => skill.colonName === target && skill.scope === scope,
        )
        if (activeSkill) {
          enqueueActiveTarget(activeSkill, requested)
          return true
        }

        return false
      })

    for (const target of initialTargets) {
      if (yield* enqueueInitialTargetInScope(target, options.scope, true)) {
        continue
      }

      if (axis === 'scope') {
        const destinationScope = direction === 'up' ? ('user' as const) : ('project' as const)
        if (destinationScope !== options.scope) {
          if (yield* enqueueInitialTargetInScope(target, destinationScope, true)) {
            continue
          }
        }
      }

      blockedLines.push(`${SkillGraph.formatSkillRef(options.scope, target)} -> not found`)
    }

    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) continue

      for (const dependency of next.frontmatter?.dependencies ?? []) {
        const resolved = yield* SkillGraph.resolveDependencyTarget(
          dependency,
          next.scope,
          activeGraph.skills,
        )
        if (resolved.issue) {
          blockedLines.push(
            `${SkillGraph.formatSkillRef(next.scope, next.colonName)} -> ${resolved.issue.message}`,
          )
          continue
        }

        if (resolved.resolution.sourceKind === 'active-core') {
          for (const dependencyLeaf of resolved.resolution.leaves) {
            const skill = activeGraph.skillsById.get(dependencyLeaf.id)
            if (!skill) continue
            enqueueActiveTarget(skill, false)
            cascadedTargets.set(skill.id, {
              colonName: skill.colonName,
              id: skill.id,
              scope: skill.scope,
            })
          }
          continue
        }

        const concreteTarget = yield* Lib.resolveTarget(
          dependency,
          resolved.resolution.resolvedInScope,
          true,
        )
        if (!concreteTarget) {
          blockedLines.push(
            `${SkillGraph.formatSkillRef(next.scope, next.colonName)} -> dependency "${dependency}" not found`,
          )
          continue
        }

        enqueueLibraryTarget(concreteTarget, false)
        for (const leaf of concreteTarget.leaves) {
          const id = SkillGraph.skillId(leaf.libraryScope, leaf.colonName)
          cascadedTargets.set(id, {
            colonName: leaf.colonName,
            id,
            scope: leaf.libraryScope,
          })
        }
      }
    }

    const extraTargets = sortMoveTargets(
      [...requiredTargets.values()].filter((target) => !requestedTargets.has(target.id)),
    )
    if (extraTargets.length > 0 && !options.cascadeDependencies) {
      blockedLines.push(
        `move requires dependencies: ${extraTargets
          .map((target) => SkillGraph.formatSkillRef(target.scope, target.colonName))
          .join(', ')}`,
      )
    }

    return {
      blockedLines,
      cascadedTargets: sortMoveTargets(
        [...cascadedTargets.values()].filter((target) => !requestedTargets.has(target.id)),
      ).map((target) => SkillGraph.formatSkillRef(target.scope, target.colonName)),
      targets: sortMoveTargets(requiredTargets.values()),
    }
  })

const findExternalDependents = (
  activeGraph: SkillGraph.ActiveSkillGraph,
  movedTargets: readonly MoveTarget[],
): string[] => {
  const movedIds = new Set(movedTargets.map((target) => target.id))
  const externalDependents = new Set<string>()

  for (const target of movedTargets) {
    const activeSkill = activeGraph.skillsById.get(target.id)
    if (!activeSkill) continue
    for (const dependent of SkillGraph.skillDependents(activeGraph, activeSkill.id)) {
      if (movedIds.has(dependent.id)) continue
      externalDependents.add(
        `${SkillGraph.formatSkillRef(dependent.scope, dependent.colonName)} depends on ${SkillGraph.formatSkillRef(activeSkill.scope, activeSkill.colonName)}`,
      )
    }
  }

  return [...externalDependents].sort()
}

export const skillsMove = (
  axis: MoveAxis,
  direction: MoveDirection,
  targetInput: string,
  options: SkillsMoveOptions,
) =>
  Effect.gen(function* () {
    if (!targetInput) {
      yield* Console.error('Usage: shan skills move <axis> <direction> <targets>')
      return yield* Effect.fail(new Error('Missing targets'))
    }

    const activeGraph = yield* SkillGraph.loadActiveSkillGraph()
    if (activeGraph.issues.length > 0) {
      for (const issue of activeGraph.issues) {
        yield* Console.error(
          `${SkillGraph.formatSkillRef(issue.skill.scope, issue.skill.colonName)} -> ${issue.message}`,
        )
      }
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    const requestedTargets = Lib.parseTargets(targetInput)
    const dependencyClosure = yield* collectMoveDependencyClosure(
      axis,
      direction,
      requestedTargets,
      activeGraph,
      options,
    )
    const externalDependents = findExternalDependents(activeGraph, dependencyClosure.targets)
    const targets = dependencyClosure.targets
    const batch = Lib.emptyBatch<ValidatedMove>()

    if (dependencyClosure.blockedLines.length > 0 || externalDependents.length > 0) {
      for (const line of [...dependencyClosure.blockedLines, ...externalDependents]) {
        yield* Console.error(line)
      }
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    if (options.cascadeDependencies && dependencyClosure.cascadedTargets.length > 0) {
      yield* Console.log(
        `Cascading dependencies into move set: ${dependencyClosure.cascadedTargets.join(', ')}`,
      )
    }

    // ── Phase 1: Validate all targets ───────────────────────────────

    for (const target of targets) {
      const result = yield* validateMove(axis, direction, target, options)
      if (result._tag === 'error') {
        batch.errors.push({
          name: SkillGraph.formatSkillRef(target.scope, target.colonName),
          reason: result.reason,
        })
      } else if (result._tag === 'skip') {
        batch.skips.push({
          name: SkillGraph.formatSkillRef(target.scope, target.colonName),
          reason: result.reason,
        })
      } else {
        batch.actions.push(result.action)
      }
    }

    // ── Abort check ─────────────────────────────────────────────────

    const toRow = (a: ValidatedMove): Lib.ResultRow => {
      if (axis === 'scope') {
        const scopeStr = direction === 'up' ? 'project → user' : 'user → project'
        return {
          status: 'ok',
          name: SkillGraph.formatSkillRef(a.scope, a.colonName),
          scope: scopeStr,
        }
      }
      const commitStr = direction === 'up' ? 'pluggable → core' : 'core → pluggable'
      return {
        status: 'ok',
        name: SkillGraph.formatSkillRef(a.scope, a.colonName),
        commitment: commitStr,
      }
    }

    if (Lib.shouldAbort(batch, options.strict)) {
      yield* Lib.reportResults(Lib.batchToRows(batch, toRow, true))
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    // ── Phase 2: Execute all mutations ──────────────────────────────

    // Ensure outfit dirs are functional before any mutations
    if (axis === 'scope') {
      const targetScope = direction === 'up' ? 'user' : 'project'
      yield* Lib.ensureOutfitDir(Lib.outfitDir(targetScope))
    }

    const state = yield* Lib.loadState()
    const config = yield* Lib.loadConfig()
    const allSubActions: Lib.HistoryEntry[] = []
    const gitignorePath = path.join(getRuntimeConfig().projectRoot, '.gitignore')
    const originalGitignore = yield* Effect.tryPromise(() => readFile(gitignorePath, 'utf-8')).pipe(
      Effect.catchAll(returnNull),
    )

    const completedActions: ValidatedMove[] = []

    yield* Effect.gen(function* () {
      for (const action of batch.actions) {
        yield* action.execute()
        completedActions.push(action)
        allSubActions.push(...action.subActions)
      }
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          for (const action of [...completedActions].reverse()) {
            for (const subAction of [...action.subActions].reverse()) {
              yield* rollbackMoveSubAction(subAction)
            }
          }
          yield* restoreGitignore(originalGitignore)
        }),
      ),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const message = renderMoveError(error)
          if (message) yield* Console.error(message)
          return yield* Effect.fail(new Error('Some targets failed'))
        }),
      ),
    )

    // Rebuild current installs for affected scopes after filesystem mutations.
    let updatedState = yield* Lib.syncCurrentInstalls(state, 'user')
    updatedState = yield* Lib.syncCurrentInstalls(updatedState, 'project')

    // Record composite history entry
    const history = Lib.getProjectHistory(updatedState, options.scope)
    if (history.undoneCount > 0) {
      history.entries.splice(history.entries.length - history.undoneCount)
      history.undoneCount = 0
    }
    history.entries.push(
      Lib.MoveOp({
        targets: targets.map((target) => SkillGraph.formatSkillRef(target.scope, target.colonName)),
        scope: options.scope,
        timestamp: new Date().toISOString(),
        axis,
        direction,
        subActions: allSubActions,
      }),
    )
    if (history.entries.length > config.skills.historyLimit) {
      history.entries.splice(0, history.entries.length - config.skills.historyLimit)
    }
    const finalState = Lib.setProjectHistory(updatedState, options.scope, history)
    yield* Lib.saveState(finalState)
    yield* Lib.syncAgentMirrors('user', config)
    yield* Lib.syncAgentMirrors('project', config)

    // Report results
    yield* Lib.reportResults(Lib.batchToRows(batch, toRow))

    // Collateral notifications for cross-project uninstalls
    for (const sub of allSubActions) {
      if (sub._tag === 'OffOp' && sub.scope !== options.scope && sub.scope !== 'user') {
        yield* Console.log(`  uninstalled from: ${sub.scope}`)
      }
    }
    yield* Lib.printSlashCommandNotice
  })

// ── Validation ────────────────────────────────────────────────────

type ValidationResult =
  | { readonly _tag: 'ok'; readonly action: ValidatedMove }
  | { readonly _tag: 'skip'; readonly reason: string }
  | { readonly _tag: 'error'; readonly reason: string }

const validateMove = (
  axis: MoveAxis,
  direction: MoveDirection,
  target: MoveTarget,
  options: SkillsMoveOptions,
): Effect.Effect<ValidationResult> =>
  Effect.gen(function* () {
    if (axis === 'scope' && direction === 'up') return yield* validateScopeUp(target, options)
    if (axis === 'scope' && direction === 'down') return yield* validateScopeDown(target, options)
    if (axis === 'commitment' && direction === 'up')
      return yield* validateCommitmentUp(target, options)
    if (axis === 'commitment' && direction === 'down')
      return yield* validateCommitmentDown(target, options)
    return { _tag: 'error', reason: `unknown move: ${axis} ${direction}` }
  })

// ── Scope Up (project → user) ────────────────────────────────────

const validateScopeUp = (
  target: MoveTarget,
  _options: SkillsMoveOptions,
): Effect.Effect<ValidationResult> =>
  Effect.gen(function* () {
    if (target.scope === 'user') return { _tag: 'skip' as const, reason: 'already at user scope' }

    const flatName = Lib.flattenName(Lib.colonToPath(target.colonName))
    const projectOutfitDir = Lib.outfitDir('project')
    const userOutfitDir = Lib.outfitDir('user')
    const projectOutfitPath = path.join(projectOutfitDir, flatName)
    const userOutfitPath = path.join(userOutfitDir, flatName)

    // Check if it exists in project outfit
    const projectStat = yield* Effect.tryPromise(() => lstat(projectOutfitPath)).pipe(
      Effect.catchAll(returnNull),
    )

    // Check if it's in the project library (not installed)
    const projLibDir = Lib.projectLibraryDir()
    const relPath = Lib.colonToPath(target.colonName)
    const projLibPath = path.join(projLibDir, relPath)
    const projLibExists = yield* Effect.tryPromise(async () => {
      const s = await lstat(projLibPath)
      return s.isDirectory()
    }).pipe(Effect.catchAll(returnFalse))

    // Already at user scope?
    const userExists = yield* Effect.tryPromise(() => lstat(userOutfitPath)).pipe(
      Effect.catchAll(returnNull),
    )
    if (userExists) return { _tag: 'skip' as const, reason: 'already at user scope' }

    // Check user library collision
    const userLibDir = Lib.LIBRARY_DIR
    const userLibPath = path.join(userLibDir, relPath)
    const userLibOccupied = yield* Effect.tryPromise(async () => {
      const s = await lstat(userLibPath)
      return s.isDirectory()
    }).pipe(Effect.catchAll(returnFalse))
    if (userLibOccupied) {
      return { _tag: 'error' as const, reason: 'already exists in user library' }
    }

    if (projectStat?.isDirectory() && !projectStat.isSymbolicLink()) {
      // Core skill — move directory
      return {
        _tag: 'ok' as const,
        action: {
          colonName: target.colonName,
          flatName,
          scope: target.scope,
          execute: () => executeScopeUpCore(projectOutfitPath, userOutfitPath, target.colonName),
          subActions: [
            Lib.MoveDirOp({
              targets: [target.colonName],
              scope: 'project',
              timestamp: new Date().toISOString(),
              sourcePath: projectOutfitPath,
              destPath: userOutfitPath,
            }),
          ],
        },
      }
    }

    if (projectStat?.isSymbolicLink()) {
      // Pluggable, installed at project scope
      return {
        _tag: 'ok' as const,
        action: {
          colonName: target.colonName,
          flatName,
          scope: target.scope,
          execute: () =>
            executeScopeUpPluggableInstalled(
              projectOutfitPath,
              userOutfitPath,
              projLibPath,
              userLibPath,
              projLibExists,
              relPath,
            ),
          subActions: buildScopeUpPluggableSubActions(
            target.colonName,
            projectOutfitPath,
            userOutfitPath,
            projLibPath,
            userLibPath,
            projLibExists,
          ),
        },
      }
    }

    if (projLibExists) {
      // Pluggable, not installed — just move library dir
      return {
        _tag: 'ok' as const,
        action: {
          colonName: target.colonName,
          flatName,
          scope: target.scope,
          execute: () => executeMoveLibraryDir(projLibPath, userLibPath),
          subActions: [
            Lib.MoveLibraryDirOp({
              targets: [target.colonName],
              scope: 'project',
              timestamp: new Date().toISOString(),
              sourcePath: projLibPath,
              destPath: userLibPath,
            }),
          ],
        },
      }
    }

    return { _tag: 'error' as const, reason: 'not found at project scope' }
  })

// ── Scope Down (user → project) ──────────────────────────────────

const validateScopeDown = (
  target: MoveTarget,
  _options: SkillsMoveOptions,
): Effect.Effect<ValidationResult> =>
  Effect.gen(function* () {
    if (target.scope === 'project') {
      return { _tag: 'skip' as const, reason: 'already at project scope' }
    }

    const flatName = Lib.flattenName(Lib.colonToPath(target.colonName))
    const projectOutfitDir = Lib.outfitDir('project')
    const userOutfitDir = Lib.outfitDir('user')
    const userOutfitPath = path.join(userOutfitDir, flatName)
    const projectOutfitPath = path.join(projectOutfitDir, flatName)
    const relPath = Lib.colonToPath(target.colonName)

    // Check if it exists in user outfit
    const userStat = yield* Effect.tryPromise(() => lstat(userOutfitPath)).pipe(
      Effect.catchAll(returnNull),
    )

    // Check user library
    const userLibPath = path.join(Lib.LIBRARY_DIR, relPath)
    const userLibExists = yield* Effect.tryPromise(async () => {
      const s = await lstat(userLibPath)
      return s.isDirectory()
    }).pipe(Effect.catchAll(returnFalse))

    // Already at project scope?
    const projectExists = yield* Effect.tryPromise(() => lstat(projectOutfitPath)).pipe(
      Effect.catchAll(returnNull),
    )
    if (projectExists) return { _tag: 'skip' as const, reason: 'already at project scope' }

    // Check project library collision
    const projLibDir = Lib.projectLibraryDir()
    const projLibPath = path.join(projLibDir, relPath)
    const projLibOccupied = yield* Effect.tryPromise(async () => {
      const s = await lstat(projLibPath)
      return s.isDirectory()
    }).pipe(Effect.catchAll(returnFalse))
    if (projLibOccupied) {
      return { _tag: 'error' as const, reason: 'already exists in project library' }
    }

    if (userStat?.isDirectory() && !userStat.isSymbolicLink()) {
      // Core skill — move directory
      return {
        _tag: 'ok' as const,
        action: {
          colonName: target.colonName,
          flatName,
          scope: target.scope,
          execute: () => executeScopeDownCore(userOutfitPath, projectOutfitPath),
          subActions: [
            Lib.MoveDirOp({
              targets: [target.colonName],
              scope: 'user',
              timestamp: new Date().toISOString(),
              sourcePath: userOutfitPath,
              destPath: projectOutfitPath,
            }),
          ],
        },
      }
    }

    if (userStat?.isSymbolicLink() || userLibExists) {
      // Pluggable — move library dir, repoint installs
      // Find all scopes where installed
      const state = yield* Lib.loadState()
      const affectedScopes = findAffectedScopes(state, flatName)

      return {
        _tag: 'ok' as const,
        action: {
          colonName: target.colonName,
          flatName,
          scope: target.scope,
          execute: () =>
            executeScopeDownPluggable(
              userLibPath,
              projLibPath,
              projectOutfitPath,
              relPath,
              affectedScopes,
            ),
          subActions: buildScopeDownPluggableSubActions(
            target.colonName,
            userLibPath,
            projLibPath,
            affectedScopes,
          ),
        },
      }
    }

    return { _tag: 'error' as const, reason: 'not found at user scope' }
  })

// ── Commitment Up (pluggable → core) ─────────────────────────────

const validateCommitmentUp = (
  target: MoveTarget,
  _options: SkillsMoveOptions,
): Effect.Effect<ValidationResult> =>
  Effect.gen(function* () {
    const flatName = Lib.flattenName(Lib.colonToPath(target.colonName))
    const relPath = Lib.colonToPath(target.colonName)

    // Find the skill in any library (commitment changes can cross scopes)
    const resolved = yield* Lib.resolveTarget(target.colonName, target.scope, true)
    if (!resolved) {
      // Check if it's already core
      const alreadyCore = yield* isCorePath(path.join(Lib.outfitDir(target.scope), flatName))
      if (alreadyCore) return { _tag: 'skip' as const, reason: 'already core' }
      return { _tag: 'error' as const, reason: 'not found' }
    }

    const outfitScope = resolved.libraryScope
    const outfitDir = Lib.outfitDir(outfitScope)
    const outfitPath = path.join(outfitDir, flatName)
    const libraryPath = path.join(resolved.libraryDir, relPath)

    // Find all scopes where installed
    const state = yield* Lib.loadState()
    const affectedScopes = findAffectedScopes(state, flatName)

    return {
      _tag: 'ok' as const,
      action: {
        colonName: target.colonName,
        flatName,
        scope: target.scope,
        execute: () =>
          executeCommitmentUp(libraryPath, outfitPath, outfitScope, flatName, affectedScopes),
        subActions: buildCommitmentUpSubActions(
          target.colonName,
          outfitScope,
          affectedScopes,
          libraryPath,
          outfitPath,
        ),
      },
    }
  })

// ── Commitment Down (core → pluggable) ───────────────────────────

const validateCommitmentDown = (
  target: MoveTarget,
  _options: SkillsMoveOptions,
): Effect.Effect<ValidationResult> =>
  Effect.gen(function* () {
    const flatName = Lib.flattenName(Lib.colonToPath(target.colonName))
    const relPath = Lib.colonToPath(target.colonName)

    // Find in outfit as core
    const outfitPath = path.join(Lib.outfitDir(target.scope), flatName)
    const isCore = yield* isCorePath(outfitPath)

    if (!isCore) {
      // Check if already pluggable
      const resolved = yield* Lib.resolveTarget(target.colonName, target.scope, true)
      if (resolved) return { _tag: 'skip' as const, reason: 'already pluggable' }
      return { _tag: 'error' as const, reason: 'not found' }
    }

    const scope = target.scope
    const libDir = Lib.scopeLibraryDir(scope)
    const libPath = path.join(libDir, relPath)

    // Check library destination not occupied
    const libOccupied = yield* Effect.tryPromise(async () => {
      const s = await lstat(libPath)
      return s.isDirectory()
    }).pipe(Effect.catchAll(returnFalse))

    if (libOccupied) {
      return { _tag: 'error' as const, reason: 'library path already occupied' }
    }

    return {
      _tag: 'ok' as const,
      action: {
        colonName: target.colonName,
        flatName,
        scope: target.scope,
        execute: () => executeCommitmentDown(outfitPath, libPath, scope, flatName),
        subActions: [
          Lib.MoveToLibraryOp({
            targets: [target.colonName],
            scope,
            timestamp: new Date().toISOString(),
            sourcePath: outfitPath,
            destPath: libPath,
          }),
          Lib.OnOp({
            targets: [target.colonName],
            scope,
            timestamp: new Date().toISOString(),
            snapshot: [],
            generatedRouters: [],
          }),
        ],
      },
    }
  })

// ── Execution helpers ─────────────────────────────────────────────

const executeScopeUpCore = (src: string, dest: string, target: string) =>
  Effect.gen(function* () {
    yield* Lib.ensureOutfitDir(path.dirname(dest))
    yield* Effect.tryPromise(() => rename(src, dest))
    yield* Lib.manageGitignoreRemove(getRuntimeConfig().projectRoot, [
      `.claude/skills/${Lib.flattenName(Lib.colonToPath(target))}`,
    ])
  })

const executeScopeUpPluggableInstalled = (
  projectOutfitPath: string,
  userOutfitPath: string,
  projLibPath: string,
  userLibPath: string,
  projLibExists: boolean,
  relPath: string,
) =>
  Effect.gen(function* () {
    // Off at project scope
    yield* Effect.tryPromise(() => unlink(projectOutfitPath))
    // Move library dir if it was in project library
    if (projLibExists) {
      yield* Effect.tryPromise(() => mkdir(path.dirname(userLibPath), { recursive: true }))
      yield* Effect.tryPromise(() => rename(projLibPath, userLibPath))
    }
    // On at user scope
    const libTarget = path.join(Lib.LIBRARY_DIR, relPath)
    yield* Lib.ensureOutfitDir(path.dirname(userOutfitPath))
    yield* Effect.tryPromise(() => symlink(libTarget, userOutfitPath))
    // Clean up gitignore entry from old project-scope install
    const flatName = Lib.flattenName(relPath)
    yield* Lib.manageGitignoreRemove(getRuntimeConfig().projectRoot, [`.claude/skills/${flatName}`])
  })

const executeMoveLibraryDir = (src: string, dest: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(path.dirname(dest), { recursive: true }))
    yield* Effect.tryPromise(() => rename(src, dest))
  })

const executeScopeDownCore = (src: string, dest: string) =>
  Effect.gen(function* () {
    yield* Lib.ensureOutfitDir(path.dirname(dest))
    yield* Effect.tryPromise(() => rename(src, dest))
  })

const executeScopeDownPluggable = (
  userLibPath: string,
  projLibPath: string,
  projectOutfitPath: string,
  relPath: string,
  affectedScopes: string[],
) =>
  Effect.gen(function* () {
    const flatName = Lib.flattenName(relPath)
    // Always remove user outfit symlink (source scope)
    const userLink = path.join(Lib.outfitDir('user'), flatName)
    yield* Effect.tryPromise(() => unlink(userLink))
    // Off at all other affected scopes (cross-project installs)
    for (const scopeKey of affectedScopes) {
      if (scopeKey === 'global') continue // already handled above
      const outfitDir = path.join(scopeKey, '.claude/skills')
      const linkPath = path.join(outfitDir, flatName)
      yield* Effect.tryPromise(() => unlink(linkPath))
    }
    // Move library dir
    yield* Effect.tryPromise(() => mkdir(path.dirname(projLibPath), { recursive: true }))
    yield* Effect.tryPromise(() => rename(userLibPath, projLibPath))
    // On at project scope
    yield* Lib.ensureOutfitDir(path.dirname(projectOutfitPath))
    yield* Effect.tryPromise(() => symlink(projLibPath, projectOutfitPath))
    // Add gitignore entry for new project-scope skill
    yield* Lib.manageGitignore(getRuntimeConfig().projectRoot, [`.claude/skills/${flatName}`])
  })

const executeCommitmentUp = (
  libraryPath: string,
  outfitPath: string,
  outfitScope: Lib.Scope,
  flatName: string,
  affectedScopes: string[],
) =>
  Effect.gen(function* () {
    // Always remove source scope's symlink
    const sourceLink = path.join(Lib.outfitDir(outfitScope), flatName)
    yield* Effect.tryPromise(() => unlink(sourceLink))
    // Off at all other affected scopes
    const sourceScopeKey = outfitScope === 'user' ? 'global' : getRuntimeConfig().projectRoot
    for (const scopeKey of affectedScopes) {
      if (scopeKey === sourceScopeKey) continue
      const outfitDir =
        scopeKey === 'global' ? Lib.outfitDir('user') : path.join(scopeKey, '.claude/skills')
      const linkPath = path.join(outfitDir, flatName)
      yield* Effect.tryPromise(() => unlink(linkPath))
    }
    // Copy library contents to outfit (becomes core)
    yield* Lib.ensureOutfitDir(path.dirname(outfitPath))
    yield* Effect.tryPromise(() => cp(libraryPath, outfitPath, { recursive: true }))
  })

const executeCommitmentDown = (
  outfitPath: string,
  libPath: string,
  scope: Lib.Scope,
  flatName: string,
) =>
  Effect.gen(function* () {
    // Move from outfit to library
    yield* Effect.tryPromise(() => mkdir(path.dirname(libPath), { recursive: true }))
    yield* Effect.tryPromise(() => rename(outfitPath, libPath))
    // Create symlink back (auto-install)
    yield* Effect.tryPromise(() => symlink(libPath, outfitPath))
    // Update gitignore if project scope
    if (scope === 'project') {
      yield* Lib.manageGitignore(getRuntimeConfig().projectRoot, [`.claude/skills/${flatName}`])
    }
  })

// ── Sub-action builders ───────────────────────────────────────────

const buildScopeUpPluggableSubActions = (
  target: string,
  _projectOutfitPath: string,
  _userOutfitPath: string,
  projLibPath: string,
  userLibPath: string,
  projLibExists: boolean,
): Lib.HistoryEntry[] => {
  const ts = new Date().toISOString()
  const actions: Lib.HistoryEntry[] = [
    Lib.OffOp({
      targets: [target],
      scope: 'project',
      timestamp: ts,
      snapshot: [],
      generatedRouters: [],
    }),
  ]
  if (projLibExists) {
    actions.push(
      Lib.MoveLibraryDirOp({
        targets: [target],
        scope: 'project',
        timestamp: ts,
        sourcePath: projLibPath,
        destPath: userLibPath,
      }),
    )
  }
  actions.push(
    Lib.OnOp({
      targets: [target],
      scope: 'user',
      timestamp: ts,
      snapshot: [],
      generatedRouters: [],
    }),
  )
  return actions
}

const buildScopeDownPluggableSubActions = (
  target: string,
  userLibPath: string,
  projLibPath: string,
  affectedScopes: string[],
): Lib.HistoryEntry[] => {
  const ts = new Date().toISOString()
  const actions: Lib.HistoryEntry[] = []
  for (const scopeKey of affectedScopes) {
    actions.push(
      Lib.OffOp({
        targets: [target],
        scope: scopeKey,
        timestamp: ts,
        snapshot: [],
        generatedRouters: [],
      }),
    )
  }
  actions.push(
    Lib.MoveLibraryDirOp({
      targets: [target],
      scope: 'user',
      timestamp: ts,
      sourcePath: userLibPath,
      destPath: projLibPath,
    }),
  )
  actions.push(
    Lib.OnOp({
      targets: [target],
      scope: 'project',
      timestamp: ts,
      snapshot: [],
      generatedRouters: [],
    }),
  )
  return actions
}

const buildCommitmentUpSubActions = (
  target: string,
  outfitScope: Lib.Scope,
  affectedScopes: string[],
  libraryPath: string,
  outfitPath: string,
): Lib.HistoryEntry[] => {
  const ts = new Date().toISOString()
  const actions: Lib.HistoryEntry[] = []
  for (const scopeKey of affectedScopes) {
    actions.push(
      Lib.OffOp({
        targets: [target],
        scope: scopeKey,
        timestamp: ts,
        snapshot: [],
        generatedRouters: [],
      }),
    )
  }
  actions.push(
    Lib.CopyToOutfitOp({
      targets: [target],
      scope: outfitScope,
      timestamp: ts,
      sourcePath: libraryPath,
      destPath: outfitPath,
    }),
  )
  return actions
}

// ── Utility helpers ───────────────────────────────────────────────

const restoreGitignore = (content: string | null) =>
  Effect.gen(function* () {
    const gitignorePath = path.join(getRuntimeConfig().projectRoot, '.gitignore')
    if (content === null) {
      yield* Effect.tryPromise(() => rm(gitignorePath, { force: true })).pipe(
        Effect.catchAll(ignoreError),
      )
      return
    }

    yield* Effect.tryPromise(() => mkdir(path.dirname(gitignorePath), { recursive: true }))
    yield* Effect.tryPromise(() => writeFile(gitignorePath, content))
  })

const rollbackMoveSubAction = (sub: Lib.HistoryEntry): Effect.Effect<void, unknown> => {
  if (
    sub._tag === 'MoveDirOp' ||
    sub._tag === 'MoveLibraryDirOp' ||
    sub._tag === 'MoveToLibraryOp'
  ) {
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(path.dirname(sub.sourcePath), { recursive: true }))
      yield* Effect.tryPromise(() => rename(sub.destPath, sub.sourcePath))
    }).pipe(Effect.catchAll(ignoreError))
  }

  if (sub._tag === 'CopyToOutfitOp') {
    return Effect.tryPromise(() => rm(sub.destPath, { recursive: true, force: true })).pipe(
      Effect.catchAll(ignoreError),
    )
  }

  if (sub._tag === 'OnOp') {
    return Effect.gen(function* () {
      for (const target of sub.targets) {
        const targetPaths = Lib.resolveCanonicalTargetPaths(target)
        if (!targetPaths) continue

        const linkPath = path.join(Lib.resolveHistoryOutfitDir(sub.scope), targetPaths.flatName)
        yield* Effect.tryPromise(() => unlink(linkPath)).pipe(Effect.catchAll(ignoreError))
      }
    })
  }

  if (sub._tag === 'OffOp') {
    return Effect.gen(function* () {
      const scope = Lib.resolveHistoryScope(sub.scope)
      const libDir = Lib.scopeLibraryDir(scope)

      for (const target of sub.targets) {
        const targetPaths = Lib.resolveCanonicalTargetPaths(target)
        if (!targetPaths) continue

        const linkPath = path.join(Lib.resolveHistoryOutfitDir(sub.scope), targetPaths.flatName)
        const libPath = path.join(libDir, targetPaths.relPath)
        const libExists = yield* Effect.tryPromise(() =>
          lstat(libPath).then((stat) => stat.isDirectory()),
        ).pipe(Effect.catchAll(returnFalse))
        if (!libExists) continue
        yield* Effect.tryPromise(() => mkdir(path.dirname(linkPath), { recursive: true }))
        yield* Effect.tryPromise(() => symlink(libPath, linkPath)).pipe(
          Effect.catchAll(ignoreError),
        )
      }
    })
  }

  return Effect.void
}

/** Check if a path is a real directory (core skill), not a symlink. */
const isCorePath = (p: string) =>
  Effect.tryPromise(async () => {
    const s = await lstat(p)
    return s.isDirectory() && !s.isSymbolicLink()
  }).pipe(Effect.catchAll(returnFalse))

/** Find all scope keys in state.json that have this flat name installed. */
const findAffectedScopes = (state: Lib.ShanState, flatName: string): string[] =>
  Object.entries(state.current)
    .filter(([_, scopeState]) => scopeState.installs.includes(flatName))
    .map(([key]) => key)
