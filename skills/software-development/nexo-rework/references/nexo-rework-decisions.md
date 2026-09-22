# Nexo Rework Decisions

This document captures key architectural decisions made during the rework implementation.

## Multi-Platform Approach

The project is transitioning from separate implementations for web, Windows, and Android to a unified codebase using:
- TypeScript for shared components
- Platform-specific adapters in crates/platform
- packages/core as the central session layer

## Directory Structure Changes

### Removals (per REWORK.md)
- `crates/client` - replaced by `packages/core`
- `crates/store` - replaced by `packages/core/store.ts`
- `src/app/client` - removed entirely
- `src/app/components/ClientApp.tsx` - removed from platform-specific code

### Additions (per Wave 6)
- `packages/core/src/session.ts` - implements the session layer as `crates/client` was in desktop app
- `packages/core/src/index.ts` - exports components for the new structure

## Key Implementation Details

1. **Session class placement**: The Session class should be placed in packages/core/src/session.ts, not in crates/client.

2. **Method name alignment**: 
   - store.tokens() -> store.session()
   - store.clear() -> store.wipe()

3. **Type handling**: 
   - Identity and Account types are defined in packages/core/src/store.ts
   - Device type is imported from crypto module
   - Proper imports using `import * as module` syntax instead of `import { module }`

4. **Component coordination**:
   - Session class coordinates auth, conversations, storage, crypto, and transport
   - Each module should export its public API through index.ts files
   - Type safety is maintained throughout the transition

This approach allows for a clean migration while maintaining the existing architecture patterns.