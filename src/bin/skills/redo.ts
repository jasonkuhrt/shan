/**
 * shan skills redo [N] — Redo the last N undone operations (default 1).
 *
 * Restores the outfit to the state after each re-applied operation.
 * For composite MoveOp entries, replays sub-actions in forward order.
 *
 * IMPORTANT: Redo replays filesystem mutations directly — it must NOT call
 * skillsOn/skillsOff because those run full pipelines (including their own
 * state saves), which would corrupt state when redo saves its own version.
 */

import { Console, Effect } from 'effect'
import * as path from 'node:path'
import { cp, lstat, mkdir, rename, rm, symlink, unlink } from 'node:fs/promises'
import * as Lib from '../../lib/skill-library.js'

export const skillsRedo = (n: number, scope: Lib.Scope) =>
  Effect.gen(function* () {
    const state = yield* Lib.loadState()
    const history = Lib.getProjectHistory(state, scope)

    if (history.undoneCount === 0) {
      yield* Console.log('Nothing to redo.')
      return
    }

    const redoCount = Math.min(n, history.undoneCount)
    const activeCount = history.entries.length - history.undoneCount

    yield* Console.log(`Redoing ${redoCount} operation${redoCount > 1 ? 's' : ''}...`)

    // Process entries from oldest undone to newest
    for (let i = activeCount; i < activeCount + redoCount; i++) {
      const entry = history.entries[i]
      if (!entry) continue
      yield* redoEntry(entry, scope)
    }

    // Rebuild current installs from filesystem after all mutations.
    // MoveOp entries affect both scopes, so always sync both.
    let updatedState = yield* Lib.syncCurrentInstalls(state, 'user')
    updatedState = yield* Lib.syncCurrentInstalls(updatedState, 'project')

    // Update undo pointer
    history.undoneCount -= redoCount
    updatedState = Lib.setProjectHistory(updatedState, scope, history)
    yield* Lib.saveState(updatedState)
    yield* Lib.syncAgentMirrors('user')
    yield* Lib.syncAgentMirrors('project')

    yield* Console.log(`Redone ${redoCount} operation${redoCount > 1 ? 's' : ''}.`)
  })

/** Redo a single history entry via direct filesystem replay. */
const redoEntry = (entry: Lib.HistoryEntry, scope: Lib.Scope): Effect.Effect<void, unknown> => {
  if (entry._tag === 'OnOp') {
    return redoOnOp(entry, scope)
  }
  if (entry._tag === 'OffOp') {
    return redoOffOp(entry, scope)
  }
  if (entry._tag === 'MoveOp') {
    return redoMoveOp(entry)
  }
  return Console.error(`  warn: redo for ${entry._tag} not yet implemented`)
}

/** Redo an OnOp by creating symlinks directly (no full skillsOn pipeline). */
const redoOnOp = (entry: Lib.HistoryEntry & { readonly _tag: 'OnOp' }, scope: Lib.Scope) =>
  Effect.gen(function* () {
    if (entry.targets.length === 0) return
    const dir = Lib.outfitDir(scope)
    yield* Lib.ensureOutfitDir(dir)

    const gitignoreEntries: string[] = []

    for (const target of entry.targets) {
      const flatName = Lib.flattenName(Lib.colonToPath(target))
      const relPath = Lib.colonToPath(target)
      const linkPath = path.join(dir, flatName)

      const already = yield* Effect.tryPromise(() => lstat(linkPath).then(() => true)).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      )
      if (already) continue

      // Only use the scope-appropriate library (no cross-scope fallthrough)
      const libDir = Lib.scopeLibraryDir(scope)
      const libPath = path.join(libDir, relPath)
      const libExists = yield* Effect.tryPromise(() =>
        lstat(libPath).then((s) => s.isDirectory()),
      ).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (libExists) {
        yield* Effect.tryPromise(() => symlink(libPath, linkPath)).pipe(
          Effect.catchAll(() => Effect.void),
        )
        if (scope === 'project') {
          gitignoreEntries.push(`.claude/skills/${flatName}`)
        }
      }
    }

    if (gitignoreEntries.length > 0) {
      yield* Lib.manageGitignore(process.cwd(), gitignoreEntries)
    }
  })

