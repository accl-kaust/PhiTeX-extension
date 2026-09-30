#!/usr/bin/env bash
# (Re)start the dev Chromium: its own profile (a login there persists), the
# extension loaded unpacked, DevTools protocol on :9222.  scripts/chrome.sh [url]
cd "$(dirname "$0")/.."
pkill -f -- "--user-data-dir=$PWD/.chrome-profile" && sleep 2
nohup chromium --user-data-dir="$PWD/.chrome-profile" --remote-debugging-port=9222 --no-first-run \
  --disable-features=DisableLoadExtensionCommandLineSwitch --load-extension="$PWD/extension" \
  "${1:-http://localhost:8123/project/mock}" > /dev/null 2>&1 &
