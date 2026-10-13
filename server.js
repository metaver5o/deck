#!/usr/bin/env node
'use strict';

// iPad stream deck for Claude Code sessions (Desktop Code tab + CLI).
// State arrives via HTTP hooks on loopback; the iPad reads it over SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.DECK_PORT || 8787);
// Held PermissionRequest hooks block the Desktop dialog, so fall back to it
// after this long without an answer from the iPad.
const PERM_TIMEOUT_MS = Number(process.env.DECK_PERM_TIMEOUT || 90) * 1000;
// Questions need reading time; still under the 600s hook timeout.
const QUESTION_TIMEOUT_MS = Number(process.env.DECK_QUESTION_TIMEOUT || 300) * 1000;
const STALE_MS = 12 * 3600 * 1000;
const CONF_DIR = path.join(os.homedir(), '.config', 'deck');
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const CS_BIN = process.env.DECK_CS || path.join(os.homedir(), '.local', 'bin', 'cs');

const WAIT_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

const ACTIONS = {
  focus: 'tell application "Claude" to activate',
  escape: 'tell application "Claude" to activate\ndelay 0.15\ntell application "System Events" to key code 53',
  // Reads Dock UI elements: needs the same Accessibility grant as keystrokes, with no side effects.
  check: 'tell application "System Events" to tell process "Dock" to count UI elements',
  new: 'tell application "Claude" to activate\ndelay 0.15\ntell application "System Events" to keystroke "n" using command down',
};

const CHAN_FILE = path.join(CONF_DIR, 'chan.json');
const STATE_FILE = path.join(CONF_DIR, 'sessions.json');

const TOKEN = loadToken();
// Last chan window seen in a hook; where "New session" opens its tab.
let chan = loadChan();
const sessions = loadSessions();
const pending = new Map();
const clients = new Set();

function loadToken() {
  const file = path.join(CONF_DIR, 'token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    const t = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
    return t;
  }
}

function loadChan() {
  try {
    return JSON.parse(fs.readFileSync(CHAN_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Idle Desktop sessions may not fire a hook for hours; survive server restarts.
function loadSessions() {
  try {
    return new Map(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).map((s) => [s.id, s]));
  } catch (_) {
    return new Map();
  }
}

let saveTimer = null;
function saveSessions() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify([...sessions.values()]), { mode: 0o600 }, (err) => {
      if (!err) fs.rename(tmp, STATE_FILE, () => {});
    });
  }, 1000);
}

function noteChan(headers) {
  const sock = headers['x-chan-socket'];
  const win = headers['x-chan-window'];
  if (!sock || !win || (chan && chan.sock === sock && chan.window === win)) return;
  chan = { sock: String(sock), window: String(win) };
  fs.writeFile(CHAN_FILE, JSON.stringify(chan), () => {});
}

function newChanSession(cb) {
  const tab = 'deck-' + Date.now().toString(36);
  const env = Object.assign({}, process.env, { CHAN_CONTROL_SOCKET: chan.sock });
  execFile(CS_BIN, ['terminal', 'new', '--window', chan.window, '--tab-name', tab, '--tab-group', 'deck',
    '--command', "zsh -lc 'exec claude'"], { env, timeout: 5000 },
    (err, _o, stderr) => cb(err ? (stderr || err.message).trim() : null, tab));
}

