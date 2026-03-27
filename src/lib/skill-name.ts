import { Effect, Either, ParseResult, Schema } from 'effect'

const SKILL_NAME_SEGMENT_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/

export const SkillNameSegment = Schema.String.pipe(Schema.pattern(SKILL_NAME_SEGMENT_PATTERN))
export type SkillNameSegment = typeof SkillNameSegment.Type

export const SkillName = Schema.Struct({
  namespace: Schema.Array(SkillNameSegment),
  leaf: SkillNameSegment,
})
export type SkillName = typeof SkillName.Type

type SkillNameSegments = typeof SkillNameSegmentsSchema.Type

export const segments = (name: SkillName): readonly [string, ...string[]] => {
  if (name.namespace.length === 0) return [name.leaf]

  const [head, ...tail] = name.namespace
  if (head === undefined) return [name.leaf]
  return [head, ...tail, name.leaf]
}

const SkillNameSegmentsSchema = Schema.NonEmptyArray(SkillNameSegment)

const decodeSegmentsEither = Schema.decodeUnknownEither(SkillNameSegmentsSchema)
const encodeSegmentsSync = Schema.encodeSync(SkillNameSegmentsSchema)

const fromSegments = (value: SkillNameSegments): SkillName => {
  const allSegments = [...value]
  const leaf = allSegments.pop()
  if (!leaf) {
    throw new Error('Non-empty skill-name segments unexpectedly had no leaf')
  }
  return {
    namespace: allSegments,
    leaf,
  }
}

const invalidNameIssue = (
  representation: 'frontmatter' | 'flat' | 'library-relative path',
  actual: string,
) =>
  new ParseResult.Unexpected(
    actual,
    `Invalid ${representation} skill name: ${actual}. Expected non-empty segments matching ${SKILL_NAME_SEGMENT_PATTERN.source}.`,
  )

const makeDelimitedCodec = (
  separator: ':' | '_' | '/',
  representation: 'frontmatter' | 'flat' | 'library-relative path',
) =>
  Schema.transformOrFail(Schema.String, SkillName, {
    decode: (value) => {
      const parsed = decodeSegmentsEither(value.split(separator))
      return Either.isRight(parsed)
        ? Effect.succeed(fromSegments(parsed.right))
        : Effect.fail(invalidNameIssue(representation, value))
    },
    encode: (_encoded, _options, _ast, value) =>
      Effect.succeed(encodeSegmentsSync(segments(value)).join(separator)),
  })

export const SkillNameFromFrontmatter = makeDelimitedCodec(':', 'frontmatter')
export const SkillNameFromFlat = makeDelimitedCodec('_', 'flat')
export const SkillNameFromLibraryRelPath = makeDelimitedCodec('/', 'library-relative path')

const decodeFrontmatterNameSync = Schema.decodeUnknownSync(SkillNameFromFrontmatter)
const encodeFrontmatterNameSync = Schema.encodeSync(SkillNameFromFrontmatter)
const decodeFlatNameSync = Schema.decodeUnknownSync(SkillNameFromFlat)
const encodeFlatNameSync = Schema.encodeSync(SkillNameFromFlat)
const decodeLibraryRelPathSync = Schema.decodeUnknownSync(SkillNameFromLibraryRelPath)
const encodeLibraryRelPathSync = Schema.encodeSync(SkillNameFromLibraryRelPath)
const decodeFrontmatterNameEither = Schema.decodeUnknownEither(SkillNameFromFrontmatter)
const decodeFlatNameEither = Schema.decodeUnknownEither(SkillNameFromFlat)
const decodeLibraryRelPathEither = Schema.decodeUnknownEither(SkillNameFromLibraryRelPath)
const OBSERVED_FRONTMATTER_NAME_SEPARATOR_PATTERN = /[:_]/
const OBSERVED_LIBRARY_REL_PATH_SEPARATOR_PATTERN = /[\\/_]/

export const isNamespaced = (name: SkillName): boolean => name.namespace.length > 0

export const topLevelName = (name: SkillName): string => name.namespace[0] ?? name.leaf

export const nestedName = (name: SkillName): string | null => {
  if (!isNamespaced(name)) return null
  return [...name.namespace.slice(1), name.leaf].join(':')
}

export const namespaceName = (name: SkillName): string | null =>
  name.namespace.length > 0 ? name.namespace.join(':') : null

export const prefixes = (name: SkillName): readonly string[] => {
  const allSegments = segments(name)
  return allSegments.slice(0, -1).map((_, depth) => allSegments.slice(0, depth + 1).join(':'))
}

export const stripSeparators = (name: SkillName): string =>
  segments(name).join('').replaceAll(/[_-]/g, '')

export const toFrontmatterName = (name: SkillName): string => encodeFrontmatterNameSync(name)

export const toFlatName = (name: SkillName): string => encodeFlatNameSync(name)

export const toLibraryRelPath = (name: SkillName): string => encodeLibraryRelPathSync(name)

export const fromFrontmatterName = (value: string): SkillName => decodeFrontmatterNameSync(value)

export const fromFlatName = (value: string): SkillName => decodeFlatNameSync(value)

export const fromLibraryRelPath = (relPath: string): SkillName => decodeLibraryRelPathSync(relPath)

const getRightOrNull = <A, E>(result: Either.Either<A, E>): A | null =>
  Either.isRight(result) ? result.right : null

export const parseFrontmatterName = (value: string): SkillName | null =>
  getRightOrNull(decodeFrontmatterNameEither(value))

export const parseFlatName = (value: string): SkillName | null =>
  getRightOrNull(decodeFlatNameEither(value))

export const parseLibraryRelPath = (relPath: string): SkillName | null =>
  getRightOrNull(decodeLibraryRelPathEither(relPath))

export const parseObservedFrontmatterName = (value: string): SkillName | null => {
  const parsed = decodeSegmentsEither(value.split(OBSERVED_FRONTMATTER_NAME_SEPARATOR_PATTERN))
  return Either.isRight(parsed) ? fromSegments(parsed.right) : null
}

export const parseObservedLibraryRelPath = (relPath: string): SkillName | null => {
  const parsed = decodeSegmentsEither(relPath.split(OBSERVED_LIBRARY_REL_PATH_SEPARATOR_PATTERN))
  return Either.isRight(parsed) ? fromSegments(parsed.right) : null
}

export const isUnderTopLevelGroup = (name: SkillName, groupName: string): boolean =>
  isNamespaced(name) && topLevelName(name) === groupName

export const flatGroupPrefix = (groupName: string | SkillName): string => {
  const name = typeof groupName === 'string' ? fromFrontmatterName(groupName) : groupName
  return `${toFlatName(name)}_`
}

export const isFlatNameInGroup = (flatName: string, groupName: string): boolean =>
  flatName.startsWith(flatGroupPrefix(groupName))

export const sharesAnyNamespacePrefix = (left: SkillName, right: SkillName): boolean => {
  const leftPrefixes = new Set(prefixes(left))
  return prefixes(right).some((prefix) => leftPrefixes.has(prefix))
}
