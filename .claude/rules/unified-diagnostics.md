# Unified Diagnostics

Invalid environment state (e.g. malformed outfit entries, bad skill names on disk) must be caught by a single set of validation rules shared between doctor (proactive lint pass) and normal operations (incidental encounter).

## Principles

- There are not two code paths for the same validation — doctor and normal operations use the same checks and produce the same diagnostics.
- Invalid state encountered during normal operation (e.g. `skills list`) is the same error that doctor would have found in a dedicated pass.
- These diagnostics are not defects (Effect term for bugs in the program). The program is correct; the user's environment state is invalid.
- Normal operations should surface the diagnostic and continue with the valid entries — not silently skip invalid state, and not crash with an uncaught exception.
