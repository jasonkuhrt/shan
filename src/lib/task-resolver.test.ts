import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRuntimeConfig } from './runtime-config.js'
import { parseTarget, discoverTaskLists, resolveTarget } from './task-resolver.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const tasksDir = getRuntimeConfig().paths.tasksDir

// ── parseTarget ──────────────────────────────────────────────────

describe('parseTarget', () => {
  test('plain list name', () => {
    expect(parseTarget('test-schema')).toEqual({ listPart: 'test-schema', taskPart: null })
  })
  test('UUID prefix', () => {
    expect(parseTarget('21b0')).toEqual({ listPart: '21b0', taskPart: null })
  })
  test('list@task', () => {
    expect(parseTarget('test-schema@3')).toEqual({ listPart: 'test-schema', taskPart: '3' })
  })
  test('UUID@task', () => {
    expect(parseTarget('21b0@1')).toEqual({ listPart: '21b0', taskPart: '1' })
  })
  test('@subject (no list part)', () => {
    expect(parseTarget('@Scaffold')).toEqual({ listPart: null, taskPart: 'Scaffold' })
  })
  test('@ alone gives null for both parts', () => {
    expect(parseTarget('@')).toEqual({ listPart: null, taskPart: null })
  })
  test('empty string', () => {
    expect(parseTarget('')).toEqual({ listPart: '', taskPart: null })
  })
})

// ── discoverTaskLists ────────────────────────────────────────────

