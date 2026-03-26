import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'
import {
  ReadInput,
  WriteInput,
  EditInput,
  BashInput,
  GrepInput,
  GlobInput,
  WebSearchInput,
  WebFetchInput,
  TaskInput,
  LSPInput,
  SkillInput,
  NotebookEditInput,
  ToolInputSchemas,
  isKnownTool,
  decodeToolInput,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  ContentBlock,
  Usage,
  UserMessage,
  AssistantMessage,
  UserEntry,
  AssistantEntry,
  SummaryEntry,
  SystemEntry,
  ProgressEntry,
  FileHistoryEntry,
  QueueOperationEntry,
  TranscriptEntry,
} from './transcript-schema.js'

// ── Tool Input Schemas ──────────────────────────────────────────

describe('ReadInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(ReadInput)({ file_path: '/foo.ts' })
    expect(result.file_path).toBe('/foo.ts')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(ReadInput)({
      file_path: '/foo.ts',
      offset: 10,
      limit: 50,
    })
    expect(result.offset).toBe(10)
    expect(result.limit).toBe(50)
  })
})

describe('WriteInput', () => {
  test('decodes valid data', () => {
    const result = Schema.decodeUnknownSync(WriteInput)({ file_path: '/foo.ts', content: 'hello' })
    expect(result.file_path).toBe('/foo.ts')
    expect(result.content).toBe('hello')
  })
})

describe('EditInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(EditInput)({
      file_path: '/f',
      old_string: 'a',
      new_string: 'b',
    })
    expect(result.file_path).toBe('/f')
  })
  test('decodes with replace_all', () => {
    const result = Schema.decodeUnknownSync(EditInput)({
      file_path: '/f',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    })
    expect(result.replace_all).toBe(true)
  })
})

describe('BashInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(BashInput)({ command: 'ls' })
    expect(result.command).toBe('ls')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(BashInput)({
      command: 'ls',
      description: 'list',
      timeout: 30,
    })
    expect(result.description).toBe('list')
    expect(result.timeout).toBe(30)
  })
})

describe('GrepInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(GrepInput)({ pattern: 'foo' })
    expect(result.pattern).toBe('foo')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(GrepInput)({
      pattern: 'foo',
      path: '/src',
      glob: '*.ts',
    })
    expect(result.path).toBe('/src')
    expect(result.glob).toBe('*.ts')
  })
})

describe('GlobInput', () => {
  test('decodes valid data', () => {
    const result = Schema.decodeUnknownSync(GlobInput)({ pattern: '**/*.ts' })
    expect(result.pattern).toBe('**/*.ts')
  })
  test('decodes with optional path', () => {
    const result = Schema.decodeUnknownSync(GlobInput)({ pattern: '**/*.ts', path: '/src' })
    expect(result.path).toBe('/src')
  })
})

describe('WebSearchInput', () => {
  test('decodes valid data', () => {
    const result = Schema.decodeUnknownSync(WebSearchInput)({ query: 'effect ts' })
    expect(result.query).toBe('effect ts')
  })
})

describe('WebFetchInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(WebFetchInput)({ url: 'https://example.com' })
    expect(result.url).toBe('https://example.com')
  })
  test('decodes with optional prompt', () => {
    const result = Schema.decodeUnknownSync(WebFetchInput)({
      url: 'https://example.com',
      prompt: 'summarize',
    })
    expect(result.prompt).toBe('summarize')
  })
})

describe('TaskInput', () => {
  test('decodes with no optional fields', () => {
    const result = Schema.decodeUnknownSync(TaskInput)({})
    expect(result).toEqual({})
  })
  test('decodes with all optional fields', () => {
    const result = Schema.decodeUnknownSync(TaskInput)({
      description: 'do thing',
      prompt: 'run tests',
      subagent_type: 'Explore',
    })
    expect(result.description).toBe('do thing')
    expect(result.prompt).toBe('run tests')
    expect(result.subagent_type).toBe('Explore')
  })
})