/** Redo an OffOp by removing symlinks directly (no full skillsOff pipeline). */
const redoOffOp = (entry: Lib.HistoryEntry & { readonly _tag: 'OffOp' }, scope: Lib.Scope) =>
  Effect.gen(function* () {
    const dir = Lib.outfitDir(scope)
    if (entry.targets.length === 0) {
      // Reset-all: remove all pluggable symlinks and generated routers in this scope
      const outfit = yield* Lib.listOutfit(scope)
      const removedNames: string[] = []
      for (const e of outfit) {
        if (e.commitment === 'pluggable') {
          yield* Effect.tryPromise(() => unlink(path.join(dir, e.name))).pipe(
            Effect.catchAll(() => Effect.void),
          )
          removedNames.push(e.name)
        }
      }
      // Clean up generated routers
      const routers = yield* Lib.detectGeneratedRouters(scope)
      for (const router of routers) {
        yield* Effect.tryPromise(() => rm(path.join(dir, router), { recursive: true })).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
      // Clean up gitignore entries for project scope
      if (scope === 'project' && removedNames.length > 0) {
        yield* Lib.manageGitignoreRemove(
          process.cwd(),
          removedNames.map((n) => `.claude/skills/${n}`),
        )
      }
      return
    }
    const gitignoreRemovals: string[] = []
    for (const target of entry.targets) {
      const flatName = Lib.flattenName(Lib.colonToPath(target))
      const linkPath = path.join(dir, flatName)
      yield* Effect.tryPromise(() => unlink(linkPath)).pipe(Effect.catchAll(() => Effect.void))
      if (scope === 'project') {
        gitignoreRemovals.push(`.claude/skills/${flatName}`)
      }
    }
    if (gitignoreRemovals.length > 0) {
      yield* Lib.manageGitignoreRemove(process.cwd(), gitignoreRemovals)
    }
  })

/** Redo a composite MoveOp by replaying sub-actions in forward order. */
const redoMoveOp = (entry: Lib.HistoryEntry & { readonly _tag: 'MoveOp' }) =>
  Effect.gen(function* () {
    for (const sub of entry.subActions) {
      yield* replaySubAction(sub)
    }
  })

/** Replay a single sub-action from a composite move. */
const replaySubAction = (sub: Lib.HistoryEntry): Effect.Effect<void, unknown> => {
  // Filesystem moves: execute the original move
  if (
    sub._tag === 'MoveDirOp' ||
    sub._tag === 'MoveLibraryDirOp' ||
    sub._tag === 'MoveToLibraryOp'
  ) {
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(path.dirname(sub.destPath), { recursive: true }))
      yield* Effect.tryPromise(() => rename(sub.sourcePath, sub.destPath))
    })
  }
  // CopyToOutfitOp: copy library to outfit
  if (sub._tag === 'CopyToOutfitOp') {
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(path.dirname(sub.destPath), { recursive: true }))
      yield* Effect.tryPromise(() => cp(sub.sourcePath, sub.destPath, { recursive: true }))
    })
  }
  // OnOp: create symlinks (scope-safe — only use matching library)
  if (sub._tag === 'OnOp') {
    return Effect.gen(function* () {
      const scope = sub.scope === 'user' || sub.scope === 'global' ? 'user' : 'project'
      const libDir = Lib.scopeLibraryDir(scope)
      for (const target of sub.targets) {
        const flatName = Lib.flattenName(Lib.colonToPath(target))
        const relPath = Lib.colonToPath(target)
        const outfitDir = Lib.resolveHistoryOutfitDir(sub.scope)
        const linkPath = path.join(outfitDir, flatName)
        const libPath = path.join(libDir, relPath)
        const exists = yield* Effect.tryPromise(() =>
          lstat(libPath).then((s) => s.isDirectory()),
        ).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (exists) {
          yield* Effect.tryPromise(() => mkdir(path.dirname(linkPath), { recursive: true }))
          yield* Effect.tryPromise(() => symlink(libPath, linkPath)).pipe(
            Effect.catchAll(() => Effect.void),
          )
        }
      }
    })
  }
  // OffOp: remove symlinks
  if (sub._tag === 'OffOp') {
    return Effect.gen(function* () {
      for (const target of sub.targets) {
        const flatName = Lib.flattenName(Lib.colonToPath(target))
        const outfitDir = Lib.resolveHistoryOutfitDir(sub.scope)
        const linkPath = path.join(outfitDir, flatName)
        yield* Effect.tryPromise(() => unlink(linkPath)).pipe(Effect.catchAll(() => Effect.void))
      }
    })
  }
  return Console.error(`  warn: redo for sub-action ${sub._tag} not yet implemented`)
}
