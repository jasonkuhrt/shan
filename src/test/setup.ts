import { afterAll, afterEach, beforeEach } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { replaceRuntimeConfigOverrides } from '../lib/runtime-config.js'

const workerInitialCwd = process.cwd()
const workerInitialHome = process.env['HOME']

const bootstrapRootRaw = await mkdtemp(path.join(tmpdir(), 'shan-test-env-'))
const bootstrapRoot = realpathSync(bootstrapRootRaw)
const bootstrapHome = path.join(bootstrapRoot, 'home')
const bootstrapProject = path.join(bootstrapRoot, 'bootstrap-project')

await mkdir(bootstrapHome, { recursive: true })
await mkdir(bootstrapProject, { recursive: true })

replaceRuntimeConfigOverrides({ homeDir: bootstrapHome })
process.env['HOME'] = bootstrapHome
process.chdir(bootstrapProject)

let activeProjectRoot: string | null = null

const resetHomeState = async () => {
  await Promise.all(
    ['.claude', '.codex', '.config', '.local'].map((entry) =>
      rm(path.join(bootstrapHome, entry), { recursive: true, force: true }),
    ),
  )
}

const createActiveProjectRoot = async () => {
  const rawProjectRoot = await mkdtemp(path.join(bootstrapRoot, 'project-'))
  return realpathSync(rawProjectRoot)
}

beforeEach(async () => {
  await resetHomeState()

  if (activeProjectRoot) {
    await rm(activeProjectRoot, { recursive: true, force: true })
  }

  activeProjectRoot = await createActiveProjectRoot()
  replaceRuntimeConfigOverrides({ homeDir: bootstrapHome })
  process.env['HOME'] = bootstrapHome
  process.chdir(activeProjectRoot)
})

afterEach(async () => {
  process.chdir(bootstrapProject)

  if (activeProjectRoot) {
    await rm(activeProjectRoot, { recursive: true, force: true })
    activeProjectRoot = null
  }

  await resetHomeState()
  replaceRuntimeConfigOverrides({ homeDir: bootstrapHome })
  process.env['HOME'] = bootstrapHome
})

afterAll(async () => {
  process.chdir(workerInitialCwd)
  if (workerInitialHome === undefined) {
    delete process.env['HOME']
  } else {
    process.env['HOME'] = workerInitialHome
  }
  await rm(bootstrapRoot, { recursive: true, force: true })
})
