#!/usr/bin/env bun

import {
  formatCoveragePercent,
  getCoverageHotspots,
  parseCoverageReport,
} from '../src/lib/coverage-report.js'

const DEFAULT_COVERAGE_TARGET = 95
const rawTarget =
  process.argv[2] ?? process.env['SHAN_COVERAGE_TARGET'] ?? String(DEFAULT_COVERAGE_TARGET)
const target = Number(rawTarget)

if (!Number.isFinite(target) || target < 0 || target > 100) {
  console.error(`Coverage target must be a number between 0 and 100. Received: ${rawTarget}`)
  process.exit(1)
}

const proc = Bun.spawn([process.execPath, 'scripts/run-tests.ts', '--coverage'], {
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

const output = [stdout, stderr].filter(Boolean).join('\n')
const report = parseCoverageReport(output)

if (exitCode !== 0) {
  if (!report) {
    process.exit(exitCode)
  }

  console.error('\nCoverage run failed before the overall gate could be evaluated.')
  process.exit(exitCode)
}

if (!report) {
  console.error('Could not parse Bun coverage output.')
  process.exit(1)
}

console.log(
  `\nCoverage gate: overall lines and functions must each be at least ${formatCoveragePercent(target)}.`,
)
console.log(
  `Current overall: ${formatCoveragePercent(report.summary.lines)} lines, ${formatCoveragePercent(report.summary.functions)} functions.`,
)

const hotspots = getCoverageHotspots(report, target)
if (hotspots.length > 0) {
  console.log('\nFiles below target:')
  for (const hotspot of hotspots) {
    const uncovered = hotspot.uncovered ? ` · uncovered ${hotspot.uncovered}` : ''
    console.log(
      `  ${hotspot.file} · ${formatCoveragePercent(hotspot.lines)} lines · ${formatCoveragePercent(hotspot.functions)} functions${uncovered}`,
    )
  }
}

if (report.summary.lines < target || report.summary.functions < target) {
  console.error('\nCoverage target not met.')
  process.exit(1)
}

console.log('\nCoverage target met.')
