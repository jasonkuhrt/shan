/**
 * Shared diagnostic type used by both doctor (proactive lint) and normal
 * operations (incidental encounter). See `.claude/rules/unified-diagnostics.md`.
 */

import type { Effect } from 'effect'

export type DiagnosticLevel = 'error' | 'warning' | 'info'

export interface Diagnostic {
  readonly aspect: string
  readonly level: DiagnosticLevel
  readonly message: string
  readonly fixable: boolean
  readonly fix?: () => Effect.Effect<string, unknown>
}

/** Shared aspect name — used by both doctor and loadActiveSkills. */
export const INVALID_OUTFIT_ENTRY_ASPECT = 'invalid-outfit-entry' as const
