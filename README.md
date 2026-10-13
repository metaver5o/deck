# deck

iPad mini 2 (iOS 12, Safari) as a stream deck for Claude Code sessions
(Desktop Code tab and CLI).

- `server.js`: zero-dep Node server on :8787. Receives Claude Code HTTP hooks
  on loopback, pushes state to the iPad over SSE, holds `PermissionRequest`
  hooks until Allow/Deny is tapped.
- `public/index.html`: ES5 UI for Safari 12.

## Behavior

- Tiles per session: working / needs you / done / error.
- Permission requests are held up to `DECK_PERM_TIMEOUT` (default 90s), then
  handed back to the Desktop dialog. "On Mac" hands back immediately. If no
  iPad is connected, hooks return instantly and nothing changes.
- `AskUserQuestion` arrives as a `PermissionRequest`; the deck shows the
  options and answers with `allow` + `updatedInput.answers`
  (`{questionText: label}`, multi-select joined with ", "). Works for Desktop
  and terminal sessions. Held up to `DECK_QUESTION_TIMEOUT` (default 300s).
- Tap a tile for the session detail: transcript tail (from `transcript_path`)
  plus a compose box. Sending works only for sessions inside chan terminals
  (`cs terminal write --submit claude`); Desktop sessions are read-only.
- "New session" opens `claude` in a new chan tab (group `deck`) in the last
  chan window seen by a hook (`~/.config/deck/chan.json`). Without chan it
  falls back to Cmd+N in Claude.app via `osascript`.
- Focus/Esc drive Claude.app via `osascript`; Esc needs Accessibility for the
  node binary (ad-hoc signed, so re-grant after node upgrades).
- Hooks pass `CHAN_TAB_NAME`, `CHAN_CONTROL_SOCKET`, `CHAN_WINDOW_ID` as
  headers. `SessionStart` uses a curl command hook since it does not take
  `http` hooks.
- LAN access requires the token in `~/.config/deck/token`; `/hook/*` is
  loopback only.

## Ops

- Hooks: `~/.claude/settings.json` (backup at `settings.json.bak-deck`).
- Service: `~/Library/LaunchAgents/com.marco.deck.plist`
  - restart: `launchctl kickstart -k gui/$(id -u)/com.marco.deck`
  - logs: `~/Library/Logs/deck.log`
- iPad URL: `http://<mac-ip>:8787/?t=<token>` (printed in the log).
