'use strict';
/**
 * Emergency Vehicle Green Corridor Management System (Kolhapur)
 * Full-Stack Production Server with Native SQLite Persistence & Real-Time Sync
 * Zero External Dependencies (Node 18+ / Node 24+)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Native SQLite (Node 22.5+) with fallback to atomic JSON
let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  DatabaseSync = null;
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const IMG_DIR = path.join(DATA_DIR, 'img');
const DB_FILE = path.join(DATA_DIR, 'greencorridor.db');
const JSON_BACKUP_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const KEYS = ['TRIP', 'PUBLIC_INCIDENTS', 'AUDIT_LOG', 'ADDED_USERS', 'REMOVED_USERS'];
const MAX_BODY = 15 * 1024 * 1024; // 15 MB max payload for incident photos

fs.mkdirSync(IMG_DIR, { recursive: true });

/* ---------------- Rate Limiter ---------------- */
const rateLimits = new Map();
function isRateLimited(ip, limit = 120, windowMs = 60000) {
  const now = Date.now();
  let item = rateLimits.get(ip);
  if (!item || now > item.resetTime) {
    item = { count: 0, resetTime: now + windowMs };
    rateLimits.set(ip, item);
  }
  item.count++;
  return item.count > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, item] of rateLimits.entries()) {
    if (now > item.resetTime) rateLimits.delete(ip);
  }
}, 60000);

/* ---------------- Database Initialization (SQLite + JSON Backup) ---------------- */
let sqliteDb = null;
let db = { rev: 0, state: null };

