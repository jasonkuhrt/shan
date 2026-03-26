/**
 * shan skills doctor — Run aspect-based health checks on the skills system.
 *
 * Default: detect + auto-fix. Use --no-fix for report-only mode.
 */

import { Console, Effect } from 'effect'
import * as Lib from '../../lib/skill-library.js'
import { ALL_ASPECTS, type DoctorFinding } from '../../lib/doctor-aspects.js'

export interface DoctorOptions {
  readonly noFix: boolean
  readonly scope?: Lib.Scope
}

export const createDoctorContext = (scope: Lib.Scope) =>
  Effect.gen(function* () {
    const libExists = yield* Lib.libraryExists()
    if (!libExists) return null

    const state = yield* Lib.loadState()
    const library =
      scope === 'user'
        ? yield* Lib.listLibrary([Lib.LIBRARY_DIR])
        : yield* Lib.listLibrary([Lib.LIBRARY_DIR, Lib.projectLibraryDir()])
    const userOutfit = scope === 'user' ? yield* Lib.listOutfit('user') : []
    const projectOutfit = scope === 'project' ? yield* Lib.listOutfit('project') : []
    const gitignoreEntries =
      scope === 'project' ? yield* Lib.readGitignoreEntries(process.cwd()) : []
    const config = yield* Lib.loadConfig()
    const configuredAgents = yield* Lib.resolveConfiguredAgents(config)

    return {
      scope,
      state,
      library,
      userOutfit,
      projectOutfit,
      projectOutfitDir: Lib.outfitDir('project'),
      gitignoreEntries,
      config,
      configuredAgents,
    }
  })

export const collectDoctorFindings = (scope: Lib.Scope) =>
  Effect.gen(function* () {
    const ctx = yield* createDoctorContext(scope)
    if (!ctx) return null

    // ── Resolve disabled aspects ──────────────────────────────────
    const disabled = new Set(ctx.config.skills.doctor?.disabled ?? [])
    const aspects = ALL_ASPECTS.filter((a) => !disabled.has(a.name))

    // ── Run detection ─────────────────────────────────────────────
    const allFindings: DoctorFinding[] = []
    for (const aspect of aspects) {
      const findings = yield* aspect.detect(ctx)
      allFindings.push(...findings)
    }

    return { ctx, findings: allFindings }
  })

export const skillsDoctor = (options: DoctorOptions = { noFix: false }) =>
  Effect.gen(function* () {
    const scope = options.scope ?? 'project'

    yield* Console.log('Running health checks...')
    yield* Console.log('')

    const result = yield* collectDoctorFindings(scope)
    if (!result) {
      yield* Console.error(`Library directory not found: ${Lib.LIBRARY_DIR}`)
      return
    }

    const { ctx, findings: allFindings } = result

    if (allFindings.length === 0) {
      yield* Console.log('doctor: 0 issues — all clear')
      return
    }

    // ── Apply fixes or report ─────────────────────────────────────
    const fixable = allFindings.filter((f) => f.fixable)
    const unfixable = allFindings.filter((f) => !f.fixable)
    let fixedCount = 0
    const fixDescriptions: string[] = []

    if (!options.noFix) {
      // Auto-fix mode
      for (const f of fixable) {
        if (f.fix) {
          const desc = yield* f.fix().pipe(
            Effect.catchAll((err) => {
              return Console.error(`  fix failed: ${f.message} — ${String(err)}`).pipe(
                Effect.map(() => null as string | null),
              )
            }),
          )
          if (desc) {
            fixedCount++
            fixDescriptions.push(desc)
          }
        }
      }

      yield* Console.log(`doctor: ${allFindings.length} issues found, ${fixedCount} fixed`)
      yield* Console.log('')

      for (const desc of fixDescriptions) {
        yield* Console.log(`  + ${desc}`)
      }
      for (const f of unfixable) {
        yield* Console.log(`  ! ${f.aspect}: ${f.message}`)
      }
      for (const f of fixable) {
        if (!f.fix) {
          yield* Console.log(`  ! ${f.aspect}: ${f.message}`)
        }
      }

      // Record doctor history entry — reload state since fixes may have modified it
      if (fixedCount > 0) {
        const freshState = yield* Lib.loadState()
        const history = Lib.getProjectHistory(freshState, scope)
        history.entries.push(
          Lib.DoctorOp({
            targets: fixDescriptions,
            scope,
            timestamp: new Date().toISOString(),
          }),
        )
        if (history.entries.length > ctx.config.skills.historyLimit) {
          history.entries.splice(0, history.entries.length - ctx.config.skills.historyLimit)
        }
        const newState = Lib.setProjectHistory(freshState, scope, history)
        yield* Lib.saveState(newState)
        yield* Lib.syncAgentMirrors(scope, ctx.config)
      }
    } else {
      // Report-only mode
      yield* Console.log(`doctor: ${allFindings.length} issues found (--no-fix: report only)`)
      yield* Console.log('')

      for (const f of allFindings) {
        const fixLabel = f.fixable ? ' [fixable]' : ''
        yield* Console.log(`  ${f.aspect}: ${f.message}${fixLabel}`)
      }

      if (fixable.length > 0) {
        yield* Console.log('')
        yield* Console.log(
          `  Run \`shan skills doctor\` to auto-fix ${fixable.length} of ${allFindings.length} issues`,
        )
      }
    }
  })
