import { describe, expect, test } from 'bun:test'
import * as Exports from './index.js'

describe('exports/index', () => {
  test('re-exports task-schema types', () => {
    expect(Exports.Task).toBeDefined()
    expect(Exports.TaskStatus).toBeDefined()
  })

  test('re-exports transcript-schema types', () => {
    expect(Exports.TranscriptEntry).toBeDefined()
    expect(Exports.UserEntry).toBeDefined()
    expect(Exports.AssistantEntry).toBeDefined()
    expect(Exports.SummaryEntry).toBeDefined()
    expect(Exports.SystemEntry).toBeDefined()
    expect(Exports.ProgressEntry).toBeDefined()
    expect(Exports.FileHistoryEntry).toBeDefined()
    expect(Exports.QueueOperationEntry).toBeDefined()
    expect(Exports.TextBlock).toBeDefined()
    expect(Exports.ThinkingBlock).toBeDefined()
    expect(Exports.ToolUseBlock).toBeDefined()
    expect(Exports.ToolResultBlock).toBeDefined()
    expect(Exports.ImageBlock).toBeDefined()
    expect(Exports.ContentBlock).toBeDefined()
    expect(Exports.Usage).toBeDefined()
    expect(Exports.UserMessage).toBeDefined()
    expect(Exports.AssistantMessage).toBeDefined()
    expect(Exports.ToolInputSchemas).toBeDefined()
    expect(Exports.isKnownTool).toBeDefined()
    expect(Exports.decodeToolInput).toBeDefined()
  })
})
