# deck

iPad mini 2 (iOS 12, Safari) as a stream deck for Claude Code sessions
(Desktop Code tab and CLI).

- `server.js`: zero-dep Node server on :8787. Receives Claude Code HTTP hooks
  on loopback, pushes state to the iPad over SSE, holds `PermissionRequest`
  hooks until Allow/Deny is tapped.
- `public/index.html`: ES5 UI for Safari 12.

## Quick start

Needs Node 18+ and Claude Code. No API key: the deck only sees Claude Code's
hook events, and Claude Code keeps using whatever login it already has.

```sh
git clone https://github.com/metaver5o/deck && cd deck
node server.js            # prints the iPad URL with its token
```

1. Merge `examples/hooks.json` into `~/.claude/settings.json` (or a project's
   `.claude/settings.json`). Keep any hooks you already have.
2. Open the printed `http://<mac-ip>:8787/?t=<token>` on the iPad (same Wi-Fi).
   "Add to Home Screen" makes it full screen.
3. Start `claude`. Sessions appear as tiles; permission prompts and
   questions show Allow/Deny or the options.

Works with Claude Code only (CLI and the Desktop Code tab). Other agents, such
as Gemini CLI, use different hook events and payloads and are not supported.

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
  (`cs terminal write --submit claude`, optional); Desktop sessions are read-only.
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

- Hooks: `~/.claude/settings.json` (template in `examples/hooks.json`).
- Optional macOS service: a LaunchAgent such as
  `~/Library/LaunchAgents/com.example.deck.plist` running `node server.js`
  - restart: `launchctl kickstart -k gui/$(id -u)/com.example.deck`
  - logs: wherever the plist's `StandardOutPath` points
- iPad URL: `http://<mac-ip>:8787/?t=<token>` (printed in the log).
