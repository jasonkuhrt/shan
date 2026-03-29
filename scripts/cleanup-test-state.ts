#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { getRuntimeConfig } from '../src/lib/runtime-config.js'

const STATE_FILE = getRuntimeConfig().paths.stateFile
const TEST_SCOPE_PATTERN = /(?:^|[\\/])shan-[^\\/]+-test-[^\\/]+$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isScopeState = (value: unknown): value is { installs: string[] } =>
  isRecord(value) && Array.isArray(value['installs'])

const isHistoryState = (value: unknown): value is { entries: unknown[]; undoneCount: number } =>
  isRecord(value) && Array.isArray(value['entries']) && typeof value['undoneCount'] === 'number'

export const cleanupTestState = async () => {
  const rawState = await readFile(STATE_FILE, 'utf-8').catch(() => null)
  if (!rawState) return { removed: [] as string[] }

  const parsed: unknown = JSON.parse(rawState)
  if (!isRecord(parsed)) return { removed: [] as string[] }

  const current = isRecord(parsed['current']) ? { ...parsed['current'] } : {}
  const history = isRecord(parsed['history']) ? { ...parsed['history'] } : {}
  const removed = new Set<string>()

  for (const [scopeKey, scopeValue] of Object.entries(current)) {
    if (!TEST_SCOPE_PATTERN.test(scopeKey) || !isScopeState(scopeValue)) continue
    delete current[scopeKey]
    removed.add(scopeKey)
  }

  for (const [scopeKey, scopeValue] of Object.entries(history)) {
    if (!TEST_SCOPE_PATTERN.test(scopeKey) || !isHistoryState(scopeValue)) continue
    delete history[scopeKey]
    removed.add(scopeKey)
  }

  if (removed.size === 0) return { removed: [] as string[] }

  await mkdir(path.dirname(STATE_FILE), { recursive: true })
  await writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        ...parsed,
        current,
        history,
      },
      null,
      2,
    ) + '\n',
  )

  return { removed: [...removed].sort() }
}

if (import.meta.main) {
  const { removed } = await cleanupTestState()
  if (removed.length > 0) {
    console.log(`Cleaned ${removed.length} shan test scope entries from ${STATE_FILE}.`)
  }
}
