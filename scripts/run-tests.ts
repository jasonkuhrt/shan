#!/usr/bin/env bun

const coverage = process.argv.includes('--coverage')
const args = coverage
  ? [
      'test',
      '--coverage',
      // Serialize coverage runs so Bun workers produce deterministic lcov output.
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

process.exit(exitCode)
