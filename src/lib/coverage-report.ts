export interface CoverageRow {
  readonly file: string
  readonly functions: number
  readonly lines: number
  readonly uncovered: string
}

export interface CoverageReport {
  readonly summary: CoverageRow
  readonly rows: CoverageRow[]
}

const COVERAGE_ROW_PATTERN =
  /^\s*([^|]+?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*(.*?)\s*$/

const parseCoverageNumber = (value: string): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const parseCoverageReport = (output: string): CoverageReport | null => {
  const rows: CoverageRow[] = []

  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes('|')) continue
    if (line.includes('% Funcs') || /^-+\|/.test(line.trim())) continue

    const match = COVERAGE_ROW_PATTERN.exec(line)
    if (!match) continue

    const file = match[1]?.trim() ?? ''
    const functions = parseCoverageNumber(match[2] ?? '')
    const lines = parseCoverageNumber(match[3] ?? '')
    const uncovered = match[4]?.trim() ?? ''

    if (!file || functions === null || lines === null) continue

    rows.push({ file, functions, lines, uncovered })
  }

  const summary = rows.find((row) => row.file === 'All files')
  if (!summary) return null

  return {
    summary,
    rows: rows.filter((row) => row.file !== 'All files'),
  }
}

export const getCoverageHotspots = (
  report: CoverageReport,
  target: number,
): ReadonlyArray<CoverageRow> =>
  report.rows
    .filter((row) => row.functions < target || row.lines < target)
    .sort(
      (left, right) =>
        Math.min(left.functions, left.lines) - Math.min(right.functions, right.lines) ||
        left.file.localeCompare(right.file),
    )

export const formatCoveragePercent = (value: number): string => `${value.toFixed(2)}%`
