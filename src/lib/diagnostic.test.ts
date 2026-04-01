import { describe, expect, test } from 'bun:test'
import { INVALID_OUTFIT_ENTRY_ASPECT } from './diagnostic.js'

describe('diagnostic constants', () => {
  test('INVALID_OUTFIT_ENTRY_ASPECT is the canonical aspect name', () => {
    expect(INVALID_OUTFIT_ENTRY_ASPECT).toBe('invalid-outfit-entry')
  })
})
