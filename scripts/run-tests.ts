#!/usr/bin/env bun

import { cleanupTestState } from './cleanup-test-state.js'

const coverage = process.argv.includes('--coverage')
const args = coverage
  ? [
      'test',
      '--coverage',
      // Coverage runs share global shan state fixtures, so serialize them for deterministic lcov output.
      '--max-concurrency=1',
      '--coverage-reporter=text',
      '--coverage-reporter=lcov',
      '--coverage-dir=coverage',
      'src',
    ]
  : ['test', 'src']

const proc = Bun.spawn([process.execPath, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdin: 'inherit',
  stdout: 'pipe',
  stderr: 'pipe',
})

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

if (stdout) process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)

await cleanupTestState()

process.exit(exitCode)
