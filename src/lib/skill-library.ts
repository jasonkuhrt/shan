/**
 * Core library for the shan skills system.
 *
 * Architecture:
 *   ~/.claude/skills-library/    User library: pluggable skills shared across all projects
 *   .claude/skills-library/      Project library: pluggable skills committed to a repo
 *   ~/.claude/skills/            User outfit: core (real dirs) + pluggable (symlinks → library)
 *   .claude/skills/              Project outfit: same structure, scoped to project
 *   ~/.config/shan/config.json   Settings (lazy-read)
 *   ~/.local/shan/cache.json     Cached agent auto-detection
 *   ~/.claude/shan/state.json    Undo/redo history + current install index (lazy-created)
 *
 * Terminology:
 *   outfit      — the effective set of active skills that CC sees
 *   library     — the canonical store of all pluggable skills (user or project)
 *   core        — real directory in outfit (shan never touches)
 *   pluggable   — symlink in outfit → library (shan manages)
 *   scope       — "user" | "project"
 *   provenance  — which library a skill comes from ("user" or "project")
 */

import { Console, Data, Effect, Schema } from 'effect'
import type { Option } from 'effect'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import * as path from 'node:path'
import {
  AGENT_CACHE_TTL_MS,
  AGENT_ORDER,
  AGENT_PROBE_COMMANDS,
  AGENT_ROOT_DIRS,
  CANONICAL_AGENT as RUNTIME_CANONICAL_AGENT,
  agentOutfitDirFor,
  agentRootDirFor,
  getRuntimeConfig,
  onRuntimeConfigChange,
} from './runtime-config.js'
import * as SkillName from './skill-name.js'

// ── Paths ──────────────────────────────────────────────────────────

export let LIBRARY_DIR = ''
export let USER_OUTFIT_DIR = ''
export let SHAN_DIR = ''
export let CONFIG_DIR = ''
export let CACHE_DIR = ''
export let STATE_FILE = ''
export let CONFIG_FILE = ''
export let CACHE_FILE = ''
let LEGACY_CONFIG_FILE = ''
// TODO: Make the canonical agent configurable once shan supports full multi-agent ownership.
export const CANONICAL_AGENT = RUNTIME_CANONICAL_AGENT

const refreshRuntimePathBindings = () => {
  const runtime = getRuntimeConfig()
  LIBRARY_DIR = runtime.paths.userLibraryDir
  USER_OUTFIT_DIR = runtime.paths.userClaudeSkillsDir
  SHAN_DIR = runtime.paths.shanDir
  CONFIG_DIR = runtime.paths.configDir
  CACHE_DIR = runtime.paths.cacheDir
  STATE_FILE = runtime.paths.stateFile
  CONFIG_FILE = runtime.paths.configFile
  CACHE_FILE = runtime.paths.cacheFile
  LEGACY_CONFIG_FILE = runtime.paths.legacyConfigFile
}

refreshRuntimePathBindings()
onRuntimeConfigChange(() => {
  refreshRuntimePathBindings()
})

/** Project-level library. Evaluated lazily (depends on cwd). */
export const projectLibraryDir = () => getRuntimeConfig().paths.projectLibraryDir

/**
 * Library directories to search, in priority order.
 * - project scope: project library first, then user library
 * - user scope: user library only (project skills can't be installed at user scope)
 */
export const librarySearchOrder = (scope: Scope): string[] => {
  if (scope === 'user') return [LIBRARY_DIR]
  return [projectLibraryDir(), LIBRARY_DIR]
}

/**
 * The single library directory for a scope. Unlike `librarySearchOrder`,
 * this never falls through — use it in all write paths to prevent cross-scope mutations.
 */
export const scopeLibraryDir = (scope: Scope): string =>
  scope === 'user' ? LIBRARY_DIR : projectLibraryDir()

/**
 * Rebuild `state.current` for a scope from the filesystem and return updated state.
 * Use after any operation that mutates outfit symlinks without individually tracking adds/removes.
 */
export const syncCurrentInstalls = (state: ShanState, scope: Scope) =>
  Effect.gen(function* () {
    const installs = yield* bootstrapCurrent(scope)
    return setCurrentInstalls(state, scope, installs)
  })

/**
 * Resolve a history sub-action scope key to a Lib.Scope.
 * History entries store scope as strings ('user', 'global', 'project', or absolute project paths).
 */
export const resolveHistoryScope = (scopeKey: string): Scope =>
  scopeKey === 'user' || scopeKey === 'global' ? 'user' : 'project'

/**
 * Resolve a history sub-action scope key to its outfit directory path.
 */
export const resolveHistoryOutfitDir = (scopeKey: string): string =>
  scopeKey === 'user' || scopeKey === 'global'
    ? outfitDir('user')
    : scopeKey === 'project'
      ? outfitDir('project')
      : path.join(scopeKey, AGENT_ROOT_DIRS[CANONICAL_AGENT], 'skills')

// ── Enums ──────────────────────────────────────────────────────────

export const Scope = Schema.Literal('user', 'project')
export type Scope = typeof Scope.Type

export const Agent = Schema.Literal('claude', 'codex')
export type Agent = typeof Agent.Type

export const Commitment = Schema.Literal('core', 'pluggable')
export type Commitment = typeof Commitment.Type

export const Status = Schema.Literal('on', 'off')
export type Status = typeof Status.Type

export const NodeType = Schema.Literal('leaf', 'group', 'callable-group')
export type NodeType = typeof NodeType.Type

export const Level = Schema.Literal('error', 'warning', 'info')
export type Level = typeof Level.Type

// ── Frontmatter (serialization boundary) ──────────────────────────

export const SkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  whenToUse: Schema.optional(Schema.String),
  disableModelInvocation: Schema.optional(Schema.Boolean),
  argumentHint: Schema.optional(Schema.String),
})
export type SkillFrontmatter = typeof SkillFrontmatter.Type

// ── Domain Entities ───────────────────────────────────────────────

export class OutfitEntry extends Schema.TaggedClass<OutfitEntry>()('OutfitEntry', {
  name: Schema.String,
  dir: Schema.String,
  commitment: Commitment,
  scope: Scope,
  symlinkTarget: Schema.optional(Schema.String),
}) {
  static is = Schema.is(OutfitEntry)
}

export class LibraryNode extends Schema.TaggedClass<LibraryNode>()('LibraryNode', {
  colonName: Schema.String,
  libraryRelPath: Schema.String,
  nodeType: NodeType,
  frontmatter: Schema.optional(SkillFrontmatter),
}) {
  static is = Schema.is(LibraryNode)
}

// ── Internal computation types (not domain entities) ──────────────

export interface SkillInfo {
  readonly colonName: string
  readonly libraryRelPath: string
  readonly libraryDir: string // absolute path to the library root this skill was found in
  readonly libraryScope: Scope // which library: "user" or "project"
  readonly frontmatter: SkillFrontmatter | null
}

export interface ResolvedTarget {
  readonly colonName: string
  readonly libraryPath: string
  readonly libraryDir: string // which library root it was found in
  readonly libraryScope: Scope // provenance: "user" or "project"
  readonly nodeType: NodeType
  readonly leaves: SkillInfo[]
}

export interface OnOffResult {
  readonly on: string[]
  readonly skip: string[]
  readonly errors: Array<{ name: string; reason: string }>
}

// ── Two-phase validation infrastructure ─────────────────────────────

/** A validated action ready for Phase 2 execution. Generic over the action payload. */
export interface BatchValidation<$Action> {
  readonly actions: $Action[]
  readonly skips: Array<{ name: string; reason: string }>
  readonly errors: Array<{ name: string; reason: string }>
}

/** Create an empty batch validation. */
export const emptyBatch = <$Action>(): BatchValidation<$Action> => ({
  actions: [],
  skips: [],
  errors: [],
})

/** Check whether Phase 1 validation indicates abort. */
export const shouldAbort = <$Action>(batch: BatchValidation<$Action>, strict: boolean): boolean =>
  batch.errors.length > 0 || (strict && batch.skips.length > 0)

// ── ANSI helpers ──────────────────────────────────────────────────

const ansi = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

/** A structured result row for reporting batch operations. */
export interface ResultRow {
  readonly status: 'ok' | 'skip' | 'error' | 'abort'
  readonly name: string
  readonly scope?: string
  readonly commitment?: string
  readonly reason?: string
}

