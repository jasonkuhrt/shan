import { Console, Effect } from 'effect'
import * as Lib from '../../lib/skill-library.js'
import * as SkillGraph from '../../lib/skill-graph.js'

const DEFAULT_CHAR_BUDGET = 45_000

const getCharBudget = () => {
  const raw = process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAR_BUDGET
}

const printSkillSection = (
  title: string,
  skills: readonly SkillGraph.ActiveSkill[],
  graph: SkillGraph.ActiveSkillGraph,
) =>
  Effect.gen(function* () {
    if (skills.length === 0) return
    yield* Console.log(`${title}:`)
    for (const skill of skills) {
      const ownCost =
        skill.frontmatter && !skill.frontmatter.disableModelInvocation
          ? Lib.estimateCharCost(skill.frontmatter)
          : 0
      const closureCost = SkillGraph.dependencyClosureCost(graph, skill.id)
      yield* Console.log(
        `  ${SkillGraph.formatSkillRef(skill.scope, skill.colonName)}  own=${ownCost}  deps=${closureCost}`,
      )
    }
    yield* Console.log('')
  })

export const skillsList = () =>
  Effect.gen(function* () {
    const config = yield* Lib.loadConfig()
    const configuredAgents = yield* Lib.resolveConfiguredAgents(config)
    const mirrorAgents = Lib.getMirrorAgents(configuredAgents)
    const library = yield* Lib.listLibrary()
    const graph = yield* SkillGraph.loadActiveSkillGraph()

    const userCore = graph.skills.filter(
      (skill) => skill.scope === 'user' && skill.commitment === 'core',
    )
    const userPluggable = graph.skills.filter(
      (skill) => skill.scope === 'user' && skill.commitment === 'pluggable',
    )
    const projectCore = graph.skills.filter(
      (skill) => skill.scope === 'project' && skill.commitment === 'core',
    )
    const projectPluggable = graph.skills.filter(
      (skill) => skill.scope === 'project' && skill.commitment === 'pluggable',
    )

    yield* printSkillSection('Core (user)', userCore, graph)
    yield* printSkillSection('Core (project)', projectCore, graph)
    yield* printSkillSection('On (user)', userPluggable, graph)
    yield* printSkillSection('On (project)', projectPluggable, graph)

    const activeIds = new Set(
      graph.skills.map((skill) => SkillGraph.skillId(skill.scope, skill.colonName)),
    )
    const offSkills = library
      .filter((skill) => {
        const canonicalName = Lib.canonicalFrontmatterName(skill.frontmatter)
        if (!canonicalName || canonicalName !== skill.colonName) return false
        return !activeIds.has(SkillGraph.skillId(skill.libraryScope, canonicalName))
      })
      .map((skill) => SkillGraph.formatSkillRef(skill.libraryScope, skill.colonName))
      .sort()

    if (offSkills.length > 0) {
      yield* Console.log('Off:')
      for (const skill of offSkills) {
        yield* Console.log(`  ${skill}`)
      }
      yield* Console.log('')
    }

    const totalChars = graph.skills.reduce((sum, skill) => {
      if (skill.frontmatter?.disableModelInvocation || !skill.frontmatter) return sum
      return sum + Lib.estimateCharCost(skill.frontmatter)
    }, 0)
    const charBudget = getCharBudget()
    const pct = Math.round((totalChars / charBudget) * 100)
    const isCustom = Boolean(process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET'])

    yield* Console.log(
      `Budget: ${totalChars.toLocaleString()} / ${charBudget.toLocaleString()} chars (${pct}%)`,
    )
    yield* Console.log(
      isCustom
        ? '  via SLASH_COMMAND_TOOL_CHAR_BUDGET'
        : `  default ${DEFAULT_CHAR_BUDGET.toLocaleString()} · override with SLASH_COMMAND_TOOL_CHAR_BUDGET`,
    )

    if (graph.skills.length > 0) {
      yield* Console.log('')
      yield* Console.log('Dependency graph:')
      for (const line of SkillGraph.renderDependencyForest(graph)) {
        yield* Console.log(`  ${line}`)
      }
    }

    if (graph.issues.length > 0) {
      yield* Console.log('')
      yield* Console.log('Graph issues:')
      for (const issue of graph.issues) {
        yield* Console.log(
          `  ${SkillGraph.formatSkillRef(issue.skill.scope, issue.skill.colonName)} -> ${issue.message}`,
        )
      }
    }

    if (mirrorAgents.length > 0) {
      yield* Console.log('')
      yield* Console.log('Agent mirrors:')
      for (const mirrorAgent of mirrorAgents) {
        yield* Console.log(`  ${mirrorAgent} (user)    ${Lib.agentOutfitDir('user', mirrorAgent)}`)
        yield* Console.log(
          `  ${mirrorAgent} (project) ${Lib.agentOutfitDir('project', mirrorAgent)}`,
        )
      }
    }

    if (graph.diagnostics.length > 0) {
      yield* Console.log('')
      yield* Console.log('Warnings:')
      for (const diagnostic of graph.diagnostics) {
        const fixLabel = diagnostic.fixable ? ' [fixable]' : ''
        yield* Console.log(`  ! ${diagnostic.message}${fixLabel}`)
      }

      const fixableCount = graph.diagnostics.filter((d) => d.fixable).length
      if (fixableCount > 0) {
        yield* Console.log('')
        yield* Console.log(
          `  Run \`shan doctor\` to auto-fix ${fixableCount} issue${fixableCount === 1 ? '' : 's'}.`,
        )
      }
    }
  })