describe('LSPInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(LSPInput)({ operation: 'hover', filePath: '/f.ts' })
    expect(result.operation).toBe('hover')
    expect(result.filePath).toBe('/f.ts')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(LSPInput)({
      operation: 'hover',
      filePath: '/f.ts',
      line: 5,
      character: 10,
    })
    expect(result.line).toBe(5)
    expect(result.character).toBe(10)
  })
})

describe('SkillInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(SkillInput)({ skill: 'commit' })
    expect(result.skill).toBe('commit')
  })
  test('decodes with optional args', () => {
    const result = Schema.decodeUnknownSync(SkillInput)({ skill: 'commit', args: '--amend' })
    expect(result.args).toBe('--amend')
  })
})

describe('NotebookEditInput', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(NotebookEditInput)({
      notebook_path: '/nb.ipynb',
      new_source: 'print(1)',
    })
    expect(result.notebook_path).toBe('/nb.ipynb')
    expect(result.new_source).toBe('print(1)')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(NotebookEditInput)({
      notebook_path: '/nb.ipynb',
      new_source: 'print(1)',
      cell_type: 'code',
      edit_mode: 'replace',
    })
    expect(result.cell_type).toBe('code')
    expect(result.edit_mode).toBe('replace')
  })
})

// ── ToolInputSchemas lookup ─────────────────────────────────────

describe('ToolInputSchemas', () => {
  test('has all known tools', () => {
    const names = Object.keys(ToolInputSchemas)
    expect(names).toEqual([
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch',
      'Task',
      'LSP',
      'Skill',
      'NotebookEdit',
    ])
  })
})

// ── isKnownTool ─────────────────────────────────────────────────

describe('isKnownTool', () => {
  test('returns true for known tools', () => {
    expect(isKnownTool('Read')).toBe(true)
    expect(isKnownTool('Write')).toBe(true)
    expect(isKnownTool('Bash')).toBe(true)
    expect(isKnownTool('NotebookEdit')).toBe(true)
  })
  test('returns false for unknown tools', () => {
    expect(isKnownTool('UnknownTool')).toBe(false)
    expect(isKnownTool('')).toBe(false)
    expect(isKnownTool('mcp__server__tool')).toBe(false)
  })
})

// ── decodeToolInput ─────────────────────────────────────────────

describe('decodeToolInput', () => {
  test('decodes known tool input', () => {
    const block = { type: 'tool_use' as const, id: '1', name: 'Read', input: { file_path: '/foo' } }
    const result = decodeToolInput(block) as { file_path: string }
    expect(result.file_path).toBe('/foo')
  })
  test('returns raw input for unknown tool', () => {
    const input = { custom: 'data' }
    const block = { type: 'tool_use' as const, id: '1', name: 'CustomMCP', input }
    expect(decodeToolInput(block)).toBe(input)
  })
  test('throws for known tool with invalid input', () => {
    const block = { type: 'tool_use' as const, id: '1', name: 'Read', input: { wrong: 'shape' } }
    expect(() => decodeToolInput(block)).toThrow()
  })
})

// ── Content Blocks ──────────────────────────────────────────────

describe('TextBlock', () => {
  test('decodes valid text block', () => {
    const result = Schema.decodeUnknownSync(TextBlock)({ type: 'text', text: 'hello' })
    expect(result.text).toBe('hello')
  })
})

describe('ThinkingBlock', () => {
  test('decodes without signature', () => {
    const result = Schema.decodeUnknownSync(ThinkingBlock)({ type: 'thinking', thinking: 'hmm' })
    expect(result.thinking).toBe('hmm')
  })
  test('decodes with signature', () => {
    const result = Schema.decodeUnknownSync(ThinkingBlock)({
      type: 'thinking',
      thinking: 'hmm',
      signature: 'sig',
    })
    expect(result.signature).toBe('sig')
  })
})

describe('ToolUseBlock', () => {
  test('decodes valid block', () => {
    const result = Schema.decodeUnknownSync(ToolUseBlock)({
      type: 'tool_use',
      id: 'tu_1',
      name: 'Read',
      input: { file_path: '/f' },
    })
    expect(result.id).toBe('tu_1')
    expect(result.name).toBe('Read')
  })
})

