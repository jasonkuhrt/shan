import { describe, test } from 'bun:test'
import { Effect } from 'effect'
import { renderFinding, renderSummary, type Finding } from './finding.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  file: '~/.claude/settings.json',
  location: 'hooks.Stop[0].hooks[0]',
  command: '.claude/hooks/foo.sh',
  severity: 'error',
  rule: 'no-relative-hook-path',
  message: 'Relative path breaks when Claude changes directory',
  detail: 'Hook commands execute in the shell cwd',
  happyPaths: [
    {
      pattern: '$CLAUDE_PROJECT_DIR prefix',
      example: '"$CLAUDE_PROJECT_DIR"/foo.sh',
      tradeoff: 'Portable',
    },
  ],
  references: [{ label: 'Docs', url: 'https://docs.example.com' }],
  ...overrides,
})

describe('renderFinding', () => {
  test('renders error finding', async () => {
    await run(renderFinding(makeFinding({ severity: 'error' })))
  })

  test('renders warning finding', async () => {
    await run(renderFinding(makeFinding({ severity: 'warning' })))
  })

  test('renders finding with multiple happy paths and references', async () => {
    await run(
      renderFinding(
        makeFinding({
          happyPaths: [
            { pattern: 'p1', example: 'e1', tradeoff: 't1' },
            { pattern: 'p2', example: 'e2', tradeoff: 't2' },
          ],
          references: [
            { label: 'l1', url: 'u1' },
            { label: 'l2', url: 'u2' },
          ],
        }),
      ),
    )
  })
})

describe('renderSummary', () => {
  test('renders all clear with no findings', async () => {
    await run(renderSummary([]))
  })

  test('renders single error', async () => {
    await run(renderSummary([makeFinding({ severity: 'error' })]))
  })

  test('renders single warning', async () => {
    await run(renderSummary([makeFinding({ severity: 'warning' })]))
  })

  test('renders plural errors', async () => {
    await run(
      renderSummary([makeFinding({ severity: 'error' }), makeFinding({ severity: 'error' })]),
    )
  })

  test('renders plural warnings', async () => {
    await run(
      renderSummary([makeFinding({ severity: 'warning' }), makeFinding({ severity: 'warning' })]),
    )
  })

  test('renders errors and warnings together', async () => {
    await run(
      renderSummary([
        makeFinding({ severity: 'error' }),
        makeFinding({ severity: 'error' }),
        makeFinding({ severity: 'warning' }),
      ]),
    )
  })
})