/** Convert a batch to structured result rows. */
export const batchToRows = <A>(
  batch: BatchValidation<A>,
  actionToRow: (action: A) => ResultRow,
  aborted?: boolean,
): ResultRow[] => {
  const rows: ResultRow[] = []
  for (const action of batch.actions) {
    if (aborted) {
      const row = actionToRow(action)
      rows.push({ ...row, status: 'abort', reason: 'not applied' })
    } else {
      rows.push(actionToRow(action))
    }
  }
  for (const skip of batch.skips) {
    rows.push({ status: 'skip', name: skip.name, reason: skip.reason })
  }
  for (const err of batch.errors) {
    rows.push({ status: 'error', name: err.name, reason: err.reason })
  }
  return rows
}

/** Render result rows as a colored, column-aligned table. */
export const reportResults = (rows: readonly ResultRow[]) =>
  Effect.gen(function* () {
    if (rows.length === 0) return

    const symbols: Record<ResultRow['status'], string> = {
      ok: ansi.green('✓'),
      skip: ansi.yellow('⊘'),
      error: ansi.red('✗'),
      abort: ansi.red('⊘'),
    }

    const maxName = Math.max(...rows.map((r) => r.name.length))
    const detailRows = rows.filter((r) => r.scope ?? r.commitment)
    const maxScope =
      detailRows.length > 0 ? Math.max(...detailRows.map((r) => (r.scope ?? '').length)) : 0

    for (const row of rows) {
      const sym = symbols[row.status]
      const name = ansi.bold(row.name.padEnd(maxName))

      if ((row.scope || row.commitment) && row.status !== 'skip' && row.status !== 'error') {
        const parts = [sym, name]
        if (row.scope) parts.push(ansi.dim(row.scope.padEnd(maxScope)))
        else if (maxScope > 0) parts.push(''.padEnd(maxScope))
        if (row.commitment) parts.push(ansi.dim(row.commitment))
        if (row.status === 'abort') parts.push(ansi.dim(row.reason ?? 'not applied'))
        yield* Console.log(`  ${parts.join('  ')}`)
      } else {
        yield* Console.log(`  ${sym}  ${name}  ${ansi.dim(row.reason ?? '')}`)
      }
    }
  })

// ── Slash-command notice ─────────────────────────────────────────

const CC_ISSUE_URL = 'https://github.com/anthropics/claude-code/issues/37862'
const SHAN_ISSUE_URL =
  'https://github.com/jasonkuhrt/shan/issues/new?title=CC+%2337862+resolved:+remove+slash-command+notice&body=The+CC+issue+anthropics/claude-code%2337862+has+been+resolved.+The+slash-command+autocomplete+limitation+notice+in+%60shan+skills+on/off%60+output+is+now+obsolete+and+should+be+removed+in+the+next+shan+release.&labels=enhancement'

