---
name: nexo-rework
description: Implement rework waves for the Nexo project as outlined in REWORK.md.
version: 0.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [nexo, rework, wave, implementation, typescript]
    related_skills: []
---

# Nexo Rework Implementation

Use when implementing rework waves for the Nexo project as outlined in REWORK.md.

## Overview

This skill governs the systematic implementation of rework waves for the Nexo project,
particularly focusing on transitioning from a multi-target platform implementation
to a consolidated codebase for web, Windows, and Android targets.

## Process

1. First understand the current state by examining REWORK.md, STATUS.md, and PLAN.md
2. Determine which wave needs to be implemented next based on project documentation
3. Set up the necessary directory structure if needed
4. Implement components according to specifications in REWORD.md
5. Ensure proper integration with existing modules in packages/core or crates/
6. Fix any TypeScript compilation issues that arise
7. Update exports appropriately in index.ts files
8. Verify changes work correctly before concluding a wave

## Key Instructions

- When implementing a new component, ensure consistency with the established patterns
  in existing modules (auth.ts, conversations.ts, transport.ts, etc.)
- All session management logic should be placed in packages/core/src/session.ts, not in crates/client
- The Session class serves as the main entry point coordinating auth, conversations, storage, crypto, and transport
- TypeScript types defined in store.ts must be properly imported and used
- When encountering compilation errors, check if method names changed between modules (e.g., store.tokens() -> store.session())

## Pitfalls

- Do NOT implement features beyond the scope of the current wave - stay focused on one wave at a time
- Do NOT modify or remove files in crates/client unless explicitly directed as part of the rework process
- Do NOT hardcode values from the original implementation - ensure the new implementation matches the patterns and architecture described in REWORK.md
- Do NOT attempt to complete multiple waves in one session - implement only one wave at a time
- Do NOT use incorrect import syntax (e.g., use `import * as module` instead of `import { module }` for TypeScript modules)
- Do NOT mix the old project structure with the new multi-platform implementation
- Do NOT try to access or modify files that are being removed as part of the rework (like client, store, platform)
- When fixing compilation errors, make sure to verify all method names and signature alignments between modules

## Key Files

- packages/core/src/session.ts - Main session management implementation (Wave 6)
- packages/core/src/index.ts - Exports the session module
- REWORK.md - The roadmap for rework waves
- STATUS.md - Current progress status
- PLAN.md - Planned steps for implementation

## References

- See references/nexo-rework-decisions.md for architectural decisions during this rework.