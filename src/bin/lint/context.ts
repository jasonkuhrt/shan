/**
 * Shared lint context — resolved once, passed to all lint rules.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getRuntimeConfig } from '../../lib/runtime-config.js'

// ── Types ────────────────────────────────────────────────

export interface SettingsFile {
  path: string
  displayPath: string
  scope: 'user' | 'project' | 'project-local'
  data: Record<string, unknown>
}

export interface LintContext {
  home: string
  projectDir: string
  settingsFiles: SettingsFile[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// ── Discovery ────────────────────────────────────────────

const tryParseJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const displayPath = (filePath: string, home: string): string =>
  filePath.startsWith(home) ? filePath.replace(home, '~') : filePath

export const buildLintContext = (): LintContext => {
  const runtime = getRuntimeConfig()
  const home = runtime.homeDir
  const projectDir = runtime.projectRoot
  const settingsFiles: SettingsFile[] = []

  const candidates: Array<{ filePath: string; scope: SettingsFile['scope'] }> = [
    { filePath: path.join(home, '.claude', 'settings.json'), scope: 'user' },
    { filePath: path.join(projectDir, '.claude', 'settings.json'), scope: 'project' },
    { filePath: path.join(projectDir, '.claude', 'settings.local.json'), scope: 'project-local' },
  ]

  for (const c of candidates) {
    if (!fs.existsSync(c.filePath)) continue
    const data = tryParseJson(c.filePath)
    if (!data) continue
    settingsFiles.push({
      path: c.filePath,
      displayPath: displayPath(c.filePath, home),
      scope: c.scope,
      data,
    })
  }

  return { home, projectDir, settingsFiles }
}
