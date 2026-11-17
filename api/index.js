'use strict';
/**
 * Vercel Serverless Function Handler for Green Corridor API
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Use /tmp on Vercel as only /tmp is writable in serverless environments
const DATA_DIR = process.env.VERCEL ? '/tmp/data' : (process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const IMG_DIR = path.join(DATA_DIR, 'img');
const JSON_BACKUP_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const KEYS = ['TRIP', 'PUBLIC_INCIDENTS', 'AUDIT_LOG', 'ADDED_USERS', 'REMOVED_USERS'];
const MAX_BODY = 15 * 1024 * 1024;

try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch (e) {}

// Global in-memory cache shared across warm serverless invocations
if (!global.__gcDb) {
  global.__gcDb = { rev: 0, state: null };
  if (fs.existsSync(JSON_BACKUP_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(JSON_BACKUP_FILE, 'utf8'));
      global.__gcDb.rev = parsed.rev || 0;
      global.__gcDb.state = parsed.state || null;
    } catch (e) {}
  }
}
const db = global.__gcDb;

const emptyState = () => ({
  TRIP: null,
  PUBLIC_INCIDENTS: [],
  AUDIT_LOG: [],
  ADDED_USERS: {},
  REMOVED_USERS: {}
});

function persist() {
  try {
    const tmp = JSON_BACKUP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, JSON_BACKUP_FILE);
  } catch (e) {}
}

function storeImage(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
  const file = path.join(IMG_DIR, name + '.jpg');
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return '/api/img/' + name + '.jpg';
}

function normImg(o) {
  if (!o || typeof o !== 'object' || typeof o.image !== 'string') return;
  if (o.image.startsWith('data:image')) {
    const u = storeImage(o.image);
    if (u) o.image = u;
    else delete o.image;
    return;
  }
  const m = /\/api\/img\/([a-f0-9]{20})\.jpg$/.exec(o.image);
  if (m) o.image = '/api/img/' + m[1] + '.jpg';
}

function normalize(st) {
  if (!st || typeof st !== 'object') return st;
  (Array.isArray(st.PUBLIC_INCIDENTS) ? st.PUBLIC_INCIDENTS : []).forEach(normImg);
  if (st.TRIP && typeof st.TRIP === 'object' && st.TRIP.incident) normImg(st.TRIP.incident);
  return st;
}

const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keyFor(p) {
  if (p === 'PUBLIC_INCIDENTS') return x => x && x.id;
  if (p === 'AUDIT_LOG') return x => JSON.stringify(x);
  if (/(^|\.)messages$/.test(p)) return x => x && (x.ts + '|' + x.role + '|' + x.text);
  return null;
}

function merge(base, next, cur, p) {
  if (eq(base, next)) return cur;
  if (isObj(next) && isObj(cur)) {
    if (p === 'TRIP' && next.emergencyCode && cur.emergencyCode && next.emergencyCode !== cur.emergencyCode) {
      return next;
    }
    const b = isObj(base) ? base : {};
    const out = Object.assign({}, cur);
    for (const k of Object.keys(next)) {
      if (!(k in b) || !eq(b[k], next[k])) {
        out[k] = merge(b[k], next[k], cur[k], p ? p + '.' + k : k);
      }
    }
    for (const k of Object.keys(b)) {
      if (!(k in next)) delete out[k];
    }
    return out;
  }
  if (Array.isArray(next) && Array.isArray(cur)) {
    const kf = keyFor(p);
    if (!kf) return next;
    const b = Array.isArray(base) ? base : [];
    const kb = new Map(b.map(x => [kf(x), x]));
    const out = cur.slice();
    const idx = new Map(out.map((x, i) => [kf(x), i]));
    const fresh = [];
    for (const x of next) {
      const k = kf(x), bx = kb.get(k);
      if (bx !== undefined && eq(bx, x)) continue;
      if (idx.has(k)) out[idx.get(k)] = merge(bx, x, out[idx.get(k)], p + '[]');
      else fresh.push(x);
    }
    return /messages$/.test(p)
      ? out.concat(fresh).sort((a, c) => (a.ts || 0) - (c.ts || 0))
      : fresh.concat(out);
  }
  return next;
}

function applyMerge(base, next) {
  const cur = db.state || emptyState();
  const nb = base && typeof base === 'object' ? normalize(JSON.parse(JSON.stringify(base))) : {};
  const nn = normalize(next);
  const out = {};
  for (const k of KEYS) {
    if (!(k in nn)) {
      out[k] = cur[k] === undefined ? emptyState()[k] : cur[k];
      continue;
    }
    out[k] = merge(nb[k], nn[k], cur[k] === undefined ? emptyState()[k] : cur[k], k);
  }
  if (out.AUDIT_LOG.length > 500) out.AUDIT_LOG.length = 500;
  if (out.PUBLIC_INCIDENTS.length > 300) out.PUBLIC_INCIDENTS.length = 300;
  if (!eq(out, cur) || db.state === null) {
    db.state = out;
    db.rev++;
    persist();
  }
}

function sendJson(res, code, obj, extraHeaders = {}) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-XSS-Protection': '1; mode=block'
    }, extraHeaders));
    res.end(body);
  } catch (e) {}
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(JSON.stringify(req.body));
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Payload too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      return res.end();
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'Emergency Vehicle Green Corridor Server (Vercel Serverless)',
        rev: db.rev,
        database: 'Vercel Serverless Cache',
        activeTrip: (db.state && db.state.TRIP) ? db.state.TRIP.emergencyCode : null,
        now: Date.now()
      });
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const since = parseInt(url.searchParams.get('since') || '-1', 10);
      if (since === db.rev) {
        return sendJson(res, 200, { rev: db.rev, unchanged: true, now: Date.now() });
      }
      return sendJson(res, 200, { rev: db.rev, state: db.state, now: Date.now() });
    }

    if (url.pathname === '/api/merge' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      if (!body.next || typeof body.next !== 'object') {
        return sendJson(res, 400, { error: 'Invalid payload: next state required' });
      }
      applyMerge(body.base, body.next);
      return sendJson(res, 200, { ok: true, rev: db.rev, now: Date.now() });
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
        return sendJson(res, 401, { error: 'Admin key required' });
      }
      const cur = db.state || emptyState();
      db.state = Object.assign(emptyState(), {
        ADDED_USERS: cur.ADDED_USERS || {},
        REMOVED_USERS: cur.REMOVED_USERS || {}
      });
      db.rev++;
      persist();
      try {
        fs.readdirSync(IMG_DIR).forEach(f => fs.unlinkSync(path.join(IMG_DIR, f)));
      } catch (e) {}
      return sendJson(res, 200, { ok: true, rev: db.rev, now: Date.now() });
    }

    const im = /^\/api\/img\/([a-f0-9]{20})\.jpg$/.exec(url.pathname);
    if (im && req.method === 'GET') {
      const f = path.join(IMG_DIR, im[1] + '.jpg');
      if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'Image not found' });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(fs.readFileSync(f));
    }

    return sendJson(res, 404, { error: 'Route not found: ' + url.pathname });
  } catch (err) {
    console.error('[API Error]', err);
    return sendJson(res, 500, { error: String(err.message || err) });
  }
};
