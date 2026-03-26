/**
 * shan skills doctor — Run aspect-based health checks on the skills system.
 *
 * Default: detect + auto-fix. Use --no-fix for report-only mode.
 */

import { Console, Effect } from 'effect'
import * as Lib from '../../lib/skill-library.js'
import { ALL_ASPECTS, type DoctorContext, type DoctorFinding } from '../../lib/doctor-aspects.js'

export interface DoctorOptions {
  readonly noFix: boolean
  readonly scope?: Lib.Scope
}

export const createDoctorContext = (scope: Lib.Scope) =>
  Effect.gen(function* () {
    const libExists = yield* Lib.libraryExists()
    if (!libExists) return null

    const state = yield* Lib.loadState()
    const userLibraryDir = Lib.LIBRARY_DIR
    const projectLibraryDir = Lib.projectLibraryDir()
    const userOutfitDir = Lib.outfitDir('user')
    const projectOutfitDir = Lib.outfitDir('project')
    const library =
      scope === 'user'
        ? yield* Lib.listLibrary([userLibraryDir])
        : yield* Lib.listLibrary([userLibraryDir, projectLibraryDir])
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
      userLibraryDir,
      projectLibraryDir,
      userOutfit,
      userOutfitDir,
      projectOutfit,
      projectOutfitDir,
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

export interface DoctorFixOutcome {
  readonly fixedCount: number
  readonly fixDescriptions: string[]
  readonly remainingFindings: DoctorFinding[]
}

type DoctorFindingCollector = (
  scope: Lib.Scope,
) => Effect.Effect<{ ctx: DoctorContext; findings: DoctorFinding[] } | null>

export const autoFixDoctorFindings = (
  scope: Lib.Scope,
  collect: DoctorFindingCollector = collectDoctorFindings,
) =>
  Effect.gen(function* () {
    const maxFixPasses = 512
    const failedFixes = new Set<string>()
    const fixDescriptions: string[] = []
    let fixedCount = 0
    let remainingFindings: DoctorFinding[] = []

    for (let pass = 0; pass < maxFixPasses; pass++) {
      const result = yield* collect(scope)
      if (!result) {
        return { fixedCount, fixDescriptions, remainingFindings }
      }

      remainingFindings = result.findings

      const nextFix = result.findings.find(
        (finding): finding is DoctorFinding & { fix: NonNullable<DoctorFinding['fix']> } => {
          if (!finding.fixable || !finding.fix) return false
          const signature = `${finding.aspect}::${finding.message}`
          return !failedFixes.has(signature)
        },
      )

      if (!nextFix) {
        return { fixedCount, fixDescriptions, remainingFindings }
      }

      const signature = `${nextFix.aspect}::${nextFix.message}`
      const desc = yield* nextFix.fix().pipe(
        Effect.catchAll((err) => {
          failedFixes.add(signature)
          return Console.error(`  fix failed: ${nextFix.message} — ${String(err)}`).pipe(
            Effect.map(() => null as string | null),
          )
        }),
      )

      if (!desc) continue

      fixedCount++
      fixDescriptions.push(desc)
    }

    return { fixedCount, fixDescriptions, remainingFindings }
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

    const { ctx, findings: initialFindings } = result

    if (initialFindings.length === 0) {
      yield* Console.log('doctor: 0 issues — all clear')
      return
    }

    // ── Apply fixes or report ─────────────────────────────────────
    const initialFixable = initialFindings.filter((f) => f.fixable)

    if (!options.noFix) {
      const { fixedCount, fixDescriptions, remainingFindings } = yield* autoFixDoctorFindings(scope)
      const unfixable = remainingFindings.filter((f) => !f.fixable)
      const unresolvedFixable = remainingFindings.filter((f) => f.fixable && !f.fix)

      yield* Console.log(`doctor: ${initialFindings.length} issues found, ${fixedCount} fixed`)
      yield* Console.log('')

      for (const desc of fixDescriptions) {
        yield* Console.log(`  + ${desc}`)
      }
      for (const f of unfixable) {
        yield* Console.log(`  ! ${f.aspect}: ${f.message}`)
      }
      for (const f of unresolvedFixable) {
        yield* Console.log(`  ! ${f.aspect}: ${f.message}`)
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
      yield* Console.log(`doctor: ${initialFindings.length} issues found (--no-fix: report only)`)
      yield* Console.log('')

      for (const f of initialFindings) {
        const fixLabel = f.fixable ? ' [fixable]' : ''
        yield* Console.log(`  ${f.aspect}: ${f.message}${fixLabel}`)
      }

      if (initialFixable.length > 0) {
        yield* Console.log('')
        yield* Console.log(
          `  Run \`shan skills doctor\` to auto-fix ${initialFixable.length} of ${initialFindings.length} issues`,
        )
      }
    }
  })
