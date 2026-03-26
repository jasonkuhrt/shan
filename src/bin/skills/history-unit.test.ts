import { afterAll, beforeEach, describe, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { skillsHistory } from './history.js'
import { skillsOn } from './on.js'
import { skillsOff } from './off.js'
import { skillsUndo } from './undo.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-history-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`

const setupProjectLibrary = async (...skills: string[]) => {
  const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
  for (const skill of skills) {
    const skillDir = path.join(libDir, skill)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD(skill))
  }
}

const STATE_FILE = path.join(homedir(), '.claude', 'shan', 'state.json')

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? { ...value } : {}

const readState = async (): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(STATE_FILE, 'utf-8'))
    return asRecord(parsed)
  } catch {
    return {}
  }
}

const writeState = async (state: Record<string, unknown>) => {
  await mkdir(path.dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

const cleanStateForTempDir = async () => {
  const state = await readState()
  const history = asRecord(state['history'])
  delete history[TEMP_DIR]
  state['history'] = history
  const current = asRecord(state['current'])
  delete current[TEMP_DIR]
  state['current'] = current
  await writeState(state)
}

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
  await cleanStateForTempDir()
})

afterAll(async () => {
  process.chdir(origCwd)
  await cleanStateForTempDir()
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsHistory', () => {
  test('shows no history when state is empty', async () => {
    await run(skillsHistory('project'))
  })

  test('shows history after on operation', async () => {
    await setupProjectLibrary('hist-on')
    await run(skillsOn('hist-on', { scope: 'project', strict: false }))
    await run(skillsHistory('project'))
  })

  test('shows history after on and off operations', async () => {
    await setupProjectLibrary('hist-onoff')
    await run(skillsOn('hist-onoff', { scope: 'project', strict: false }))
    await run(skillsOff('hist-onoff', { scope: 'project', strict: false }))
    await run(skillsHistory('project'))
  })

  test('shows undone marker after undo', async () => {
    await setupProjectLibrary('hist-undone')
    await run(skillsOn('hist-undone', { scope: 'project', strict: false }))
    await run(skillsUndo(1, 'project'))
    await run(skillsHistory('project'))
  })

  test('exercises all formatRelativeTime branches', async () => {
    const saved = await readState()
    const historyKey = process.cwd()

    const state = {
      ...saved,
      version: 2,
      history: {
        ...((saved['history'] ?? {}) as Record<string, unknown>),
        [historyKey]: {
          entries: [
            {
              _tag: 'OnOp',
              targets: ['a'],
              scope: 'project',
              timestamp: new Date().toISOString(), // just now
              snapshot: [],
              generatedRouters: [],
            },
            {
              _tag: 'OffOp',
              targets: ['b'],
              scope: 'project',
              timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago
              snapshot: [],
              generatedRouters: [],
            },
            {
              _tag: 'OnOp',
              targets: ['c'],
              scope: 'project',
              timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(), // 3 hr ago
              snapshot: [],
              generatedRouters: [],
            },
            {
              _tag: 'OffOp',
              targets: ['d'],
              scope: 'project',
              timestamp: new Date(Date.now() - 25 * 3_600_000).toISOString(), // 1 day ago
              snapshot: [],
              generatedRouters: [],
            },
            {
              _tag: 'OnOp',
              targets: ['e'],
              scope: 'project',
              timestamp: new Date(Date.now() - 72 * 3_600_000).toISOString(), // 3 days ago
              snapshot: [],
              generatedRouters: [],
            },
            {
              _tag: 'MoveOp',
              targets: ['f'],
              scope: 'project',
              timestamp: new Date(Date.now() - 200 * 3_600_000).toISOString(),
              axis: 'scope',
              direction: 'up',
              subActions: [],
            },
            {
              _tag: 'DoctorOp',
              targets: [],
              scope: 'project',
              timestamp: new Date(Date.now() - 500 * 3_600_000).toISOString(),
            },
          ],
          undoneCount: 2,
        },
      },
      current: (saved['current'] ?? {}) as Record<string, unknown>,
    }

    await writeState(state)
    await run(skillsHistory('project'))
  })

  test('shows no-target entry as (all)', async () => {
    const saved = await readState()
    const historyKey = process.cwd()

    const state = {
      ...saved,
      version: 2,
      history: {
        ...((saved['history'] ?? {}) as Record<string, unknown>),
        [historyKey]: {
          entries: [
            {
              _tag: 'OffOp',
              targets: [],
              scope: 'project',
              timestamp: new Date().toISOString(),
              snapshot: [],
              generatedRouters: [],
            },
          ],
          undoneCount: 0,
        },
      },
      current: (saved['current'] ?? {}) as Record<string, unknown>,
    }

    await writeState(state)
    await run(skillsHistory('project'))
  })
})