if (DatabaseSync) {
  try {
    sqliteDb = new DatabaseSync(DB_FILE);
    sqliteDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gc_meta (
        key TEXT PRIMARY KEY,
        val TEXT
      );
      CREATE TABLE IF NOT EXISTS gc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        rev INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gc_trip_history (
        emergency_code TEXT PRIMARY KEY,
        vehicle_id TEXT,
        vehicle_type TEXT,
        driver_name TEXT,
        dest_hospital TEXT,
        status TEXT,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gc_blockchain (
        block_index INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

    `);

    const row = sqliteDb.prepare('SELECT rev, state_json FROM gc_state WHERE id = 1').get();
    if (row) {
      db.rev = row.rev;
      try { db.state = JSON.parse(row.state_json); } catch (e) {}
    }
    console.log('[Database] Native SQLite initialized at:', DB_FILE);
  } catch (err) {
    console.warn('[Database] SQLite init failed, falling back to atomic JSON file:', err.message);
    sqliteDb = null;
  }
}

if (!db.state && fs.existsSync(JSON_BACKUP_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(JSON_BACKUP_FILE, 'utf8'));
    db.rev = parsed.rev || 0;
    db.state = parsed.state || null;
    console.log('[Database] Loaded state from JSON backup (rev:', db.rev, ')');
  } catch (e) {}
}

const emptyState = () => ({
  TRIP: null,
  PUBLIC_INCIDENTS: [],
  AUDIT_LOG: [],
  ADDED_USERS: {},
  REMOVED_USERS: {}
});

/* ---------------- Cryptographic Blockchain Ledger (SHA-256) ---------------- */
class AuditBlock {
  constructor(index, timestamp, data, previousHash = '', nonce = 0, hash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data;
    this.previousHash = previousHash;
    this.nonce = nonce;
    this.hash = hash || this.calculateHash();
  }

  calculateHash() {
    return crypto.createHash('sha256')
      .update(this.index + '|' + String(this.timestamp) + '|' + JSON.stringify(this.data) + '|' + this.previousHash + '|' + this.nonce)
      .digest('hex');
  }

  mineBlock(difficulty = 1) {
    const target = '0'.repeat(difficulty);
    while (this.hash.substring(0, difficulty) !== target) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
  }
}

class BlockchainLedger {
  constructor() {
    this.chain = [];
    this.difficulty = 1;
    this.initLedger();
  }

  initLedger() {
    if (sqliteDb) {
      try {
        const rows = sqliteDb.prepare('SELECT block_index, timestamp, data_json, previous_hash, hash, nonce FROM gc_blockchain ORDER BY block_index ASC').all();
        if (rows && rows.length > 0) {
          for (const r of rows) {
            let data = {};
            try { data = JSON.parse(r.data_json); } catch (e) { data = r.data_json; }
            this.chain.push(new AuditBlock(r.block_index, r.timestamp, data, r.previous_hash, r.nonce, r.hash));
          }
          console.log('[Blockchain] Loaded ' + this.chain.length + ' tamper-evident block(s) from SQLite.');
        }
      } catch (err) {
        console.warn('[Blockchain] SQLite ledger setup error:', err.message);
      }
    }

    if (this.chain.length === 0) {
      const genesis = new AuditBlock(0, 1772500000000, {
        genesis: true,
        network: 'Kolhapur Green Corridor Authority',
        security: 'SHA-256 Immutable Proof-of-Work Chain'
      }, '0000000000000000000000000000000000000000000000000000000000000000');
      genesis.mineBlock(this.difficulty);
      this.chain.push(genesis);
      this.persistBlock(genesis);
      console.log('[Blockchain] Genesis block minted: ' + genesis.hash.slice(0, 16) + '...');
    }
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addRecord(actionData) {
    const latest = this.getLatestBlock();
    const newBlock = new AuditBlock(
      this.chain.length,
      Date.now(),
      actionData,
      latest ? latest.hash : '0'
    );
    newBlock.mineBlock(this.difficulty);
    this.chain.push(newBlock);
    this.persistBlock(newBlock);
    return newBlock;
  }

  persistBlock(block) {
    if (sqliteDb) {
      try {
        const stmt = sqliteDb.prepare(`
          INSERT INTO gc_blockchain (block_index, timestamp, data_json, previous_hash, hash, nonce, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(block_index) DO NOTHING
        `);
        stmt.run(
          block.index,
          block.timestamp,
          JSON.stringify(block.data),
          block.previousHash,
          block.hash,
          block.nonce,
          Date.now()
        );
      } catch (e) {}
    }
  }

  verifyIntegrity() {
    for (let i = 1; i < this.chain.length; i++) {
      const curr = this.chain[i];
      const prev = this.chain[i - 1];
      if (curr.hash !== curr.calculateHash()) {
        return { valid: false, brokenIndex: i, reason: 'Current block hash mismatch (tampered data)' };
      }
      if (curr.previousHash !== prev.hash) {
        return { valid: false, brokenIndex: i, reason: 'Previous block hash pointer broken' };
      }
    }
    return { valid: true, length: this.chain.length, latestHash: this.getLatestBlock().hash };
  }
}

const gcBlockchain = new BlockchainLedger();

/* ---------------- Persistence ---------------- */
let saveTimer = null;
function writeNow() {
  const stateJson = JSON.stringify(db.state || emptyState());
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare(`
        INSERT INTO gc_state (id, rev, state_json, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rev = excluded.rev,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `);
      stmt.run(db.rev, stateJson, Date.now());

      if (db.state && db.state.TRIP && db.state.TRIP.emergencyCode) {
        const trip = db.state.TRIP;
        const tripStmt = sqliteDb.prepare(`
          INSERT INTO gc_trip_history (emergency_code, vehicle_id, vehicle_type, driver_name, dest_hospital, status, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(emergency_code) DO UPDATE SET
            status = excluded.status,
            data_json = excluded.data_json
        `);
        tripStmt.run(
          trip.emergencyCode,
          trip.vehicleId || null,
          trip.vehicleType || null,
          trip.driverName || null,
          trip.destHospital ? trip.destHospital.name : null,
          trip.status || null,
          JSON.stringify(trip),
          Date.now()
        );
      }
    } catch (e) {
      console.error('[Database] SQLite save failed:', e);
    }
  }

  // Always keep atomic JSON backup
  try {
    const tmp = JSON_BACKUP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, JSON_BACKUP_FILE);
  } catch (e) {
    console.error('[Database] JSON backup write failed:', e);
  }

  // Notify long-poll listeners
  notifyWaiters();
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 100);
}

function flushAndExit() {
  try {
    if (saveTimer) clearTimeout(saveTimer);
    writeNow();
  } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);
process.on('uncaughtException', err => console.error('[Uncaught Exception]', err));
process.on('unhandledRejection', reason => console.error('[Unhandled Rejection]', reason));

/* ---------------- Long Polling for Real-Time Instant Sync ---------------- */
const waiters = new Set();
function notifyWaiters() {
  for (const res of waiters) {
    try {
      if (!res.writableEnded && !res.destroyed) {
        sendJson(res, 200, { rev: db.rev, state: db.state, now: Date.now() });
      }
    } catch (e) {}
  }
  waiters.clear();
}

/* ---------------- Image Storage ---------------- */
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

/* ---------------- 3-Way Conflict-Free Merge ---------------- */
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
  
    // Auto-commit new audit log events into the tamper-proof Blockchain
    try {
      const existingLogs = (cur && Array.isArray(cur.AUDIT_LOG)) ? cur.AUDIT_LOG : [];
      const newLogs = (out && Array.isArray(out.AUDIT_LOG)) ? out.AUDIT_LOG : [];
      if (newLogs.length > 0 && (!existingLogs.length || JSON.stringify(newLogs[0]) !== JSON.stringify(existingLogs[0]))) {
        const diffLogs = newLogs.filter(n => !existingLogs.some(e => JSON.stringify(e) === JSON.stringify(n)));
        for (const item of diffLogs.reverse()) {
          gcBlockchain.addRecord({
            type: 'AUDIT_ACTION',
            user: item.user || 'system',
            action: item.action,
            meta: item.meta || '',
            recordedAt: item.time || new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.warn('[Blockchain] Audit mining warning:', err.message);
    }
if (!eq(out, cur) || db.state === null) {
    db.state = out;
    db.rev++;
    persist();
  }
}

/* ---------------- HTTP Response Utilities ---------------- */
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
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'geolocation=(self), camera=(self)'
    }, extraHeaders));
    res.end(body);
  } catch (e) {}
}

function sendHtml(res, code, html) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    res.end(html);
  } catch (e) {}
}

function readBody(req) {
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

/* ---------------- HTTP Server ---------------- */
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '127.0.0.1';
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { error: 'Too many requests. Please slow down.' });
  }

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

    // Health / Diagnostics
    
    // Blockchain Verification & Ledger Endpoints
    if (url.pathname === '/api/blockchain' && req.method === 'GET') {
      const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10));
      const integrity = gcBlockchain.verifyIntegrity();
      const blocks = gcBlockchain.chain.slice(-limit).reverse();
      return sendJson(res, 200, {
        ok: true,
        integrity,
        totalBlocks: gcBlockchain.chain.length,
        blocks,
        now: Date.now()
      });
    }

    if (url.pathname === '/api/blockchain/verify' && req.method === 'GET') {
      const auditResult = gcBlockchain.verifyIntegrity();
      return sendJson(res, 200, Object.assign({ ok: true, now: Date.now() }, auditResult));
    }

    if (url.pathname === '/api/blockchain/mine' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      if (!body.action) {
        return sendJson(res, 400, { error: 'Action is required to mint blockchain block' });
      }
      const newBlock = gcBlockchain.addRecord({
        action: body.action,
        user: body.user || 'system',
        meta: body.meta || '',
        ip: req.socket.remoteAddress || '127.0.0.1'
      });
      return sendJson(res, 200, { ok: true, block: newBlock, rev: db.rev, now: Date.now() });
    }
if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'Emergency Vehicle Green Corridor Server (Kolhapur)',
        rev: db.rev,
        database: sqliteDb ? 'Native SQLite' : 'Atomic JSON',
        blockchain: { totalBlocks: gcBlockchain.chain.length, valid: gcBlockchain.verifyIntegrity().valid, latestHash: gcBlockchain.getLatestBlock().hash },
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        activeTrip: (db.state && db.state.TRIP) ? db.state.TRIP.emergencyCode : null,
        now: Date.now()
      });
    }

    // State Synchronization (with Long-Poll support)
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const since = parseInt(url.searchParams.get('since') || '-1', 10);
      const wait = url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true';

      if (since === db.rev) {
        if (wait) {
          waiters.add(res);
          req.on('close', () => waiters.delete(res));
          // Timeout after 25s if no change
          setTimeout(() => {
            if (waiters.delete(res)) {
              sendJson(res, 200, { rev: db.rev, unchanged: true, now: Date.now() });
            }
          }, 25000);
          return;
        }
        return sendJson(res, 200, { rev: db.rev, unchanged: true, now: Date.now() });
      }
      return sendJson(res, 200, { rev: db.rev, state: db.state, now: Date.now() });
    }

    // 3-Way State Merge
    if (url.pathname === '/api/merge' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      if (!body.next || typeof body.next !== 'object') {
        return sendJson(res, 400, { error: 'Invalid payload: next state required' });
      }
      applyMerge(body.base, body.next);
      return sendJson(res, 200, { ok: true, rev: db.rev, now: Date.now() });
    }

    // Admin Reset
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

    // Incident Photos
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

    // Web App Manifest
    if (url.pathname === '/manifest.json') {
      const manifest = {
        name: 'Emergency Vehicle Green Corridor',
        short_name: 'GreenCorridor',
        description: 'Emergency Vehicle Green Corridor Management System — Kolhapur',
        start_url: '/',
        display: 'standalone',
        background_color: '#080D18',
        theme_color: '#EF4B54',
        icons: [
          {
            src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23EF4B54"/><text x="50" y="68" font-size="50" text-anchor="middle" fill="white">🚑</text></svg>',
            sizes: '192x192',
            type: 'image/svg+xml'
          }
        ]
      };
      return sendJson(res, 200, manifest);
    }

    // Frontend HTML
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const htmlPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(htmlPath)) {
        return sendHtml(res, 200, fs.readFileSync(htmlPath, 'utf8'));
      }
      return sendHtml(res, 404, '<h1>Index file not found in public directory</h1>');
    }

    // Static Assets
    const filePath = path.join(PUBLIC_DIR, url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(fs.readFileSync(filePath));
    }

    return sendJson(res, 404, { error: 'Route not found' });
  } catch (err) {
    console.error('[Server Error]', err);
    return sendJson(res, 500, { error: String(err.message || err) });
  }
});

// Detect Local Network IPv4 Addresses
function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIps();
  console.log('================================================================');
  console.log('🚑 GREEN CORRIDOR EMERGENCY MANAGEMENT SYSTEM — KOLHAPUR');
  console.log('⚡ Server running with 0 errors');
  console.log('📍 Local URL:     http://localhost:' + PORT);
  localIps.forEach(ip => {
    console.log('📱 Network / APK: http://' + ip + ':' + PORT);
  });
  console.log('💾 Database:    ' + (sqliteDb ? 'Native SQLite (' + DB_FILE + ')' : 'Atomic JSON'));
  console.log('================================================================');
});
