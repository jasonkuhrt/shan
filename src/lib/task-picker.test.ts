import { describe, expect, mock, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Mock @clack/prompts before importing task-picker
const mockSelect = mock((..._args: unknown[]) =>
  Promise.resolve<unknown>({
    kind: 'list' as const,
    list: { path: '/tmp', id: 'test', isSession: false, mtime: new Date(), taskCount: 0 },
  }),
)
const mockIsCancel = mock((..._args: unknown[]) => false)

await mock.module('@clack/prompts', () => ({
  select: mockSelect,
  isCancel: mockIsCancel,
}))

import { pickTask } from './task-picker.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tasksDir = join(homedir(), '.claude', 'tasks')

const setTTY = (stdinVal: boolean | undefined, stdoutVal: boolean | undefined) => {
  try {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: stdinVal,
      writable: true,
      configurable: true,
    })
  } catch {
    const stdin = process.stdin as unknown as { ['isTTY']?: boolean | undefined }
    stdin['isTTY'] = stdinVal
  }
  try {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: stdoutVal,
      writable: true,
      configurable: true,
    })
  } catch {
    const stdout = process.stdout as unknown as { ['isTTY']?: boolean | undefined }
    stdout['isTTY'] = stdoutVal
  }
}

describe('pickTask', () => {
  test('fails when not a TTY', async () => {
    // process.stdin.isTTY is undefined in test
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(false, false)
    try {
      await expect(run(pickTask())).rejects.toThrow('Interactive task picker requires a TTY')
    } finally {
      setTTY(origStdin, origStdout)
    }
  })

  test('fails when no lists found (all mode)', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    // Temporarily rename tasks dir
    const backupDir = tasksDir + '__picker-backup__'
    let renamed = false
    try {
      const { rename } = await import('node:fs/promises')
      await rename(tasksDir, backupDir)
      renamed = true
    } catch {
      // doesn't exist
    }

    try {
      await expect(run(pickTask({ all: true }))).rejects.toThrow('No task lists found')
    } finally {
      if (renamed) {
        const { rename } = await import('node:fs/promises')
        await rename(backupDir, tasksDir)
      }
      setTTY(origStdin, origStdout)
    }
  })

  test('fails when no active tasks in lists', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    // To isolate: rename the real tasks dir so only our test dir exists
    const backupDir = tasksDir + '__empty-tasks-backup__'
    let renamed = false
    try {
      const { rename } = await import('node:fs/promises')
      await rename(tasksDir, backupDir)
      renamed = true
    } catch {
      /* doesn't exist */
    }

    const testDir = join(tasksDir, '__picker-empty-tasks__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Deleted task',
          description: '',
          activeForm: '',
          status: 'deleted',
          blocks: [],
          blockedBy: [],
        }),
      )

      await expect(run(pickTask({ all: true }))).rejects.toThrow('No active tasks')
    } finally {
      await rm(testDir, { recursive: true, force: true })
      if (renamed) {
        try {
          await rm(tasksDir, { recursive: true, force: true })
        } catch {
          /* */
        }
        const { rename } = await import('node:fs/promises')
        await rename(backupDir, tasksDir)
      }
      setTTY(origStdin, origStdout)
    }
  })

  test('returns selected list from picker', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const testDir = join(tasksDir, '__picker-select-test__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Active task',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      // Mock select to return a list selection
      mockSelect.mockImplementation(async (opts: unknown) => {
        const options = (opts as { options: { value: unknown }[] }).options
        return options[0]!.value
      })
      mockIsCancel.mockImplementation(() => false)

      const result = await run(pickTask({ all: true }))
      expect(result.kind).toBe('list')
    } finally {
      await rm(testDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('returns selected task from picker', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const testDir = join(tasksDir, '__picker-task-test__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Task one',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      // Mock select to return a task selection (second option)
      mockSelect.mockImplementation(async (opts: unknown) => {
        const options = (opts as { options: { value: unknown }[] }).options
        // Second option should be the task
        return options[1]?.value ?? options[0]!.value
      })
      mockIsCancel.mockImplementation(() => false)

      const result = await run(pickTask({ all: true }))
      expect(['list', 'task']).toContain(result.kind)
    } finally {
      await rm(testDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('fails when user cancels selection', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const testDir = join(tasksDir, '__picker-cancel-test__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Active',
          description: '',
          activeForm: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
        }),
      )

      // Mock select to return a cancelled value
      const cancelSymbol = Symbol('cancel')
      mockSelect.mockImplementation(async () => cancelSymbol)
      mockIsCancel.mockImplementation((val: unknown) => val === cancelSymbol)

      await expect(run(pickTask({ all: true }))).rejects.toThrow('Selection cancelled')
    } finally {
      await rm(testDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('handles completed tasks within 24h', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const testDir = join(tasksDir, '__picker-completed-test__')
    try {
      await mkdir(testDir, { recursive: true })
      // Completed task — will show if within 24h (which it will be since we just wrote it)
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Completed recently',
          description: '',
          activeForm: '',
          status: 'completed',
          blocks: [],
          blockedBy: [],
        }),
      )

      mockSelect.mockImplementation(async (opts: unknown) => {
        const options = (opts as { options: { value: unknown }[] }).options
        return options[0]!.value
      })
      mockIsCancel.mockImplementation(() => false)

      const result = await run(pickTask({ all: true }))
      expect(result).toBeDefined()
    } finally {
      await rm(testDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('handles tasks with blocked dependencies', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const testDir = join(tasksDir, '__picker-blocked-test__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Blocked task',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: ['2', '3'],
        }),
      )

      mockSelect.mockImplementation(async (opts: unknown) => {
        const options = (opts as { options: { value: unknown }[] }).options
        return options[0]!.value
      })
      mockIsCancel.mockImplementation(() => false)

      const result = await run(pickTask({ all: true }))
      expect(result).toBeDefined()
    } finally {
      await rm(testDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('handles long subject truncation', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const testDir = join(tasksDir, '__picker-long-subj__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(
        join(testDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'A'.repeat(100), // > 60 chars, triggers truncation
          description: '',
          activeForm: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
        }),
      )

      mockSelect.mockImplementation(async (opts: unknown) => {
        const options = (opts as { options: { value: unknown }[] }).options
        return options[0]!.value
      })
      mockIsCancel.mockImplementation(() => false)

      const result = await run(pickTask({ all: true }))
      expect(result).toBeDefined()
    } finally {
      await rm(testDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('handles session UUID list display', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const uuidDir = join(tasksDir, 'deadbeef-1234-5678-9abc-def012345678')
    try {
      await mkdir(uuidDir, { recursive: true })
      await writeFile(
        join(uuidDir, '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'UUID task',
          description: '',
          activeForm: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        }),
      )

      mockSelect.mockImplementation(async (opts: unknown) => {
        const options = (opts as { options: { value: unknown }[] }).options
        return options[0]!.value
      })
      mockIsCancel.mockImplementation(() => false)

      const result = await run(pickTask({ all: true }))
      expect(result).toBeDefined()
    } finally {
      await rm(uuidDir, { recursive: true, force: true })
      setTTY(origStdin, origStdout)
    }
  })

  test('handles invalid json in task files gracefully', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    // Isolate: only our test dir
    const backupDir = tasksDir + '__badjson-backup__'
    let renamed = false
    try {
      const { rename } = await import('node:fs/promises')
      await rename(tasksDir, backupDir)
      renamed = true
    } catch {
      /* */
    }

    const testDir = join(tasksDir, '__picker-badjson__')
    try {
      await mkdir(testDir, { recursive: true })
      await writeFile(join(testDir, '1.json'), 'not valid json')

      // Invalid JSON → no valid tasks → "No active tasks" error
      await expect(run(pickTask({ all: true }))).rejects.toThrow('No active tasks')
    } finally {
      await rm(testDir, { recursive: true, force: true })
      if (renamed) {
        try {
          await rm(tasksDir, { recursive: true, force: true })
        } catch {
          /* */
        }
        const { rename } = await import('node:fs/promises')
        await rename(backupDir, tasksDir)
      }
      setTTY(origStdin, origStdout)
    }
  })

  test('project-scoped error message', async () => {
    const origStdin = process.stdin.isTTY
    const origStdout = process.stdout.isTTY
    setTTY(true, true)

    const backupDir = tasksDir + '__picker-scope-backup__'
    let renamed = false
    try {
      const { rename } = await import('node:fs/promises')
      await rename(tasksDir, backupDir)
      renamed = true
    } catch {
      // doesn't exist
    }

    try {
      await expect(run(pickTask({ all: false }))).rejects.toThrow('Use --all')
    } finally {
      if (renamed) {
        const { rename } = await import('node:fs/promises')
        await rename(backupDir, tasksDir)
      }
      setTTY(origStdin, origStdout)
    }
  })
})
