import { Effect, Either, Schema } from 'effect'
import { readFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'

const FRONTMATTER_BLOCK_PATTERN = /^---\n([\s\S]*?)\n---/

const StringField = Schema.decodeUnknownEither(Schema.String)
const BooleanField = Schema.decodeUnknownEither(Schema.Boolean)
const StringArrayField = Schema.decodeUnknownEither(Schema.Array(Schema.String))

export const SkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  whenToUse: Schema.optional(Schema.String),
  disableModelInvocation: Schema.optional(Schema.Boolean),
  argumentHint: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
})
export type SkillFrontmatter = typeof SkillFrontmatter.Type

export interface SkillFrontmatterDocument {
  readonly block: string | null
  readonly content: string | null
  readonly extras: Readonly<Record<string, unknown>>
  readonly frontmatter: SkillFrontmatter | null
  readonly issues: readonly string[]
  readonly raw: Readonly<Record<string, unknown>> | null
}

const knownFields = new Set([
  'name',
  'description',
  'when-to-use',
  'disable-model-invocation',
  'argument-hint',
  'dependencies',
])

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

const fieldError = (field: string, expected: string): string =>
  `invalid frontmatter field "${field}" (expected ${expected})`

export const extractFrontmatterBlock = (content: string): string | null =>
  content.match(FRONTMATTER_BLOCK_PATTERN)?.[1] ?? null

export const parseFrontmatterDocument = (content: string): SkillFrontmatterDocument => {
  try {
    const block = extractFrontmatterBlock(content)
    if (!block) {
      return {
        block: null,
        content,
        extras: {},
        frontmatter: null,
        issues: [],
        raw: null,
      }
    }

    const document = parseDocument(block)
    const issues = document.errors.map((error) => error.message)
    const raw = asRecord(document.toJS())

    if (!raw) {
      return {
        block,
        content,
        extras: {},
        frontmatter: null,
        issues: [...issues, 'frontmatter must be a YAML object'],
        raw: null,
      }
    }

    const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !knownFields.has(key)))

    const nameValue = raw['name']
    const descriptionValue = raw['description']
    const parsedName = StringField(nameValue)
    const parsedDescription = StringField(descriptionValue)
    const name = Either.isRight(parsedName) ? parsedName.right : null
    const description = Either.isRight(parsedDescription) ? parsedDescription.right : null

    if (name === null) issues.push(fieldError('name', 'a string'))
    if (description === null) issues.push(fieldError('description', 'a string'))

    let whenToUse: string | undefined
    if (raw['when-to-use'] !== undefined) {
      const parsed = StringField(raw['when-to-use'])
      if (Either.isRight(parsed)) whenToUse = parsed.right
      else issues.push(fieldError('when-to-use', 'a string'))
    }

    let disableModelInvocation: boolean | undefined
    if (raw['disable-model-invocation'] !== undefined) {
      const parsed = BooleanField(raw['disable-model-invocation'])
      if (Either.isRight(parsed)) disableModelInvocation = parsed.right
      else issues.push(fieldError('disable-model-invocation', 'a boolean'))
    }

    let argumentHint: string | undefined
    if (raw['argument-hint'] !== undefined) {
      const parsed = StringField(raw['argument-hint'])
      if (Either.isRight(parsed)) argumentHint = parsed.right
      else issues.push(fieldError('argument-hint', 'a string'))
    }

    let dependencies: SkillFrontmatter['dependencies']
    if (raw['dependencies'] !== undefined) {
      const parsed = StringArrayField(raw['dependencies'])
      if (Either.isRight(parsed)) dependencies = parsed.right
      else issues.push(fieldError('dependencies', 'a string array'))
    }

    const frontmatter =
      name !== null && description !== null
        ? ({
            name,
            description,
            ...(whenToUse ? { whenToUse } : {}),
            ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
            ...(argumentHint ? { argumentHint } : {}),
            ...(dependencies ? { dependencies } : {}),
          } satisfies SkillFrontmatter)
        : null

    return {
      block,
      content,
      extras,
      frontmatter,
      issues,
      raw,
    }
  } catch (error) {
    const safeContent = typeof content === 'string' ? content : null
    return {
      block: null,
      content: safeContent,
      extras: {},
      frontmatter: null,
      issues: [error instanceof Error ? error.message : String(error)],
      raw: null,
    }
  }
}

export const readFrontmatterDocument = (skillDir: string) =>
  Effect.gen(function* () {
    const skillMdPath = `${skillDir}/SKILL.md`
    const content = yield* Effect.tryPromise(() => readFile(skillMdPath, 'utf-8')).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (content === null) {
      return {
        block: null,
        content: null,
        extras: {},
        frontmatter: null,
        issues: [],
        raw: null,
      } satisfies SkillFrontmatterDocument
    }
    return parseFrontmatterDocument(content)
  })