function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function trim(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function summarize(tool, input) {
  input = input || {};
  const v = input.command || input.file_path || input.url || input.pattern || input.path || input.query;
  return trim(v != null ? v : JSON.stringify(input), 400);
}

function touch(body, headers) {
  const id = String(body.session_id || 'unknown');
  let s = sessions.get(id);
  if (!s) {
    s = { id, cwd: '', project: '', state: 'idle', msg: '', mode: '', updated: 0, transcript: '', tab: '', sock: '' };
    sessions.set(id, s);
  }
  if (body.cwd) {
    s.cwd = body.cwd;
    s.project = path.basename(body.cwd);
  }
  if (body.permission_mode) s.mode = body.permission_mode;
  if (body.transcript_path) s.transcript = body.transcript_path;
  // Set by the hook config from the session's env; empty outside chan terminals.
  if (headers && headers['x-chan-tab']) s.tab = String(headers['x-chan-tab']);
  if (headers && headers['x-chan-socket']) s.sock = String(headers['x-chan-socket']);
  s.updated = Date.now();
  return s;
}

function snapshot() {
  const now = Date.now();
  const list = [];
  for (const s of sessions.values()) {
    if (now - s.updated > STALE_MS) {
      sessions.delete(s.id);
      continue;
    }
    const perms = [];
    for (const p of pending.values()) {
      if (p.sessionId === s.id) {
        perms.push({ id: p.id, tool: p.tool, summary: p.summary, since: p.since, questions: p.questions });
      }
    }
    list.push({
      id: s.id, project: s.project, cwd: s.cwd, state: s.state, msg: s.msg, mode: s.mode,
      updated: s.updated, tab: s.tab, canSend: !!(s.tab && s.sock), pending: perms,
    });
  }
  list.sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  return { now, sessions: list };
}

function broadcast() {
  saveSessions();
  const frame = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const c of clients) c.write(frame);
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(body == null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1 << 20) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function authed(req, url) {
  const t = req.headers['x-deck-token'] || url.searchParams.get('t') || '';
  const a = Buffer.from(String(t));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Tail of the session JSONL, reduced to what fits on a tile-sized screen.
// Like trim() but keeps line structure, for the full-output view.
function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+$/, '');
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

function readTranscript(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (_) {
    return [];
  }
  const size = fs.fstatSync(fd).size;
  const len = Math.min(size, 4 << 20);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift();
  const out = [];
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) continue;
    const c = e.message && e.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        // Slash-command echoes and injected reminders are XML-ish noise.
        if (e.type === 'user' && /^\s*</.test(b.text)) continue;
        out.push({ role: e.type, text: clip(b.text, 20000) });
      } else if (b.type === 'tool_use') {
        out.push({ role: 'tool', text: b.name + ': ' + summarize(b.name, b.input) });
      } else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '';
        if (t.trim()) out.push({ role: 'result', text: clip(t, 3000) });
      }
    }
  }
  return out.slice(-limit);
}

function sendToTerminal(s, text, cb) {
  const env = Object.assign({}, process.env, { CHAN_CONTROL_SOCKET: s.sock });
  execFile(CS_BIN, ['terminal', 'write', '--tab-name', s.tab, '--submit', 'claude', text],
    { env, timeout: 5000 }, (err, _o, stderr) => cb(err ? (stderr || err.message).trim() : null));
}

// behavior: 'allow' | 'deny' | null (hand back to the Desktop dialog)
// answers: AskUserQuestion {questionText: label}; injected as updatedInput the way the TUI dialog fills it.
function resolvePerm(id, behavior, answers) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  const s = sessions.get(p.sessionId);
  if (behavior) {
    const decision = { behavior };
    if (behavior === 'deny') decision.message = 'Denied from deck';
    if (behavior === 'allow' && answers) decision.updatedInput = Object.assign({}, p.input, { answers });
    send(p.res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
    if (s) {
      s.state = 'working';
      s.msg = answers ? 'answered from deck' : (behavior === 'allow' ? 'allowed: ' : 'denied: ') + p.tool;
    }
  } else {
    send(p.res, 200, '');
    if (s) s.msg = 'answer on Mac: ' + p.tool;
  }
  if (s) s.updated = Date.now();
  broadcast();
  return true;
}

function holdPermission(s, body, res) {
  // Nobody watching: don't delay the Desktop dialog.
  if (clients.size === 0) return send(res, 200, '');
  const id = crypto.randomUUID();
  const isQuestion = body.tool_name === 'AskUserQuestion';
  const p = {
    id,
    sessionId: s.id,
    tool: String(body.tool_name || '?'),
    summary: summarize(body.tool_name, body.tool_input),
    input: body.tool_input || {},
    questions: isQuestion && body.tool_input ? body.tool_input.questions : undefined,
    since: Date.now(),
    res,
    timer: setTimeout(() => resolvePerm(id, null), isQuestion ? QUESTION_TIMEOUT_MS : PERM_TIMEOUT_MS),
  };
  pending.set(id, p);
  // Claude Code may cancel the hook (session interrupted, answered elsewhere).
  res.on('close', () => {
    if (pending.get(id) === p) {
      pending.delete(id);
      clearTimeout(p.timer);
      broadcast();
    }
  });
  s.state = 'waiting';
  s.msg = p.questions && p.questions[0] ? 'question: ' + trim(p.questions[0].question, 150) : 'permission: ' + p.tool;
  broadcast();
}

