import { Console, Effect } from 'effect'
import type {
  DoctorContext as SkillsDoctorContext,
  DoctorFinding as SkillsDoctorFinding,
} from '../lib/doctor-aspects.js'
import { ALL_ASPECTS } from '../lib/doctor-aspects.js'
import * as Lib from '../lib/skill-library.js'
import { buildLintContext } from './lint/context.js'
import { renderFinding as renderLintFinding, type Finding as LintFinding } from './lint/finding.js'
import { lintHooks } from './lint/hooks.js'
import { autoFixDoctorFindings, collectDoctorFindings } from './skills/doctor.js'

export interface DoctorOptions {
  readonly noFix: boolean
  readonly scope?: Lib.Scope
  readonly selector?: string
}

interface RenderableFinding {
  readonly severity: 'error' | 'warning' | 'info'
  readonly fixable: boolean
  readonly render: () => Effect.Effect<void>
}

const CONFIG_RULES = ['config/no-relative-hook-path'] as const
const DOCTOR_NAMESPACES = ['config', 'skills'] as const
const SKILLS_RULES = ALL_ASPECTS.map((aspect) => `skills/${aspect.name}` as const)
const DOCTOR_RULES = [...CONFIG_RULES, ...SKILLS_RULES]

const normalizeSelector = (selector: string | undefined): string =>
  selector?.trim().replace(/\/+$/, '') ?? ''

const matchesSelector = (selector: string, ruleId: string): boolean =>
  selector === '' || selector === ruleId || ruleId.startsWith(`${selector}/`)

const selectorTargetsNamespace = (
  selector: string,
  namespace: (typeof DOCTOR_NAMESPACES)[number],
): boolean => selector === '' || selector === namespace || selector.startsWith(`${namespace}/`)

const isKnownSelector = (selector: string): boolean =>
  selector === '' ||
  DOCTOR_NAMESPACES.some((namespace) => namespace === selector) ||
  DOCTOR_RULES.some((ruleId) => ruleId === selector)

const severityIcon = (severity: RenderableFinding['severity']): string => {
  if (severity === 'error') return '✗'
  if (severity === 'warning') return '!'
  return 'i'
}

const renderSkillsFinding = (finding: SkillsDoctorFinding) =>
  Effect.gen(function* () {
    const fixable = finding.fixable ? ' [fixable]' : ''
    yield* Console.log(`  ${severityIcon(finding.level)} skills/${finding.aspect}${fixable}`)
    yield* Console.log(`    ${finding.message}`)
    yield* Console.log('')
  })

const recordDoctorHistory = (
  scope: Lib.Scope,
  ctx: SkillsDoctorContext,
  fixDescriptions: string[],
) =>
  Effect.gen(function* () {
    if (fixDescriptions.length === 0) return

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
  })

const renderNotes = (notes: string[]) =>
  Effect.gen(function* () {
    for (const note of notes) {
      yield* Console.log(`  - ${note}`)
    }
    if (notes.length > 0) {
      yield* Console.log('')
    }
  })

const renderFindings = (findings: RenderableFinding[]) =>
  Effect.gen(function* () {
    for (const finding of findings) {
      yield* finding.render()
    }
  })

const countErrors = (findings: RenderableFinding[]): number =>
  findings.filter((finding) => finding.severity === 'error').length

const collectConfigFindings = (selector: string, disabledRules: Set<string>) =>
  Effect.sync(() => {
    if (!selectorTargetsNamespace(selector, 'config')) {
      return {
        findings: [] as RenderableFinding[],
        note: null as string | null,
      }
    }

    if (disabledRules.has('config/no-relative-hook-path')) {
      return {
        findings: [] as RenderableFinding[],
        note: null as string | null,
      }
    }

    const ctx = buildLintContext()
    if (ctx.settingsFiles.length === 0) {
      return {
        findings: [] as RenderableFinding[],
        note: 'skipped config/*: no Claude settings files found',
      }
    }

    const findings = lintHooks(ctx).map((finding) => {
      const prefixedFinding: LintFinding = {
        ...finding,
        rule: `config/${finding.rule}`,
      }
      return {
        severity: finding.severity,
        fixable: false,
        render: () => renderLintFinding(prefixedFinding),
      } satisfies RenderableFinding
    })

    return {
      findings,
      note: null as string | null,
    }
  })

const collectSelectedSkillsFindings = (scope: Lib.Scope, selector: string) =>
  Effect.gen(function* () {
    if (!selectorTargetsNamespace(selector, 'skills')) {
      return {
        result: null as { ctx: SkillsDoctorContext; findings: SkillsDoctorFinding[] } | null,
        note: null as string | null,
      }
    }

    const result = yield* collectDoctorFindings(scope)
    if (!result) {
      return {
        result: null as { ctx: SkillsDoctorContext; findings: SkillsDoctorFinding[] } | null,
        note: `skipped skills/*: no skills library found at ${Lib.LIBRARY_DIR}`,
      }
    }

    return {
      result: {
        ctx: result.ctx,
        findings: result.findings.filter((finding) =>
          matchesSelector(selector, `skills/${finding.aspect}`),
        ),
      },
      note: null as string | null,
    }
  })

