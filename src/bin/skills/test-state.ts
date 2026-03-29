import { afterAll } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'

const stateFile = () => Lib.STATE_FILE

export const registerStateFileRestore = async () => {
  const originalState = await readFile(stateFile(), 'utf-8').catch(() => null)

  afterAll(async () => {
    if (originalState === null) {
      await rm(stateFile(), { force: true })
      return
    }

    await mkdir(path.dirname(stateFile()), { recursive: true })
    await writeFile(stateFile(), originalState)
  })
}
