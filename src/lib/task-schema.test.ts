import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'
import { Task, TaskStatus } from './task-schema.js'

describe('TaskStatus', () => {
  test('decodes all valid statuses', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'deleted'] as const) {
      expect(Schema.decodeUnknownSync(TaskStatus)(status)).toBe(status)
    }
  })
  test('rejects invalid status', () => {
    expect(() => Schema.decodeUnknownSync(TaskStatus)('unknown')).toThrow()
  })
})

describe('Task', () => {
  const validTask = {
    id: '1',
    subject: 'Do thing',
    description: 'A task',
    activeForm: 'Doing thing',
    status: 'pending' as const,
    blocks: ['2'],
    blockedBy: ['3'],
  }

  test('decodes valid task with required fields', () => {
    const result = Schema.decodeUnknownSync(Task)(validTask)
    expect(result.id).toBe('1')
    expect(result.subject).toBe('Do thing')
    expect(result.status).toBe('pending')
    expect(result.blocks).toEqual(['2'])
    expect(result.blockedBy).toEqual(['3'])
  })

  test('decodes with optional owner', () => {
    const result = Schema.decodeUnknownSync(Task)({ ...validTask, owner: 'agent-1' })
    expect(result.owner).toBe('agent-1')
  })

  test('decodes with optional metadata', () => {
    const result = Schema.decodeUnknownSync(Task)({
      ...validTask,
      metadata: { priority: 'high', count: 5 },
    })
    expect(result.metadata).toEqual({ priority: 'high', count: 5 })
  })

  test('decodes with empty blocks arrays', () => {
    const result = Schema.decodeUnknownSync(Task)({ ...validTask, blocks: [], blockedBy: [] })
    expect(result.blocks).toEqual([])
    expect(result.blockedBy).toEqual([])
  })

  test('rejects missing required fields', () => {
    expect(() => Schema.decodeUnknownSync(Task)({ id: '1' })).toThrow()
  })

  test('decodes all status values in task context', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'deleted'] as const) {
      const result = Schema.decodeUnknownSync(Task)({ ...validTask, status })
      expect(result.status).toBe(status)
    }
  })
})
