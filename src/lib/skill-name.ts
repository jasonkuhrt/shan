import { Effect, ParseResult, Schema } from 'effect'

const SKILL_NAME_SEGMENT_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/

export const SkillNameSegment = Schema.String.pipe(Schema.pattern(SKILL_NAME_SEGMENT_PATTERN))
export type SkillNameSegment = typeof SkillNameSegment.Type

export const SkillName = Schema.Struct({
  namespace: Schema.Array(SkillNameSegment),
  leaf: SkillNameSegment,
})
export type SkillName = typeof SkillName.Type

const parseSegments = (rawSegments: ReadonlyArray<string>): SkillName | null => {
  if (rawSegments.length === 0) return null
  if (!rawSegments.every((segment) => SKILL_NAME_SEGMENT_PATTERN.test(segment))) return null

  const segments = [...rawSegments]
  const leaf = segments.pop()
  if (!leaf) return null

  return {
    namespace: segments,
    leaf,
  }
}

const invalidNameIssue = (representation: 'frontmatter' | 'flat', actual: string) =>
  new ParseResult.Unexpected(
    actual,
    `Invalid ${representation} skill name: ${actual}. Expected non-empty segments matching ${SKILL_NAME_SEGMENT_PATTERN.source}.`,
  )

const makeDelimitedCodec = (separator: ':' | '_', representation: 'frontmatter' | 'flat') =>
  Schema.transformOrFail(Schema.String, SkillName, {
    decode: (value) => {
      const parsed = parseSegments(value.split(separator))
      return parsed ? Effect.succeed(parsed) : Effect.fail(invalidNameIssue(representation, value))
    },
    encode: (_encoded, _options, _ast, value) => Effect.succeed(segments(value).join(separator)),
  })

export const SkillNameFromFrontmatter = makeDelimitedCodec(':', 'frontmatter')
export const SkillNameFromFlat = makeDelimitedCodec('_', 'flat')

const decodeFrontmatterNameSync = Schema.decodeUnknownSync(SkillNameFromFrontmatter)
const encodeFrontmatterNameSync = Schema.encodeSync(SkillNameFromFrontmatter)
const decodeFlatNameSync = Schema.decodeUnknownSync(SkillNameFromFlat)
const encodeFlatNameSync = Schema.encodeSync(SkillNameFromFlat)

export const segments = (name: SkillName): readonly [string, ...string[]] => {
  if (name.namespace.length === 0) return [name.leaf]

  const [head, ...tail] = name.namespace
  if (head === undefined) return [name.leaf]
  return [head, ...tail, name.leaf]
}

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

export const fromFrontmatterName = (value: string): SkillName => decodeFrontmatterNameSync(value)

export const fromFlatName = (value: string): SkillName => decodeFlatNameSync(value)

export const parseFrontmatterName = (value: string): SkillName | null => {
  try {
    return fromFrontmatterName(value)
  } catch {
    return null
  }
}

export const parseFlatName = (value: string): SkillName | null => {
  try {
    return fromFlatName(value)
  } catch {
    return null
  }
}

export const fromLibraryRelPath = (relPath: string): SkillName => {
  const parsed = parseSegments(relPath.split('/').filter(Boolean))
  if (!parsed) {
    throw new Error(`Invalid library skill path: ${relPath}`)
  }
  return parsed
}

export const parseLibraryRelPath = (relPath: string): SkillName | null => {
  try {
    return fromLibraryRelPath(relPath)
  } catch {
    return null
  }
}

export const toLibraryRelPath = (name: SkillName): string => segments(name).join('/')

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
