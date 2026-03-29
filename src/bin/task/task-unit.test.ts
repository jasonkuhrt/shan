import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { getRuntimeConfig } from '../../lib/runtime-config.js'
import { taskDump } from './dump.js'
import { taskOpen } from './open.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-task-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

// Test list in ~/.claude/tasks/
const TASKS_DIR = getRuntimeConfig().paths.tasksDir
const TEST_LIST = '__shan-task-unit-test__'
const TEST_LIST_DIR = path.join(TASKS_DIR, TEST_LIST)

const makeTask = (id: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    subject: `Task ${id}`,
    description: `Description for task ${id}`,
    activeForm: '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  })

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  await rm(TEST_LIST_DIR, { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
  await rm(TEST_LIST_DIR, { recursive: true, force: true })
})

// ── taskDump ────────────────────────────────────────────────────

describe('taskDump', () => {
  test('dumps single task as JSON', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    await writeFile(path.join(TEST_LIST_DIR, '1.json'), makeTask('1'))

    await run(taskDump(`${TEST_LIST}@1`, { all: true }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'tasks', TEST_LIST)
    const files = await readdir(outputDir)
    expect(files).toContain('1.json')
  })

  test('dumps single task as markdown with all fields', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    await writeFile(
      path.join(TEST_LIST_DIR, '1.json'),
      makeTask('1', {
        subject: 'Markdown task',
        status: 'in_progress',
        activeForm: 'Working on it',
        blocks: ['2', '3'],
        blockedBy: ['0'],
        owner: 'test-agent',
      }),
    )

    await run(taskDump(`${TEST_LIST}@1`, { all: true, md: true }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'tasks', TEST_LIST)
    const files = await readdir(outputDir)
    expect(files).toContain('1.md')

    const content = await readFile(path.join(outputDir, '1.md'), 'utf-8')
    expect(content).toContain('# #1')
    expect(content).toContain('In Progress')
    expect(content).toContain('**Active Form:** Working on it')
    expect(content).toContain('**Blocks:** #2, #3')
    expect(content).toContain('**Blocked By:** #0')
    expect(content).toContain('**Owner:** test-agent')
  })

  test('dumps entire list as JSON', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    await writeFile(path.join(TEST_LIST_DIR, '1.json'), makeTask('1'))
    await writeFile(path.join(TEST_LIST_DIR, '2.json'), makeTask('2'))

    await run(taskDump(TEST_LIST, { all: true }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'tasks', TEST_LIST)
    const files = await readdir(outputDir)
    expect(files).toContain('1.json')
    expect(files).toContain('2.json')
  })

  test('exercises all status labels in markdown mode', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    const statuses = ['pending', 'in_progress', 'completed', 'deleted', 'custom_status']
    for (let i = 0; i < statuses.length; i++) {
      await writeFile(
        path.join(TEST_LIST_DIR, `${i + 1}.json`),
        makeTask(String(i + 1), { status: statuses[i] }),
      )
    }

    await run(taskDump(TEST_LIST, { all: true, md: true }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'tasks', TEST_LIST)
    const files = await readdir(outputDir)
    expect(files.filter((f) => f.endsWith('.md')).length).toBeGreaterThanOrEqual(4)
  })

  test('skips invalid task JSON in markdown mode', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    await writeFile(path.join(TEST_LIST_DIR, '99.json'), JSON.stringify({ invalid: true }))

    // Should not crash — copyTaskFile returns 0 for invalid tasks
    await run(taskDump(`${TEST_LIST}@99`, { all: true, md: true }))
  })

  test('handles empty list directory', async () => {
    const emptyList = '__shan-task-empty__'
    const emptyDir = path.join(TASKS_DIR, emptyList)
    await mkdir(emptyDir, { recursive: true })
    try {
      await run(taskDump(emptyList, { all: true }))
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })

  test('fails when target not found', async () => {
    await expect(run(taskDump('__nonexistent_xyz__', { all: true }))).rejects.toThrow()
  })
})

// ── taskOpen ────────────────────────────────────────────────────

describe('taskOpen', () => {
  test('opens a task list with EDITOR', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    await writeFile(path.join(TEST_LIST_DIR, '1.json'), makeTask('1'))

    const origEditor = process.env['EDITOR']
    process.env['EDITOR'] = 'true'
    try {
      await run(taskOpen(TEST_LIST, { all: true }))
    } finally {
      if (origEditor !== undefined) process.env['EDITOR'] = origEditor
      else delete process.env['EDITOR']
    }
  })

  test('opens a specific task file', async () => {
    await mkdir(TEST_LIST_DIR, { recursive: true })
    await writeFile(path.join(TEST_LIST_DIR, '1.json'), makeTask('1'))

    const origEditor = process.env['EDITOR']
    process.env['EDITOR'] = 'true'
    try {
      await run(taskOpen(`${TEST_LIST}@1`, { all: true }))
    } finally {
      if (origEditor !== undefined) process.env['EDITOR'] = origEditor
      else delete process.env['EDITOR']
    }
  })

  test('fails with nonexistent target', async () => {
    await expect(run(taskOpen('__nonexistent_xyz__', { all: true }))).rejects.toThrow()
  })
})
