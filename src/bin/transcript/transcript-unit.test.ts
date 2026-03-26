import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { transcriptDump } from './dump.js'
import { transcriptAnalyze } from './analyze.js'
import { transcriptPrint } from './print.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// ── Temp filesystem ──────────────────────────────────────────────

const RAW_BASE = path.join(
  tmpdir(),
  `shan-transcript-test-${Math.random().toString(36).slice(2, 8)}`,
)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

// ── UUID generator ───────────────────────────────────────────────

let uuidCounter = 0
const uuid = () => {
  uuidCounter++
  const hex = uuidCounter.toString(16).padStart(8, '0')
  return `${hex}-0000-0000-0000-000000000000`
}

// ── Test transcript entries ──────────────────────────────────────

const userEntry = (text: string, ts = '2025-01-15T10:00:00Z') =>
  JSON.stringify({
    type: 'user',
    uuid: uuid(),
    timestamp: ts,
    message: { role: 'user', content: text },
  })

const userToolResultEntry = (toolUseIds: string[], ts = '2025-01-15T10:00:05Z') =>
  JSON.stringify({
    type: 'user',
    uuid: uuid(),
    timestamp: ts,
    message: {
      role: 'user',
      content: toolUseIds.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: `Result for ${id}`,
      })),
    },
  })

const userTextBlockEntry = (ts = '2025-01-15T10:00:01Z') =>
  JSON.stringify({
    type: 'user',
    uuid: uuid(),
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Block text content' }],
    },
  })

const userEmptyBlockEntry = (ts = '2025-01-15T10:00:02Z') =>
  JSON.stringify({
    type: 'user',
    uuid: uuid(),
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'image', source: { media_type: 'image/png', data: 'abc' } }],
    },
  })

const assistantTextEntry = (ts = '2025-01-15T10:01:00Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid: uuid(),
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello, I can help with that.' }],
    },
  })

const assistantToolEntry = (ts = '2025-01-15T10:01:30Z') => {
  const toolIds = {
    read: 'tu-read',
    bash: 'tu-bash',
    edit: 'tu-edit',
    write: 'tu-write',
    grep: 'tu-grep',
    glob: 'tu-glob',
    ws: 'tu-ws',
    wf: 'tu-wf',
    task: 'tu-task',
    lsp: 'tu-lsp',
    skill: 'tu-skill',
    nb: 'tu-nb',
    read2: 'tu-read2',
    unknown: 'tu-unknown',
  }
  return JSON.stringify({
    type: 'assistant',
    uuid: uuid(),
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolIds.read, name: 'Read', input: { file_path: '/tmp/foo.ts' } },
        { type: 'tool_use', id: toolIds.read2, name: 'Read', input: { file_path: '/tmp/bar.ts' } },
        {
          type: 'tool_use',
          id: toolIds.bash,
          name: 'Bash',
          input: { command: 'echo hello world' },
        },
        {
          type: 'tool_use',
          id: toolIds.edit,
          name: 'Edit',
          input: { file_path: '/tmp/e.ts', old_string: 'old\nline', new_string: 'new\nline' },
        },
        {
          type: 'tool_use',
          id: toolIds.write,
          name: 'Write',
          input: { file_path: '/tmp/w.ts', content: 'x' },
        },
        { type: 'tool_use', id: toolIds.grep, name: 'Grep', input: { pattern: 'foo.*bar' } },
        { type: 'tool_use', id: toolIds.glob, name: 'Glob', input: { pattern: '**/*.ts' } },
        { type: 'tool_use', id: toolIds.ws, name: 'WebSearch', input: { query: 'hello world' } },
        {
          type: 'tool_use',
          id: toolIds.wf,
          name: 'WebFetch',
          input: { url: 'https://example.com' },
        },
        { type: 'tool_use', id: toolIds.task, name: 'Task', input: { description: 'do stuff' } },
        {
          type: 'tool_use',
          id: toolIds.lsp,
          name: 'LSP',
          input: { operation: 'hover', filePath: '/tmp/x.ts' },
        },
        { type: 'tool_use', id: toolIds.skill, name: 'Skill', input: { skill: 'test' } },
        {
          type: 'tool_use',
          id: toolIds.nb,
          name: 'NotebookEdit',
          input: { notebook_path: '/x.ipynb', new_source: 'x' },
        },
        { type: 'tool_use', id: toolIds.unknown, name: 'UnknownTool', input: {} },
      ],
    },
  })
}

const assistantThinkingEntry = (ts = '2025-01-15T10:02:00Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid: uuid(),
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think about this carefully.\nLine 2.' },
        { type: 'text', text: 'After thinking...' },
      ],
    },
  })

const summaryEntry = () =>
  JSON.stringify({
    type: 'summary',
    summary: 'Earlier context was summarized.',
    timestamp: '2025-01-15T10:03:00Z',
  })

const systemEntry = (subtype?: string) =>
  JSON.stringify({
    type: 'system',
    uuid: uuid(),
    timestamp: '2025-01-15T10:04:00Z',
    subtype,
  })

const progressEntry = () =>
  JSON.stringify({
    type: 'progress',
    timestamp: '2025-01-15T10:05:00Z',
    data: { type: 'progress-type', hookName: 'PostToolUse' },
  })

const fileSnapshotEntry = () =>
  JSON.stringify({
    type: 'file-history-snapshot',
    timestamp: '2025-01-15T10:06:00Z',
  })

const queueEntry = () =>
  JSON.stringify({
    type: 'queue-operation',
    timestamp: '2025-01-15T10:07:00Z',
    operation: 'enqueue',
  })

