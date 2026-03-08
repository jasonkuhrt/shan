/**
 * Shared JSONL transcript parser.
 *
 * Uses Effect Schema to decode each JSON line into a typed TranscriptEntry.
 */

import { Console, Effect, Option, Schema } from 'effect'
import { TranscriptEntry } from './transcript-schema.js'

export const parseTranscriptEntries = (text: string) =>
  Effect.gen(function* () {
    const lines = text.trim().split('\n')
    const entries: TranscriptEntry[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.trim()) continue
      const trimmed = line.trim()

      const raw = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: () => new Error(`Invalid JSON at line ${i + 1}`),
      })

      const decoded = Schema.decodeUnknownOption(TranscriptEntry)(raw)
      if (Option.isSome(decoded)) {
        entries.push(decoded.value)
      } else {
        yield* Console.warn(`Unknown entry type at line ${i + 1}`)
      }
    }

    return entries
  })
