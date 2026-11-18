#!/bin/sh
# Installs (or removes) Claude Code hooks that drive this Tabby fork's profile sidebar for
# tmux profiles: the icon breathes while Claude works and bounces once it finishes a reply
# or asks for permission.
#
#   UserPromptSubmit,
#   PreToolUse          -> set @tabby-working, unset @tabby-attention  (icon breathes; PreToolUse
#                          also covers turns that start without a prompt, e.g. when a
#                          background task reports back)
#   Stop, Notification  -> unset @tabby-working, set @tabby-attention  (icon bounces)
#
# The sidebar clears @tabby-attention itself once the session's tab is looked at, and
# ignores @tabby-working once the session stops producing output (an interrupted reply).
# The hooks do nothing when Claude is not running inside tmux.
#
# Usage: install-tabby-attention-hooks.sh [--uninstall]
# Works on macOS and Linux; needs python3. Edits $CLAUDE_CONFIG_DIR/settings.json
# (default ~/.claude/settings.json) and keeps a timestamped backup next to it.
set -eu

mode=install
case "${1:-}" in
    --uninstall) mode=uninstall ;;
    '') ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
esac

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required (macOS: xcode-select --install)" >&2
    exit 1
fi

settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
mkdir -p "$(dirname "$settings")"
if [ -f "$settings" ]; then
    backup="$settings.bak-$(date +%Y%m%d%H%M%S)"
    cp "$settings" "$backup"
    echo "backup: $backup"
fi

python3 - "$settings" "$mode" <<'PY'
import json, os, sys

path, mode = sys.argv[1], sys.argv[2]
MARKER = '@tabby-attention'
def tmux(*commands):
    chained = " ';' ".join('set-option -t "$TMUX_PANE" ' + c for c in commands)
    return '[ -n "$TMUX_PANE" ] && tmux ' + chained + ' >/dev/null 2>&1; exit 0'
DONE = tmux('-u @tabby-working', '@tabby-attention 1')
START = tmux('@tabby-working 1', '-u @tabby-attention')
WANTED = {'Stop': DONE, 'Notification': DONE, 'UserPromptSubmit': START, 'PreToolUse': START}

settings = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path) as f:
        settings = json.load(f)
hooks = settings.setdefault('hooks', {})

# drop any earlier copy of these hooks so re-running stays idempotent
for event in list(hooks):
    groups = []
    for group in hooks[event]:
        group['hooks'] = [h for h in group.get('hooks', []) if MARKER not in h.get('command', '')]
        if group['hooks']:
            groups.append(group)
    if groups:
        hooks[event] = groups
    else:
        del hooks[event]

if mode == 'install':
    for event, command in WANTED.items():
        group = {'hooks': [{'type': 'command', 'command': command}]}
        if event == 'PreToolUse':
            group = {'matcher': '*', **group}
        hooks.setdefault(event, []).append(group)
if not hooks:
    del settings['hooks']

tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write('\n')
os.replace(tmp, path)
print(('installed' if mode == 'install' else 'removed') + ' Tabby attention hooks in ' + path)
PY

if [ "$mode" = install ] && ! command -v tmux >/dev/null 2>&1; then
    echo "note: tmux is not on PATH here; the hooks only act inside tmux sessions" >&2
fi
echo "restart running Claude Code sessions (or run /hooks) to pick up the change"
