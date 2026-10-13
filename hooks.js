#!/usr/bin/env node
'use strict';

// Installs (or removes) the deck's hooks in Claude Code's settings.json.
// Usage: node hooks.js install|uninstall   (env: DECK_CLAUDE_DIR, DECK_HOOK_URL)
// Only entries pointing at the deck are touched; other hooks are left alone.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.DECK_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const BASE = (process.env.DECK_HOOK_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '') + '/hook/';

const HTTP_EVENTS = { UserPromptSubmit: 2, PostToolUse: 2, PostToolUseFailure: 2, Notification: 2,
  Stop: 2, StopFailure: 2, SessionEnd: 1, PermissionRequest: 600 };

function deckHooks() {
  // SessionStart doesn't take http hooks, so it posts with curl.
  const hooks = { SessionStart: [{ hooks: [{ type: 'command', timeout: 3,
    command: "curl -s -m 2 -o /dev/null -H 'Content-Type: application/json' --data-binary @- " + BASE + 'SessionStart || true' }] }] };
  for (const [ev, t] of Object.entries(HTTP_EVENTS)) hooks[ev] = [{ hooks: [{ type: 'http', url: BASE + ev, timeout: t }] }];
  return hooks;
}

// Any hook posting to a deck on this machine, whatever its port.
const isDeck = (h) => /127\.0\.0\.1:\d+\/hook\/[A-Za-z]+/.test(String(h.url || h.command || ''));

function strip(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).map((m) => Object.assign({}, m, { hooks: (m.hooks || []).filter((h) => !isDeck(h)) }))
      .filter((m) => m.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  return settings;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(SETTINGS + ' is not valid JSON, not touching it: ' + e.message);
  }
}

function save(settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const bak = SETTINGS + '.bak-deck';
  if (fs.existsSync(SETTINGS) && !fs.existsSync(bak)) fs.copyFileSync(SETTINGS, bak);
  const tmp = SETTINGS + '.deck-tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}

function install() {
  const s = strip(load());
  s.hooks = s.hooks || {};
  for (const [ev, list] of Object.entries(deckHooks())) s.hooks[ev] = (s.hooks[ev] || []).concat(list);
  save(s);
  return SETTINGS;
}

function uninstall() {
  save(strip(load()));
  return SETTINGS;
}

module.exports = { install, uninstall, deckHooks };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'install') console.log('deck hooks installed in ' + install() + ' -> ' + BASE);
  else if (cmd === 'uninstall') console.log('deck hooks removed from ' + uninstall());
  else {
    console.error('usage: node hooks.js install|uninstall');
    process.exit(2);
  }
}
