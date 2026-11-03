#!/usr/bin/env bash
# PostToolUse hook: run the test suite after Claude edits a file under src/.
# A failure exits 2 so Claude sees the test output and fixes it.
set -u
path=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&(j.tool_input.file_path||j.tool_input.notebook_path))||"")}catch{}})')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$path" in
  "$root"/src/*|src/*) ;;
  *) exit 0 ;;
esac
cd "$root" || exit 0
if ! out=$(npm test --silent 2>&1); then
  printf 'Tests failed after editing %s:\n%s\n' "$path" "$(printf '%s' "$out" | grep -E '✖|not ok|Error|expected|actual|fail' | head -40)" >&2
  exit 2
fi
exit 0
