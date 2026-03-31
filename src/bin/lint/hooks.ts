/**
 * Config doctor rule support — check Claude Code settings for hook path issues.
 *
 * Detects relative paths in hook commands that break when Claude changes
 * the working directory. Reports findings with links to official docs and
 * GitHub issues explaining the correct patterns.
 */

import type { LintContext, SettingsFile } from './context.js'
import type { Finding, HappyPath, Reference } from './finding.js'

// ── Reference Database ───────────────────────────────────

const REFERENCES: Reference[] = [
  {
    label: 'Docs: "Use absolute paths" — Security Best Practices',
    url: 'https://docs.anthropic.com/en/docs/claude-code/hooks',
  },
  {
    label: '#3583 — relative paths fail when cwd changes',
    url: 'https://github.com/anthropics/claude-code/issues/3583',
  },
  {
    label: "#4198 — how to specify relative hook paths (answer: don't)",
    url: 'https://github.com/anthropics/claude-code/issues/4198',
  },
  {
    label: '#22343 — hooks execute with wrong cwd (~ instead of project)',
    url: 'https://github.com/anthropics/claude-code/issues/22343',
  },
  {
    label: '#7925 — statusLine command path affected identically',
    url: 'https://github.com/anthropics/claude-code/issues/7925',
  },
]

const HAPPY_PATHS_PROJECT: HappyPath[] = [
  {
    pattern: '$CLAUDE_PROJECT_DIR prefix',
    example: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/scripts/foo.sh',
    tradeoff: 'Portable across machines. Official recommendation. Must quote in JSON.',
  },
  {
    pattern: '~ home-relative path',
    example: '~/projects/myrepo/.claude/hooks/scripts/foo.sh',
    tradeoff: 'Simple. Works everywhere. Tied to your directory layout.',
  },
  {
    pattern: 'Absolute path',
    example: '/Users/you/projects/myrepo/.claude/hooks/scripts/foo.sh',
    tradeoff: 'Always works. Not portable across machines or users.',
  },
]

const HAPPY_PATHS_USER: HappyPath[] = [
  {
    pattern: '~ home-relative path',
    example: '~/.claude/hooks/scripts/foo.sh',
    tradeoff: 'Natural home for user hooks. Simple and reliable.',
  },
  {
    pattern: 'Absolute path',
    example: '/Users/you/.claude/hooks/scripts/foo.sh',
    tradeoff: 'Always works. Not portable across machines.',
  },
]

// ── Detection ────────────────────────────────────────────

/**
 * Find a relative file path token in a shell command string.
 *
 * A token is considered a relative path if it contains a `/` but does not
 * start with `/`, `~`, `$`, or a quote wrapping a variable. Flags (`-`)
 * and bare command names (no `/`) are skipped.
 */
const findRelativePathToken = (command: string): string | null => {
  const tokens = command.split(/\s+/)
  for (const token of tokens) {
    if (!token) continue
    if (
      token.startsWith('/') ||
      token.startsWith('~') ||
      token.startsWith('$') ||
      token.startsWith('"$') ||
      token.startsWith("'$")
    )
      continue
    if (token.startsWith('-')) continue
    if (!token.includes('/')) continue
    return token
  }
  return null
}

// ── Hook command extraction ──────────────────────────────

interface HookCommand {
  command: string
  location: string
}

interface HookMatcher {
  hooks?: unknown[]
}

interface CommandEntry {
  type?: string
  command?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isHookMatcher = (value: unknown): value is HookMatcher => isRecord(value)

const isCommandEntry = (value: unknown): value is CommandEntry => isRecord(value)

const extractHookCommands = (data: Record<string, unknown>): HookCommand[] => {
  const commands: HookCommand[] = []

  const hooks = data['hooks']
  if (isRecord(hooks)) {
    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue
      const matchers: unknown[] = value
      for (let mi = 0; mi < matchers.length; mi++) {
        const matcher = matchers[mi]
        if (!isHookMatcher(matcher)) continue
        if (!matcher.hooks || !Array.isArray(matcher.hooks)) continue
        for (let hi = 0; hi < matcher.hooks.length; hi++) {
          const hook = matcher.hooks[hi]
          if (!isCommandEntry(hook)) continue
          if (hook.type === 'command' && typeof hook.command === 'string') {
            commands.push({
              command: hook.command,
              location: `hooks.${event}[${mi}].hooks[${hi}]`,
            })
          }
        }
      }
    }
  }

  const statusLine = data['statusLine']
  if (!isCommandEntry(statusLine)) return commands
  if (statusLine.type === 'command' && typeof statusLine.command === 'string') {
    commands.push({ command: statusLine.command, location: 'statusLine' })
  }

  return commands
}

// ── Rule ─────────────────────────────────────────────────

const checkFile = (settingsFile: SettingsFile): Finding[] => {
  const findings: Finding[] = []
  const commands = extractHookCommands(settingsFile.data)

  for (const { command, location } of commands) {
    const offending = findRelativePathToken(command)
    if (offending) {
      findings.push({
        file: settingsFile.displayPath,
        location,
        command,
        severity: 'error',
        rule: 'no-relative-hook-path',
        message: 'Relative path breaks when Claude changes directory',
        detail: [
          "Hook commands execute in the shell's cwd at invocation time.",
          "When Claude's Bash tool runs in another directory, the cwd shifts",
          'and relative paths stop resolving. The official docs say "use absolute',
          'paths" and $CLAUDE_PROJECT_DIR was introduced specifically for this.',
        ].join(' '),
        happyPaths: settingsFile.scope === 'user' ? HAPPY_PATHS_USER : HAPPY_PATHS_PROJECT,
        references: REFERENCES,
      })
    }
  }

  return findings
}

// ── Entry point ──────────────────────────────────────────

export const lintHooks = (ctx: LintContext): Finding[] => {
  const findings: Finding[] = []
  for (const file of ctx.settingsFiles) {
    findings.push(...checkFile(file))
  }
  return findings
}
