#!/usr/bin/env bash
# PostToolUse hook (advisory): after Claude edits a file under src/, remind it to
# run the tests. It runs no project code itself, so editing files never executes
# code; `npm test` still goes through the normal Bash permission prompt.
set -u
path=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&(j.tool_input.file_path||j.tool_input.notebook_path))||"")}catch{}})')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$path" in
  "$root"/src/*|src/*) ;;
  *) exit 0 ;;
esac
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A file under src/ changed. Run `npm test` before finishing this change, and fix any failures."}}
EOF
exit 0
