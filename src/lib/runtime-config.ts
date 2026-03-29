import { homedir } from 'node:os'
import * as path from 'node:path'

export const CANONICAL_AGENT = 'claude' as const
export const AGENT_ORDER = [CANONICAL_AGENT, 'codex'] as const
export type RuntimeAgent = (typeof AGENT_ORDER)[number]

export const AGENT_PROBE_COMMANDS: Readonly<Record<RuntimeAgent, string>> = {
  claude: 'claude',
  codex: 'codex',
}

export const AGENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export const AGENT_ROOT_DIRS: Readonly<Record<RuntimeAgent, string>> = {
  claude: '.claude',
  codex: '.codex',
}

export interface RuntimeConfigOverrides {
  readonly homeDir?: string
  readonly projectRoot?: string
}

export interface RuntimePaths {
  readonly userClaudeDir: string
  readonly projectClaudeDir: string
  readonly userCodexDir: string
  readonly projectCodexDir: string
  readonly userLibraryDir: string
  readonly projectLibraryDir: string
  readonly userClaudeSkillsDir: string
  readonly projectClaudeSkillsDir: string
  readonly userCodexSkillsDir: string
  readonly projectCodexSkillsDir: string
  readonly shanDir: string
  readonly stateFile: string
  readonly configDir: string
  readonly configFile: string
  readonly legacyConfigFile: string
  readonly cacheDir: string
  readonly cacheFile: string
  readonly claudeProjectsDir: string
  readonly tasksDir: string
  readonly transcriptOutputDir: string
  readonly projectTasksDir: string
  readonly legacySkillInventoryDir: string
  readonly legacySkillLoadoutsFile: string
}

export interface RuntimeConfig {
  readonly homeDir: string
  readonly projectRoot: string
  readonly agents: {
    readonly canonical: typeof CANONICAL_AGENT
    readonly order: typeof AGENT_ORDER
    readonly probeCommands: typeof AGENT_PROBE_COMMANDS
    readonly cacheTtlMs: typeof AGENT_CACHE_TTL_MS
    readonly rootDirs: typeof AGENT_ROOT_DIRS
  }
  readonly paths: RuntimePaths
}

type RuntimeConfigListener = (config: RuntimeConfig) => void

let runtimeOverrides: RuntimeConfigOverrides = {}
const listeners = new Set<RuntimeConfigListener>()

const resolveHomeDir = (): string => runtimeOverrides.homeDir ?? process.env['HOME'] ?? homedir()

const resolveProjectRoot = (): string => runtimeOverrides.projectRoot ?? process.cwd()

const buildRuntimeConfig = (): RuntimeConfig => {
  const homeDir = resolveHomeDir()
  const projectRoot = resolveProjectRoot()
  const userClaudeDir = path.join(homeDir, AGENT_ROOT_DIRS['claude'])
  const projectClaudeDir = path.join(projectRoot, AGENT_ROOT_DIRS['claude'])
  const userCodexDir = path.join(homeDir, AGENT_ROOT_DIRS['codex'])
  const projectCodexDir = path.join(projectRoot, AGENT_ROOT_DIRS['codex'])
  const shanDir = path.join(userClaudeDir, 'shan')
  const configDir = path.join(homeDir, '.config', 'shan')
  const cacheDir = path.join(homeDir, '.local', 'shan')

  return {
    homeDir,
    projectRoot,
    agents: {
      canonical: CANONICAL_AGENT,
      order: AGENT_ORDER,
      probeCommands: AGENT_PROBE_COMMANDS,
      cacheTtlMs: AGENT_CACHE_TTL_MS,
      rootDirs: AGENT_ROOT_DIRS,
    },
    paths: {
      userClaudeDir,
      projectClaudeDir,
      userCodexDir,
      projectCodexDir,
      userLibraryDir: path.join(userClaudeDir, 'skills-library'),
      projectLibraryDir: path.join(projectClaudeDir, 'skills-library'),
      userClaudeSkillsDir: path.join(userClaudeDir, 'skills'),
      projectClaudeSkillsDir: path.join(projectClaudeDir, 'skills'),
      userCodexSkillsDir: path.join(userCodexDir, 'skills'),
      projectCodexSkillsDir: path.join(projectCodexDir, 'skills'),
      shanDir,
      stateFile: path.join(shanDir, 'state.json'),
      configDir,
      configFile: path.join(configDir, 'config.json'),
      legacyConfigFile: path.join(shanDir, 'config.json'),
      cacheDir,
      cacheFile: path.join(cacheDir, 'cache.json'),
      claudeProjectsDir: path.join(userClaudeDir, 'projects'),
      tasksDir: path.join(userClaudeDir, 'tasks'),
      transcriptOutputDir: path.join(projectClaudeDir, 'transcripts'),
      projectTasksDir: path.join(projectClaudeDir, 'tasks'),
      legacySkillInventoryDir: path.join(userClaudeDir, 'skill-inventory'),
      legacySkillLoadoutsFile: path.join(userClaudeDir, 'skill-loadouts.yml'),
    },
  }
}

const notifyRuntimeConfigListeners = () => {
  const config = buildRuntimeConfig()
  for (const listener of listeners) {
    listener(config)
  }
}

export const getRuntimeConfig = (): RuntimeConfig => buildRuntimeConfig()

export const setRuntimeConfigOverrides = (overrides: RuntimeConfigOverrides): RuntimeConfig => {
  runtimeOverrides = { ...runtimeOverrides, ...overrides }
  notifyRuntimeConfigListeners()
  return getRuntimeConfig()
}

export const replaceRuntimeConfigOverrides = (overrides: RuntimeConfigOverrides): RuntimeConfig => {
  runtimeOverrides = { ...overrides }
  notifyRuntimeConfigListeners()
  return getRuntimeConfig()
}

export const resetRuntimeConfigOverrides = (): RuntimeConfig => {
  runtimeOverrides = {}
  notifyRuntimeConfigListeners()
  return getRuntimeConfig()
}

export const onRuntimeConfigChange = (listener: RuntimeConfigListener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const agentRootDirFor = (scope: 'user' | 'project', agent: RuntimeAgent): string => {
  const config = getRuntimeConfig()
  const baseDir = scope === 'user' ? config.homeDir : config.projectRoot
  return path.join(baseDir, config.agents.rootDirs[agent])
}

export const agentOutfitDirFor = (scope: 'user' | 'project', agent: RuntimeAgent): string =>
  path.join(agentRootDirFor(scope, agent), 'skills')
