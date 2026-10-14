'use strict';

/* Vercel Function: ランキングAPI (GET: 取得 / POST: 登録)
   保存先は PostgreSQL(環境変数 DATABASE_URL または POSTGRES_URL) */

const crypto = require('crypto');

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const COURSES = new Set(['jp', 'en', 'mix'].flatMap((l) => [1, 2, 3].map((v) => `${l}-${v}`)));
const DURATION = 60;

let pool = null;
let ready = null;

// 接続URLの sslmode は、下の ssl 設定と食い違わないよう取り除く
function cleanUrl(u) {
  try {
    const x = new URL(u);
    x.searchParams.delete('sslmode');
    return x.toString();
  } catch (_) {
    return u;
  }
}

function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: cleanUrl(DB_URL),
      ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
      max: 1, // サーバーレスでは接続を増やさない
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

function init() {
  if (!ready) {
    ready = (async () => {
      const p = getPool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS scores (
          id          SERIAL PRIMARY KEY,
          course      TEXT NOT NULL,
          name        TEXT NOT NULL,
          score       INTEGER NOT NULL,
          kpm         INTEGER NOT NULL,
          accuracy    REAL NOT NULL,
          ip_hash     TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await p.query('CREATE INDEX IF NOT EXISTS idx_scores_course_score ON scores (course, score DESC)');
      await p.query('CREATE INDEX IF NOT EXISTS idx_scores_ip_time ON scores (ip_hash, created_at)');
      // Supabaseでは公開APIから直接テーブルを触れないようにする(このサーバー経由のみ許可)
      await p.query('ALTER TABLE scores ENABLE ROW LEVEL SECURITY');
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function cleanName(v) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, 12).join('');
}
const int = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : NaN);

function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'kiwami')).digest('hex').slice(0, 32);
}

async function handleGet(req, res) {
  const course = String((req.query && req.query.course) || '');
  if (!COURSES.has(course)) return res.status(400).json({ error: 'invalid_course' });
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { rows } = await getPool().query(
    'SELECT id, name, score, kpm, accuracy, created_at FROM scores WHERE course = $1 ORDER BY score DESC, id ASC LIMIT $2',
    [course, limit]
  );
  return res.status(200).json({
    course,
    entries: rows.map((r, i) => ({
      id: r.id, rank: i + 1, name: r.name, score: r.score, kpm: r.kpm,
      accuracy: Math.round(r.accuracy * 1000) / 10, at: r.created_at,
    })),
  });
}

async function handlePost(req, res) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = null; } }
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'bad_request' });

  const course = String(b.course || '');
  const name = cleanName(b.name);
  const score = int(b.score);
  const keys = int(b.keys);
  const miss = int(b.miss);

  if (!COURSES.has(course)) return res.status(400).json({ error: 'invalid_course' });
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  if (![score, keys, miss].every(Number.isFinite)) return res.status(400).json({ error: 'invalid_value' });
  if (score < 1 || score > 60000 || keys < 1 || keys > 1500 || miss < 0 || miss > 1500) return res.status(400).json({ error: 'invalid_value' });
  if (score > keys * 40) return res.status(400).json({ error: 'invalid_value' }); // 打鍵数に対してありえない点数

  const p = getPool();
  const h = ipHash(req);
  const recent = await p.query(
    "SELECT COUNT(*)::int AS n FROM scores WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '10 minutes'",
    [h]
  );
  if (recent.rows[0].n >= 15) return res.status(429).json({ error: 'rate_limited' });

  const kpm = Math.round((keys * 60) / DURATION);
  const accuracy = keys / (keys + miss);
  const ins = await p.query(
    'INSERT INTO scores (course, name, score, kpm, accuracy, ip_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [course, name, score, kpm, accuracy, h]
  );
  const id = ins.rows[0].id;
  const rk = await p.query(
    'SELECT COUNT(*)::int AS n FROM scores WHERE course = $1 AND (score > $2 OR (score = $2 AND id < $3))',
    [course, score, id]
  );
  return res.status(201).json({ id, rank: rk.rows[0].n + 1 });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DB_URL) return res.status(503).json({ error: 'no_database' });
  try {
    await init();
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
};