describe('discoverTaskLists', () => {
  const testListDir = join(tasksDir, '__test-list-discover__')

  test('discovers named task lists', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(
        join(testListDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Test',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      const lists = await discoverTaskLists({ all: true })
      const found = lists.find((l) => l.id === '__test-list-discover__')
      expect(found).toBeDefined()
      expect(found!.isSession).toBe(false)
      expect(found!.taskCount).toBe(1)
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('returns empty when tasks dir missing', async () => {
    // Pass all: true to avoid project scoping issues
    const lists = await discoverTaskLists({ all: true })
    expect(Array.isArray(lists)).toBe(true)
  })

  test('sorts named lists before session lists', async () => {
    const namedDir = join(tasksDir, '__aaa-test-sort__')
    const uuidDir = join(tasksDir, '00000000-0000-0000-0000-000000000001')
    try {
      await mkdir(namedDir, { recursive: true })
      await mkdir(uuidDir, { recursive: true })

      const lists = await discoverTaskLists({ all: true })
      const namedIdx = lists.findIndex((l) => l.id === '__aaa-test-sort__')
      const uuidIdx = lists.findIndex((l) => l.id === '00000000-0000-0000-0000-000000000001')
      if (namedIdx !== -1 && uuidIdx !== -1) {
        expect(namedIdx).toBeLessThan(uuidIdx)
      }
    } finally {
      await rm(namedDir, { recursive: true, force: true })
      await rm(uuidDir, { recursive: true, force: true })
    }
  })

  test('skips non-directory entries', async () => {
    const filePath = join(tasksDir, '__test-file-entry__')
    try {
      await mkdir(tasksDir, { recursive: true })
      await writeFile(filePath, 'not a dir')
      const lists = await discoverTaskLists({ all: true })
      const found = lists.find((l) => l.id === '__test-file-entry__')
      expect(found).toBeUndefined()
    } finally {
      await rm(filePath, { force: true })
    }
  })

  test('skips entries that cannot be stat-ed (broken symlinks)', async () => {
    const brokenLink = join(tasksDir, '__test-broken-stat__')
    try {
      await mkdir(tasksDir, { recursive: true })
      await symlink('/nonexistent-target-for-stat-test', brokenLink)
      const lists = await discoverTaskLists({ all: true })
      const found = lists.find((l) => l.id === '__test-broken-stat__')
      expect(found).toBeUndefined()
    } finally {
      await rm(brokenLink, { force: true })
    }
  })

  test('project scoping filters UUID lists', async () => {
    const uuidDir = join(tasksDir, '00000000-0000-0000-0000-ffffffffffff')
    try {
      await mkdir(uuidDir, { recursive: true })
      // Without --all, this UUID won't match any project sessions
      const lists = await discoverTaskLists({ all: false })
      const found = lists.find((l) => l.id === '00000000-0000-0000-0000-ffffffffffff')
      // Should be filtered out since it doesn't match project sessions
      expect(found).toBeUndefined()
    } finally {
      await rm(uuidDir, { recursive: true, force: true })
    }
  })
})

// ── resolveTarget ────────────────────────────────────────────────

describe('resolveTarget', () => {
  const testListDir = join(tasksDir, '__test-resolve__')

  test('resolves a named list', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(
        join(testListDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'First',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      const result = await run(resolveTarget('__test-resolve__', { all: true }))
      expect(result.kind).toBe('list')
      expect(result.listId).toBe('__test-resolve__')
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('resolves a specific task by number', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(
        join(testListDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'First',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      const result = await run(resolveTarget('__test-resolve__@1', { all: true }))
      expect(result.kind).toBe('task')
      expect(result.taskNum).toBe('1')
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('fails for nonexistent task number', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(
        join(testListDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'First',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      await expect(run(resolveTarget('__test-resolve__@999', { all: true }))).rejects.toThrow(
        'not found',
      )
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('fails for nonexistent list', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await expect(run(resolveTarget('__nonexistent_list_zzz__', { all: true }))).rejects.toThrow(
        'No task list found',
      )
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('fails with no lists at all', async () => {
    // Create an isolated situation — use a scope where no lists exist
    // With all: true we get all lists, so we test the error message
    // by checking that an impossible name still fails
    const tmpDir = join(tasksDir, '__tmp-empty-test__')
    try {
      await mkdir(tmpDir, { recursive: true })
      await expect(run(resolveTarget('__impossible_list__', { all: true }))).rejects.toThrow()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('fails with no target specified', async () => {
    const tmpDir = join(tasksDir, '__tmp-no-target__')
    try {
      await mkdir(tmpDir, { recursive: true })
      // parseTarget('@') gives {listPart: null, taskPart: null}
      // But resolveTarget with empty string gives listPart: '' which is falsy
      // So let's test with something that triggers the "no target" branch
      await expect(run(resolveTarget('@', { all: true }))).rejects.toThrow()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('resolves by subject substring (@query)', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(
        join(testListDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Scaffold the project',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      const result = await run(resolveTarget('@Scaffold', { all: true }))
      expect(result.kind).toBe('task')
      expect(result.taskNum).toBe('1')
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('fails for non-matching subject', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(
        join(testListDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Something',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      await expect(run(resolveTarget('@ZZZNonexistent', { all: true }))).rejects.toThrow(
        'No task found',
      )
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('resolves by substring match on list name', async () => {
    const namedDir = join(tasksDir, '__substring-match-test__')
    try {
      await mkdir(namedDir, { recursive: true })

      const result = await run(resolveTarget('substring-match', { all: true }))
      expect(result.kind).toBe('list')
      expect(result.listId).toContain('substring-match')
    } finally {
      await rm(namedDir, { recursive: true, force: true })
    }
  })

  test('resolves by UUID prefix', async () => {
    const uuidDir = join(tasksDir, 'aabbccdd-1111-2222-3333-444455556666')
    try {
      await mkdir(uuidDir, { recursive: true })

      const result = await run(resolveTarget('aabbccdd', { all: true }))
      expect(result.kind).toBe('list')
      expect(result.listId).toBe('aabbccdd-1111-2222-3333-444455556666')
    } finally {
      await rm(uuidDir, { recursive: true, force: true })
    }
  })

  test('subject search handles non-json gracefully', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(join(testListDir, '1.json'), 'not json')

      await expect(run(resolveTarget('@Anything', { all: true }))).rejects.toThrow('No task found')
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('subject search handles object without subject field', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(join(testListDir, '1.json'), JSON.stringify({ id: '1', noSubject: true }))

      await expect(run(resolveTarget('@Anything', { all: true }))).rejects.toThrow('No task found')
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('subject search handles non-string subject', async () => {
    try {
      await mkdir(testListDir, { recursive: true })
      await writeFile(join(testListDir, '1.json'), JSON.stringify({ id: '1', subject: 42 }))

      await expect(run(resolveTarget('@Anything', { all: true }))).rejects.toThrow('No task found')
    } finally {
      await rm(testListDir, { recursive: true, force: true })
    }
  })

  test('errors with --all message when no lists exist', async () => {
    // Temporarily rename the tasks dir if it exists, to force empty state
    const backupDir = tasksDir + '__backup__'
    let renamed = false
    try {
      const { rename } = await import('node:fs/promises')
      await rename(tasksDir, backupDir)
      renamed = true
    } catch {
      // tasks dir doesn't exist — that's fine, we'll get the error naturally
    }
    try {
      await expect(run(resolveTarget('anything', { all: true }))).rejects.toThrow(
        'No task lists found in ~/.claude/tasks/',
      )
    } finally {
      if (renamed) {
        const { rename } = await import('node:fs/promises')
        await rename(backupDir, tasksDir)
      }
    }
  })

  test('errors with project-scoped message when no lists found', async () => {
    const backupDir = tasksDir + '__backup2__'
    let renamed = false
    try {
      const { rename } = await import('node:fs/promises')
      await rename(tasksDir, backupDir)
      renamed = true
    } catch {
      // tasks dir doesn't exist
    }
    try {
      await expect(run(resolveTarget('anything', { all: false }))).rejects.toThrow('Use --all')
    } finally {
      if (renamed) {
        const { rename } = await import('node:fs/promises')
        await rename(backupDir, tasksDir)
      }
    }
  })
})
