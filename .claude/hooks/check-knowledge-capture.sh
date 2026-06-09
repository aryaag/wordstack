#!/usr/bin/env bash
# PostToolUse hook for Bash. Fires once per session, immediately after the first
# `gh pr create` call, to prompt Claude to run the knowledge-capture flow.
#
# Behavior:
#   - Reads the PostToolUse JSON payload from stdin.
#   - If the tool is not Bash, or the command is not `gh pr create`, exits 0 silently.
#   - If a session marker already exists, exits 0 silently — only the first PR
#     create per session triggers the prompt.
#   - Otherwise: creates the marker and emits a JSON response that injects
#     additionalContext instructing Claude to run the capture flow.

set -euo pipefail

payload="$(cat)"

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
# Match `gh pr create` as a whole phrase (allow surrounding flags / pipes / heredocs).
if ! [[ "$command_str" =~ (^|[^[:alnum:]_-])gh[[:space:]]+pr[[:space:]]+create($|[^[:alnum:]_-]) ]]; then
  exit 0
fi

session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty')"
if [[ -z "$session_id" ]]; then
  exit 0
fi

marker_dir="${TMPDIR:-/tmp}/claude-knowledge-capture"
mkdir -p "$marker_dir"
marker="$marker_dir/$session_id"

if [[ -f "$marker" ]]; then
  exit 0
fi

touch "$marker"

context=$(cat <<'EOF'
A pull request was just created in this session. Before continuing, check whether any knowledge worth preserving was produced.

Re-read the session and ask: was anything learned about this project that is non-obvious from reading the code — a constraint, a gotcha, a decision and its reason, a wrangler/D1 quirk? If nothing fits that bar, say so in one line and stop. If there are candidates, list them as short bullets, propose where to add them in CLAUDE.md (or a new docs/ file if the topic is large), and ask whether to capture all, some, or none. Show any diffs before staging — let the developer decide whether to include doc changes in the PR.

This prompt fires once per session, after the first `gh pr create`.
EOF
)

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
