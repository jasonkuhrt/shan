import { describe, expect, test } from 'bun:test'
import * as SkillName from './skill-name.js'

describe('skill-name codecs', () => {
  test('frontmatter codec captures namespace structure', () => {
    expect(SkillName.fromFrontmatterName('skills:change')).toEqual({
      namespace: ['skills'],
      leaf: 'change',
    })
  })

  test('flat codec encodes the same underlying name for filesystem usage', () => {
    const name = SkillName.fromFrontmatterName('skills:change')
    expect(SkillName.toFlatName(name)).toBe('skills_change')
  })

  test('library-relative paths round-trip through the same structured name', () => {
    const name = SkillName.fromLibraryRelPath('skills/change')
    expect(SkillName.toFrontmatterName(name)).toBe('skills:change')
    expect(SkillName.toLibraryRelPath(name)).toBe('skills/change')
  })

  test('top-level grouping preserves nested child display', () => {
    const name = SkillName.fromFrontmatterName('skills:change:undo')
    expect(SkillName.topLevelName(name)).toBe('skills')
    expect(SkillName.nestedName(name)).toBe('change:undo')
  })

  test('namespace helpers expose prefixes and namespace display', () => {
    const name = SkillName.fromFrontmatterName('skills:change:undo')
    expect(SkillName.segments(name)).toEqual(['skills', 'change', 'undo'])
    expect(SkillName.namespaceName(name)).toBe('skills:change')
    expect(SkillName.prefixes(name)).toEqual(['skills', 'skills:change'])
  })

  test('separator helpers normalize related names', () => {
    const name = SkillName.fromFrontmatterName('skills:change-undo')
    expect(SkillName.stripSeparators(name)).toBe('skillschangeundo')
    expect(SkillName.flatGroupPrefix('skills')).toBe('skills_')
    expect(SkillName.isFlatNameInGroup('skills_change', 'skills')).toBe(true)
  })

  test('namespace relationship helpers detect shared ancestry', () => {
    const left = SkillName.fromFrontmatterName('skills:change:undo')
    const right = SkillName.fromFrontmatterName('skills:change:redo')
    const unrelated = SkillName.fromFrontmatterName('git:sync')

    expect(SkillName.sharesAnyNamespacePrefix(left, right)).toBe(true)
    expect(SkillName.sharesAnyNamespacePrefix(left, unrelated)).toBe(false)
    expect(SkillName.isUnderTopLevelGroup(left, 'skills')).toBe(true)
  })

  test('safe parsers return null for invalid names', () => {
    expect(SkillName.parseFrontmatterName('skills::change')).toBeNull()
    expect(SkillName.parseFrontmatterName('skills:change_undo')).toBeNull()
    expect(SkillName.parseFrontmatterName('_private:skill')).toBeNull()
    expect(SkillName.parseFlatName('skills__change')).toBeNull()
    expect(SkillName.parseLibraryRelPath('skills/$change')).toBeNull()
  })

  test('flat codec treats underscores as namespace separators', () => {
    const name = SkillName.fromFlatName('my_tool')
    expect(name).toEqual({
      namespace: ['my'],
      leaf: 'tool',
    })
    expect(SkillName.toFrontmatterName(name)).toBe('my:tool')
  })

  test('observed library paths treat underscores as namespace separators too', () => {
    const name = SkillName.parseObservedLibraryRelPath('devin_review')
    expect(name).toEqual({
      namespace: ['devin'],
      leaf: 'review',
    })
    expect(name && SkillName.toFrontmatterName(name)).toBe('devin:review')
  })

  test('observed library paths collapse slash and underscore legacy namespace forms', () => {
    const name = SkillName.parseObservedLibraryRelPath('skills/change_undo')
    expect(name).toEqual({
      namespace: ['skills', 'change'],
      leaf: 'undo',
    })
    expect(name && SkillName.toFrontmatterName(name)).toBe('skills:change:undo')
  })

  test('observed frontmatter names treat underscores as namespace separators for repair', () => {
    const name = SkillName.parseObservedFrontmatterName('skills:change_undo')
    expect(name).toEqual({
      namespace: ['skills', 'change'],
      leaf: 'undo',
    })
    expect(name && SkillName.toFrontmatterName(name)).toBe('skills:change:undo')
  })

  test('observed frontmatter names reject structurally broken separator patterns', () => {
    expect(SkillName.parseObservedFrontmatterName('skills::change')).toBeNull()
    expect(SkillName.parseObservedFrontmatterName('skills__change')).toBeNull()
    expect(SkillName.parseObservedFrontmatterName('_private:skill')).toBeNull()
  })
})
