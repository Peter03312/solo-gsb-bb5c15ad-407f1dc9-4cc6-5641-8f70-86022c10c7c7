'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geom = require('./geom');
const { optimizeMulti } = require('./nest');
const { validateJobInput } = require('./validate');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 数据访问辅助 ----------

function loadFull(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const rolls = db.prepare('SELECT * FROM rolls WHERE job_id = ? ORDER BY seq').all(jobId);
  const defects = db
    .prepare(
      `SELECT d.id, d.roll_id, d.x, d.y, d.w, d.h, r.seq AS roll_seq
       FROM defects d LEFT JOIN rolls r ON r.id = d.roll_id
       WHERE d.job_id = ? ORDER BY d.id`
    )
    .all(jobId);
  const types = db.prepare('SELECT * FROM piece_types WHERE job_id = ?').all(jobId);
  const placements = db
    .prepare(
      `SELECT p.*, t.name, t.allow_rotate, t.bw, t.bh, r.seq AS roll_seq
       FROM placements p
       JOIN piece_types t ON t.id = p.piece_type_id
       LEFT JOIN rolls r ON r.id = p.roll_id
       WHERE p.job_id = ? ORDER BY p.id`
    )
    .all(jobId);
  return { job, rolls, defects, types, placements };
}

/** 重算各卷占用长度、启用卷数、总占用长度与方案状态（complete / partial / draft） */
function recompute(jobId) {
  const cnt = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(placed), 0) AS placed FROM placements WHERE job_id = ?')
    .get(jobId);
  const perRoll = db
    .prepare(
      `SELECT p.roll_id AS rollId, MAX(p.y + t.bh) AS used, COUNT(*) AS n
       FROM placements p JOIN piece_types t ON t.id = p.piece_type_id
       WHERE p.job_id = ? AND p.placed = 1
       GROUP BY p.roll_id`
    )
    .all(jobId);
  let usedTotal = 0;
  for (const r of perRoll) usedTotal += r.used || 0;
  const cur = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status;
  let status;
  if (cnt.placed === cnt.total) status = 'complete';
  else status = cur === 'draft' ? 'draft' : 'partial';
  db.prepare('UPDATE jobs SET used_length = ?, rolls_used = ?, status = ? WHERE id = ?').run(
    usedTotal,
    perRoll.length,
    status,
    jobId
  );
}

/** 组装完整方案状态（API 返回） */
function jobState(jobId) {
  const full = loadFull(jobId);
  if (!full) return null;
  const { job, rolls, defects, types, placements } = full;
  const perRoll = new Map(
    db
      .prepare(
        `SELECT p.roll_id AS rollId, MAX(p.y + t.bh) AS used, COUNT(*) AS n
         FROM placements p JOIN piece_types t ON t.id = p.piece_type_id
         WHERE p.job_id = ? AND p.placed = 1
         GROUP BY p.roll_id`
      )
      .all(jobId)
      .map((r) => [r.rollId, r])
  );
  return {
    job: {
      id: job.id,
      name: job.name,
      // 兼容字段：各卷最大宽度 / 最大长度（旧单卷方案即原布幅尺寸）
      fabricWidth: job.fabric_width,
      fabricLength: job.fabric_length,
      status: job.status,
      usedLength: job.used_length, // 各启用卷占用长度之和
      rollsUsed: job.rolls_used,
      createdAt: job.created_at,
    },
    rolls: rolls.map((r) => {
      const st = perRoll.get(r.id);
      return {
        id: r.id,
        seq: r.seq,
        width: r.width,
        length: r.length,
        usedLength: st ? st.used : 0,
        pieceCount: st ? st.n : 0,
      };
    }),
    defects: defects.map((d) => ({ id: d.id, roll: d.roll_seq, x: d.x, y: d.y, w: d.w, h: d.h })),
    pieceTypes: types.map((t) => ({
      id: t.id,
      name: t.name,
      vertices: JSON.parse(t.vertices),
      quantity: t.quantity,
      allowRotate: !!t.allow_rotate,
      bw: t.bw,
      bh: t.bh,
    })),
    placements: placements.map((p) => ({
      id: p.id,
      pieceTypeId: p.piece_type_id,
      name: p.name,
      seq: p.seq,
      roll: p.placed ? p.roll_seq : null, // 卷号（未排入为 null）
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      placed: !!p.placed,
      locked: !!p.locked,
      requiredRoll: p.required_roll, // 必用卷号（null 表示不限）
      allowRotate: !!p.allow_rotate,
      bw: p.bw,
      bh: p.bh,
    })),
    unplaced: placements
      .filter((p) => !p.placed)
      .map((p) => ({ id: p.id, name: p.name, seq: p.seq, requiredRoll: p.required_roll })),
  };
}