const osc8 = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`

/**
 * Print a notice explaining the slash-command autocomplete limitation
 * after any skill outfit mutation (on/off/undo/redo/move/reset).
 *
 * CC hot-reloads skill files via chokidar, so the model sees changes immediately.
 * But the slash-command parser is frozen at session start (CC bug #37862).
 */
export const printSlashCommandNotice = Effect.gen(function* () {
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
  const white = (s: string) => `\x1b[1;37m${s}\x1b[0m`
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
  const blue = (s: string) => `\x1b[34m${s}\x1b[0m`
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

  const bar = dim('│')

  const lines = [
    '',
    dim('  ┌──────────────────────────────────────────────────────────┐'),
    `  ${bar}  ${cyan('ℹ')}  ${white('Skill Availability')}                                   ${bar}`,
    dim('  ├──────────────────────────────────────────────────────────┤'),
    `  ${bar}  ${ansi.green('●')}  Model-initiated use     ${white('available now')}             ${bar}`,
    `  ${bar}  ${yellow('⊘')}  /slash-command autocomplete  ${yellow('next session')}          ${bar}`,
    dim('  ├──────────────────────────────────────────────────────────┤'),
    `  ${bar}  ${dim('The slash-command parser is frozen at session start.')}   ${bar}`,
    `  ${bar}  ${dim('The model uses skills immediately — only the')}          ${bar}`,
    `  ${bar}  ${dim('/autocomplete index requires a new session.')}           ${bar}`,
    `  ${bar}                                                          ${bar}`,
    `  ${bar}  ${blue(osc8(CC_ISSUE_URL, 'Track CC fix → anthropics/claude-code#37862'))}`,
    `  ${bar}  ${blue(osc8(SHAN_ISSUE_URL, 'Report when fixed → remove this notice'))}`,
    dim('  └──────────────────────────────────────────────────────────┘'),
  ]

  yield* Console.log(lines.join('\n'))
})

// ── History (Data.TaggedEnum) ─────────────────────────────────────

interface HistoryEntryFields {
  readonly targets: ReadonlyArray<string>
  readonly scope: string
  readonly timestamp: string
  readonly snapshot: ReadonlyArray<string>
  readonly generatedRouters: ReadonlyArray<string>
}

interface FsOpFields {
  readonly targets: ReadonlyArray<string>
  readonly scope: string
  readonly timestamp: string
  readonly sourcePath: string
  readonly destPath: string
}

interface MoveOpFields {
  readonly targets: ReadonlyArray<string>
  readonly scope: string
  readonly timestamp: string
  readonly axis: 'scope' | 'commitment'
  readonly direction: 'up' | 'down'
  readonly subActions: ReadonlyArray<HistoryEntry>
}

interface DoctorOpFields {
  readonly targets: ReadonlyArray<string>
  readonly scope: string
  readonly timestamp: string
}

export type HistoryEntry = Data.TaggedEnum<{
  readonly OnOp: HistoryEntryFields
  readonly OffOp: HistoryEntryFields
  readonly MoveOp: MoveOpFields
  readonly CopyToOutfitOp: FsOpFields
  readonly MoveToLibraryOp: FsOpFields
  readonly MoveDirOp: FsOpFields
  readonly MoveLibraryDirOp: FsOpFields
  readonly DoctorOp: DoctorOpFields
}>

export const {
  OnOp,
  OffOp,
  MoveOp,
  CopyToOutfitOp,
  MoveToLibraryOp,
  MoveDirOp,
  MoveLibraryDirOp,
  DoctorOp,
  $is: isHistoryEntry,
  $match: matchHistoryEntry,
} = Data.taggedEnum<HistoryEntry>()

export interface ProjectHistory {
  entries: HistoryEntry[]
  undoneCount: number
}

export interface ScopeState {
  installs: string[] // flat names of pluggable skills installed by shan (symlinks only)
}

export interface ShanState {
  version: 2
  current: Record<string, ScopeState> // "global" for user, or project paths
  history: Record<string, ProjectHistory>
}

export interface ShanConfig {
  version: 1
  skills: {
    historyLimit: number
    defaultScope: Scope
    agents: 'auto' | Agent[]
  }
  doctor?: {
    disabled?: string[]
  }
}

export interface ShanCache {
  version: 1
  agents: {
    checkedAt: string
    installed: Agent[]
  }
}

// ── Errors ────────────────────────────────────────────────────────

export class SkillNotFoundError extends Data.TaggedError('SkillNotFoundError')<{
  readonly name: string
}> {}

export class CollisionError extends Data.TaggedError('CollisionError')<{
  readonly name: string
  readonly scope: string
}> {}

export class LibraryPathOccupiedError extends Data.TaggedError('LibraryPathOccupiedError')<{
  readonly path: string
}> {}

export class BrokenSymlinkError extends Data.TaggedError('BrokenSymlinkError')<{
  readonly name: string
  readonly target: string
}> {}

// ── Doctor types (used in Steps 8-9) ──────────────────────────────

export class DoctorReconciled extends Schema.TaggedClass<DoctorReconciled>()('DoctorReconciled', {
  restored: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  repointed: Schema.Array(Schema.String),
  untracked: Schema.Array(Schema.String),
  newLeaves: Schema.Array(Schema.String),
  regenerated: Schema.Array(Schema.String),
  pruned: Schema.Array(Schema.String),
}) {
  static is = Schema.is(DoctorReconciled)
}

export type DoctorFinding = Data.TaggedEnum<{
  readonly BrokenSymlink: {
    readonly scope: string
    readonly name: string
    readonly symlinkTarget: string
    readonly renameTo: Option.Option<string>
  }
  readonly StateDrift: {
    readonly scope: string
    readonly name: string
    readonly kind: 'missing-symlink' | 'untracked-symlink' | 'irrecoverable'
  }
  readonly NewLeaf: { readonly scope: string; readonly name: string; readonly groupName: string }
  readonly StaleRouter: {
    readonly scope: string
    readonly name: string
    readonly added: ReadonlyArray<string>
    readonly removed: ReadonlyArray<string>
  }
  readonly OrphanedRouter: { readonly scope: string; readonly name: string }
  readonly OrphanedScope: { readonly scopePath: string }
  readonly StaleGitignore: { readonly entries: ReadonlyArray<string> }
  readonly FrontmatterMismatch: {
    readonly scope: string
    readonly name: string
    readonly expected: string
    readonly actual: string
  }
  readonly NameConflict: {
    readonly name: string
    readonly libraryScope: string
    readonly coreScope: string
  }
  readonly DuplicateName: { readonly flatName: string; readonly paths: ReadonlyArray<string> }
  readonly Shadow: { readonly name: string }
  readonly StaleShadow: { readonly scope: string; readonly name: string }
  readonly CrossScopeInstall: { readonly name: string; readonly symlinkTarget: string }
}>

export const { $match: matchDoctorFinding } = Data.taggedEnum<DoctorFinding>()

// ── Doctor aspect interface ───────────────────────────────────────

export interface DoctorAspect {
  readonly name: string
  readonly description: string
  readonly level: Level
  readonly detect: (ctx: DoctorContext) => Effect.Effect<DoctorFinding[]>
  readonly fix?: (finding: DoctorFinding) => Effect.Effect<void>
}

export interface DoctorContext {
  readonly state: ShanState
  readonly userOutfit: OutfitEntry[]
  readonly projectOutfit: OutfitEntry[]
}

// ── Config ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ShanConfig = {
  version: 1,
  skills: {
    historyLimit: 50,
    defaultScope: 'project',
    agents: 'auto',
  },
}

const DEFAULT_CACHE: ShanCache = {
  version: 1,
  agents: {
    checkedAt: '',
    installed: [],
  },
}

const isScope = (value: string): value is Scope => value === 'user' || value === 'project'

const isAgent = (value: string): value is Agent => value === 'claude' || value === 'codex'

export const normalizeAgents = (agents: readonly string[]): Agent[] => {
  const unique = new Set(agents.filter(isAgent))
  return AGENT_ORDER.filter((agent) => unique.has(agent))
}

export const agentRootDir = (scope: Scope, agent: Agent): string => agentRootDirFor(scope, agent)

export const agentOutfitDir = (scope: Scope, agent: Agent): string =>
  agentOutfitDirFor(scope, agent)

export const getMirrorAgents = (agents: readonly Agent[]): Agent[] =>
  agents.filter((agent) => agent !== CANONICAL_AGENT)

const readOptionalFile = (file: string) =>
  Effect.tryPromise(() => readFile(file, 'utf-8')).pipe(Effect.catchAll(() => Effect.succeed(null)))

const parseConfiguredAgents = (skills: Record<string, unknown> | undefined): 'auto' | Agent[] => {
  if (!skills) return DEFAULT_CONFIG.skills.agents

  const rawAgents = skills['agents']
  if (rawAgents === 'auto') return 'auto'
  if (Array.isArray(rawAgents)) {
    return normalizeAgents(rawAgents.filter((value): value is string => typeof value === 'string'))
  }

  // Legacy config support: mirrorAgents implied the canonical Claude outfit plus mirrors.
  const legacyMirrorAgents = getStringArray(skills, 'mirrorAgents')
  if (legacyMirrorAgents.length > 0) {
    return normalizeAgents([CANONICAL_AGENT, ...legacyMirrorAgents])
  }

  return DEFAULT_CONFIG.skills.agents
}

const normalizeDoctorDisabledRule = (rule: string): string | null => {
  const normalized = rule.trim().replace(/\/+$/, '')
  if (normalized === '') return null
  return normalized.includes('/') ? normalized : `skills/${normalized}`
}

const normalizeDoctorDisabledRules = (rules: readonly string[]): string[] => {
  const unique = new Set<string>()
  const normalized: string[] = []

  for (const rule of rules) {
    const nextRule = normalizeDoctorDisabledRule(rule)
    if (!nextRule || unique.has(nextRule)) continue
    unique.add(nextRule)
    normalized.push(nextRule)
  }

  return normalized
}

export const loadConfig = (): Effect.Effect<ShanConfig> =>
  Effect.gen(function* () {
    const content =
      (yield* readOptionalFile(CONFIG_FILE)) ?? (yield* readOptionalFile(LEGACY_CONFIG_FILE))
    if (!content) return DEFAULT_CONFIG
    try {
      const parsed: unknown = JSON.parse(content)
      if (!isRecord(parsed)) return DEFAULT_CONFIG

      const skills = getObject(parsed, 'skills')
      const doctor = getObject(parsed, 'doctor')
      const legacySkillsDoctor = skills ? getObject(skills, 'doctor') : undefined
      const defaultScope = skills ? getString(skills, 'defaultScope') : undefined
      const disabledRules = normalizeDoctorDisabledRules([
        ...getStringArray(doctor ?? {}, 'disabled'),
        ...getStringArray(legacySkillsDoctor ?? {}, 'disabled'),
      ])

      return {
        version: 1 as const,
        skills: {
          historyLimit: skills
            ? (getNumber(skills, 'historyLimit') ?? DEFAULT_CONFIG.skills.historyLimit)
            : DEFAULT_CONFIG.skills.historyLimit,
          defaultScope:
            defaultScope && isScope(defaultScope)
              ? defaultScope
              : DEFAULT_CONFIG.skills.defaultScope,
          agents: parseConfiguredAgents(skills),
        },
        ...(disabledRules.length > 0 ? { doctor: { disabled: disabledRules } } : {}),
      } satisfies ShanConfig
    } catch {
      return DEFAULT_CONFIG
    }
  })

const isFreshTimestamp = (value: string): boolean => {
  const checkedAt = Date.parse(value)
  return Number.isFinite(checkedAt) && Date.now() - checkedAt <= AGENT_CACHE_TTL_MS
}

export const loadCache = (): Effect.Effect<ShanCache> =>
  Effect.gen(function* () {
    const content = yield* readOptionalFile(CACHE_FILE)
    if (!content) return DEFAULT_CACHE
    try {
      const parsed: unknown = JSON.parse(content)
      if (!isRecord(parsed)) return DEFAULT_CACHE
      const agents = getObject(parsed, 'agents')
      return {
        version: 1 as const,
        agents: {
          checkedAt: agents ? (getString(agents, 'checkedAt') ?? '') : '',
          installed: agents ? normalizeAgents(getStringArray(agents, 'installed')) : [],
        },
      } satisfies ShanCache
    } catch {
      return DEFAULT_CACHE
    }
  })

export const saveCache = (cache: ShanCache) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(CACHE_DIR, { recursive: true }))
    yield* Effect.tryPromise(() => writeFile(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n'))
  })

export const detectInstalledAgents = (): Effect.Effect<Agent[]> =>
  Effect.try(() =>
    AGENT_ORDER.filter((agent) => {
      const command = AGENT_PROBE_COMMANDS[agent]
      return typeof Bun !== 'undefined' && Bun.which(command) !== null
    }),
  ).pipe(Effect.catchAll(() => Effect.succeed([])))

export const resolveConfiguredAgents = (config: ShanConfig): Effect.Effect<Agent[]> =>
  Effect.gen(function* () {
    if (config.skills.agents !== 'auto') {
      return normalizeAgents(config.skills.agents)
    }

    const cache = yield* loadCache()
    if (isFreshTimestamp(cache.agents.checkedAt)) {
      return cache.agents.installed
    }

    const detectedAgents = yield* detectInstalledAgents()
    const installed = normalizeAgents(detectedAgents)
    yield* saveCache({
      version: 1,
      agents: {
        checkedAt: new Date().toISOString(),
        installed,
      },
    }).pipe(Effect.catchAll(() => Effect.void))
    return installed
  })

// ── State ──────────────────────────────────────────────────────────

const DEFAULT_STATE: ShanState = {
  version: 2,
  current: {},
  history: {},
}

/** Type guard for Record<string, unknown>. */
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

/** Typed getter for unknown record values. */
const getString = (obj: Record<string, unknown>, key: string): string | undefined => {
  const val = obj[key]
  return typeof val === 'string' ? val : undefined
}

const getStringArray = (obj: Record<string, unknown>, key: string): string[] => {
  const val = obj[key]
  return Array.isArray(val)
    ? (val as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
}

const getObjectArray = (obj: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const val = obj[key]
  return Array.isArray(val) ? (val as unknown[]).filter(isRecord) : []
}

const getNumber = (obj: Record<string, unknown>, key: string): number | undefined => {
  const val = obj[key]
  return typeof val === 'number' ? val : undefined
}

const getObject = (
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const val = obj[key]
  return isRecord(val) ? val : undefined
}

/** Reconstruct a HistoryEntry from raw JSON (handles v1 `op` field and v2 `_tag` field). */
const deserializeHistoryEntry = (raw: Record<string, unknown>): HistoryEntry | null => {
  // Migrate v1 `op` field → v2 `_tag` field
  const tag =
    getString(raw, '_tag') ?? (raw['op'] === 'on' ? 'OnOp' : raw['op'] === 'off' ? 'OffOp' : null)
  if (!tag) return null

  const base = {
    targets: getStringArray(raw, 'targets'),
    scope: getString(raw, 'scope') ?? '',
    timestamp: getString(raw, 'timestamp') ?? '',
  }

  if (tag === 'OnOp' || tag === 'OffOp') {
    const fields = {
      ...base,
      snapshot: getStringArray(raw, 'snapshot'),
      generatedRouters: getStringArray(raw, 'generatedRouters'),
    }
    return tag === 'OnOp' ? OnOp(fields) : OffOp(fields)
  }

  if (tag === 'MoveOp') {
    const subRaw = getObjectArray(raw, 'subActions')
    const axisVal = getString(raw, 'axis')
    const dirVal = getString(raw, 'direction')
    return MoveOp({
      ...base,
      axis: axisVal === 'scope' || axisVal === 'commitment' ? axisVal : 'scope',
      direction: dirVal === 'up' || dirVal === 'down' ? dirVal : 'up',
      subActions: subRaw
        .map((s) => deserializeHistoryEntry(s))
        .filter((e): e is HistoryEntry => e !== null),
    })
  }

  const fsFields = {
    ...base,
    sourcePath: getString(raw, 'sourcePath') ?? '',
    destPath: getString(raw, 'destPath') ?? '',
  }
  if (tag === 'CopyToOutfitOp') return CopyToOutfitOp(fsFields)
  if (tag === 'MoveToLibraryOp') return MoveToLibraryOp(fsFields)
  if (tag === 'MoveDirOp') return MoveDirOp(fsFields)
  if (tag === 'MoveLibraryDirOp') return MoveLibraryDirOp(fsFields)

  if (tag === 'DoctorOp') return DoctorOp(base)

  return null
}

export const loadState = () =>
  Effect.gen(function* () {
    const content = yield* Effect.tryPromise(() => readFile(STATE_FILE, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (!content) return DEFAULT_STATE
    try {
      const raw: unknown = JSON.parse(content)
      const rawObj = isRecord(raw) ? raw : {}
      const rawHistory = getObject(rawObj, 'history') ?? {}
      const history: Record<string, ProjectHistory> = {}
      for (const [key, ph] of Object.entries(rawHistory)) {
        const phObj = isRecord(ph) ? ph : {}
        const rawEntries = getObjectArray(phObj, 'entries')
        const entries = rawEntries
          .map((e) => deserializeHistoryEntry(e))
          .filter((e): e is HistoryEntry => e !== null)
        const undoneCount = getNumber(phObj, 'undoneCount') ?? 0
        history[key] = { entries, undoneCount }
      }
      // Migrate v1 → v2: add `current` if missing
      const currentObj = getObject(rawObj, 'current')
      const current: Record<string, ScopeState> = {}
      if (currentObj) {
        for (const [k, v] of Object.entries(currentObj)) {
          if (isRecord(v)) {
            current[k] = { installs: getStringArray(v, 'installs') }
          }
        }
      }
      return { version: 2 as const, current, history }
    } catch {
      return DEFAULT_STATE
    }
  })

export const saveState = (state: ShanState) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(SHAN_DIR, { recursive: true }))
    yield* Effect.tryPromise(() => writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n'))
  })

export const getProjectHistory = (state: ShanState, scope: Scope): ProjectHistory => {
  const key = scope === 'user' ? 'global' : getRuntimeConfig().projectRoot
  return state.history[key] ?? { entries: [], undoneCount: 0 }
}

export const setProjectHistory = (
  state: ShanState,
  scope: Scope,
  history: ProjectHistory,
): ShanState => {
  const key = scope === 'user' ? 'global' : getRuntimeConfig().projectRoot
  return { ...state, history: { ...state.history, [key]: history } }
}

/** Get the current install list for a scope key. */
export const getCurrentInstalls = (state: ShanState, scope: Scope): string[] => {
  const key = scope === 'user' ? 'global' : getRuntimeConfig().projectRoot
  return state.current[key]?.installs ?? []
}

/** Set the current install list for a scope key, returning updated state. */
export const setCurrentInstalls = (
  state: ShanState,
  scope: Scope,
  installs: string[],
): ShanState => {
  const key = scope === 'user' ? 'global' : getRuntimeConfig().projectRoot
  return { ...state, current: { ...state.current, [key]: { installs } } }
}

/** Add a flat name to the current install list (idempotent). */
export const addCurrentInstall = (state: ShanState, scope: Scope, flatName: string): ShanState => {
  const installs = getCurrentInstalls(state, scope)
  if (installs.includes(flatName)) return state
  return setCurrentInstalls(state, scope, [...installs, flatName])
}

/** Remove a flat name from the current install list (idempotent). */
export const removeCurrentInstall = (
  state: ShanState,
  scope: Scope,
  flatName: string,
): ShanState => {
  const installs = getCurrentInstalls(state, scope)
  const filtered = installs.filter((n) => n !== flatName)
  if (filtered.length === installs.length) return state
  return setCurrentInstalls(state, scope, filtered)
}

/**
 * Bootstrap the `current` section for a scope by scanning the outfit directory.
 * Used on first use in a project or after doctor reconciliation.
 */
export const bootstrapCurrent = (scope: Scope) =>
  Effect.gen(function* () {
    const outfit = yield* listOutfit(scope)
    const installs = outfit.filter((e) => e.commitment === 'pluggable').map((e) => e.name)
    return installs
  })

// ── Outfit path resolution ─────────────────────────────────────────

export const outfitDir = (scope: Scope): string => agentOutfitDir(scope, CANONICAL_AGENT)

/**
 * Ensure an outfit directory exists and is writable.
 *
 * Handles the case where the path is a broken symlink (e.g. dotfiles-managed
 * symlink whose target was deleted). `mkdir` fails with EEXIST on broken
 * symlinks, so we detect and report a clear error instead.
 */
export const ensureOutfitDir = (dir: string) =>
  Effect.gen(function* () {
    const entryStat = yield* Effect.tryPromise(() => lstat(dir)).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )

    if (entryStat?.isSymbolicLink()) {
      // Symlink exists — check if target resolves
      const targetOk = yield* Effect.tryPromise(async () => {
        await stat(dir) // stat follows symlinks
        return true
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (!targetOk) {
        const target = yield* Effect.tryPromise(() => readlink(dir)).pipe(
          Effect.catchAll(() => Effect.succeed('(unknown)')),
        )
        return yield* Effect.fail(new BrokenOutfitDirError({ path: dir, symlinkTarget: target }))
      }
      // Symlink resolves — ensure the target is a directory
      return
    }

    if (entryStat?.isDirectory()) return

    // Doesn't exist at all — create it
    yield* Effect.tryPromise(() => mkdir(dir, { recursive: true }))
  })

const mirrorGitignoreEntry = (agent: Agent): string => path.join(AGENT_ROOT_DIRS[agent], 'skills')

export class AgentOutfitConflictError extends Data.TaggedError('AgentOutfitConflictError')<{
  readonly scope: Scope
  readonly canonicalAgent: Agent
  readonly mirrorAgent: Agent
  readonly skillName: string
  readonly canonicalPath: string
  readonly mirrorPath: string
}> {}

const lstatOrNull = async (targetPath: string) => {
  try {
    return await lstat(targetPath)
  } catch {
    return null
  }
}

const statOrNull = async (targetPath: string) => {
  try {
    return await stat(targetPath)
  } catch {
    return null
  }
}

const realpathOrNull = async (targetPath: string) => {
  try {
    return await realpath(targetPath)
  } catch {
    return null
  }
}

const isDirectoryLike = async (targetPath: string): Promise<boolean> => {
  const targetStat = await statOrNull(targetPath)
  return Boolean(targetStat?.isDirectory())
}

const resolvesToSameDirectory = async (leftPath: string, rightPath: string): Promise<boolean> => {
  const [leftRealpath, rightRealpath] = await Promise.all([
    realpathOrNull(leftPath),
    realpathOrNull(rightPath),
  ])
  return Boolean(leftRealpath && rightRealpath && leftRealpath === rightRealpath)
}

const snapshotSkillEntry = async (entryPath: string, seen = new Set<string>()): Promise<string> => {
  const entryLstat = await lstatOrNull(entryPath)
  if (!entryLstat) return 'missing'

  if (entryLstat.isSymbolicLink()) {
    const targetStat = await statOrNull(entryPath)
    if (!targetStat) {
      const target = await readlink(entryPath).catch(() => '(broken)')
      return `broken:${target}`
    }
  }

  const resolvedPath = await realpath(entryPath).catch(() => entryPath)
  if (seen.has(resolvedPath)) return `cycle:${resolvedPath}`

  const entryStat = await stat(entryPath)
  if (entryStat.isDirectory()) {
    seen.add(resolvedPath)
    const childNames = (await readdir(entryPath)).sort()
    const children = await Promise.all(
      childNames.map(async (childName) => {
        const childSnapshot = await snapshotSkillEntry(path.join(entryPath, childName), seen)
        return `${childName}:${childSnapshot}`
      }),
    )
    seen.delete(resolvedPath)
    return `dir(${children.join('|')})`
  }

  if (entryStat.isFile()) {
    return `file:${await readFile(entryPath, 'utf-8')}`
  }

  return `other:${entryStat.mode}`
}

const mergeMirrorEntriesIntoCanonical = async (
  scope: Scope,
  mirrorAgent: Agent,
  canonicalDir: string,
  mirrorDir: string,
) => {
  const mirrorNames = await readdir(mirrorDir).catch(() => [] as string[])

  const plans = await Promise.all(
    mirrorNames.map(async (entryName) => {
      const mirrorEntryPath = path.join(mirrorDir, entryName)
      const canonicalEntryPath = path.join(canonicalDir, entryName)
      const canonicalEntry = await lstatOrNull(canonicalEntryPath)

      if (!canonicalEntry) {
        return {
          type: 'move' as const,
          entryName,
          mirrorEntryPath,
          canonicalEntryPath,
        }
      }

      const [canonicalSnapshot, mirrorSnapshot] = await Promise.all([
        snapshotSkillEntry(canonicalEntryPath),
        snapshotSkillEntry(mirrorEntryPath),
      ])

      if (canonicalSnapshot !== mirrorSnapshot) {
        return {
          type: 'conflict' as const,
          entryName,
          mirrorEntryPath,
          canonicalEntryPath,
        }
      }

      return {
        type: 'drop' as const,
        mirrorEntryPath,
      }
    }),
  )

  const conflict = plans.find((plan) => plan.type === 'conflict')
  if (conflict?.type === 'conflict') {
    throw new AgentOutfitConflictError({
      scope,
      canonicalAgent: CANONICAL_AGENT,
      mirrorAgent,
      skillName: conflict.entryName,
      canonicalPath: conflict.canonicalEntryPath,
      mirrorPath: conflict.mirrorEntryPath,
    })
  }

  await Promise.all(
    plans
      .filter(
        (plan): plan is Extract<(typeof plans)[number], { type: 'move' }> => plan.type === 'move',
      )
      .map((plan) => rename(plan.mirrorEntryPath, plan.canonicalEntryPath)),
  )

  await Promise.all(
    plans
      .filter(
        (plan): plan is Extract<(typeof plans)[number], { type: 'drop' }> => plan.type === 'drop',
      )
      .map((plan) => rm(plan.mirrorEntryPath, { recursive: true, force: true })),
  )
}

const ensureMirrorSymlink = async (canonicalDir: string, mirrorDir: string) => {
  const mirrorLstat = await lstatOrNull(mirrorDir)
  if (mirrorLstat?.isSymbolicLink()) {
    const existingTarget = await readlink(mirrorDir).catch(() => '')
    if (existingTarget === canonicalDir) return
    if (await resolvesToSameDirectory(canonicalDir, mirrorDir)) return
    await rm(mirrorDir, { recursive: true, force: true })
  } else if (mirrorLstat) {
    await rm(mirrorDir, { recursive: true, force: true })
  }

  await mkdir(path.dirname(mirrorDir), { recursive: true })
  await symlink(canonicalDir, mirrorDir)
}

const reconcileMirrorOutfit = (scope: Scope, mirrorAgent: Agent) =>
  Effect.tryPromise(async () => {
    const canonicalDir = outfitDir(scope)
    const mirrorDir = agentOutfitDir(scope, mirrorAgent)

    await mkdir(path.dirname(canonicalDir), { recursive: true })
    await mkdir(path.dirname(mirrorDir), { recursive: true })

    const canonicalExists = await isDirectoryLike(canonicalDir)
    const mirrorExists = await isDirectoryLike(mirrorDir)

    if (!canonicalExists && !mirrorExists) {
      await mkdir(canonicalDir, { recursive: true })
      await ensureMirrorSymlink(canonicalDir, mirrorDir)
      return
    }

    if (!canonicalExists && mirrorExists) {
      await mkdir(canonicalDir, { recursive: true })
      await mergeMirrorEntriesIntoCanonical(scope, mirrorAgent, canonicalDir, mirrorDir)
      await ensureMirrorSymlink(canonicalDir, mirrorDir)
      return
    }

    if (canonicalExists && !mirrorExists) {
      await ensureMirrorSymlink(canonicalDir, mirrorDir)
      return
    }

    const mirrorLstat = await lstatOrNull(mirrorDir)
    if (mirrorLstat?.isSymbolicLink()) {
      const existingTarget = await readlink(mirrorDir).catch(() => '')
      if (existingTarget === canonicalDir) return
      if (await resolvesToSameDirectory(canonicalDir, mirrorDir)) return
    }

    await mergeMirrorEntriesIntoCanonical(scope, mirrorAgent, canonicalDir, mirrorDir)
    await ensureMirrorSymlink(canonicalDir, mirrorDir)
  })

export const syncAgentMirrors = (scope: Scope, config?: ShanConfig) =>
  Effect.gen(function* () {
    const resolvedConfig = config ?? (yield* loadConfig())
    const configuredAgents = yield* resolveConfiguredAgents(resolvedConfig)
    const mirrorAgents = getMirrorAgents(configuredAgents)

    for (const mirrorAgent of mirrorAgents) {
      yield* reconcileMirrorOutfit(scope, mirrorAgent)
    }

    if (scope === 'project') {
      const pluggableEntries = yield* snapshotOutfit(scope)
      const generatedRouters = yield* detectGeneratedRouters(scope)
      const canonicalEntries = [...new Set([...pluggableEntries, ...generatedRouters])].map(
        (name) => path.join('.claude', 'skills', name),
      )
      const gitignoreEntries = [
        ...canonicalEntries,
        ...mirrorAgents.map((agent) => mirrorGitignoreEntry(agent)),
      ].sort()
      yield* setGitignoreEntries(getRuntimeConfig().projectRoot, gitignoreEntries)
    }
  })

export class BrokenOutfitDirError extends Data.TaggedError('BrokenOutfitDirError')<{
  readonly path: string
  readonly symlinkTarget: string
}> {}

// ── Name translation ───────────────────────────────────────────────

/** Translate colon name to library-relative path: "ts:tooling" → "ts/tooling" */
export const colonToPath = (colonName: string): string =>
  SkillName.toLibraryRelPath(SkillName.fromFrontmatterName(colonName))

/** Translate library-relative path to colon name: "ts/tooling" → "ts:tooling" */
export const pathToColon = (relPath: string): string =>
  SkillName.toFrontmatterName(SkillName.fromLibraryRelPath(relPath))

/** Flatten a library-relative path to a symlink name: "ts/tooling" → "ts_tooling" */
export const flattenName = (relPath: string): string =>
  SkillName.toFlatName(SkillName.fromLibraryRelPath(relPath))

/** Unflatten a symlink name to a library-relative path: "ts_tooling" → "ts/tooling" */
export const unflattenName = (flatName: string): string =>
  SkillName.toLibraryRelPath(SkillName.fromFlatName(flatName))

export const resolveCanonicalTargetPaths = (
  target: string,
): { readonly flatName: string; readonly relPath: string } | null => {
  const parsed = SkillName.parseFrontmatterName(target)
  if (!parsed) return null

  return {
    flatName: SkillName.toFlatName(parsed),
    relPath: SkillName.toLibraryRelPath(parsed),
  }
}

const legacyLibraryRelPathCandidates = (flatName: string): readonly string[] => {
  const parsed = SkillName.parseFlatName(flatName)
  return parsed ? [SkillName.toLibraryRelPath(parsed), flatName] : [flatName]
}

const legacyObservedColonName = (relPath: string): string => relPath.split(path.sep).join(':')

const legacyObservedFlatName = (relPath: string): string => relPath.split(path.sep).join('_')

const observedColonNameFromLibraryRelPath = (relPath: string): string => {
  const parsed = SkillName.parseObservedLibraryRelPath(relPath)
  return parsed ? SkillName.toFrontmatterName(parsed) : legacyObservedColonName(relPath)
}

export const observedFlatNameFromLibraryRelPath = (relPath: string): string => {
  const parsed = SkillName.parseObservedLibraryRelPath(relPath)
  return parsed ? SkillName.toFlatName(parsed) : legacyObservedFlatName(relPath)
}

export const canonicalFrontmatterName = (
  frontmatter: SkillFrontmatter | null | undefined,
): string | null => {
  if (!frontmatter) return null
  const parsed = SkillName.parseFrontmatterName(frontmatter.name)
  return parsed ? SkillName.toFrontmatterName(parsed) : null
}

export const isAdmissibleLibrarySkill = (
  skill: Pick<SkillInfo, 'colonName' | 'frontmatter'>,
): boolean => {
  const canonicalName = canonicalFrontmatterName(skill.frontmatter)
  return canonicalName !== null && canonicalName === skill.colonName
}

// ── Frontmatter parsing ────────────────────────────────────────────

/** Extract YAML frontmatter from a SKILL.md file. */
export const readFrontmatter = (skillDir: string) =>
  Effect.gen(function* () {
    const skillMd = path.join(skillDir, 'SKILL.md')
    const content = yield* Effect.tryPromise(() => readFile(skillMd, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (!content) return null

    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match?.[1]) return null

    const yaml = match[1]
    const fm: Record<string, string | boolean> = {}
    for (const line of yaml.split('\n')) {
      const sepIdx = line.indexOf(':')
      if (sepIdx === -1) continue
      const key = line.slice(0, sepIdx).trim()
      const raw = line.slice(sepIdx + 1).trim()
      // Handle multi-line (>-) by taking just the first line value
      if (raw === '>-' || raw === '>') continue
      if (raw === 'true') fm[key] = true
      else if (raw === 'false') fm[key] = false
      // Strip surrounding quotes
      else fm[key] = raw.replace(/^["']|["']$/g, '')
    }

    return {
      name: String(fm['name'] ?? ''),
      description: String(fm['description'] ?? ''),
      disableModelInvocation: fm['disable-model-invocation'] === true,
      ...(fm['when-to-use'] ? { whenToUse: String(fm['when-to-use']) } : {}),
      ...(fm['argument-hint'] ? { argumentHint: String(fm['argument-hint']) } : {}),
    } satisfies SkillFrontmatter
  })

// ── Budget ─────────────────────────────────────────────────────────

/** Estimate character cost of a skill's metadata (name + description + whenToUse). */
export const estimateCharCost = (fm: SkillFrontmatter): number => {
  const parts = [fm.name, fm.description]
  if (fm.whenToUse) parts.push(fm.whenToUse)
  return parts.join(' ').length
}

// ── Library operations ─────────────────────────────────────────────

/** Check if the library directory exists. When scope is given, only checks that scope's library. */
export const libraryExists = (scope?: Scope) =>
  Effect.gen(function* () {
    const dirs = scope ? [scopeLibraryDir(scope)] : [LIBRARY_DIR, projectLibraryDir()]
    for (const dir of dirs) {
      const exists = yield* Effect.tryPromise(async () => {
        const dirStat = await stat(dir)
        return dirStat.isDirectory()
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (exists) return true
    }
    return false
  })

/**
 * Determine the node type at a library path.
 * - Leaf: has SKILL.md, no subdirectories with SKILL.md
 * - Group: has subdirectories, no SKILL.md
 * - Callable group: has both SKILL.md and subdirectories with SKILL.md
 */
export const getNodeType = (libraryPath: string) =>
  Effect.gen(function* () {
    const hasSkillMd = yield* Effect.tryPromise(async () => {
      const fileStat = await lstat(path.join(libraryPath, 'SKILL.md'))
      return fileStat.isFile()
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))

    const entries = yield* Effect.tryPromise(() => readdir(libraryPath)).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    )

    let hasSubdirs = false
    for (const entry of entries) {
      const entryPath = path.join(libraryPath, entry)
      const entryStat = yield* Effect.tryPromise(() => lstat(entryPath)).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (entryStat?.isDirectory()) {
        hasSubdirs = true
        break
      }
    }

    if (hasSkillMd && hasSubdirs) return 'callable-group' as NodeType
    if (hasSkillMd) return 'leaf' as NodeType
    if (hasSubdirs) return 'group' as NodeType
    // Edge case: empty dir or just files — treat as leaf if SKILL.md is absent
    return 'group' as NodeType
  })

/**
 * Resolve a target name (colon syntax) to its library path and node type.
 * Returns null if not found in library.
 *
 * @param strict - When true (default), only searches the scope-matched library.
 *   When false, falls through to other scopes (read-only discovery only — never
 *   use strict=false in write paths).
 */
export const resolveTarget = (colonName: string, scope: Scope = 'project', strict = true) =>
  Effect.gen(function* () {
    const parsedTarget = SkillName.parseFrontmatterName(colonName)
    if (!parsedTarget) return null

    const relPath = SkillName.toLibraryRelPath(parsedTarget)
    const dirs = strict ? [scopeLibraryDir(scope)] : librarySearchOrder(scope)

    for (const libDir of dirs) {
      const libraryPath = path.join(libDir, relPath)
      const libScope: Scope = libDir === LIBRARY_DIR ? 'user' : 'project'

      const exists = yield* Effect.tryPromise(async () => {
        const entryStat = await lstat(libraryPath)
        return entryStat.isDirectory()
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (!exists) continue

      const nodeType = yield* getNodeType(libraryPath)

      // For leaf skills, the leaves array is just the skill itself
      if (nodeType === 'leaf') {
        const fm = yield* readFrontmatter(libraryPath)
        const resolvedLeaf: SkillInfo = {
          colonName,
          libraryRelPath: relPath,
          libraryDir: libDir,
          libraryScope: libScope,
          frontmatter: fm,
        }
        const leaf = {
          colonName,
          libraryPath,
          libraryDir: libDir,
          libraryScope: libScope,
          nodeType,
          leaves: [resolvedLeaf],
        } as ResolvedTarget
        return isAdmissibleLibrarySkill(resolvedLeaf) ? leaf : null
      }

      const leaves = yield* resolveLeaves(relPath, libDir)
      if (!leaves.every(isAdmissibleLibrarySkill)) return null

      // For callable groups, include the group's own SKILL.md as a leaf
      if (nodeType === 'callable-group') {
        const fm = yield* readFrontmatter(libraryPath)
        const ownLeaf: SkillInfo = {
          colonName,
          libraryRelPath: relPath,
          libraryDir: libDir,
          libraryScope: libScope,
          frontmatter: fm,
        }
        if (!isAdmissibleLibrarySkill(ownLeaf)) return null

        return {
          colonName,
          libraryPath,
          libraryDir: libDir,
          libraryScope: libScope,
          nodeType,
          leaves: [ownLeaf, ...leaves],
        } as ResolvedTarget
      }

      // Pure group — only descendant leaves
      return {
        colonName,
        libraryPath,
        libraryDir: libDir,
        libraryScope: libScope,
        nodeType,
        leaves,
      } as ResolvedTarget
    }

    return null
  })

/**
 * Recursively enumerate all descendant leaf skills in a library path.
 */
export const resolveLeaves = (
  relPath: string,
  libDir: string = LIBRARY_DIR,
): Effect.Effect<SkillInfo[]> =>
  Effect.gen(function* () {
    const absPath = path.join(libDir, relPath)
    const libScope: Scope = libDir === LIBRARY_DIR ? 'user' : 'project'
    const entries = yield* Effect.tryPromise(() => readdir(absPath)).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    )

    const results: SkillInfo[] = []

    for (const entry of entries.sort()) {
      const entryPath = path.join(absPath, entry)
      const entryStat = yield* Effect.tryPromise(() => lstat(entryPath)).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (!entryStat?.isDirectory()) continue

      const childRelPath = path.join(relPath, entry)
      const childColonName = observedColonNameFromLibraryRelPath(childRelPath)
      const hasSkillMd = yield* Effect.tryPromise(async () => {
        const s = await lstat(path.join(entryPath, 'SKILL.md'))
        return s.isFile()
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (hasSkillMd) {
        const fm = yield* readFrontmatter(entryPath)
        results.push({
          colonName: childColonName,
          libraryRelPath: childRelPath,
          libraryDir: libDir,
          libraryScope: libScope,
          frontmatter: fm,
        })
      }

      // Recurse into subdirectories regardless (they may have deeper leaves)
      const childLeaves = yield* resolveLeaves(childRelPath, libDir)
      results.push(...childLeaves)
    }

    return results
  })

/**
 * List all skills in the library (recursive tree walk).
 */
export const listLibrary = (dirs?: readonly string[]) =>
  Effect.gen(function* () {
    const searchDirs = dirs ?? [LIBRARY_DIR, projectLibraryDir()]
    const seen = new Set<string>()
    const results: SkillInfo[] = []

    for (const dir of searchDirs) {
      const exists = yield* Effect.tryPromise(async () => {
        const dirStat = await stat(dir)
        return dirStat.isDirectory()
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (!exists) continue

      const leaves = yield* resolveLeaves('', dir)
      for (const leaf of leaves) {
        if (seen.has(leaf.libraryRelPath)) continue
        seen.add(leaf.libraryRelPath)
        results.push(leaf)
      }
    }

    return results
  })

// ── Outfit operations ──────────────────────────────────────────────

/**
 * List all entries in an outfit directory with commitment detection.
 */
export const listOutfit = (scope: Scope) =>
  Effect.gen(function* () {
    const dir = outfitDir(scope)
    const entries = yield* Effect.tryPromise(() => readdir(dir)).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    )

    const results: OutfitEntry[] = []
    for (const name of entries.sort()) {
      const entryPath = path.join(dir, name)
      const entryStat = yield* Effect.tryPromise(() => lstat(entryPath)).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (!entryStat) continue

      if (entryStat.isSymbolicLink()) {
        const target = yield* Effect.tryPromise(() => readlink(entryPath)).pipe(
          Effect.catchAll(() => Effect.succeed('')),
        )
        results.push(
          OutfitEntry.make({
            name,
            dir: entryPath,
            commitment: 'pluggable',
            scope,
            symlinkTarget: target,
          }),
        )
      } else if (entryStat.isDirectory()) {
        results.push(OutfitEntry.make({ name, dir: entryPath, commitment: 'core', scope }))
      }
    }
    return results
  })

/**
 * Check for collision at the given name across relevant scopes.
 * Returns a collision reason string, or null if no collision.
 */
export const checkCollision = (flatName: string, scope: Scope) =>
  Effect.gen(function* () {
    // User outfit always checked (highest priority)
    const userOutfit = yield* listOutfit('user')
    const userEntry = userOutfit.find((e) => e.name === flatName)
    if (userEntry?.commitment === 'core') {
      return 'collides with core skill at user level'
    }

    // When operating at project scope, also check user-level pluggable
    if (scope === 'project') {
      if (userEntry) {
        return 'collides with skill at user level'
      }

      // Check project core
      const projectOutfit = yield* listOutfit('project')
      const projectEntry = projectOutfit.find((e) => e.name === flatName)
      if (projectEntry?.commitment === 'core') {
        return 'collides with core skill at project level'
      }
    }

    return null
  })

// ── Snapshot operations ────────────────────────────────────────────

/**
 * Take a snapshot of the current pluggable outfit state.
 * Returns list of symlink names (pluggable skills that are on).
 */
export const snapshotOutfit = (scope: Scope) =>
  Effect.gen(function* () {
    const outfit = yield* listOutfit(scope)
    return outfit.filter((e) => e.commitment === 'pluggable').map((e) => e.name)
  })

/**
 * Detect generated routers in the outfit.
 * A generated router is a real directory that corresponds to a group name in the library.
 */
export const detectGeneratedRouters = (scope: Scope) =>
  Effect.gen(function* () {
    const outfit = yield* listOutfit(scope)
    const routers: string[] = []
    for (const entry of outfit) {
      if (entry.commitment !== 'core') continue
      // Check if this name corresponds to a group in any accessible library
      for (const libDir of librarySearchOrder(scope)) {
        const libraryPath = path.join(libDir, entry.name)
        const exists = yield* Effect.tryPromise(async () => {
          const entryStat = await lstat(libraryPath)
          return entryStat.isDirectory()
        }).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (exists) {
          const nodeType = yield* getNodeType(libraryPath)
          const routerPath = path.join(outfitDir(scope), entry.name)
          const isGeneratedRouter = yield* isGeneratedRouterDir(routerPath, entry.name)
          if (isGeneratedRouter && (nodeType === 'group' || nodeType === 'callable-group')) {
            routers.push(entry.name)
            break
          }
        }
      }
    }
    return routers
  })

const isGeneratedRouterDir = (routerPath: string, routerName: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() =>
      readdir(routerPath, { withFileTypes: true }),
    ).pipe(Effect.catchAll(() => Effect.succeed([])))
    const visibleEntries = entries.filter((entry) => entry.name !== '.DS_Store')
    if (visibleEntries.length !== 1) return false

    const skillMd = visibleEntries[0]
    if (!skillMd?.isFile() || skillMd.name !== 'SKILL.md') return false

    const frontmatter = yield* readFrontmatter(routerPath)
    return frontmatter?.name === routerName && frontmatter.disableModelInvocation
  })

/**
 * Restore an outfit to match a snapshot.
 * Adds missing symlinks, removes extra ones. Never touches core skills.
 */
export const restoreSnapshot = (
  snapshot: ReadonlyArray<string>,
  generatedRouters: ReadonlyArray<string>,
  scope: Scope,
) =>
  Effect.gen(function* () {
    const dir = outfitDir(scope)
    const currentOutfit = yield* listOutfit(scope)
    const snapshotSet = new Set(snapshot)
    const routerSet = new Set(generatedRouters)

    // Remove symlinks not in snapshot
    for (const entry of currentOutfit) {
      if (entry.commitment !== 'pluggable') continue
      if (!snapshotSet.has(entry.name)) {
        yield* Effect.tryPromise(() => unlink(path.join(dir, entry.name))).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
    }

    // Remove generated routers not in snapshot
    const currentRouters = yield* detectGeneratedRouters(scope)
    for (const router of currentRouters) {
      if (!routerSet.has(router)) {
        yield* Effect.tryPromise(() => rm(path.join(dir, router), { recursive: true })).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
    }

    // Add symlinks from snapshot that are missing
    for (const name of snapshot) {
      const entryPath = path.join(dir, name)
      const exists = yield* Effect.tryPromise(async () => {
        await lstat(entryPath)
        return true
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (!exists) {
        // Reverse-resolve: symlink name → library path (scope-safe — no cross-scope fallthrough)
        // Prefer the canonical unflattened path first, then fall back to the literal
        // name for invalid legacy directories that still need cleanup.
        const libDir = scopeLibraryDir(scope)
        const candidates = legacyLibraryRelPathCandidates(name)
        let resolved = false
        for (const candidate of candidates) {
          const libPath = path.join(libDir, candidate)
          const libExists = yield* Effect.tryPromise(async () => {
            const entryStat = await lstat(libPath)
            return entryStat.isDirectory()
          }).pipe(Effect.catchAll(() => Effect.succeed(false)))
          if (libExists) {
            yield* Effect.tryPromise(() => symlink(libPath, entryPath)).pipe(
              Effect.catchAll((err) =>
                Console.error(`  warn: could not restore ${name}: ${String(err)}`),
              ),
            )
            resolved = true
            break
          }
        }
        if (!resolved) {
          yield* Console.error(`  warn: skipping ${name} — not found in ${scope} library`)
        }
      }
    }

    // Restore generated routers
    for (const router of generatedRouters) {
      const routerPath = path.join(dir, router)
      const exists = yield* Effect.tryPromise(async () => {
        await lstat(routerPath)
        return true
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (!exists) {
        // Re-generate the router (scope-safe — no cross-scope fallthrough)
        const routerLibDir = scopeLibraryDir(scope)
        const libPath = path.join(routerLibDir, router)
        const libExists = yield* Effect.tryPromise(async () => {
          const entryStat = await lstat(libPath)
          return entryStat.isDirectory()
        }).pipe(Effect.catchAll(() => Effect.succeed(false)))

        if (libExists) {
          const leaves = yield* resolveLeaves(router, routerLibDir)
          const routerContent = generateRouter(router, leaves)
          yield* Effect.tryPromise(() => mkdir(routerPath, { recursive: true }))
          yield* Effect.tryPromise(() =>
            writeFile(path.join(routerPath, 'SKILL.md'), routerContent),
          )
        }
      }
    }

    // Sync gitignore for project scope: set entries to match restored snapshot
    if (scope === 'project') {
      yield* setGitignoreEntries(
        getRuntimeConfig().projectRoot,
        snapshot.map((n) => `.claude/skills/${n}`),
      )
    }
  })

// ── Auto-router generation ─────────────────────────────────────────

/**
 * Generate a namespace router SKILL.md for a top-level group.
 */
export const generateRouter = (groupName: string, children: SkillInfo[]): string => {
  const childNames = children.map((c) => c.colonName).join(', ')
  const childLines = children
    .map((c) => {
      const hint = c.frontmatter?.argumentHint ? ` \`${c.frontmatter.argumentHint}\`` : ''
      const desc = c.frontmatter?.description ?? '(no description)'
      return `- **${c.colonName}**${hint} — ${desc}`
    })
    .join('\n')

  return `---
name: ${groupName}
description: "${groupName} namespace. Routes to sub-skills: ${childNames}."
disable-model-invocation: true
---

# ${groupName}

Available sub-skills:

${childLines}

Interpret the user's request and route to the most appropriate sub-skill above.
If the user's intent is unclear, present the options and ask which they need.
`
}

// ── Gitignore management ───────────────────────────────────────────

const GITIGNORE_START = '# shan-managed (do not edit)'
const GITIGNORE_END = '# end shan-managed'

/**
 * Add entries to the shan-managed section of a project's .gitignore.
 */
export const manageGitignore = (projectRoot: string, newEntries: string[]) =>
  Effect.gen(function* () {
    const gitignorePath = path.join(projectRoot, '.gitignore')
    let content = yield* Effect.tryPromise(() => readFile(gitignorePath, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed('')),
    )

    // Parse existing shan-managed entries
    const startIdx = content.indexOf(GITIGNORE_START)
    const endIdx = content.indexOf(GITIGNORE_END)

    let existingEntries: string[] = []
    let before = content
    let after = ''

    if (startIdx !== -1 && endIdx !== -1) {
      before = content.slice(0, startIdx)
      after = content.slice(endIdx + GITIGNORE_END.length)
      const managed = content.slice(startIdx + GITIGNORE_START.length, endIdx)
      existingEntries = managed
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    }

    // Merge and sort
    const allEntries = [...new Set([...existingEntries, ...newEntries])].sort()

    if (allEntries.length === 0) {
      if (startIdx === -1 || endIdx === -1) return
      const trimmedBefore = before.trimEnd()
      const trimmedAfter = after.trimStart()
      const newContent = [trimmedBefore, trimmedAfter].filter(Boolean).join('\n\n')
      yield* Effect.tryPromise(() => writeFile(gitignorePath, newContent.trimEnd() + '\n'))
      return
    }

    // Rebuild content
    const managedSection = `${GITIGNORE_START}\n${allEntries.join('\n')}\n${GITIGNORE_END}`

    // Ensure before ends with newline
    const trimmedBefore = before.trimEnd()
    const newContent = trimmedBefore
      ? `${trimmedBefore}\n\n${managedSection}${after}`
      : `${managedSection}${after}`

    yield* Effect.tryPromise(() => writeFile(gitignorePath, newContent.trimEnd() + '\n'))
  })

/** Remove entries from the shan-managed .gitignore section. If no entries remain, remove the section. */
export const manageGitignoreRemove = (projectRoot: string, entriesToRemove: string[]) =>
  Effect.gen(function* () {
    const gitignorePath = path.join(projectRoot, '.gitignore')
    const content = yield* Effect.tryPromise(() => readFile(gitignorePath, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed('')),
    )

    const startIdx = content.indexOf(GITIGNORE_START)
    const endIdx = content.indexOf(GITIGNORE_END)
    if (startIdx === -1 || endIdx === -1) return

    const before = content.slice(0, startIdx)
    const after = content.slice(endIdx + GITIGNORE_END.length)
    const managed = content.slice(startIdx + GITIGNORE_START.length, endIdx)
    const existingEntries = managed
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const removeSet = new Set(entriesToRemove)
    const remaining = existingEntries.filter((e) => !removeSet.has(e))

    if (remaining.length === 0) {
      // Remove the entire section
      const newContent = (before.trimEnd() + after).trimEnd()
      yield* Effect.tryPromise(() => writeFile(gitignorePath, newContent ? newContent + '\n' : ''))
    } else {
      const managedSection = `${GITIGNORE_START}\n${remaining.join('\n')}\n${GITIGNORE_END}`
      const trimmedBefore = before.trimEnd()
      const newContent = trimmedBefore
        ? `${trimmedBefore}\n\n${managedSection}${after}`
        : `${managedSection}${after}`
      yield* Effect.tryPromise(() => writeFile(gitignorePath, newContent.trimEnd() + '\n'))
    }
  })

/** Replace the shan-managed gitignore section with exactly the given entries. Empty array removes the section. */
export const setGitignoreEntries = (projectRoot: string, entries: string[]) =>
  Effect.gen(function* () {
    const gitignorePath = path.join(projectRoot, '.gitignore')
    const content = yield* Effect.tryPromise(() => readFile(gitignorePath, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed('')),
    )

    const startIdx = content.indexOf(GITIGNORE_START)
    const endIdx = content.indexOf(GITIGNORE_END)

    let before = content
    let after = ''
    if (startIdx !== -1 && endIdx !== -1) {
      before = content.slice(0, startIdx)
      after = content.slice(endIdx + GITIGNORE_END.length)
    }

    if (entries.length === 0) {
      // Remove the entire section
      const newContent = (before.trimEnd() + after).trimEnd()
      yield* Effect.tryPromise(() => writeFile(gitignorePath, newContent ? newContent + '\n' : ''))
    } else {
      const sorted = [...new Set(entries)].sort()
      const managedSection = `${GITIGNORE_START}\n${sorted.join('\n')}\n${GITIGNORE_END}`
      const trimmedBefore = before.trimEnd()
      const newContent = trimmedBefore
        ? `${trimmedBefore}\n\n${managedSection}${after}`
        : `${managedSection}${after}`
      yield* Effect.tryPromise(() => writeFile(gitignorePath, newContent.trimEnd() + '\n'))
    }
  })

/**
 * Read current shan-managed gitignore entries.
 */
export const readGitignoreEntries = (projectRoot: string) =>
  Effect.gen(function* () {
    const gitignorePath = path.join(projectRoot, '.gitignore')
    const content = yield* Effect.tryPromise(() => readFile(gitignorePath, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed('')),
    )

    const startIdx = content.indexOf(GITIGNORE_START)
    const endIdx = content.indexOf(GITIGNORE_END)

    if (startIdx === -1 || endIdx === -1) return []

    const managed = content.slice(startIdx + GITIGNORE_START.length, endIdx)
    return managed
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  })

// ── Output helpers ─────────────────────────────────────────────────

export const printTable = (rows: readonly (readonly string[])[]) =>
  Effect.gen(function* () {
    if (rows.length === 0) return
    const firstRow = rows[0]
    if (!firstRow) return
    const widths = firstRow.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)))
    for (const row of rows) {
      const line = row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')
      yield* Console.log(line)
    }
  })

// ── Parse batch targets ────────────────────────────────────────────

/** Parse comma-separated targets, trimming whitespace. */
export const parseTargets = (input: string): string[] => [
  ...new Set(
    input
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
]
