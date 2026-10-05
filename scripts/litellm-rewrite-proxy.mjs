#!/usr/bin/env node
// LLM upstream proxy with two modes:
//
// 1. `litellm` (default) — LiteLLM model-prefix rewrite proxy.
//    Claude Code CLI strips the `anthropic/` provider prefix locally and stores
//    bare `claude-opus-4-7` in its jsonl; on resume it sends that bare name to
//    the Anthropic-compat API — which the Tenstorrent LiteLLM proxy rejects
//    ("Invalid model name"). This mode rewrites the model field in both request
//    and response (including SSE streams). Injects the LiteLLM Bearer key so
//    OneCLI credential injection is not needed for this hop — the container
//    bypasses OneCLI (via NO_PROXY) for host.docker.internal.
//
// 2. `anthropic-oauth` — Anthropic-direct via a Claude subscription OAuth
//    token. Reads the access + refresh tokens from ~/.claude/.credentials.json,
//    auto-refreshes via console.anthropic.com when the access token expires,
//    and forwards to api.anthropic.com. No model rewrite (Anthropic-direct
//    wants bare `claude-opus-5`). Gated to Claude Code by the caller's system
//    prompt — non-Claude-Code callers get 429 from Anthropic even with a
//    valid token, so downstream must identify as Claude Code (the container
//    Claude Code CLI does this automatically).
//
// Env:
//   UPSTREAM_MODE     — `litellm` (default) or `anthropic-oauth`
//   LITELLM_API_KEY   — required for `litellm` mode
//   CREDENTIALS_FILE  — path to Claude Code credentials JSON (default: ~/.claude/.credentials.json)
//   PORT              — default 9090
//   BIND              — default 172.17.0.1 (docker bridge)
//   UPSTREAM_HOST     — override upstream (mode-appropriate default otherwise)

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';

const UPSTREAM_MODE = process.env.UPSTREAM_MODE || 'litellm';
const PORT = parseInt(process.env.PORT || '9090', 10);
const BIND = process.env.BIND || '172.17.0.1';

// Mode-appropriate defaults; override with UPSTREAM_HOST if needed.
const DEFAULT_UPSTREAM = UPSTREAM_MODE === 'anthropic-oauth'
  ? 'api.anthropic.com'
  : 'litellm-proxy--tenstorrent.workload.tenstorrent.com';
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || DEFAULT_UPSTREAM;

// LiteLLM-mode config
const API_KEY = process.env.LITELLM_API_KEY;
if (UPSTREAM_MODE === 'litellm' && !API_KEY) {
  console.error('LITELLM_API_KEY not set for litellm mode');
  process.exit(1);
}

// OAuth-mode config
const CREDENTIALS_FILE = process.env.CREDENTIALS_FILE ||
  path.join(process.env.HOME || '/home/aswin', '.claude/.credentials.json');
// Public Claude Code OAuth client id
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';
// Refresh when the access token has < 60s left.
const TOKEN_REFRESH_SLACK_MS = 60_000;

// LiteLLM requires provider-prefixed model names (anthropic/, azure/, gemini/, tenstorrent/).
// Claude Code CLI strips its own `anthropic/` prefix locally before storing model names
// in the session jsonl; on resume it sends the bare name and LiteLLM 400s. Extend the
// same restoration to `gpt-*` (azure) and `gemini-*` (gemini) as a defense-in-depth in
// case Claude Code CLI ever normalizes those on the fly too.
const PREFIX_BY_FAMILY = [
  { re: /"model"\s*:\s*"(claude-[a-z0-9.-]+)"/g, prefix: 'anthropic/' },
  { re: /"model"\s*:\s*"(gpt-[a-z0-9.-]+)"/g, prefix: 'azure/' },
  { re: /"model"\s*:\s*"(gemini-[a-z0-9.-]+)"/g, prefix: 'gemini/' },
];

function prefixModel(s) {
  for (const { re, prefix } of PREFIX_BY_FAMILY) {
    s = s.replace(re, (_m, name) => `"model":"${prefix}${name}"`);
  }
  return s;
}