// ---------- 路由 ----------

app.get('/api/jobs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT j.id, j.name, j.fabric_width AS fabricWidth, j.fabric_length AS fabricLength,
              j.status, j.used_length AS usedLength, j.rolls_used AS rollsUsed, j.created_at AS createdAt,
              (SELECT COUNT(*) FROM placements p WHERE p.job_id = j.id) AS pieceCount,
              (SELECT COUNT(*) FROM rolls r WHERE r.job_id = j.id) AS rollCount
       FROM jobs j ORDER BY j.id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/jobs', (req, res) => {
  const { errors, value } = validateJobInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: '输入不合法，未创建方案', details: errors });
  }
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO jobs (name, fabric_width, fabric_length) VALUES (?, ?, ?)')
      .run(value.name, value.fabricWidth, value.fabricLength);
    const jobId = info.lastInsertRowid;
    const insRoll = db.prepare('INSERT INTO rolls (job_id, seq, width, length) VALUES (?, ?, ?, ?)');
    const insD = db.prepare('INSERT INTO defects (job_id, roll_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)');
    const rollIdBySeq = new Map();
    value.rolls.forEach((r, i) => {
      const rollId = insRoll.run(jobId, i + 1, r.width, r.length).lastInsertRowid;
      rollIdBySeq.set(i + 1, rollId);
      for (const d of r.defects) insD.run(jobId, rollId, d.x, d.y, d.w, d.h);
    });
    const insT = db.prepare(
      'INSERT INTO piece_types (job_id, name, vertices, quantity, allow_rotate, bw, bh) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insP = db.prepare('INSERT INTO placements (job_id, piece_type_id, seq, required_roll) VALUES (?, ?, ?, ?)');
    for (const p of value.pieces) {
      const t = insT.run(jobId, p.name, JSON.stringify(p.vertices), p.quantity, p.allowRotate ? 1 : 0, p.bw, p.bh);
      for (let s = 1; s <= p.quantity; s++) insP.run(jobId, t.lastInsertRowid, s, p.requiredRoll);
    }
    return jobId;
  });
  const jobId = tx();
  res.status(201).json(jobState(jobId));
});

app.get('/api/jobs/:id', (req, res) => {
  const state = jobState(Number(req.params.id));
  if (!state) return res.status(404).json({ error: '方案不存在' });
  res.json(state);
});

app.delete('/api/jobs/:id', (req, res) => {
  const info = db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: '方案不存在' });
  res.status(204).end();
});

/**
 * 优化排样：锁定件与各卷瑕疵固定，重新排入全部未锁定裁片。
 * 目标（字典序）：排入件数最多 → 启用卷数最少 → 总占用长度最小；
 * 绝不为减少用卷牺牲本可排入的裁片。
 */
