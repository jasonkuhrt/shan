/**
 * Shared finding types and rendering for all lint rules.
 */

import { Console, Effect } from 'effect'

// ── Types ────────────────────────────────────────────────

export interface Finding {
  file: string
  location: string
  command: string
  severity: 'error' | 'warning'
  rule: string
  message: string
  detail: string
  happyPaths: HappyPath[]
  references: Reference[]
}

export interface HappyPath {
  pattern: string
  example: string
  tradeoff: string
}

export interface Reference {
  label: string
  url: string
}

// ── Rendering ────────────────────────────────────────────

export const renderFinding = (f: Finding) =>
  Effect.gen(function* () {
    const icon = f.severity === 'error' ? '✗' : '!'
    yield* Console.log(`  ${icon} ${f.rule}`)
    yield* Console.log(`    File:    ${f.file}`)
    yield* Console.log(`    At:      ${f.location}`)
    yield* Console.log(`    Command: ${f.command}`)
    yield* Console.log('')
    yield* Console.log(`    ${f.message}:`)
    yield* Console.log(`    ${f.detail}`)
    yield* Console.log('')
    yield* Console.log('    Happy paths:')
    for (const hp of f.happyPaths) {
      yield* Console.log(`      ${hp.pattern}`)
      yield* Console.log(`        e.g. ${hp.example}`)
      yield* Console.log(`        ${hp.tradeoff}`)
    }
    yield* Console.log('')
    yield* Console.log('    References:')
    for (const ref of f.references) {
      yield* Console.log(`      ${ref.url}`)
      yield* Console.log(`        ${ref.label}`)
    }
    yield* Console.log('')
  })

export const renderSummary = (findings: Finding[]) =>
  Effect.gen(function* () {
    const errors = findings.filter((f) => f.severity === 'error').length
    const warnings = findings.filter((f) => f.severity === 'warning').length
    const parts: string[] = []
    if (errors > 0) parts.push(`${errors} error${errors > 1 ? 's' : ''}`)
    if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`)
    yield* Console.log(`lint: ${parts.length > 0 ? parts.join(', ') : 'all clear'}`)
  })
