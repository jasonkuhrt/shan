import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from './skill-library.js'
import * as SkillGraph from './skill-graph.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmpBase = path.join(import.meta.dir, '__test_skill_graph_tmp__')
const origCwd = process.cwd()

const writeProjectSkill = async (
  rootDir: string,
  relPath: string,
  options: {
    readonly dependencies?: readonly string[]
    readonly description?: string
    readonly name?: string
  } = {},
) => {
  const skillDir = path.join(rootDir, '.claude', 'skills-library', relPath)
  const name = options.name ?? relPath.replaceAll('/', ':')
  const dependencies = options.dependencies
    ? `dependencies:\n${options.dependencies.map((dependency) => `  - ${dependency}`).join('\n')}\n`
    : ''
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${options.description ?? `Test skill ${name}`}\n${dependencies}---\n\n# ${name}\n`,
  )
}

const makeActiveSkill = (
  scope: Lib.Scope,
  colonName: string,
  options: {
    readonly dependencies?: readonly string[]
    readonly description?: string
  } = {},
): SkillGraph.ActiveSkill => ({
  colonName,
  commitment: 'pluggable',
  flatName: Lib.flattenName(Lib.colonToPath(colonName)),
  frontmatter: {
    ...(options.dependencies ? { dependencies: [...options.dependencies] } : {}),
    description: options.description ?? `Test skill ${colonName}`,
    name: colonName,
  },
  frontmatterIssues: [],
  id: SkillGraph.skillId(scope, colonName),
  scope,
  sourceKind: 'library',
  sourcePath: `/virtual/${colonName}`,
})

beforeEach(async () => {
  await rm(tmpBase, { force: true, recursive: true })
  await mkdir(tmpBase, { recursive: true })
  process.chdir(tmpBase)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(tmpBase, { force: true, recursive: true })
})