export const doctor = (options: DoctorOptions = { noFix: false }) =>
  Effect.gen(function* () {
    const selector = normalizeSelector(options.selector)
    if (!isKnownSelector(selector)) {
      yield* Console.error(`Unknown doctor selector: ${selector}`)
      yield* Console.log(
        '\nUsage: shan doctor [skills|skills/<rule>|config|config/<rule>] [--scope user] [--no-fix]',
      )
      return yield* Effect.fail(new Error('Unknown command'))
    }

    const scope = options.scope ?? 'project'
    const config = yield* Lib.loadConfig()
    const disabledRules = new Set(config.doctor?.disabled ?? [])

    const notes: string[] = []

    const configResult = yield* collectConfigFindings(selector, disabledRules)
    if (configResult.note) notes.push(configResult.note)

    const skillsResult = yield* collectSelectedSkillsFindings(scope, selector)
    if (skillsResult.note) notes.push(skillsResult.note)

    const initialSkillsFindings = skillsResult.result?.findings ?? []
    const initialRenderableFindings = [
      ...configResult.findings,
      ...initialSkillsFindings.map((finding) => ({
        severity: finding.level,
        fixable: finding.fixable,
        render: () => renderSkillsFinding(finding),
      })),
    ] satisfies RenderableFinding[]
    const initialFindableCount = initialRenderableFindings.length

    if (initialFindableCount === 0) {
      if (notes.length > 0) {
        yield* renderNotes(notes)
      }
      yield* Console.log('doctor: 0 issues — all clear')
      return
    }

    if (options.noFix) {
      yield* Console.log(`doctor: ${initialFindableCount} issues found (--no-fix: report only)`)
      yield* Console.log('')
      if (notes.length > 0) {
        yield* renderNotes(notes)
      }
      yield* renderFindings(initialRenderableFindings)

      const fixableCount = initialRenderableFindings.filter((finding) => finding.fixable).length
      if (fixableCount > 0) {
        yield* Console.log(
          `  Run \`shan doctor${selector ? ` ${selector}` : ''}\` to auto-fix ${fixableCount} of ${initialFindableCount} issues`,
        )
      }

      if (countErrors(initialRenderableFindings) > 0) {
        return yield* Effect.fail(new Error('Doctor errors found'))
      }
      return
    }

    let skillsAutoFixOutcome: {
      readonly fixedCount: number
      readonly fixDescriptions: string[]
      readonly remainingFindings: SkillsDoctorFinding[]
    } = {
      fixedCount: 0,
      fixDescriptions: [],
      remainingFindings: initialSkillsFindings,
    }

    if (skillsResult.result && initialSkillsFindings.some((finding) => finding.fixable)) {
      skillsAutoFixOutcome = yield* autoFixDoctorFindings(scope, () =>
        Effect.gen(function* () {
          const next = yield* collectDoctorFindings(scope)
          if (!next) return null
          return {
            ctx: next.ctx,
            findings: next.findings.filter((finding) =>
              matchesSelector(selector, `skills/${finding.aspect}`),
            ),
          }
        }),
      )
    }

    if (skillsAutoFixOutcome.fixedCount > 0 && skillsResult.result) {
      yield* recordDoctorHistory(
        scope,
        skillsResult.result.ctx,
        skillsAutoFixOutcome.fixDescriptions,
      )
    }

    const remainingRenderableFindings = [
      ...configResult.findings,
      ...skillsAutoFixOutcome.remainingFindings.map((finding) => ({
        severity: finding.level,
        fixable: finding.fixable,
        render: () => renderSkillsFinding(finding),
      })),
    ] satisfies RenderableFinding[]

    yield* Console.log(
      `doctor: ${initialFindableCount} issues found, ${skillsAutoFixOutcome.fixedCount} fixed`,
    )
    yield* Console.log('')

    if (notes.length > 0) {
      yield* renderNotes(notes)
    }

    for (const description of skillsAutoFixOutcome.fixDescriptions) {
      yield* Console.log(`  + ${description}`)
    }
    if (skillsAutoFixOutcome.fixDescriptions.length > 0 && remainingRenderableFindings.length > 0) {
      yield* Console.log('')
    }

    yield* renderFindings(remainingRenderableFindings)

    if (countErrors(remainingRenderableFindings) > 0) {
      return yield* Effect.fail(new Error('Doctor errors found'))
    }
  })
