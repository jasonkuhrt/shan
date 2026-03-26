/**
 * shan skills off [targets] [--scope user] [--strict]
 *
 * Turn off one or more skills or groups. Removes symlinks from outfit.
 * No targets = turn off ALL pluggable (reset).
 * Two-phase execution: validate all targets first, abort on any error, then execute.
 */

import { Console, Effect, Option } from 'effect'
import { lstat, rm, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'
import * as SkillName from '../../lib/skill-name.js'

export interface SkillsOffOptions {
  readonly scope: Lib.Scope
  readonly strict: boolean
}

/** Validated uninstall action ready for Phase 2. */
interface ValidatedUninstall {
  readonly flatName: string
  readonly colonName: string
  readonly linkPath: string
  readonly scope: Lib.Scope
}

export const skillsOff = (targetInput: string, options: SkillsOffOptions) =>
  Effect.gen(function* () {
    const exists = yield* Lib.libraryExists(options.scope)
    if (!exists) {
      yield* Console.error('No skills library found.')
      return yield* Effect.fail(new Error('Library not found'))
    }

    // No targets = reset all pluggable (non-atomic — always succeeds)
    if (!targetInput) {
      yield* resetAll(Lib.outfitDir(options.scope), options.scope)
      return
    }

    const targets = Lib.parseTargets(targetInput)
    // Only search the requested scope's outfit — never cross scope boundaries.
    const searchScopes: Lib.Scope[] = [options.scope]

    // ── Phase 1: Validate all targets (no side effects) ─────────────

    const batch = Lib.emptyBatch<ValidatedUninstall>()
    const groupsToClean = new Set<string>()

    for (const target of targets) {
      // strict=false: off needs fallthrough to resolve group leaves for legacy cross-scope installs.
      // The write is scoped by searchScopes=[options.scope], so fallthrough here is read-only.
      const resolved = yield* Lib.resolveTarget(target, options.scope, false)
      if (!resolved) {
        batch.errors.push({ name: target, reason: 'not found in library' })
        continue
      }

      // Track top-level group for router cleanup
      if (resolved.nodeType === 'group' || resolved.nodeType === 'callable-group') {
        const parsedTarget = SkillName.parseFrontmatterName(target)
        if (!parsedTarget || !SkillName.isNamespaced(parsedTarget)) {
          groupsToClean.add(parsedTarget ? SkillName.topLevelName(parsedTarget) : target)
        }
      }

      for (const leaf of resolved.leaves) {
        const flatName = Lib.flattenName(leaf.libraryRelPath)

        // Search both scopes for the symlink
        let found = false
        for (const checkScope of searchScopes) {
          const checkDir = Lib.outfitDir(checkScope)
          const linkPath = path.join(checkDir, flatName)

          const stat = yield* Effect.tryPromise(() => lstat(linkPath)).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (!stat) continue

          found = true
          if (stat.isSymbolicLink()) {
            batch.actions.push({ flatName, colonName: leaf.colonName, linkPath, scope: checkScope })
          } else if (stat.isDirectory()) {
            batch.errors.push({ name: leaf.colonName, reason: 'cannot turn off core skill' })
          }
          break
        }

        if (!found) {
          batch.skips.push({ name: leaf.colonName, reason: 'already off' })
        }
      }
    }

    // ── Abort check ─────────────────────────────────────────────────

    const toRow = (a: ValidatedUninstall): Lib.ResultRow => ({
      status: 'ok',
      name: a.colonName,
      scope: a.scope,
      commitment: 'pluggable',
    })

    if (Lib.shouldAbort(batch, options.strict)) {
      yield* Lib.reportResults(Lib.batchToRows(batch, toRow, true))
      return yield* Effect.fail(new Error('Some targets failed'))
    }

    // ── Phase 2: Execute all mutations ──────────────────────────────

    const affectedScopes = new Set(batch.actions.map((a) => a.scope))

    // Snapshot before mutations (per affected scope)
    const snapshots = new Map<Lib.Scope, string[]>()
    const routersBeforeMap = new Map<Lib.Scope, string[]>()
    for (const scope of affectedScopes) {
      snapshots.set(scope, yield* Lib.snapshotOutfit(scope))
      routersBeforeMap.set(scope, yield* Lib.detectGeneratedRouters(scope))
    }

    // Remove symlinks
    for (const action of batch.actions) {
      yield* Effect.tryPromise(() => unlink(action.linkPath))
    }

    // Auto-router cleanup for top-level groups (per affected scope)
    for (const scope of affectedScopes) {
      const scopeDir = Lib.outfitDir(scope)
      for (const groupName of groupsToClean) {
        yield* cleanupRouter(scopeDir, groupName, scope)
      }
    }

    // Clean up gitignore entries for removed project-scope skills
    const projectGitignoreRemovals = batch.actions
      .filter((a) => a.scope === 'project')
      .map((a) => `.claude/skills/${a.flatName}`)
    if (projectGitignoreRemovals.length > 0) {
      yield* Lib.manageGitignoreRemove(process.cwd(), projectGitignoreRemovals)
    }

    // Update current state
    const state = yield* Lib.loadState()
    const config = yield* Lib.loadConfig()
    let updatedState = state
    for (const action of batch.actions) {
      updatedState = Lib.removeCurrentInstall(updatedState, action.scope, action.flatName)
    }

    // Record history per affected scope
    for (const scope of affectedScopes) {
      const history = Lib.getProjectHistory(updatedState, scope)
      if (history.undoneCount > 0) {
        history.entries.splice(history.entries.length - history.undoneCount)
        history.undoneCount = 0
      }
      history.entries.push(
        Lib.OffOp({
          targets,
          scope,
          timestamp: new Date().toISOString(),
          snapshot: snapshots.get(scope) ?? [],
          generatedRouters: routersBeforeMap.get(scope) ?? [],
        }),
      )
      if (history.entries.length > config.skills.historyLimit) {
        history.entries.splice(0, history.entries.length - config.skills.historyLimit)
      }
      updatedState = Lib.setProjectHistory(updatedState, scope, history)
    }
    yield* Lib.saveState(updatedState)
    yield* Lib.syncAgentMirrors(options.scope, config)

    // Report results
    yield* Lib.reportResults(Lib.batchToRows(batch, toRow))
  })

/** Reset all pluggable skills at the given scope. */
const resetAll = (dir: string, scope: Lib.Scope) =>
  Effect.gen(function* () {
    const state = yield* Lib.loadState()
    const config = yield* Lib.loadConfig()
    const snapshotBefore = yield* Lib.snapshotOutfit(scope)
    const routersBefore = yield* Lib.detectGeneratedRouters(scope)

    const outfit = yield* Lib.listOutfit(scope)
    let removed = 0
    let coreSkipped = 0
    const removedNames: string[] = []

    for (const entry of outfit) {
      if (entry.commitment === 'pluggable') {
        yield* Effect.ignore(Effect.tryPromise(() => unlink(path.join(dir, entry.name))))
        removed++
        removedNames.push(entry.name)
      } else {
        coreSkipped++
      }
    }

    // Clean up gitignore entries for project-scope removals
    if (scope === 'project' && removedNames.length > 0) {
      const gitignoreEntries = removedNames.map((n) => `.claude/skills/${n}`)
      yield* Lib.manageGitignoreRemove(process.cwd(), gitignoreEntries)
    }

    // Cleanup all generated routers
    const routers = yield* Lib.detectGeneratedRouters(scope)
    for (const router of routers) {
      yield* Effect.ignore(Effect.tryPromise(() => rm(path.join(dir, router), { recursive: true })))
    }

    // Clear current installs for this scope
    const updatedStateAfterClear = Lib.setCurrentInstalls(state, scope, [])

    // Record history
    const history = Lib.getProjectHistory(updatedStateAfterClear, scope)
    if (history.undoneCount > 0) {
      history.entries.splice(history.entries.length - history.undoneCount)
      history.undoneCount = 0
    }
    history.entries.push(
      Lib.OffOp({
        targets: [],
        scope,
        timestamp: new Date().toISOString(),
        snapshot: snapshotBefore,
        generatedRouters: routersBefore,
      }),
    )
    if (history.entries.length > config.skills.historyLimit) {
      history.entries.splice(0, history.entries.length - config.skills.historyLimit)
    }
    const newState = Lib.setProjectHistory(updatedStateAfterClear, scope, history)
    yield* Lib.saveState(newState)
    yield* Lib.syncAgentMirrors(scope, config)

    yield* Console.log(
      `Reset: ${removed} pluggable skills turned off (${coreSkipped} core skills untouched)`,
    )
    yield* Lib.printSlashCommandNotice
  })

/** Remove an auto-generated router directory if it exists. */
export const cleanupRouter = (outfitDir: string, groupName: string, scope: Lib.Scope) =>
  Effect.gen(function* () {
    const routerPath = path.join(outfitDir, groupName)
    const stat = Option.getOrNull(yield* Effect.option(Effect.tryPromise(() => lstat(routerPath))))
    if (!stat) return

    // Only remove if it's a real directory (not a symlink = not core)
    // AND it corresponds to a group in one of the libraries
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const libDir of Lib.librarySearchOrder(scope)) {
        const libPath = path.join(libDir, groupName)
        const libStat = yield* Effect.option(
          Effect.tryPromise(async () => {
            const s = await lstat(libPath)
            return s
          }),
        )
        const libExists = Option.isSome(libStat) && libStat.value.isDirectory()

        if (libExists) {
          const nodeType = yield* Lib.getNodeType(libPath)
          if (nodeType === 'group' || nodeType === 'callable-group') {
            yield* Effect.ignore(Effect.tryPromise(() => rm(routerPath, { recursive: true })))
            return
          }
        }
      }
    }
  })
