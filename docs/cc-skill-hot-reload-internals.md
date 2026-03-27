# CC Skill Hot-Reload Internals

> Reverse-engineered from `@anthropic-ai/claude-code@2.1.84` (`cli.js`, 12.7MB minified).
> Empirically verified in a live CC session on 2026-03-26.

## Executive Summary

**CC already hot-reloads skills from `~/.claude/skills/`.** When shan creates or removes symlinks, CC's chokidar watcher detects the change, clears its memoized caches, and the model sees updated skills on its next conversational turn. No restart needed.

**The remaining gap** is the slash-command parser index (user-typed `/skill-name` autocomplete), which is frozen at session start and never rebuilt — even by `/reload-plugins`. This is CC bug [#37862](https://github.com/anthropics/claude-code/issues/37862). Shan cannot fix this; it's a CC architectural limitation.

## Architecture: Two Independent Systems

CC has two completely separate paths for making skills available:

### System 1: Model-Facing Context (Dynamic)

How the LLM discovers and invokes skills.

```
Per API request:
  c6z()                          # skill_listing builder
    → rS(config)                 # memoized: returns invocable skills
      → A0(config)               # merges all skill sources
        → CC4(config)            # memoized: loads from disk
          → _r1()               # scans skill directories
            → IE6(dir, scope)   # reads each dir, parses SKILL.md frontmatter
    → si1(skills, model)         # formats skill list for token budget
    → inject as system-reminder  # "The following skills are available..."
```

**Key property:** `rS` and `CC4` are wrapped in `_1()` (lodash `memoize()`). When the cache is cleared via `e88()`, the next call re-reads from disk.

The skill list appears in `<system-reminder>` blocks as:

```
The following skills are available for use with the Skill tool:
- skill-name: description
- skill-name: description
...
```

This is regenerated on **every model turn** from the current cache state. After cache invalidation, the next turn gets fresh data from disk.

### System 2: Slash-Command Parser (Frozen)

How the user types `/skill-name` in the REPL.

```
Session start (once):
  _r1()                          # loads all skills from disk
    → populates `tr` Map        # the command registry
    → populates `uE6` Map       # conditional skills (path-activated)
    → populates `en1` Set       # name index

  REPL input handler reads `tr`  # for "/" autocomplete suggestions
```

**Key property:** `tr` is a plain `Map`, not memoized. It's populated once during initialization. The `L34()` function exists to clear it (`tr.clear()`) but is **never called by the reload path**.

### Why `/reload-plugins` Doesn't Fix It

```javascript
// /reload-plugins calls:
Yh6(setAppState)
  → O_()                    // clears plugin caches
  → g34()                   // clears some state
  → AM()                    // re-fetches enabled plugins
  → G26()                   // re-fetches plugin commands
  → setAppState({           // updates React state with new plugins
      plugins: { enabled, disabled, commands, errors },
      agentDefinitions: _,
      mcp: { pluginReconnectKey: +1 }
    })
  → Zb8()                   // notifies something

// What it does NOT call:
  ✗ e88()                   // does NOT clear memoized skill caches
  ✗ L34()                   // does NOT clear the tr command Map
  ✗ _r1()                   // does NOT re-scan skill directories
  ✗ By6()                   // does NOT clear the sent-skills tracking Set
```

`/reload-plugins` reloads **plugin** metadata into React state, but it doesn't touch the skill directory watcher's cache chain or the command registry.

## The Chokidar Watcher (System 1's Refresh Mechanism)

### Initialization

```javascript
// $vz() — called once during session setup
CQ = chokidar.watch(watchedPaths, {
  persistent: true,
  ignoreInitial: true,
  depth: 2, // watches 2 levels deep
  awaitWriteFinish: {
    stabilityThreshold: T18?.stabilityThreshold ?? 1000, // Kvz = 1000ms
    pollInterval: T18?.pollInterval ?? 500, // _vz = 500ms
  },
  ignored: (path, stats) => {
    if (stats && !stats.isFile() && !stats.isDirectory()) return true
    return path.split(sep).some((s) => s === '.git')
  },
  ignorePermissionErrors: true,
  usePolling: typeof Bun !== 'undefined', // polls only in Bun
  interval: T18?.chokidarInterval ?? 2000, // Yvz = 2000ms
  atomic: true,
  // NOTE: followSymlinks defaults to true (chokidar default)
})
```

### Watched Paths

```javascript
// jvz() — resolves watched directories
;[
  c76('userSettings', 'skills'), // ~/.claude/skills/
  c76('userSettings', 'commands'), // ~/.claude/commands/
  c76('projectSettings', 'skills'), // .claude/skills/
  c76('projectSettings', 'commands'), // .claude/commands/
  // + any --add-dir paths
]
```

### Change Handler Chain

```javascript
// M4A — the chokidar event handler
function M4A(path) {
  log(`Detected skill change: ${path}`)
  telemetry('tengu_skill_file_changed', { source: 'chokidar' })
  Hvz(path) // debounced handler
}

// Hvz — debounced reload (300ms default)
function Hvz(path) {
  changedPaths.add(path) // v18 Set
  clearTimeout(debounceTimer) // bQ
  debounceTimer = setTimeout(async () => {
    debounceTimer = null
    let paths = [...changedPaths]
    changedPaths.clear()

    // ConfigChange hook — CAN BLOCK the reload
    let hookResult = await iy6('skills', paths[0])
    if (isBlocked(hookResult)) {
      log(`ConfigChange hook blocked skill reload (${paths.length} paths)`)
      return // ← reload aborted!
    }

    Ib8() // internal reset
    qQ() // clear ALL caches (the important one)
    By6() // clear sent-skills tracking Set (Qy6)
    emit() // notify UI to re-render (k18)
  }, T18?.reloadDebounce ?? 300) // zvz = 300ms
}

// qQ — cache clearing
function qQ() {
  e88() // clears memoized: CC4.cache, rS.cache, pO6.cache
  rx8() // clears something else
  UH4() // clears something else
  Ib8() // internal reset
}

// e88 — the memoize cache buster
function e88() {
  CC4.cache?.clear?.() // skill loader cache
  rS.cache?.clear?.() // invocable skills cache
  pO6.cache?.clear?.() // another cache
  tfz?.() // optional cleanup
}
```

### The Delta Logic in `c6z()`

The skill listing builder tracks which skills have already been sent to the model via `Qy6` (a `Set`). On cache clear, `By6()` clears this Set, so the next call sends ALL skills fresh:

```javascript
function c6z(options) {
  let allSkills = await rS(config);    // re-reads from disk after cache clear

  // Filter to only NEW skills (not yet sent)
  let newSkills = allSkills.filter(s => !Qy6.has(s.name));
  if (newSkills.length === 0) return [];

  let isInitial = Qy6.size === 0;     // true after By6() clears it
  for (let s of newSkills) Qy6.add(s.name);

  log(`Sending ${newSkills.length} skills via attachment ` +
      `(${isInitial ? "initial" : "dynamic"}, ${Qy6.size} total sent)`);

  return [{
    type: "skill_listing",
    content: formatSkillList(newSkills, model),
    skillCount: newSkills.length,
    isInitial: isInitial
  }];
}
```

After `By6()` → `Qy6.clear()`, the next `c6z()` call sees all skills as "new" and sends the full list. This is how the model sees updated skills without restart.

## Symlink Behavior

Chokidar's default `followSymlinks: true` means:

- Creating a symlink `~/.claude/skills/foo -> ~/.claude/skills-library/foo` fires an `add` event
- Removing the symlink fires an `unlink` event
- Both trigger `M4A` → debounced `Hvz` → cache clear → fresh skill list on next turn

**Empirically verified:** Created symlink via `shan skills on spelunking`, confirmed skill appeared in system-reminder on the next model turn. Removed symlink, confirmed skill disappeared.

**Timing:** There's a ~1.3 second delay minimum:

- `awaitWriteFinish.stabilityThreshold`: 1000ms
- `reloadDebounce`: 300ms
- Total: file change → 1000ms stability wait → 300ms debounce → cache clear → next model turn picks it up

## Why Shan Cannot Fix the Slash-Command Gap

The `tr` Map (command registry) is:

1. Populated **once** during `_r1()` at session init
2. Never cleared by the chokidar watcher's reload chain
3. Never cleared by `/reload-plugins`
4. The `L34()` function that clears it exists but is only called during full session teardown

To rebuild `tr`, CC would need to call `L34()` then re-run `_r1()`. This is internal to CC's module system. There is no:

- External IPC endpoint
- Signal handler (SIGHUP etc.)
- File-based trigger
- Hook that could force `tr` reconstruction
- Way for shan to reach into CC's process memory

The `ConfigChange` hook fires during skill reload but only has the power to **block** the reload, not to trigger additional actions like rebuilding the command registry.

### Could Shan Work Around It?

| Approach                                 | Feasible?     | Why/Why Not                                                                                    |
| ---------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Touch a sentinel file                    | No            | Watcher triggers `qQ()` (memoize clear), not `L34()` (command registry)                        |
| Send SIGHUP to CC process                | No            | CC has no signal handlers for reload                                                           |
| Write to CC's stdin                      | No            | Would be interpreted as user input, not a command                                              |
| Use `/reload-plugins` programmatically   | No            | Can't inject REPL commands from outside                                                        |
| Modify CC's runtime via Node inspector   | Theoretically | Wildly fragile, version-coupled, security nightmare                                            |
| Kill + resume (`claude -r <session-id>`) | Yes, nuclear  | Kills the process, resumes same conversation. Works but UX is terrible — user sees process die |

**The only reliable fix is a CC code change** where the chokidar reload chain (`Hvz`) also calls `L34()` + re-runs the command registry population, or where `/reload-plugins` does the same.

## Related CC Issues

| Issue                                                            | Title                                                        | State | Relevance              |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ----- | ---------------------- |
| [#37862](https://github.com/anthropics/claude-code/issues/37862) | `/reload-plugins` doesn't rebuild slash-command index        | OPEN  | The exact bug          |
| [#35641](https://github.com/anthropics/claude-code/issues/35641) | `/reload-plugins` doesn't load new marketplace plugin skills | OPEN  | Related reload gap     |
| [#20507](https://github.com/anthropics/claude-code/issues/20507) | Add `/reload-skills` command                                 | OPEN  | Feature request        |
| [#28685](https://github.com/anthropics/claude-code/issues/28685) | `/restart-session` to reload everything                      | OPEN  | Nuclear option request |

## Recommendations for Shan

1. **Remove "restart required" messaging.** Skill toggling works without restart for model-initiated use (the primary path).
2. **Add a note about `/` autocomplete.** Something like: "Note: `/skill-name` autocomplete updates on next session start (CC limitation)."
3. **Don't attempt workarounds.** The gap is in CC's command registry, which is inaccessible from outside the process.
4. **Track #37862.** When CC fixes the slash-command rebuild, shan gets full hot-reload for free.
