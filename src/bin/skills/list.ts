/**
 * shan skills list — Show effective outfit across all layers.
 *
 * Displays core skills, pluggable on/off, budget info.
 * This is the default command when `shan skills` is called with no subcommand.
 */

import { Console, Effect } from 'effect'
import * as Lib from '../../lib/skill-library.js'
import * as SkillName from '../../lib/skill-name.js'

const DEFAULT_CHAR_BUDGET = 16_000

/**
 * Claude Code's skill character budget.
 * Override: SLASH_COMMAND_TOOL_CHAR_BUDGET (in characters).
 * Default: 2% of context window, fallback 16,000 chars.
 */
const getCharBudget = (): number => {
  const envVal = process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET']
  if (envVal) {
    const parsed = Number(envVal)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_CHAR_BUDGET
}

interface GridItem {
  readonly name: string
  readonly detail?: string
}

export const skillsList = () =>
  Effect.gen(function* () {
    const config = yield* Lib.loadConfig()
    const configuredAgents = yield* Lib.resolveConfiguredAgents(config)
    const mirrorAgents = Lib.getMirrorAgents(configuredAgents)
    const userOutfit = yield* Lib.listOutfit('user')
    const projectOutfit = yield* Lib.listOutfit('project')
    const library = yield* Lib.listLibrary()

    // Classify outfit entries
    const userCore = userOutfit.filter((e) => e.commitment === 'core')
    const userPluggable = userOutfit.filter((e) => e.commitment === 'pluggable')
    const projectCore = projectOutfit.filter((e) => e.commitment === 'core')
    const projectPluggable = projectOutfit.filter((e) => e.commitment === 'pluggable')

    const allOnNames = new Set([
      ...userPluggable.map((e) => e.name),
      ...projectPluggable.map((e) => e.name),
    ])
    const libraryOff = library.filter((s) => {
      const flatName = Lib.flattenName(s.libraryRelPath)
      return !allOnNames.has(flatName)
    })

    const readDisplayName = (skillDir: string, fallbackName: string) =>
      Effect.gen(function* () {
        const fm = yield* Lib.readFrontmatter(skillDir)
        return fm?.name ?? fallbackName
      })

    // Resolve outfit entries to display items, preferring frontmatter names everywhere.
    const toGridItems = (
      entries: ReadonlyArray<(typeof userOutfit)[number]>,
      options?: { readonly includeDetail?: boolean },
    ) =>
      Effect.gen(function* () {
        const items: GridItem[] = []
        for (const entry of entries) {
          const targetDir = entry.symlinkTarget ?? entry.dir
          const name = yield* readDisplayName(targetDir, entry.name)
          const fm = yield* Lib.readFrontmatter(targetDir)
          const chars =
            options?.includeDetail && fm && !fm.disableModelInvocation
              ? Lib.estimateCharCost(fm)
              : 0
          items.push({
            name,
            ...(options?.includeDetail ? { detail: chars > 0 ? String(chars) : '--' } : {}),
          })
        }
        return items
      })

    // Core (user)
    if (userCore.length > 0) {
      yield* Console.log('Core (user):')
      yield* printGrid(yield* toGridItems(userCore))
      yield* Console.log('')
    }

    // Core (project)
    if (projectCore.length > 0) {
      yield* Console.log('Core (project):')
      yield* printGrid(yield* toGridItems(projectCore))
      yield* Console.log('')
    }

    // On (user)
    if (userPluggable.length > 0) {
      yield* Console.log('On (user):')
      yield* printGrid(yield* toGridItems(userPluggable, { includeDetail: true }))
      yield* Console.log('')
    }

    // On (project)
    if (projectPluggable.length > 0) {
      yield* Console.log('On (project):')
      yield* printGrid(yield* toGridItems(projectPluggable, { includeDetail: true }))
      yield* Console.log('')
    }

    // Off
    if (libraryOff.length > 0) {
      yield* Console.log('Off:')
      yield* printGrouped(libraryOff.map((s) => s.colonName))
      yield* Console.log('')
    }

    // Budget summary
    let totalChars = 0
    for (const entry of [...userOutfit, ...projectOutfit]) {
      const targetDir = entry.symlinkTarget ?? entry.dir
      const fm = yield* Lib.readFrontmatter(targetDir)
      if (fm && !fm.disableModelInvocation) {
        totalChars += Lib.estimateCharCost(fm)
      }
    }
    const charBudget = getCharBudget()
    const pct = Math.round((totalChars / charBudget) * 100)
    const isCustom = Boolean(process.env['SLASH_COMMAND_TOOL_CHAR_BUDGET'])
    yield* Console.log(
      `Budget: ${totalChars.toLocaleString()} / ${charBudget.toLocaleString()} chars (${pct}%)`,
    )
    yield* Console.log(
      isCustom
        ? `  via SLASH_COMMAND_TOOL_CHAR_BUDGET`
        : `  default ${DEFAULT_CHAR_BUDGET.toLocaleString()} · override with SLASH_COMMAND_TOOL_CHAR_BUDGET`,
    )

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
  })

/** Print names grouped by namespace prefix, standalone items listed individually. */
const printGrouped = (colonNames: readonly string[]) =>
  Effect.gen(function* () {
    if (colonNames.length === 0) return

    const groups = new Map<string, string[]>()
    const standalone: string[] = []
    for (const name of colonNames) {
      const parsed = SkillName.parseFrontmatterName(name)
      if (!parsed || !SkillName.isNamespaced(parsed)) {
        standalone.push(name)
      } else {
        const ns = SkillName.topLevelName(parsed)
        const child = SkillName.nestedName(parsed) ?? name
        let children = groups.get(ns)
        if (!children) {
          children = []
          groups.set(ns, children)
        }
        children.push(child)
      }
    }

    // Print namespaced groups: "  ns: a, b, c"
    for (const [ns, children] of groups) {
      yield* Console.log(`  ${ns}: ${children.join(', ')}`)
    }

    // Print standalone items
    for (const name of standalone) {
      yield* Console.log(`  ${name}`)
    }
  })

/** Auto-sizing grid that fits columns to terminal width. */
const printGrid = (items: readonly GridItem[], bullet = '●') =>
  Effect.gen(function* () {
    if (items.length === 0) return
    const termWidth = process.stdout.columns || 80

    const maxName = Math.max(...items.map((it) => it.name.length))
    const hasDetail = items.some((it) => it.detail !== undefined)
    const maxDetail = hasDetail ? Math.max(...items.map((it) => (it.detail ?? '').length)) : 0

    // "  ● " = 4 chars prefix, then padded name, then "  " + right-aligned detail
    const cellW = 4 + maxName + (hasDetail ? 2 + maxDetail : 0)
    const gap = 2
    const cols = Math.max(1, Math.floor((termWidth + gap) / (cellW + gap)))

    for (let i = 0; i < items.length; i += cols) {
      const row = items.slice(i, i + cols)
      const line = row
        .map((it, j) => {
          let cell = `  ${bullet} ${it.name.padEnd(maxName)}`
          if (hasDetail) cell += `  ${(it.detail ?? '').padStart(maxDetail)}`
          return j < row.length - 1 ? cell.padEnd(cellW + gap) : cell
        })
        .join('')
      yield* Console.log(line)
    }
  })