// Streaming rewriter: keeps a small tail so the pattern isn't split by a chunk boundary.
class ChunkPrefixer extends Transform {
  constructor() {
    super();
    this.tail = '';
  }
  _transform(chunk, _enc, cb) {
    const s = this.tail + chunk.toString('utf8');
    const boundary = Math.max(0, s.length - 64);
    const out = prefixModel(s.slice(0, boundary));
    this.tail = s.slice(boundary);
    cb(null, Buffer.from(out, 'utf8'));
  }
  _flush(cb) {
    cb(null, Buffer.from(prefixModel(this.tail), 'utf8'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// OAuth token cache + refresh (only used in anthropic-oauth mode)
// ────────────────────────────────────────────────────────────────────────

let cachedCreds = null;
let refreshInFlight = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadCredsFromDisk() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  if (!raw.claudeAiOauth) throw new Error('claudeAiOauth block missing in credentials file');
  return raw.claudeAiOauth;
}

function writeCredsToDisk(newTokens) {
  // Merge the refresh response into the existing file (preserve other keys).
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  raw.claudeAiOauth.accessToken = newTokens.access_token;
  if (newTokens.refresh_token) raw.claudeAiOauth.refreshToken = newTokens.refresh_token;
  raw.claudeAiOauth.expiresAt = Date.now() + (newTokens.expires_in * 1000);
  // Some Anthropic responses include refresh_token_expires_at; keep the old one otherwise.
  if (newTokens.refresh_token_expires_at) {
    raw.claudeAiOauth.refreshTokenExpiresAt = newTokens.refresh_token_expires_at;
  }
  // Atomic write via rename to avoid a torn file that host Claude Code might read mid-write.
  const tmp = CREDENTIALS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS_FILE);
  return raw.claudeAiOauth;
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
    const url = new URL(OAUTH_REFRESH_URL);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`OAuth refresh failed: HTTP ${res.statusCode} ${data.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`OAuth refresh: bad JSON: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const now = Date.now();
  // Fast path: in-memory cache still fresh
  if (cachedCreds && cachedCreds.expiresAt - now > TOKEN_REFRESH_SLACK_MS) {
    return cachedCreds.accessToken;
  }
  // Reload from disk — host Claude Code may have refreshed independently
  try {
    cachedCreds = loadCredsFromDisk();
  } catch (e) {
    throw new Error(`cannot read ${CREDENTIALS_FILE}: ${e.message}`);
  }
  if (cachedCreds.expiresAt - now > TOKEN_REFRESH_SLACK_MS) {
    return cachedCreds.accessToken;
  }
  // Refresh, deduping concurrent requests that arrive during the refresh window.
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        log('OAuth access token expired, refreshing…');
        const resp = await refreshAccessToken(cachedCreds.refreshToken);
        cachedCreds = writeCredsToDisk(resp);
        log(`OAuth refreshed, new expiry ${new Date(cachedCreds.expiresAt).toISOString()}`);
        return cachedCreds.accessToken;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return await refreshInFlight;
}

// ────────────────────────────────────────────────────────────────────────
// Request handler
// ────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const reqChunks = [];
  req.on('data', (c) => reqChunks.push(c));
  req.on('end', async () => {
    let body = Buffer.concat(reqChunks);

    // Only litellm mode needs request-body model rewriting.
    if (UPSTREAM_MODE === 'litellm') {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('json') && body.length > 0) {
        body = Buffer.from(prefixModel(body.toString('utf8')), 'utf8');
      }
    }

    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length'];
    delete headers['authorization'];
    delete headers['proxy-authorization'];
    delete headers['x-api-key'];
    headers['accept-encoding'] = 'identity';
    headers['host'] = UPSTREAM_HOST;
    headers['content-length'] = String(body.length);

    try {
      if (UPSTREAM_MODE === 'anthropic-oauth') {
        const token = await getAccessToken();
        headers['authorization'] = `Bearer ${token}`;
        // Preserve any beta headers Claude Code sent; ensure oauth-2025-04-20 is present.
        const existing = headers['anthropic-beta'] || '';
        if (!existing.split(',').map((s) => s.trim()).includes('oauth-2025-04-20')) {
          headers['anthropic-beta'] = existing ? `${existing},oauth-2025-04-20` : 'oauth-2025-04-20';
        }
      } else {
        headers['authorization'] = `Bearer ${API_KEY}`;
      }
    } catch (err) {
      log(`auth setup failed: ${err.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_auth_error', message: err.message } }));
      return;
    }

    const upReq = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        const respHeaders = { ...upRes.headers };
        delete respHeaders['content-length'];
        delete respHeaders['content-encoding'];
        delete respHeaders['transfer-encoding'];
        res.writeHead(upRes.statusCode, respHeaders);
        // Only litellm mode rewrites response bodies (Anthropic-direct returns bare model names).
        if (UPSTREAM_MODE === 'litellm') {
          upRes.pipe(new ChunkPrefixer()).pipe(res);
        } else {
          upRes.pipe(res);
        }
      },
    );
    upReq.on('error', (err) => {
      log(`upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
    upReq.write(body);
    upReq.end();
  });
  req.on('error', (err) => log(`req error: ${err.message}`));
});

server.listen(PORT, BIND, () => {
  log(`proxy listening on ${BIND}:${PORT} → https://${UPSTREAM_HOST}  (mode=${UPSTREAM_MODE})`);
});
