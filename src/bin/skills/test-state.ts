import { afterAll } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'

const STATE_FILE = path.join(homedir(), '.claude', 'shan', 'state.json')

export const registerStateFileRestore = async () => {
  const originalState = await readFile(STATE_FILE, 'utf-8').catch(() => null)

  afterAll(async () => {
    if (originalState === null) {
      await rm(STATE_FILE, { force: true })
      return
    }

    await mkdir(path.dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, originalState)
  })
}
