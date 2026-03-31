import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { parseFrontmatterDocument, readFrontmatterDocument } from './skill-frontmatter.js'

const tmpBase = path.join(tmpdir(), 'shan-frontmatter-test')
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

beforeEach(async () => {
  await rm(tmpBase, { force: true, recursive: true })
  await mkdir(tmpBase, { recursive: true })
})

afterAll(async () => {
  await rm(tmpBase, { force: true, recursive: true })
})

describe('parseFrontmatterDocument', () => {
  test('parses dependencies and preserves unknown frontmatter fields', () => {
    const document = parseFrontmatterDocument(`---
name: dispatch
description: Dispatch work
dependencies:
  - cmux
argument-hint: "[prompt]"
custom-field: keep-me
---

# dispatch
`)

    expect(document.frontmatter).toEqual({
      argumentHint: '[prompt]',
      dependencies: ['cmux'],
      description: 'Dispatch work',
      name: 'dispatch',
    })
    expect(document.extras).toEqual({ 'custom-field': 'keep-me' })
    expect(document.issues).toEqual([])
  })

  test('records invalid dependency field shapes without discarding valid core fields', () => {
    const document = parseFrontmatterDocument(`---
name: broken
description: Broken deps
dependencies: nope
---

# broken
`)

    expect(document.frontmatter).toEqual({
      description: 'Broken deps',
      name: 'broken',
    })
    expect(document.issues).toContain(
      'invalid frontmatter field "dependencies" (expected a string array)',
    )
  })

  test('returns an empty parsed document when no frontmatter exists', () => {
    const document = parseFrontmatterDocument('# just markdown\n')

    expect(document.frontmatter).toBeNull()
    expect(document.block).toBeNull()
    expect(document.issues).toEqual([])
  })

  test('records non-object frontmatter as an issue', () => {
    const document = parseFrontmatterDocument(`---
- not
- an
- object
---

# broken
`)

    expect(document.frontmatter).toBeNull()
    expect(document.issues).toContain('frontmatter must be a YAML object')
  })

  test('records invalid optional field shapes while keeping valid required fields', () => {
    const document = parseFrontmatterDocument(`---
name: dispatch
description: Dispatch work
argument-hint: [not, a, string]
disable-model-invocation: nope
when-to-use: [also, wrong]
---

# dispatch
`)

    expect(document.frontmatter).toEqual({
      description: 'Dispatch work',
      name: 'dispatch',
    })
    expect(document.issues).toContain(
      'invalid frontmatter field "argument-hint" (expected a string)',
    )
    expect(document.issues).toContain(
      'invalid frontmatter field "disable-model-invocation" (expected a boolean)',
    )
    expect(document.issues).toContain('invalid frontmatter field "when-to-use" (expected a string)')
  })

  test('records YAML parse failures without throwing', () => {
    const document = parseFrontmatterDocument(`---
name: broken
description: [unterminated
---

# broken
`)

    expect(document.issues.length).toBeGreaterThan(0)
  })

  test('records unexpected parser failures without throwing', () => {
    const document = parseFrontmatterDocument(null as unknown as string)

    expect(document.frontmatter).toBeNull()
    expect(document.extras).toEqual({})
    expect(document.issues.length).toBeGreaterThan(0)
  })
})

describe('readFrontmatterDocument', () => {
  test('returns an empty document when SKILL.md is missing', async () => {
    await expect(
      run(readFrontmatterDocument(path.join(tmpBase, 'missing-skill'))),
    ).resolves.toEqual({
      block: null,
      content: null,
      extras: {},
      frontmatter: null,
      issues: [],
      raw: null,
    })
  })

  test('reads and parses SKILL.md from disk', async () => {
    const skillDir = path.join(tmpBase, 'disk-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: disk-skill
description: From disk
dependencies:
  - cmux
custom-field: keep-me
---

# disk-skill
`,
    )

    const document = await run(readFrontmatterDocument(skillDir))

    expect(document.frontmatter).toEqual({
      dependencies: ['cmux'],
      description: 'From disk',
      name: 'disk-skill',
    })
    expect(document.extras).toEqual({ 'custom-field': 'keep-me' })
  })
})
