/**
 * shan lint hooks — Check Claude Code settings for hook path issues.
 *
 * Detects relative paths in hook commands that break when Claude changes
 * the working directory. Reports findings with links to official docs and
 * GitHub issues explaining the correct patterns.
 */

import { Console, Effect } from 'effect'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ── Types ────────────────────────────────────────────────

interface Finding {
  file: string
  location: string
  command: string
  severity: 'error' | 'warning'
  rule: string
  message: string
  detail: string
  happyPaths: HappyPath[]
  references: Reference[]
}

interface HappyPath {
  pattern: string
  example: string
  tradeoff: string
}

interface Reference {
  label: string
  url: string
}

interface SettingsFile {
  path: string
  scope: 'user' | 'project' | 'project-local'
}

interface HookCommand {
  command: string
  location: string
}

// ── Reference Database ───────────────────────────────────

const DOCS: Record<string, Reference[]> = {
  relativePaths: [
    {
      label: 'Docs: "Use absolute paths" — Security Best Practices',
      url: 'https://docs.anthropic.com/en/docs/claude-code/hooks',
    },
    {
      label: '#3583 — relative paths fail when cwd changes',
      url: 'https://github.com/anthropics/claude-code/issues/3583',
    },
    {
      label: '#4198 — how to specify relative hook paths (answer: don\'t)',
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
  ],
}

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
    // Absolute, home-relative, or variable-based — all good
    if (token.startsWith('/') || token.startsWith('~') || token.startsWith('$') || token.startsWith('"$') || token.startsWith("'$")) continue
    // Flags are not paths
    if (token.startsWith('-')) continue
    // Must contain a slash to look like a path (bare commands are PATH-resolved)
    if (!token.includes('/')) continue
    // This token has a slash but no safe prefix — it's relative
    return token
  }
  return null
}

// ── Settings file discovery ──────────────────────────────

const discoverSettingsFiles = (): SettingsFile[] => {
  const home = os.homedir()
  const cwd = process.cwd()
  const files: SettingsFile[] = []

  const candidates: Array<{ path: string; scope: SettingsFile['scope'] }> = [
    { path: path.join(home, '.claude', 'settings.json'), scope: 'user' },
    { path: path.join(cwd, '.claude', 'settings.json'), scope: 'project' },
    { path: path.join(cwd, '.claude', 'settings.local.json'), scope: 'project-local' },
  ]

  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      files.push(c)
    }
  }
  return files
}

// ── Hook command extraction ──────────────────────────────

const extractHookCommands = (data: Record<string, unknown>): HookCommand[] => {
  const commands: HookCommand[] = []

  // hooks.{EventName}[].hooks[].command
  const hooks = data['hooks'] as Record<string, unknown[]> | undefined
  if (hooks && typeof hooks === 'object') {
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) continue
      for (let mi = 0; mi < matchers.length; mi++) {
        const matcher = matchers[mi] as { hooks?: unknown[] } | undefined
        if (!matcher?.hooks || !Array.isArray(matcher.hooks)) continue
        for (let hi = 0; hi < matcher.hooks.length; hi++) {
          const hook = matcher.hooks[hi] as { type?: string; command?: string } | undefined
          if (hook?.type === 'command' && typeof hook.command === 'string') {
            commands.push({
              command: hook.command,
              location: `hooks.${event}[${mi}].hooks[${hi}]`,
            })
          }
        }
      }
    }
  }

  // statusLine.command
  const statusLine = data['statusLine'] as { type?: string; command?: string } | undefined
  if (statusLine?.type === 'command' && typeof statusLine.command === 'string') {
    commands.push({ command: statusLine.command, location: 'statusLine' })
  }

  return commands
}

// ── Lint logic ───────────────────────────────────────────

const lintFile = (settingsFile: SettingsFile): Finding[] => {
  const findings: Finding[] = []

  let data: Record<string, unknown>
  try {
    const raw = fs.readFileSync(settingsFile.path, 'utf-8')
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return findings
  }

  const commands = extractHookCommands(data)
  const displayPath = settingsFile.path.startsWith(os.homedir())
    ? settingsFile.path.replace(os.homedir(), '~')
    : path.relative(process.cwd(), settingsFile.path)

  for (const { command, location } of commands) {
    const offending = findRelativePathToken(command)
    if (offending) {
      findings.push({
        file: displayPath,
        location,
        command,
        severity: 'error',
        rule: 'no-relative-hook-path',
        message: 'Relative path breaks when Claude changes directory',
        detail: [
          'Hook commands execute in the shell\'s cwd at invocation time.',
          'When Claude\'s Bash tool runs in another directory, the cwd shifts',
          'and relative paths stop resolving. The official docs say "use absolute',
          'paths" and $CLAUDE_PROJECT_DIR was introduced specifically for this.',
        ].join(' '),
        happyPaths: settingsFile.scope === 'user' ? HAPPY_PATHS_USER : HAPPY_PATHS_PROJECT,
        references: DOCS['relativePaths']!,
      })
    }
  }

  return findings
}

// ── Rendering ────────────────────────────────────────────

const renderFinding = (f: Finding) =>
  Effect.gen(function* () {
    const icon = f.severity === 'error' ? '✗' : '!'
    yield* Console.log(`  ${icon} ${f.rule}`)
    yield* Console.log(`    File:    ${f.file}`)
    yield* Console.log(`    At:      ${f.location}`)
    yield* Console.log(`    Command: ${f.command}`)
    yield* Console.log('')
    yield* Console.log(`    ${f.message}:`)
    yield* Console.log(`    ${f.detail}`)
    yield* Console.log('')
    yield* Console.log('    Happy paths:')
    for (const hp of f.happyPaths) {
      yield* Console.log(`      ${hp.pattern}`)
      yield* Console.log(`        e.g. ${hp.example}`)
      yield* Console.log(`        ${hp.tradeoff}`)
    }
    yield* Console.log('')
    yield* Console.log('    References:')
    for (const ref of f.references) {
      yield* Console.log(`      ${ref.url}`)
      yield* Console.log(`        ${ref.label}`)
    }
    yield* Console.log('')
  })

// ── Entry point ──────────────────────────────────────────

export const lintHooks = () =>
  Effect.gen(function* () {
    const files = discoverSettingsFiles()
    if (files.length === 0) {
      yield* Console.log('lint hooks: no settings files found')
      return
    }

    yield* Console.log(`lint hooks: checking ${files.length} settings file${files.length > 1 ? 's' : ''}...`)
    yield* Console.log('')

    const allFindings: Finding[] = []
    for (const file of files) {
      allFindings.push(...lintFile(file))
    }

    if (allFindings.length === 0) {
      yield* Console.log('lint hooks: all clear')
      return
    }

    for (const f of allFindings) {
      yield* renderFinding(f)
    }

    const errors = allFindings.filter((f) => f.severity === 'error').length
    const warnings = allFindings.filter((f) => f.severity === 'warning').length
    const parts: string[] = []
    if (errors > 0) parts.push(`${errors} error${errors > 1 ? 's' : ''}`)
    if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`)
    yield* Console.log(`lint hooks: ${parts.join(', ')}`)

    if (errors > 0) {
      return yield* Effect.fail(new Error('Lint errors found'))
    }
  })