// Build a comprehensive JSONL with all entry types
const buildFullTranscript = () =>
  [
    userEntry('Hello Claude'),
    assistantTextEntry(),
    userToolResultEntry(['tu-x']),
    userTextBlockEntry(),
    userEmptyBlockEntry(),
    assistantToolEntry(),
    assistantThinkingEntry(),
    summaryEntry(),
    systemEntry('init'),
    systemEntry(),
    progressEntry(),
    fileSnapshotEntry(),
    queueEntry(),
  ].join('\n')

// ── Setup / Teardown ─────────────────────────────────────────────

beforeEach(async () => {
  uuidCounter = 0
  // Clean temp dir contents
  try {
    const entries = await readdir(TEMP_DIR)
    for (const e of entries) {
      await rm(path.join(TEMP_DIR, e), { recursive: true, force: true })
    }
  } catch {}
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

// ── transcriptDump ───────────────────────────────────────────────

describe('transcriptDump', () => {
  test('formatted mode processes all entry types', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'test-session.jsonl')
    await writeFile(jsonlPath, buildFullTranscript())

    await run(transcriptDump(jsonlPath))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    expect(files.some((f) => f.endsWith('.transcript.md'))).toBe(true)
  })

  test('raw mode copies JSONL as-is', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'raw-session.jsonl')
    await writeFile(jsonlPath, buildFullTranscript())

    await run(transcriptDump(jsonlPath, { raw: true }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true)
  })
})

// ── transcriptAnalyze ────────────────────────────────────────────

describe('transcriptAnalyze', () => {
  test('analyzes transcript with entries', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'analyze-session.jsonl')
    await writeFile(jsonlPath, buildFullTranscript())

    await run(transcriptAnalyze(jsonlPath))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    expect(files.some((f) => f.endsWith('.viz.txt'))).toBe(true)
  })

  test('fails on empty transcript', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'empty-session.jsonl')
    await writeFile(jsonlPath, '')

    await expect(run(transcriptAnalyze(jsonlPath))).rejects.toThrow('No valid entries')
  })
})

// ── transcriptPrint ──────────────────────────────────────────────

describe('transcriptPrint', () => {
  test('prints basic conversation', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'print-session.jsonl')
    await writeFile(jsonlPath, buildFullTranscript())

    await run(transcriptPrint(jsonlPath))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    expect(files.some((f) => f.endsWith('.print.md'))).toBe(true)
  })

  test('prints with --show=all layers', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'print-all-session.jsonl')
    // Include assistant with tools then tool results and an error result
    const toolEntry = assistantToolEntry()
    const toolResults = userToolResultEntry(['tu-read', 'tu-bash'])
    const errorResult = JSON.stringify({
      type: 'user',
      uuid: uuid(),
      timestamp: '2025-01-15T10:01:32Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-bash',
            content: 'command failed',
            is_error: true,
          },
        ],
      },
    })
    const transcript = [
      userEntry('Hello'),
      toolEntry,
      toolResults,
      errorResult,
      assistantThinkingEntry(),
      summaryEntry(),
    ].join('\n')
    await writeFile(jsonlPath, transcript)

    await run(transcriptPrint(jsonlPath, { show: ['all'] }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    const printFile = files.find((f) => f.endsWith('.print.md'))
    expect(printFile).toBeDefined()
    const content = await readFile(path.join(outputDir, printFile!), 'utf-8')
    expect(content).toContain('Claude')
    // thinking layer
    expect(content).toContain('thinking')
  })

  test('prints with trace layer adds session header', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'print-trace-session.jsonl')
    await writeFile(jsonlPath, [userEntry('Hello'), assistantTextEntry()].join('\n'))

    await run(transcriptPrint(jsonlPath, { show: ['trace'] }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    const printFile = files.find((f) => f.endsWith('.print.md'))
    const content = await readFile(path.join(outputDir, printFile!), 'utf-8')
    expect(content).toContain('session:')
    expect(content).toContain('entries:')
  })

  test('prints with diffs layer expands Edit calls', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'print-diffs-session.jsonl')
    await writeFile(jsonlPath, [userEntry('Fix it'), assistantToolEntry()].join('\n'))

    await run(transcriptPrint(jsonlPath, { show: ['diffs'] }))

    const outputDir = path.join(TEMP_DIR, '.claude', 'transcripts')
    const files = await readdir(outputDir)
    const printFile = files.find((f) => f.endsWith('.print.md'))
    const content = await readFile(path.join(outputDir, printFile!), 'utf-8')
    expect(content).toContain('```diff')
  })

  test('parseShowFlags handles comma-separated and unknown layers', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'print-comma-session.jsonl')
    await writeFile(jsonlPath, [userEntry('Hello'), assistantTextEntry()].join('\n'))

    await run(transcriptPrint(jsonlPath, { show: ['results,thinking', 'unknown'] }))
  })

  test('handles tool result with array content', async () => {
    const jsonlPath = path.join(TEMP_DIR, 'print-array-result-session.jsonl')
    const assistantWithTool = JSON.stringify({
      type: 'assistant',
      uuid: uuid(),
      timestamp: '2025-01-15T10:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-arr', name: 'Read', input: { file_path: '/x' } }],
      },
    })
    const resultWithArray = JSON.stringify({
      type: 'user',
      uuid: uuid(),
      timestamp: '2025-01-15T10:01:01Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-arr',
            content: [{ type: 'text', text: 'File content here' }],
          },
        ],
      },
    })
    await writeFile(
      jsonlPath,
      [userEntry('Read it'), assistantWithTool, resultWithArray].join('\n'),
    )

    await run(transcriptPrint(jsonlPath, { show: ['results'] }))
  })
})
