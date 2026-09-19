<#
.SYNOPSIS
  Runs the same gate CI runs. Run this before pushing.

.DESCRIPTION
  Prepares its own environment, so `.\scripts\check.ps1` works from any shell.

  It did not always. The header used to say "assumes the session has already
  been prepared by dev-env.ps1", and running it without that produced a
  *specific and misleading* failure: cargo clippy keeps its own build cache, so
  it is usually the one step that has to compile from scratch, and without
  MSVC and Perl on PATH the vendored OpenSSL in SQLCipher fails to build. The
  report read "cargo clippy FAILED" -- which looks exactly like a lint error in
  code that is in fact clean. Twice.
#>

. "$PSScriptRoot\dev-env.ps1"

$ErrorActionPreference = 'Continue'
$failed = @()

function Step($name, [scriptblock]$body) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & $body
    if ($LASTEXITCODE -ne 0) {
        $script:failed += $name
        Write-Host "FAILED: $name" -ForegroundColor Red
    }
}

Step 'cargo fmt'        { cargo fmt --all --check }
Step 'cargo clippy'     { cargo clippy --workspace --all-targets -- -D warnings }
Step 'cargo test'       { cargo test --workspace }

# Two passes: the client ships only for Windows, the server runs only on Linux.
# See the comment at the top of deny.toml.
Step 'cargo deny (windows client)' {
    cargo deny --target x86_64-pc-windows-msvc --exclude nexo-server check
}
Step 'cargo deny (linux server)' {
    cargo deny --target aarch64-unknown-linux-gnu --exclude nexo-desktop check
}
Step 'cargo audit'      { cargo audit }

Step 'pnpm typecheck'   { pnpm typecheck }
Step 'pnpm build'       { pnpm build }

if ($failed.Count -gt 0) {
    Write-Host "`n$($failed.Count) step(s) failed:" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "`nAll checks passed." -ForegroundColor Green