app.post('/api/jobs/:id/optimize', (req, res) => {
  const full = loadFull(Number(req.params.id));
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, rolls, defects, types, placements } = full;
  const typeById = new Map(types.map((t) => [t.id, t]));
  const rollIdBySeq = new Map(rolls.map((r) => [r.seq, r.id]));

  const locked = placements.filter((p) => p.placed && p.locked);
  const rest = placements.filter((p) => !(p.placed && p.locked));

  const result = optimizeMulti({
    rolls: rolls.map((r) => ({
      key: r.id,
      label: r.seq,
      W: r.width,
      L: r.length,
      defects: defects.filter((d) => d.roll_id === r.id),
      locked: locked
        .filter((p) => p.roll_id === r.id)
        .map((p) => {
          const t = typeById.get(p.piece_type_id);
          return { key: p.id, verts: JSON.parse(t.vertices), rot: p.rotation, x: p.x, y: p.y, w: t.bw, h: t.bh };
        }),
    })),
    pieces: rest.map((p) => {
      const t = typeById.get(p.piece_type_id);
      const verts = JSON.parse(t.vertices);
      return {
        key: p.id,
        maskKey: 'T' + t.id,
        verts,
        allowRotate: !!t.allow_rotate,
        w: t.bw,
        h: t.bh,
        area: Math.abs(geom.area2(verts)) / 2,
        requiredRoll: p.required_roll != null ? rollIdBySeq.get(p.required_roll) ?? -1 : null,
      };
    }),
  });

  const lockedIds = new Set(locked.map((p) => p.id));
  const upd = db.prepare(
    'UPDATE placements SET roll_id = ?, x = ?, y = ?, rotation = ?, placed = 1, locked = 0 WHERE id = ?'
  );
  const clr = db.prepare(
    'UPDATE placements SET roll_id = NULL, x = NULL, y = NULL, rotation = 0, placed = 0, locked = 0 WHERE id = ?'
  );
  const status = result.unplaced.length === 0 ? 'complete' : 'partial';
  const tx = db.transaction(() => {
    for (const pl of result.placements) {
      if (lockedIds.has(pl.key)) continue; // 锁定件保持原卷原位
      upd.run(pl.roll, pl.x, pl.y, pl.rotation, pl.key);
    }
    for (const u of result.unplaced) clr.run(u.key);
    db.prepare('UPDATE jobs SET used_length = ?, rolls_used = ?, status = ? WHERE id = ?').run(
      result.usedLength,
      result.rollsUsed,
      status,
      job.id
    );
  });
  tx();
  res.json(jobState(job.id));
});

/**
 * 手动移动（或未排入件手动放入，可跨卷）。
 * body: {x, y, rotation, roll?} —— roll 为目标卷号（缺省：已排件保持原卷，未排件默认卷 1）。
 * 必用卷约束、目标卷布边/瑕疵/已排裁片均校验；冲突时指出对象并保持原方案。
 */
app.post('/api/jobs/:id/placements/:pid/move', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, rolls, defects, types, placements } = full;
  const placement = placements.find((p) => p.id === pid);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const label = `裁片「${placement.name}#${placement.seq}」`;

  if (placement.locked) {
    return res.status(409).json({ error: `${label}已锁定，请先解锁再移动`, conflicts: [label] });
  }
  const { x, y, rotation } = req.body || {};
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(rotation)) {
    return res.status(400).json({ error: '位置与旋转角度必须为整数（x, y 单位 mm；rotation 为 0 或 180）' });
  }
  if (rotation !== 0 && rotation !== 180) {
    return res.status(400).json({ error: '旋转角度仅支持 0° 或 180°' });
  }
  if (rotation === 180 && !placement.allow_rotate) {
    return res.status(409).json({ error: `${label}不允许旋转（禁旋转件须保持原方向）`, conflicts: [label] });
  }

  // 目标卷：显式指定卷号，或默认原卷 / 卷 1
  let roll;
  const bodyRoll = req.body ? req.body.roll : undefined;
  if (bodyRoll !== undefined && bodyRoll !== null) {
    if (!Number.isInteger(bodyRoll)) {
      return res.status(400).json({ error: `卷号必须为整数（1~${rolls.length}），收到 ${JSON.stringify(bodyRoll)}` });
    }
    roll = rolls.find((r) => r.seq === bodyRoll);
    if (!roll) {
      return res.status(400).json({ error: `无效卷号 ${bodyRoll}：方案 #${jobId} 共 ${rolls.length} 卷（有效卷号 1~${rolls.length}）` });
    }
  } else if (placement.placed && placement.roll_id != null) {
    roll = rolls.find((r) => r.id === placement.roll_id);
  } else {
    roll = rolls[0];
  }
  if (!roll) return res.status(500).json({ error: '方案缺少布卷数据' });

  // 必用卷约束
  if (placement.required_roll != null && placement.required_roll !== roll.seq) {
    return res.status(409).json({
      error: `${label}指定了必用卷（卷${placement.required_roll}），不能移动到卷${roll.seq}，已保留原方案`,
      conflicts: [label],
    });
  }

  const w = placement.bw;
  const h = placement.bh;
  if (x < 0 || y < 0 || x + w > roll.width || y + h > roll.length) {
    return res.status(409).json({
      error: `${label}移动后超出卷${roll.seq}布边（需满足 0≤x≤${roll.width - w}, 0≤y≤${roll.length - h}），已保留原方案`,
      conflicts: [label],
    });
  }

  const type = types.find((t) => t.id === placement.piece_type_id);
  const verts = JSON.parse(type.vertices);
  const abs = geom.toAbsolute(verts, rotation, w, h, x, y);

  const conflicts = [];
  for (const d of defects) {
    if (d.roll_id !== roll.id) continue;
    if (geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h))) {
      conflicts.push(`卷${roll.seq}瑕疵区#${d.id}（${d.x},${d.y} ${d.w}×${d.h}mm）`);
    }
  }
  for (const q of placements) {
    if (q.id === pid || !q.placed || q.roll_id !== roll.id) continue;
    const qt = types.find((t) => t.id === q.piece_type_id);
    const qAbs = geom.toAbsolute(JSON.parse(qt.vertices), q.rotation, qt.bw, qt.bh, q.x, q.y);
    if (geom.polygonsInteriorOverlap(abs, qAbs)) {
      conflicts.push(`裁片「${q.name}#${q.seq}」${q.locked ? '（已锁定）' : ''}`);
    }
  }
  if (conflicts.length > 0) {
    return res.status(409).json({ error: `${label}移动后与以下对象冲突，已保留原方案`, conflicts });
  }

  db.prepare('UPDATE placements SET roll_id = ?, x = ?, y = ?, rotation = ?, placed = 1 WHERE id = ?').run(
    roll.id,
    x,
    y,
    rotation,
    pid
  );
  recompute(jobId);
  res.json(jobState(jobId));
});