describe('ToolResultBlock', () => {
  test('decodes with string content', () => {
    const result = Schema.decodeUnknownSync(ToolResultBlock)({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'file contents',
    })
    expect(result.content).toBe('file contents')
  })
  test('decodes with array content', () => {
    const result = Schema.decodeUnknownSync(ToolResultBlock)({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(Array.isArray(result.content)).toBe(true)
  })
  test('decodes with is_error', () => {
    const result = Schema.decodeUnknownSync(ToolResultBlock)({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'err',
      is_error: true,
    })
    expect(result.is_error).toBe(true)
  })
})

describe('ImageBlock', () => {
  test('decodes valid image block', () => {
    const result = Schema.decodeUnknownSync(ImageBlock)({
      type: 'image',
      source: { media_type: 'image/png', data: 'base64data' },
    })
    expect(result.source.media_type).toBe('image/png')
  })
})

describe('ContentBlock', () => {
  test('decodes text variant', () => {
    const result = Schema.decodeUnknownSync(ContentBlock)({ type: 'text', text: 'hi' })
    expect(result.type).toBe('text')
  })
  test('decodes tool_use variant', () => {
    const result = Schema.decodeUnknownSync(ContentBlock)({
      type: 'tool_use',
      id: '1',
      name: 'Bash',
      input: {},
    })
    expect(result.type).toBe('tool_use')
  })
})

// ── Message structures ──────────────────────────────────────────

describe('Usage', () => {
  test('decodes with required fields', () => {
    const result = Schema.decodeUnknownSync(Usage)({ input_tokens: 100, output_tokens: 50 })
    expect(result.input_tokens).toBe(100)
  })
  test('decodes with all optional fields', () => {
    const result = Schema.decodeUnknownSync(Usage)({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation: { some: 'data' },
      service_tier: 'default',
    })
    expect(result.cache_creation_input_tokens).toBe(10)
    expect(result.service_tier).toBe('default')
  })
})

describe('UserMessage', () => {
  test('decodes with string content', () => {
    const result = Schema.decodeUnknownSync(UserMessage)({ role: 'user', content: 'hello' })
    expect(result.content).toBe('hello')
  })
  test('decodes with array content', () => {
    const result = Schema.decodeUnknownSync(UserMessage)({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(Array.isArray(result.content)).toBe(true)
  })
})

describe('AssistantMessage', () => {
  test('decodes with minimal fields', () => {
    const result = Schema.decodeUnknownSync(AssistantMessage)({
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(result.content).toHaveLength(1)
  })
  test('decodes with all optional fields', () => {
    const result = Schema.decodeUnknownSync(AssistantMessage)({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: 'claude-sonnet-4-20250514',
      id: 'msg_1',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
      type: 'message',
      stop_sequence: null,
    })
    expect(result.model).toBe('claude-sonnet-4-20250514')
    expect(result.stop_sequence).toBe(null)
  })
})

// ── Entry Types ─────────────────────────────────────────────────

const baseFields = {
  uuid: 'u1',
  timestamp: '2024-01-01T00:00:00Z',
}

describe('UserEntry', () => {
  test('decodes valid entry', () => {
    const result = Schema.decodeUnknownSync(UserEntry)({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      ...baseFields,
    })
    expect(result.type).toBe('user')
  })
  test('decodes with optional base fields', () => {
    const result = Schema.decodeUnknownSync(UserEntry)({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      ...baseFields,
      parentUuid: null,
      sessionId: 's1',
      cwd: '/home',
      version: '1.0',
      isSidechain: false,
      userType: 'external',
      gitBranch: 'main',
    })
    expect(result.parentUuid).toBe(null)
    expect(result.sessionId).toBe('s1')
    expect(result.gitBranch).toBe('main')
  })
})

describe('AssistantEntry', () => {
  test('decodes valid entry', () => {
    const result = Schema.decodeUnknownSync(AssistantEntry)({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
      ...baseFields,
    })
    expect(result.type).toBe('assistant')
  })
  test('decodes with requestId', () => {
    const result = Schema.decodeUnknownSync(AssistantEntry)({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
      ...baseFields,
      requestId: 'req_1',
    })
    expect(result.requestId).toBe('req_1')
  })
})

describe('SummaryEntry', () => {
  test('decodes minimal', () => {
    const result = Schema.decodeUnknownSync(SummaryEntry)({
      type: 'summary',
      summary: 'context...',
    })
    expect(result.summary).toBe('context...')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(SummaryEntry)({
      type: 'summary',
      summary: 'context...',
      leafUuid: null,
      timestamp: '2024-01-01T00:00:00Z',
    })
    expect(result.leafUuid).toBe(null)
  })
})

describe('SystemEntry', () => {
  test('decodes valid entry', () => {
    const result = Schema.decodeUnknownSync(SystemEntry)({
      type: 'system',
      ...baseFields,
    })
    expect(result.type).toBe('system')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(SystemEntry)({
      type: 'system',
      ...baseFields,
      subtype: 'init',
      content: 'started',
      level: 'info',
      isMeta: true,
    })
    expect(result.subtype).toBe('init')
    expect(result.isMeta).toBe(true)
  })
})

describe('ProgressEntry', () => {
  test('decodes valid entry', () => {
    const result = Schema.decodeUnknownSync(ProgressEntry)({
      type: 'progress',
      data: { type: 'hook' },
    })
    expect(result.data.type).toBe('hook')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(ProgressEntry)({
      type: 'progress',
      data: { type: 'hook', hookName: 'preToolUse' },
      timestamp: '2024-01-01T00:00:00Z',
      uuid: 'u1',
    })
    expect(result.data.hookName).toBe('preToolUse')
  })
})

describe('FileHistoryEntry', () => {
  test('decodes minimal', () => {
    const result = Schema.decodeUnknownSync(FileHistoryEntry)({ type: 'file-history-snapshot' })
    expect(result.type).toBe('file-history-snapshot')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(FileHistoryEntry)({
      type: 'file-history-snapshot',
      messageId: 'msg_1',
      isSnapshotUpdate: true,
      snapshot: { files: [] },
      timestamp: '2024-01-01T00:00:00Z',
    })
    expect(result.messageId).toBe('msg_1')
    expect(result.isSnapshotUpdate).toBe(true)
  })
})

describe('QueueOperationEntry', () => {
  test('decodes valid entry', () => {
    const result = Schema.decodeUnknownSync(QueueOperationEntry)({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2024-01-01T00:00:00Z',
    })
    expect(result.operation).toBe('enqueue')
  })
  test('decodes with optional fields', () => {
    const result = Schema.decodeUnknownSync(QueueOperationEntry)({
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: '2024-01-01T00:00:00Z',
      sessionId: 's1',
      content: 'msg',
    })
    expect(result.sessionId).toBe('s1')
    expect(result.content).toBe('msg')
  })
})

describe('TranscriptEntry', () => {
  test('decodes user entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      ...baseFields,
    })
    expect(result.type).toBe('user')
  })
  test('decodes assistant entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
      ...baseFields,
    })
    expect(result.type).toBe('assistant')
  })
  test('decodes summary entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'summary',
      summary: 'ctx',
    })
    expect(result.type).toBe('summary')
  })
  test('decodes system entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'system',
      ...baseFields,
    })
    expect(result.type).toBe('system')
  })
  test('decodes progress entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'progress',
      data: { type: 'hook' },
    })
    expect(result.type).toBe('progress')
  })
  test('decodes file-history-snapshot entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'file-history-snapshot',
    })
    expect(result.type).toBe('file-history-snapshot')
  })
  test('decodes queue-operation entry', () => {
    const result = Schema.decodeUnknownSync(TranscriptEntry)({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2024-01-01T00:00:00Z',
    })
    expect(result.type).toBe('queue-operation')
  })
  test('rejects unknown type', () => {
    expect(() =>
      Schema.decodeUnknownSync(TranscriptEntry)({ type: 'alien', ...baseFields }),
    ).toThrow()
  })
})