describe('buildActiveSkillGraph', () => {
  test('detects active-graph drift when a declared dependency is not active', async () => {
    await writeProjectSkill(tmpBase, 'dep')

    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'owner', { dependencies: ['dep'] }),
      ]),
    )

    expect(
      graph.issues.some(
        (issue) => issue.code === 'active-graph-drift' && issue.dependency === 'dep',
      ),
    ).toBe(true)
  })

  test('rejects dependency targets that reach inside namespace roots', async () => {
    await writeProjectSkill(tmpBase, 'bundle/leaf-a', { name: 'bundle:leaf-a' })

    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'owner', { dependencies: ['bundle:leaf-a'] }),
      ]),
    )

    expect(
      graph.issues.some(
        (issue) => issue.code === 'illegal-reach-in' && issue.dependency === 'bundle:leaf-a',
      ),
    ).toBe(true)
  })

  test('dedupes shared dependencies in closure cost and tree rendering', async () => {
    await writeProjectSkill(tmpBase, 'shared')
    await writeProjectSkill(tmpBase, 'left', { dependencies: ['shared'] })
    await writeProjectSkill(tmpBase, 'right', { dependencies: ['shared'] })
    await writeProjectSkill(tmpBase, 'root', { dependencies: ['left', 'right'] })

    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'shared'),
        makeActiveSkill('project', 'left', { dependencies: ['shared'] }),
        makeActiveSkill('project', 'right', { dependencies: ['shared'] }),
        makeActiveSkill('project', 'root', { dependencies: ['left', 'right'] }),
      ]),
    )

    const sharedCost = Lib.estimateCharCost({
      description: 'Test skill shared',
      name: 'shared',
    })
    const leftCost = Lib.estimateCharCost({
      dependencies: ['shared'],
      description: 'Test skill left',
      name: 'left',
    })
    const rightCost = Lib.estimateCharCost({
      dependencies: ['shared'],
      description: 'Test skill right',
      name: 'right',
    })

    expect(
      SkillGraph.collectTransitiveDependencyIds(graph, SkillGraph.skillId('project', 'root')),
    ).toEqual([
      SkillGraph.skillId('project', 'left'),
      SkillGraph.skillId('project', 'right'),
      SkillGraph.skillId('project', 'shared'),
    ])
    expect(SkillGraph.dependencyClosureCost(graph, SkillGraph.skillId('project', 'root'))).toBe(
      leftCost + rightCost + sharedCost,
    )
    expect(SkillGraph.renderDependencyForest(graph).join('\n')).toContain(
      'shared [project] (shared)',
    )
  })

  test('records malformed dependency names', async () => {
    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'owner', { dependencies: ['not valid'] }),
      ]),
    )

    expect(
      graph.issues.some(
        (issue) => issue.code === 'malformed-dependency' && issue.dependency === 'not valid',
      ),
    ).toBe(true)
  })

  test('records self-dependencies', async () => {
    await writeProjectSkill(tmpBase, 'selfish')

    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'selfish', { dependencies: ['selfish'] }),
      ]),
    )

    expect(
      graph.issues.some(
        (issue) => issue.code === 'self-dependency' && issue.dependency === 'selfish',
      ),
    ).toBe(true)
  })

  test('records dependency cycles', async () => {
    await writeProjectSkill(tmpBase, 'left', { dependencies: ['right'] })
    await writeProjectSkill(tmpBase, 'right', { dependencies: ['left'] })

    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'left', { dependencies: ['right'] }),
        makeActiveSkill('project', 'right', { dependencies: ['left'] }),
      ]),
    )

    expect(graph.issues.some((issue) => issue.code === 'cycle')).toBe(true)
  })

  test('resolves active core namespace roots and rejects core reach-ins', async () => {
    const coreGroup = makeActiveSkill('project', 'core-group', { description: 'Core group' })
    const coreLeaf = makeActiveSkill('project', 'core-group:leaf', { description: 'Core leaf' })
    const coreOnlyGraph = await run(
      SkillGraph.resolveDependencyTarget('core-group', 'project', [
        { ...coreGroup, commitment: 'core', sourceKind: 'core' },
        { ...coreLeaf, commitment: 'core', sourceKind: 'core' },
      ]),
    )

    expect(coreOnlyGraph.issue).toBeNull()
    expect(coreOnlyGraph.resolution?.sourceKind).toBe('active-core')
    expect(coreOnlyGraph.resolution?.nodeType).toBe('callable-group')
    expect(coreOnlyGraph.resolution?.leaves.map((leaf) => leaf.colonName)).toEqual([
      'core-group',
      'core-group:leaf',
    ])

    const illegalReachIn = await run(
      SkillGraph.resolveDependencyTarget('core-group:leaf', 'project', [
        { ...coreGroup, commitment: 'core', sourceKind: 'core' },
        { ...coreLeaf, commitment: 'core', sourceKind: 'core' },
      ]),
    )

    expect(illegalReachIn.issue?.code).toBe('illegal-reach-in')
  })

  test('exposes dependency helpers and tree cycle rendering', async () => {
    await writeProjectSkill(tmpBase, 'left', { dependencies: ['right'] })
    await writeProjectSkill(tmpBase, 'right', { dependencies: ['left'] })

    const graph = await run(
      SkillGraph.buildActiveSkillGraph([
        makeActiveSkill('project', 'left', { dependencies: ['right'] }),
        makeActiveSkill('project', 'right', { dependencies: ['left'] }),
      ]),
    )

    expect(SkillGraph.dependencyNamesForSkill(makeActiveSkill('project', 'left'))).toEqual([])
    expect(
      SkillGraph.skillDependsOn(graph, SkillGraph.skillId('project', 'left')).map(
        (skill) => skill.colonName,
      ),
    ).toEqual(['right'])
    expect(
      SkillGraph.skillDependents(graph, SkillGraph.skillId('project', 'left')).map(
        (skill) => skill.colonName,
      ),
    ).toEqual(['right'])
    expect(SkillGraph.isSkillActive(graph, 'project', 'left')).toBe(true)
    expect(SkillGraph.isSkillActive(graph, 'user', 'left')).toBe(false)
    expect(SkillGraph.renderDependencyForest(graph).join('\n')).toContain('left [project] (cycle)')
  })

  test('loadActiveSkills resolves relative symlink targets and helper path checks', async () => {
    await writeProjectSkill(tmpBase, 'rel-target')

    const outfitDir = path.join(tmpBase, '.claude', 'skills')
    const projectLibrarySkill = path.join(tmpBase, '.claude', 'skills-library', 'rel-target')
    await mkdir(outfitDir, { recursive: true })
    await symlink('../skills-library/rel-target', path.join(outfitDir, 'rel-target'))

    const activeSkills = await run(SkillGraph.loadActiveSkills())

    expect(activeSkills.map((skill) => skill.colonName)).toEqual(['rel-target'])
    expect(activeSkills[0]?.sourcePath).toBe(projectLibrarySkill)
    await expect(run(SkillGraph.ensureSkillPathExists('project', 'rel-target'))).resolves.toBe(true)
    await expect(run(SkillGraph.ensureSkillPathExists('project', 'missing-target'))).resolves.toBe(
      false,
    )
  })
})
