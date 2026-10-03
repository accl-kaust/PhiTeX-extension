#!/usr/bin/env bash
# (Re)start the dev Chromium: its own profile (a login there persists), the
# extension loaded unpacked, DevTools protocol on :9222.  scripts/chrome.sh [url]
# (PHITEX_CDP_PORT and PHITEX_PROFILE: a second instance, e.g. :9223 with
# .chrome-profile-2, so two sessions don't close each other's tabs; the
# scripts read PHITEX_CDP_PORT too)
cd "$(dirname "$0")/.."
port="${PHITEX_CDP_PORT:-9222}"
profile="$PWD/${PHITEX_PROFILE:-.chrome-profile}"
pkill -f -- "--user-data-dir=$profile( |$)" && sleep 2
nohup chromium --user-data-dir="$profile" --remote-debugging-port="$port" --no-first-run \
  --disable-features=DisableLoadExtensionCommandLineSwitch --load-extension="$PWD/extension" \
  "${1:-http://localhost:8123/project/mock}" > /dev/null 2>&1 &
