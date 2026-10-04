'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nesting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  fabric_width  INTEGER NOT NULL,    -- 兼容字段：各卷最大宽度
  fabric_length INTEGER NOT NULL,    -- 兼容字段：各卷最大长度
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | partial | complete
  used_length   INTEGER NOT NULL DEFAULT 0,      -- 各启用卷占用长度之和
  rolls_used    INTEGER NOT NULL DEFAULT 0,      -- 启用卷数（有裁片的卷）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 布卷：一个方案可登记多卷，卷号 seq 从 1 开始、方案内唯一
CREATE TABLE IF NOT EXISTS rolls (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,           -- 卷号（1..n，按登记顺序）
  width  INTEGER NOT NULL,
  length INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS defects (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  roll_id INTEGER,                   -- 所属卷（旧数据迁移后必有值）
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS piece_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  vertices     TEXT NOT NULL,              -- JSON，归一化后的顶点 [[x,y],...]
  quantity     INTEGER NOT NULL,
  allow_rotate INTEGER NOT NULL DEFAULT 0, -- 是否允许旋转 180°
  bw INTEGER NOT NULL, bh INTEGER NOT NULL -- 外接矩形尺寸（旋转 180° 不变）
);

CREATE TABLE IF NOT EXISTS placements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  piece_type_id INTEGER NOT NULL REFERENCES piece_types(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,          -- 该型号的第几件（1..quantity）
  roll_id       INTEGER,                   -- 所在卷（未排入为 NULL）
  x INTEGER, y INTEGER,                    -- 卷内坐标（未排入为 NULL）
  rotation INTEGER NOT NULL DEFAULT 0,     -- 0 | 180
  placed   INTEGER NOT NULL DEFAULT 0,
  locked   INTEGER NOT NULL DEFAULT 0,
  required_roll INTEGER                    -- 必用卷号（seq），NULL 表示不限
);

CREATE INDEX IF NOT EXISTS idx_rolls_job      ON rolls(job_id);
CREATE INDEX IF NOT EXISTS idx_defects_job    ON defects(job_id);
CREATE INDEX IF NOT EXISTS idx_types_job      ON piece_types(job_id);
CREATE INDEX IF NOT EXISTS idx_placements_job ON placements(job_id);
`);

// ---------- 旧库迁移（单卷 → 多卷结构） ----------

const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

if (!colsOf('jobs').includes('rolls_used')) {
  db.exec("ALTER TABLE jobs ADD COLUMN rolls_used INTEGER NOT NULL DEFAULT 0");
}
if (!colsOf('defects').includes('roll_id')) {
  db.exec('ALTER TABLE defects ADD COLUMN roll_id INTEGER');
}
const plCols = colsOf('placements');
if (!plCols.includes('roll_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN roll_id INTEGER');
}
if (!plCols.includes('required_roll')) {
  db.exec('ALTER TABLE placements ADD COLUMN required_roll INTEGER');
}

// 旧方案回填：没有卷记录的方案补建唯一卷（沿用原布幅尺寸），瑕疵与裁片归入该卷
const legacyJobs = db
  .prepare('SELECT id, fabric_width, fabric_length FROM jobs WHERE id NOT IN (SELECT DISTINCT job_id FROM rolls)')
  .all();
if (legacyJobs.length > 0) {
  const insRoll = db.prepare('INSERT INTO rolls (job_id, seq, width, length) VALUES (?, 1, ?, ?)');
  const backfill = db.transaction(() => {
    for (const j of legacyJobs) {
      const rollId = insRoll.run(j.id, j.fabric_width, j.fabric_length).lastInsertRowid;
      db.prepare('UPDATE defects SET roll_id = ? WHERE job_id = ? AND roll_id IS NULL').run(rollId, j.id);
      db.prepare('UPDATE placements SET roll_id = ? WHERE job_id = ? AND roll_id IS NULL').run(rollId, j.id);
      const used = db
        .prepare('SELECT COUNT(*) AS c FROM placements WHERE job_id = ? AND placed = 1 AND roll_id = ?')
        .get(j.id, rollId).c;
      db.prepare('UPDATE jobs SET rolls_used = ? WHERE id = ?').run(used > 0 ? 1 : 0, j.id);
    }
  });
  backfill();
}

module.exports = db;