/**
 * 设置 / 取消裁片的必用卷约束。body: {roll: 卷号 | null}
 * 无效卷号、或卷容不下裁片外接尺寸时明确拒绝（400）。
 */
app.post('/api/jobs/:id/placements/:pid/required-roll', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { rolls, placements } = full;
  const placement = placements.find((p) => p.id === pid);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const label = `裁片「${placement.name}#${placement.seq}」`;

  const rollSeq = req.body ? req.body.roll : undefined;
  if (rollSeq === null || rollSeq === undefined || rollSeq === 0) {
    db.prepare('UPDATE placements SET required_roll = NULL WHERE id = ?').run(pid);
    return res.json(jobState(jobId));
  }
  if (!Number.isInteger(rollSeq)) {
    return res.status(400).json({ error: `必用卷号必须为整数（1~${rolls.length}），收到 ${JSON.stringify(rollSeq)}` });
  }
  const roll = rolls.find((r) => r.seq === rollSeq);
  if (!roll) {
    return res.status(400).json({ error: `无效必用卷号 ${rollSeq}：方案 #${jobId} 共 ${rolls.length} 卷（有效卷号 1~${rolls.length}），约束未设置` });
  }
  if (placement.bw > roll.width || placement.bh > roll.length) {
    return res.status(400).json({
      error: `必用卷${rollSeq}（${roll.width}×${roll.length}mm）容不下${label}的外接尺寸 ${placement.bw}×${placement.bh}mm，约束无效已拒绝`,
    });
  }
  db.prepare('UPDATE placements SET required_roll = ? WHERE id = ?').run(rollSeq, pid);
  res.json(jobState(jobId));
});

/** 锁定 / 解锁（锁定件的卷号、位置、方向在优化中始终固定） */
app.post('/api/jobs/:id/placements/:pid/lock', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const placement = db
    .prepare(
      `SELECT p.*, t.name FROM placements p JOIN piece_types t ON t.id = p.piece_type_id
       WHERE p.id = ? AND p.job_id = ?`
    )
    .get(pid, jobId);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const locked = !!(req.body && req.body.locked);
  if (locked && !placement.placed) {
    return res.status(400).json({ error: `裁片「${placement.name}#${placement.seq}」尚未排入，不能锁定` });
  }
  db.prepare('UPDATE placements SET locked = ? WHERE id = ?').run(locked ? 1 : 0, pid);
  res.json(jobState(jobId));
});

/** 移回未排区（同时解除锁定；必用卷约束保留） */
app.post('/api/jobs/:id/placements/:pid/unplace', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const info = db
    .prepare(
      'UPDATE placements SET roll_id = NULL, x = NULL, y = NULL, rotation = 0, placed = 0, locked = 0 WHERE id = ? AND job_id = ?'
    )
    .run(pid, jobId);
  if (info.changes === 0) return res.status(404).json({ error: '裁片不存在' });
  recompute(jobId);
  res.json(jobState(jobId));
});

// ---------- 错误处理与启动 ----------

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`布料裁片排样系统已启动：http://localhost:${PORT}`);
});
