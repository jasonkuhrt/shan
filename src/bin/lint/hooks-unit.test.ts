import { describe, expect, test } from 'bun:test'
import { lintHooks } from './hooks.js'
import type { LintContext, SettingsFile } from './context.js'

const makeCtx = (files: SettingsFile[]): LintContext => ({
  home: '/Users/test',
  projectDir: '/Users/test/project',
  settingsFiles: files,
})

const makeFile = (
  data: Record<string, unknown>,
  scope: SettingsFile['scope'] = 'project',
): SettingsFile => ({
  path:
    scope === 'user'
      ? '/Users/test/.claude/settings.json'
      : '/Users/test/project/.claude/settings.json',
  displayPath: scope === 'user' ? '~/.claude/settings.json' : '.claude/settings.json',
  scope,
  data,
})

describe('lintHooks', () => {
  test('returns empty for no settings files', () => {
    expect(lintHooks(makeCtx([]))).toEqual([])
  })

  test('returns empty for absolute hook path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/foo.sh' }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('returns empty for tilde hook path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/foo.sh' }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('returns empty for $VAR path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/foo.sh' }] }],
          },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('returns empty for quoted "$VAR" path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/foo.sh' }],
              },
            ],
          },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test("returns empty for single-quoted '$VAR' path", () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: "'$VAR'/foo.sh" }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('returns empty for bare command (no /)', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hello' }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('returns empty for flag tokens', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cmd --option value' }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('detects relative hook path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/foo.sh' }] }] },
        }),
      ]),
    )
    expect(findings.length).toBe(1)
    expect(findings[0]!.rule).toBe('no-relative-hook-path')
    expect(findings[0]!.severity).toBe('error')
  })

  test('detects ./ relative path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: './scripts/guard.sh' }] }] },
        }),
      ]),
    )
    expect(findings.length).toBe(1)
  })

  test('detects relative path as argument to interpreter', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .claude/check.js' }] }] },
        }),
      ]),
    )
    expect(findings.length).toBe(1)
  })

  test('detects relative statusLine path', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          statusLine: { type: 'command', command: 'scripts/status.sh' },
        }),
      ]),
    )
    expect(findings.length).toBe(1)
    expect(findings[0]!.location).toBe('statusLine')
  })

  test('uses user happy paths for user scope', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile(
          {
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'hooks/foo.sh' }] }] },
          },
          'user',
        ),
      ]),
    )
    expect(findings.length).toBe(1)
    const hasProjectDir = findings[0]!.happyPaths.some((hp) =>
      hp.pattern.includes('$CLAUDE_PROJECT_DIR'),
    )
    expect(hasProjectDir).toBe(false)
  })

  test('uses project happy paths for project scope', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile(
          {
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'hooks/foo.sh' }] }] },
          },
          'project',
        ),
      ]),
    )
    expect(findings.length).toBe(1)
    const hasProjectDir = findings[0]!.happyPaths.some((hp) =>
      hp.pattern.includes('$CLAUDE_PROJECT_DIR'),
    )
    expect(hasProjectDir).toBe(true)
  })

  test('uses project happy paths for project-local scope', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile(
          {
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'hooks/foo.sh' }] }] },
          },
          'project-local',
        ),
      ]),
    )
    expect(findings.length).toBe(1)
    const hasProjectDir = findings[0]!.happyPaths.some((hp) =>
      hp.pattern.includes('$CLAUDE_PROJECT_DIR'),
    )
    expect(hasProjectDir).toBe(true)
  })

  test('skips non-command hooks', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'prompt', command: 'hooks/foo.sh' }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('skips non-array matchers', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: 'not-an-array' },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('skips matchers without hooks array', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ noHooks: true }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('handles missing hooks property', () => {
    const findings = lintHooks(makeCtx([makeFile({})]))
    expect(findings).toEqual([])
  })

  test('handles non-command statusLine', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          statusLine: { type: 'text', text: 'hello' },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('handles statusLine without command string', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          statusLine: { type: 'command', command: 123 },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('handles hooks with non-string command', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 42 }] }] },
        }),
      ]),
    )
    expect(findings).toEqual([])
  })

  test('handles multiple findings across files', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile(
          { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a/b.sh' }] }] } },
          'user',
        ),
        makeFile(
          { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c/d.sh' }] }] } },
          'project',
        ),
      ]),
    )
    expect(findings.length).toBe(2)
  })

  test('handles multiple hooks in same event', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'a/b.sh' },
                  { type: 'command', command: '/ok.sh' },
                ],
              },
              { hooks: [{ type: 'command', command: 'c/d.sh' }] },
            ],
          },
        }),
      ]),
    )
    expect(findings.length).toBe(2)
  })

  test('reports correct location for nested hooks', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: {
            PreToolUse: [
              { hooks: [{ type: 'command', command: '/ok.sh' }] },
              { hooks: [{ type: 'command', command: 'bad/path.sh' }] },
            ],
          },
        }),
      ]),
    )
    expect(findings.length).toBe(1)
    expect(findings[0]!.location).toBe('hooks.PreToolUse[1].hooks[0]')
  })

  test('populates finding detail and message', () => {
    const findings = lintHooks(
      makeCtx([
        makeFile({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'rel/path.sh' }] }] },
        }),
      ]),
    )
    expect(findings[0]!.message).toContain('Relative path')
    expect(findings[0]!.detail).toContain('absolute')
    expect(findings[0]!.references.length).toBeGreaterThan(0)
  })
})
