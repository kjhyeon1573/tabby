#!/bin/sh
# Installs (or removes) Claude Code hooks that make this Tabby fork's profile sidebar
# bounce a tmux profile's icon when Claude finishes a reply or asks for permission.
#
#   Stop, Notification  -> tmux set-option @tabby-attention 1   (icon starts bouncing)
#   UserPromptSubmit    -> tmux set-option -u @tabby-attention  (cleared on the next prompt)
#
# The sidebar also clears the flag itself once the session's tab is looked at.
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
SET = '[ -n "$TMUX_PANE" ] && tmux set-option -t "$TMUX_PANE" @tabby-attention 1 >/dev/null 2>&1; exit 0'
UNSET = '[ -n "$TMUX_PANE" ] && tmux set-option -t "$TMUX_PANE" -u @tabby-attention >/dev/null 2>&1; exit 0'
WANTED = {'Stop': SET, 'Notification': SET, 'UserPromptSubmit': UNSET}

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
        hooks.setdefault(event, []).append({'hooks': [{'type': 'command', 'command': command}]})
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