function onHook(ev, body, headers, res) {
  const s = touch(body, headers);
  switch (ev) {
    case 'SessionStart':
      s.state = 'idle';
      s.msg = 'session ' + (body.source || 'start');
      break;
    case 'UserPromptSubmit':
      s.state = 'working';
      s.msg = trim(body.prompt, 160);
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (s.state === 'waiting') s.state = 'working';
      break;
    case 'Notification':
      if (WAIT_TYPES.has(body.notification_type)) {
        s.state = 'waiting';
        s.msg = trim(body.message, 160);
      }
      break;
    case 'Stop':
      s.state = 'done';
      s.msg = trim(body.last_assistant_message, 160) || 'finished';
      break;
    case 'StopFailure':
      s.state = 'error';
      s.msg = trim(body.error || body.message, 160) || 'stopped with error';
      break;
    case 'SessionEnd':
      sessions.delete(s.id);
      broadcast();
      return send(res, 200, '');
    case 'PermissionRequest':
      return holdPermission(s, body, res);
  }
  broadcast();
  send(res, 200, '');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX_PATH), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && parts[0] === 'hook' && parts.length === 2) {
      if (!isLoopback(req)) return send(res, 403, { error: 'loopback only' });
      noteChan(req.headers);
      return onHook(parts[1], await readBody(req), req.headers, res);
    }

    if (!authed(req, url)) return send(res, 401, { error: 'bad token' });

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/decide') {
      const b = await readBody(req);
      const behavior = b.behavior === 'allow' || b.behavior === 'deny' ? b.behavior : null;
      const answers = b.answers && typeof b.answers === 'object' ? b.answers : null;
      return send(res, resolvePerm(String(b.id), behavior, answers) ? 200 : 404, {});
    }

    if (req.method === 'GET' && parts[0] === 'session' && parts.length === 2) {
      const s = sessions.get(parts[1]);
      if (!s) return send(res, 404, { error: 'no such session' });
      return send(res, 200, { messages: s.transcript ? readTranscript(s.transcript, 200) : [] });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const b = await readBody(req);
      const s = sessions.get(String(b.session));
      const text = String(b.text || '').trim();
      if (!s) return send(res, 404, { error: 'no such session' });
      if (!s.tab || !s.sock) return send(res, 409, { error: 'Desktop session: reply on the Mac' });
      if (!text || Buffer.byteLength(text) > 4000) return send(res, 400, { error: 'empty or too long' });
      return sendToTerminal(s, text, (err) => {
        if (err) console.error('send', s.tab, err);
        else {
          s.state = 'working';
          s.msg = trim(text, 160);
          s.updated = Date.now();
          broadcast();
        }
        send(res, err ? 500 : 200, err ? { error: err } : {});
      });
    }

    if (req.method === 'POST' && url.pathname === '/dismiss') {
      const b = await readBody(req);
      for (const p of pending.values()) if (p.sessionId === b.session) resolvePerm(p.id, null);
      sessions.delete(String(b.session));
      broadcast();
      return send(res, 200, {});
    }

    if (req.method === 'POST' && url.pathname === '/action/new' && chan) {
      return newChanSession((err, tab) => {
        if (err) console.error('new', err);
        send(res, err ? 500 : 200, err ? { error: err } : { tab });
      });
    }

    if (req.method === 'POST' && parts[0] === 'action' && ACTIONS[parts[1]]) {
      return execFile('osascript', ['-e', ACTIONS[parts[1]]], { timeout: 5000 }, (err, _o, stderr) => {
        if (err) console.error('action', parts[1], (stderr || err.message).trim());
        send(res, err ? 500 : 200, err ? { error: (stderr || err.message).trim() } : {});
      });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// SSE keepalive; also lets the iPad notice a dead link quickly.
setInterval(() => {
  for (const c of clients) c.write('event: ping\ndata: 1\n\n');
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('deck listening on :' + PORT);
  for (const a of lanAddrs()) console.log('  iPad: http://' + a + ':' + PORT + '/?t=' + TOKEN);
});
