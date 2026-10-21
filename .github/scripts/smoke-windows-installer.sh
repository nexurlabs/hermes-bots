#!/usr/bin/env bash
# Smoke-tests the PACKAGED Windows app: installs the NSIS installer silently into a temp folder,
# launches the installed exe with HERMES_BOTS_SMOKE=1 and fails unless it prints HERMES_BOTS_SMOKE_OK.
# Falls back to nothing: a missing installer is a failure. Run with bash on windows-latest.
set -euo pipefail
shopt -s nullglob
installers=(dist/Hermes-Bots-Setup-*.exe)
if [ ${#installers[@]} -ne 1 ]; then echo "::error::expected one installer in dist/, found ${#installers[@]}"; exit 1; fi
installer="${installers[0]}"
target="$(cygpath -w "$RUNNER_TEMP")\\hermes-bots-smoke"
echo "Installing $installer silently to $target"
# NSIS: /S silent, /D= install dir (must be last, unquoted). Start-Process -Wait waits for the installer.
powershell -NoProfile -Command "\$p = Start-Process -FilePath '$(cygpath -w "$installer")' -ArgumentList '/S','/D=$target' -Wait -PassThru; exit \$p.ExitCode"
exe="$target\\Hermes Bots.exe"
if [ ! -f "$(cygpath -u "$exe")" ]; then echo "::error::installed app not found at $exe"; ls -la "$(cygpath -u "$target")" || true; exit 1; fi
SMOKE_EXE="$(cygpath -u "$exe")" SMOKE_TIMEOUT_MS="${SMOKE_TIMEOUT_MS:-120000}" node tests/build/smoke.cjs
# The uninstaller is left alone: the runner is thrown away after the job.
