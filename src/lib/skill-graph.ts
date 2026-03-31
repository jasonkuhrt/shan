import { Effect } from 'effect'
import { lstat, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from './skill-library.js'
import * as SkillName from './skill-name.js'

export type DependencyIssueCode =
  | 'active-graph-drift'
  | 'cycle'
  | 'illegal-reach-in'
  | 'malformed-dependency'
  | 'missing-dependency'
  | 'self-dependency'

export interface ActiveSkill {
  readonly colonName: string
  readonly commitment: Lib.Commitment
  readonly flatName: string
  readonly frontmatter: Lib.SkillFrontmatter | null
  readonly frontmatterIssues: readonly string[]
  readonly id: string
  readonly scope: Lib.Scope
  readonly sourceKind: 'core' | 'library'
  readonly sourcePath: string
}

export interface DependencyLeafRef {
  readonly colonName: string
  readonly id: string
  readonly scope: Lib.Scope
  readonly sourceKind: 'active-core' | 'library'
}

export interface DependencyTargetResolution {
  readonly dependency: string
  readonly leaves: readonly DependencyLeafRef[]
  readonly nodeType: Lib.NodeType
  readonly resolvedInScope: Lib.Scope
  readonly sourceKind: 'active-core' | 'library'
}

export interface DependencyIssue {
  readonly code: DependencyIssueCode
  readonly dependency?: string
  readonly message: string
  readonly skill: ActiveSkill
}

export interface ActiveSkillGraph {
  readonly dependencyLeafIdsBySkill: ReadonlyMap<string, readonly string[]>
  readonly dependentsBySkill: ReadonlyMap<string, readonly string[]>
  readonly issues: readonly DependencyIssue[]
  readonly skills: readonly ActiveSkill[]
  readonly skillsById: ReadonlyMap<string, ActiveSkill>
}

const scopeOrder = (scope: Lib.Scope): readonly Lib.Scope[] =>
  scope === 'user' ? ['user'] : ['project', 'user']

export const skillId = (scope: Lib.Scope, colonName: string): string => `${scope}:${colonName}`

export const formatSkillRef = (scope: Lib.Scope, colonName: string): string =>
  `${colonName} [${scope}]`

const coreTargetLeaves = (
  target: string,
  scope: Lib.Scope,
  coreSkills: readonly ActiveSkill[],
): { readonly leaves: readonly ActiveSkill[]; readonly nodeType: Lib.NodeType } | null => {
  const scopeCoreSkills = coreSkills.filter((skill) => skill.scope === scope)
  const self = scopeCoreSkills.find((skill) => skill.colonName === target)
  const descendants = scopeCoreSkills.filter((skill) => skill.colonName.startsWith(`${target}:`))
  if (!self && descendants.length === 0) return null
  if (self && descendants.length > 0) {
    return { leaves: [self, ...descendants], nodeType: 'callable-group' }
  }
  if (descendants.length > 0) {
    return { leaves: descendants, nodeType: 'group' }
  }
  return self ? { leaves: [self], nodeType: 'leaf' } : null
}

const resolveDependencyTargetInScope = (
  dependency: string,
  scope: Lib.Scope,
  coreSkills: readonly ActiveSkill[],
) =>
  Effect.gen(function* () {
    const libraryTarget = yield* Lib.resolveTarget(dependency, scope, true)
    if (libraryTarget) {
      return {
        dependency,
        leaves: libraryTarget.leaves.map((leaf) => ({
          colonName: leaf.colonName,
          id: skillId(leaf.libraryScope, leaf.colonName),
          scope: leaf.libraryScope,
          sourceKind: 'library' as const,
        })),
        nodeType: libraryTarget.nodeType,
        resolvedInScope: libraryTarget.libraryScope,
        sourceKind: 'library' as const,
      } satisfies DependencyTargetResolution
    }

    const coreTarget = coreTargetLeaves(dependency, scope, coreSkills)
    if (!coreTarget) return null

    return {
      dependency,
      leaves: coreTarget.leaves.map((leaf) => ({
        colonName: leaf.colonName,
        id: leaf.id,
        scope: leaf.scope,
        sourceKind: 'active-core' as const,
      })),
      nodeType: coreTarget.nodeType,
      resolvedInScope: scope,
      sourceKind: 'active-core' as const,
    } satisfies DependencyTargetResolution
  })

const hasIllegalReachIn = (
  dependency: string,
  scope: Lib.Scope,
  coreSkills: readonly ActiveSkill[],
) =>
  Effect.gen(function* () {
    const parsed = SkillName.parseFrontmatterName(dependency)
    if (!parsed) return false

    for (const prefix of SkillName.prefixes(parsed)) {
      const libraryPrefix = yield* Lib.resolveTarget(prefix, scope, true)
      if (libraryPrefix && libraryPrefix.nodeType !== 'leaf') return true

      const corePrefix = coreTargetLeaves(prefix, scope, coreSkills)
      if (corePrefix && corePrefix.nodeType !== 'leaf') return true
    }

    return false
  })

export const resolveDependencyTarget = (
  dependency: string,
  ownerScope: Lib.Scope,
  activeSkills: readonly ActiveSkill[],
) =>
  Effect.gen(function* () {
    const coreSkills = activeSkills.filter((skill) => skill.sourceKind === 'core')

    for (const scope of scopeOrder(ownerScope)) {
      const resolved = yield* resolveDependencyTargetInScope(dependency, scope, coreSkills)
      if (!resolved) continue

      const illegalReachIn = yield* hasIllegalReachIn(
        dependency,
        resolved.resolvedInScope,
        coreSkills,
      )
      if (illegalReachIn) {
        return {
          issue: {
            code: 'illegal-reach-in' as const,
            message: `dependency "${dependency}" reaches inside namespace ${formatSkillRef(
              resolved.resolvedInScope,
              dependency,
            )}`,
          },
          resolution: null,
        }
      }

      return { issue: null, resolution: resolved }
    }

    return {
      issue: {
        code: 'missing-dependency' as const,
        message: `dependency "${dependency}" not found`,
      },
      resolution: null,
    }
  })

const inferObservedColonName = (entry: Lib.OutfitEntry, sourcePath: string): string | null => {
  if (entry.commitment === 'pluggable') {
    const libraryRoots = [
      { dir: Lib.projectLibraryDir(), scope: 'project' as const },
      { dir: Lib.LIBRARY_DIR, scope: 'user' as const },
    ]

    for (const root of libraryRoots) {
      const relativePath = path.relative(root.dir, sourcePath)
      if (!relativePath || relativePath.startsWith('..')) continue
      const colonName = Lib.pathToColon(relativePath)
      return colonName || null
    }
  }

  const relPath = Lib.unflattenName(entry.name)
  if (!relPath) return null
  return Lib.pathToColon(relPath)
}

const resolveSourcePath = (entry: Lib.OutfitEntry) =>
  Effect.gen(function* () {
    const rawPath = entry.symlinkTarget ?? entry.dir
    const candidate = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(path.dirname(entry.dir), rawPath)
    return yield* Effect.tryPromise(() => realpath(candidate)).pipe(
      Effect.catchAll(() => Effect.succeed(candidate)),
    )
  })

const detectSourceKind = (entry: Lib.OutfitEntry): 'core' | 'library' =>
  entry.commitment === 'core' ? 'core' : 'library'

export const loadActiveSkills = () =>
  Effect.gen(function* () {
    const allSkills: ActiveSkill[] = []

    for (const scope of ['user', 'project'] as const) {
      const routers = new Set(yield* Lib.detectGeneratedRouters(scope))
      const outfit = yield* Lib.listOutfit(scope)

      for (const entry of outfit) {
        if (routers.has(entry.name)) continue

        const sourcePath = yield* resolveSourcePath(entry)
        const frontmatterResult = yield* Lib.readFrontmatterResult(sourcePath)
        const observedName =
          Lib.canonicalFrontmatterName(frontmatterResult.frontmatter) ??
          frontmatterResult.frontmatter?.name ??
          inferObservedColonName(entry, sourcePath)
        if (!observedName) continue

        allSkills.push({
          colonName: observedName,
          commitment: entry.commitment,
          flatName: entry.name,
          frontmatter: frontmatterResult.frontmatter,
          frontmatterIssues: frontmatterResult.issues,
          id: skillId(scope, observedName),
          scope,
          sourceKind: detectSourceKind(entry),
          sourcePath,
        })
      }
    }

    return allSkills.sort((left, right) =>
      left.scope === right.scope
        ? left.colonName.localeCompare(right.colonName)
        : left.scope.localeCompare(right.scope),
    )
  })

const sortIds = (ids: Iterable<string>, skillsById: ReadonlyMap<string, ActiveSkill>): string[] =>
  [...ids].sort((left, right) => {
    const leftSkill = skillsById.get(left)
    const rightSkill = skillsById.get(right)
    if (!leftSkill || !rightSkill) return left.localeCompare(right)
    if (leftSkill.scope !== rightSkill.scope) return leftSkill.scope.localeCompare(rightSkill.scope)
    return leftSkill.colonName.localeCompare(rightSkill.colonName)
  })

const detectCycles = (
  skills: readonly ActiveSkill[],
  skillsById: ReadonlyMap<string, ActiveSkill>,
  dependencyLeafIdsBySkill: ReadonlyMap<string, readonly string[]>,
): DependencyIssue[] => {
  const cycleIssues: DependencyIssue[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const recordedCycles = new Set<string>()

  const visit = (skill: ActiveSkill, trail: string[]) => {
    if (visited.has(skill.id)) return
    if (visiting.has(skill.id)) {
      const cycleStart = trail.indexOf(skill.id)
      const cyclePath =
        cycleStart === -1 ? [...trail, skill.id] : [...trail.slice(cycleStart), skill.id]
      const signature = cyclePath.join('->')
      if (recordedCycles.has(signature)) return
      recordedCycles.add(signature)
      cycleIssues.push({
        code: 'cycle',
        message: `cycle detected: ${cyclePath
          .map((id) => {
            const node = skillsById.get(id)
            return node ? formatSkillRef(node.scope, node.colonName) : id
          })
          .join(' -> ')}`,
        skill,
      })
      return
    }

    visiting.add(skill.id)
    const nextTrail = [...trail, skill.id]
    for (const dependencyId of dependencyLeafIdsBySkill.get(skill.id) ?? []) {
      const dependency = skillsById.get(dependencyId)
      if (!dependency) continue
      visit(dependency, nextTrail)
    }
    visiting.delete(skill.id)
    visited.add(skill.id)
  }

  for (const skill of skills) {
    visit(skill, [])
  }

  return cycleIssues
}

export const buildActiveSkillGraph = (skills: readonly ActiveSkill[]) =>
  Effect.gen(function* () {
    const skillsById = new Map(skills.map((skill) => [skill.id, skill]))
    const activeIds = new Set(skills.map((skill) => skill.id))
    const dependencyLeafIdsBySkill = new Map<string, string[]>()
    const dependentsBySkill = new Map<string, Set<string>>()
    const issues: DependencyIssue[] = []

    for (const skill of skills) {
      const dependencies = skill.frontmatter?.dependencies ?? []
      const leafIds = new Set<string>()

      for (const dependency of dependencies) {
        if (!SkillName.parseFrontmatterName(dependency)) {
          issues.push({
            code: 'malformed-dependency',
            dependency,
            message: `dependency "${dependency}" is not a valid skill name`,
            skill,
          })
          continue
        }

        const resolved = yield* resolveDependencyTarget(dependency, skill.scope, skills)
        if (resolved.issue) {
          issues.push({
            code: resolved.issue.code,
            dependency,
            message: resolved.issue.message,
            skill,
          })
          continue
        }

        const resolutionLeafIds = resolved.resolution.leaves.map((leaf) => leaf.id)
        if (resolutionLeafIds.includes(skill.id)) {
          issues.push({
            code: 'self-dependency',
            dependency,
            message: `dependency "${dependency}" resolves back to ${formatSkillRef(
              skill.scope,
              skill.colonName,
            )}`,
            skill,
          })
          continue
        }

        for (const dependencyId of resolutionLeafIds) {
          leafIds.add(dependencyId)
          if (!activeIds.has(dependencyId)) {
            const leaf = resolved.resolution.leaves.find(
              (candidate) => candidate.id === dependencyId,
            )
            if (!leaf) continue
            issues.push({
              code: 'active-graph-drift',
              dependency,
              message: `dependency "${dependency}" requires missing active skill ${formatSkillRef(
                leaf.scope,
                leaf.colonName,
              )}`,
              skill,
            })
            continue
          }

          let dependents = dependentsBySkill.get(dependencyId)
          if (!dependents) {
            dependents = new Set()
            dependentsBySkill.set(dependencyId, dependents)
          }
          dependents.add(skill.id)
        }
      }

      dependencyLeafIdsBySkill.set(skill.id, sortIds(leafIds, skillsById))
    }

    for (const cycleIssue of detectCycles(skills, skillsById, dependencyLeafIdsBySkill)) {
      issues.push(cycleIssue)
    }

    return {
      dependencyLeafIdsBySkill,
      dependentsBySkill: new Map(
        [...dependentsBySkill.entries()].map(([id, dependents]) => [
          id,
          sortIds(dependents, skillsById),
        ]),
      ),
      issues,
      skills,
      skillsById,
    } satisfies ActiveSkillGraph
  })

export const loadActiveSkillGraph = () =>
  Effect.gen(function* () {
    const skills = yield* loadActiveSkills()
    return yield* buildActiveSkillGraph(skills)
  })

export const collectTransitiveDependencyIds = (
  graph: ActiveSkillGraph,
  rootId: string,
): readonly string[] => {
  const seen = new Set<string>()

  const visit = (skillIdValue: string) => {
    for (const dependencyId of graph.dependencyLeafIdsBySkill.get(skillIdValue) ?? []) {
      if (dependencyId === rootId || seen.has(dependencyId)) continue
      seen.add(dependencyId)
      visit(dependencyId)
    }
  }

  visit(rootId)
  return sortIds(seen, graph.skillsById)
}

const renderTreeLine = (prefix: string, isLast: boolean, label: string): string =>
  `${prefix}${isLast ? '\\- ' : '|- '}${label}`

const renderTreeFrom = (
  graph: ActiveSkillGraph,
  skillIdValue: string,
  prefix: string,
  isLast: boolean,
  ancestorIds: Set<string>,
  renderedIds: Set<string>,
  lines: string[],
) => {
  const skill = graph.skillsById.get(skillIdValue)
  if (!skill) return
  const label = formatSkillRef(skill.scope, skill.colonName)
  lines.push(renderTreeLine(prefix, isLast, label))
  renderedIds.add(skill.id)

  const nextPrefix = `${prefix}${isLast ? '   ' : '|  '}`
  const dependencyIds = [...(graph.dependencyLeafIdsBySkill.get(skill.id) ?? [])]
  if (dependencyIds.length === 0) return

  ancestorIds.add(skill.id)

  for (const [index, dependencyId] of dependencyIds.entries()) {
    const dependency = graph.skillsById.get(dependencyId)
    if (!dependency) continue
    const dependencyLabel = formatSkillRef(dependency.scope, dependency.colonName)
    const dependencyIsLast = index === dependencyIds.length - 1

    if (ancestorIds.has(dependencyId)) {
      lines.push(renderTreeLine(nextPrefix, dependencyIsLast, `${dependencyLabel} (cycle)`))
      continue
    }

    if (renderedIds.has(dependencyId)) {
      lines.push(renderTreeLine(nextPrefix, dependencyIsLast, `${dependencyLabel} (shared)`))
      continue
    }

    renderTreeFrom(
      graph,
      dependencyId,
      nextPrefix,
      dependencyIsLast,
      new Set(ancestorIds),
      renderedIds,
      lines,
    )
  }
}

export const renderDependencyForest = (graph: ActiveSkillGraph): string[] => {
  const renderedIds = new Set<string>()
  const roots = graph.skills
    .filter((skill) => (graph.dependentsBySkill.get(skill.id) ?? []).length === 0)
    .map((skill) => skill.id)
  const startIds = roots.length > 0 ? roots : graph.skills.map((skill) => skill.id)
  const remainingIds = graph.skills.map((skill) => skill.id).filter((id) => !startIds.includes(id))
  const orderedIds = [...startIds, ...remainingIds]
  const lines: string[] = []

  for (const [index, skillIdValue] of orderedIds.entries()) {
    const skill = graph.skillsById.get(skillIdValue)
    if (!skill) continue
    const dependents = graph.dependentsBySkill.get(skill.id) ?? []
    const suffix = dependents.length === 0 ? ' (root)' : ''
    lines.push(`${formatSkillRef(skill.scope, skill.colonName)}${suffix}`)
    const dependencyIds = graph.dependencyLeafIdsBySkill.get(skill.id) ?? []
    for (const [dependencyIndex, dependencyId] of dependencyIds.entries()) {
      renderTreeFrom(
        graph,
        dependencyId,
        '',
        dependencyIndex === dependencyIds.length - 1,
        new Set([skill.id]),
        renderedIds,
        lines,
      )
    }
    if (index < orderedIds.length - 1) lines.push('')
  }

  return lines
}

export const activationScopeForLeaf = (leaf: DependencyLeafRef): Lib.Scope => leaf.scope

export const dependencyClosureCost = (graph: ActiveSkillGraph, skillIdValue: string): number =>
  collectTransitiveDependencyIds(graph, skillIdValue)
    .map((dependencyId) => graph.skillsById.get(dependencyId))
    .filter((skill): skill is ActiveSkill => skill !== undefined)
    .reduce((sum, skill) => {
      const frontmatter = skill.frontmatter
      if (!frontmatter || frontmatter.disableModelInvocation) return sum
      return sum + Lib.estimateCharCost(frontmatter)
    }, 0)

export const dependencyNamesForSkill = (
  skill: Pick<ActiveSkill, 'frontmatter'>,
): readonly string[] => skill.frontmatter?.dependencies ?? []

export const skillDependsOn = (
  graph: ActiveSkillGraph,
  skillIdValue: string,
): readonly ActiveSkill[] =>
  (graph.dependencyLeafIdsBySkill.get(skillIdValue) ?? [])
    .map((dependencyId) => graph.skillsById.get(dependencyId))
    .filter((skill): skill is ActiveSkill => skill !== undefined)

export const skillDependents = (
  graph: ActiveSkillGraph,
  skillIdValue: string,
): readonly ActiveSkill[] =>
  (graph.dependentsBySkill.get(skillIdValue) ?? [])
    .map((dependentId) => graph.skillsById.get(dependentId))
    .filter((skill): skill is ActiveSkill => skill !== undefined)

export const isSkillActive = (
  graph: ActiveSkillGraph,
  scope: Lib.Scope,
  colonName: string,
): boolean => graph.skillsById.has(skillId(scope, colonName))

export const ensureSkillPathExists = (scope: Lib.Scope, colonName: string) =>
  Effect.gen(function* () {
    const targetPaths = Lib.resolveCanonicalTargetPaths(colonName)
    if (!targetPaths) return false
    const skillPath = path.join(Lib.outfitDir(scope), targetPaths.flatName)
    return yield* Effect.tryPromise(async () => {
      const stat = await lstat(skillPath)
      return stat.isDirectory() || stat.isSymbolicLink()
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))
  })
