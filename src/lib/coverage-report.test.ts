import { describe, expect, test } from 'bun:test'

import {
  formatCoveragePercent,
  getCoverageHotspots,
  parseCoverageReport,
} from './coverage-report.js'

const SAMPLE_REPORT = `
--------------------------------|---------|---------|-------------------
File                            | % Funcs | % Lines | Uncovered Line #s
--------------------------------|---------|---------|-------------------
All files                       |   96.66 |   97.97 |
 src/bin/shan.ts                |   90.00 |   97.42 | 262-263,288,293
 src/bin/skills/install.ts      |   87.50 |   72.22 | 44-74,103-105
 src/lib/transcript-parser.ts   |  100.00 |  100.00 |
--------------------------------|---------|---------|-------------------
`.trim()

describe('parseCoverageReport', () => {
  test('parses the overall coverage summary and file rows', () => {
    const report = parseCoverageReport(SAMPLE_REPORT)

    expect(report).not.toBeNull()
    expect(report?.summary.functions).toBe(96.66)
    expect(report?.summary.lines).toBe(97.97)
    expect(report?.rows).toHaveLength(3)
    expect(report?.rows[1]).toEqual({
      file: 'src/bin/skills/install.ts',
      functions: 87.5,
      lines: 72.22,
      uncovered: '44-74,103-105',
    })
  })

  test('returns null when the overall row is missing', () => {
    expect(parseCoverageReport('src/bin/foo.ts | 99.0 | 99.0 |')).toBeNull()
  })
})

describe('getCoverageHotspots', () => {
  test('returns files below the requested target ordered by weakest coverage first', () => {
    const report = parseCoverageReport(SAMPLE_REPORT)
    expect(report).not.toBeNull()
    if (!report) throw new Error('expected coverage report')

    const hotspots = getCoverageHotspots(report, 95)

    expect(hotspots.map((row) => row.file)).toEqual([
      'src/bin/skills/install.ts',
      'src/bin/shan.ts',
    ])
  })
})

describe('formatCoveragePercent', () => {
  test('formats to two decimal places', () => {
    expect(formatCoveragePercent(95)).toBe('95.00%')
  })
})
