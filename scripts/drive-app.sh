#!/bin/sh
# Drive a release build with real macOS input through `orca computer`.
#   scripts/drive-app.sh launch <data-dir>   copy the build to a scratch bundle and open it
#   scripts/drive-app.sh <orca computer args> e.g. hotkey --key CmdOrCtrl+K --restore-window
# The copy gets its own bundle id because LaunchServices routes dev.readi.app to
# /Applications/Readi.app, which opens the real library and ignores READI_DATA_DIR.
set -e
APP_ID=dev.readi.check
SCRATCH=${TMPDIR:-/tmp}/readi-drive

if [ "$1" = launch ]; then
  data=${2:?data dir}
  rm -rf "$SCRATCH/ReadiCheck.app" && mkdir -p "$SCRATCH" "$data"
  cp -R "$(dirname "$0")/../src-tauri/target/release/bundle/macos/Readi.app" "$SCRATCH/ReadiCheck.app"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $APP_ID" "$SCRATCH/ReadiCheck.app/Contents/Info.plist"
  codesign --force --deep -s - "$SCRATCH/ReadiCheck.app" 2>/dev/null
  open -n --env READI_DATA_DIR="$data" "$SCRATCH/ReadiCheck.app"
  exit 0
fi

orca computer "$@" --app "$APP_ID" --json | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d.get("ok"): sys.exit(json.dumps(d["error"]))
r = d["result"]
if "action" in r: print("verification:", r["action"].get("verification", {}).get("state"))
print(r.get("snapshot", {}).get("treeText", ""))
print("screenshot:", (r.get("screenshot") or {}).get("path"))
'
