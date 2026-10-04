'use strict';

const assert = require('assert');
const geom = require('../src/geom');
const { optimize, optimizeMulti } = require('../src/nest');
const { validateJobInput } = require('../src/validate');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    process.exitCode = 1;
  }
}

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** 排样结果不变量校验：边界、两两不重叠、不压瑕疵、锁定件不动 */
function verifyLayout({ W, L, defects, locked, result, typesByKey }) {
  const absOf = (pl) => {
    const t = typesByKey.get(pl.key);
    return geom.toAbsolute(t.verts, pl.rotation, t.w, t.h, pl.x, pl.y);
  };
  const polys = result.placements.map((pl) => ({ pl, abs: absOf(pl) }));
  for (const { pl, abs } of polys) {
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= W && y >= 0 && y <= L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出布幅`);
    }
    for (const d of defects) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与瑕疵区 (${d.x},${d.y},${d.w},${d.h}) 重叠`
      );
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      assert(
        !geom.polygonsInteriorOverlap(polys[i].abs, polys[j].abs),
        `裁片 ${polys[i].pl.key} 与 ${polys[j].pl.key} 内部重叠`
      );
    }
  }
  for (const lp of locked) {
    const got = result.placements.find((p) => p.key === lp.key);
    assert(got, '锁定件丢失');
    assert(got.x === lp.x && got.y === lp.y && got.rotation === lp.rot, '锁定件位置被改变');
  }
}

// ---------------- 几何：轮廓校验 ----------------
console.log('几何：轮廓校验');
test('合法矩形通过', () => {
  assert.strictEqual(geom.validatePolygon(rect(0, 0, 10, 10)), null);
});
test('凹多边形（L 形）通过', () => {
  assert.strictEqual(
    geom.validatePolygon([[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]),
    null
  );
});
test('自交（蝴蝶结）被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 10], [10, 0], [0, 10]]));
});
test('零面积被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [5, 5], [10, 10]]));
});
test('重复相邻顶点被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0], [10, 0], [0, 10]]));
});
test('非整数坐标被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10.5, 0], [0, 10]]));
});
test('顶点数不足被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0]]));
});

// ---------------- 几何：内部重叠（边界接触允许） ----------------
console.log('几何：内部重叠判定');
test('边接触的矩形不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10)));
});
test('部分共边（T 型接触）不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(3, 10, 4, 8)));
});
test('角点接触不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 10, 5, 5)));
});
test('正面积重叠被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(9, 0, 10, 10)));
});
test('完全重合被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(0, 0, 10, 10)));
});
test('包含关系被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(2, 2, 3, 3)));
});
test('内接菱形（顶点全在对方边界上）被检出', () => {
  const diamond = [[5, 0], [10, 5], [5, 10], [0, 5]];
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), diamond));
});
test('旋转 180° 后与原向不重叠（相邻放置）', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 40, 0);
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 互补拼接（共斜边）不重叠', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 0, 0); // 与 a 恰好拼满同一矩形，仅共斜边
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 错位放置重叠被检出', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, -10, 0);
  assert(geom.polygonsInteriorOverlap(a, b));
});

// ---------------- 排样 ----------------
console.log('排样优化器');
test('矩形排样：全部排入且无重叠，占用长度正确', () => {
  const W = 1000, L = 2000;
  const defects = [{ x: 0, y: 0, w: 100, h: 100 }];
  const mk = (key) => ({
    key, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000,
  });
  const pieces = [mk('a'), mk('b'), mk('c'), mk('d')];
  const result = optimize({ W, L, defects, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '应全部排入');
  assert.strictEqual(result.placements.length, 4);
  assert(result.usedLength <= 1100, `占用长度 ${result.usedLength} 应 ≤ 1100`);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
});

test('超出布幅宽度的裁片列入未排入', () => {
  const result = optimize({
    W: 1000, L: 2000, defects: [], locked: [],
    pieces: [{ key: 'big', maskKey: 'b', verts: rect(0, 0, 1200, 100), allowRotate: true, w: 1200, h: 100, area: 120000 }],
  });
  assert.strictEqual(result.unplaced.length, 1);
  assert(/超出布幅/.test(result.unplaced[0].reason));
});

test('长度不足时列入未排入', () => {
  const pieces = [];
  for (let i = 0; i < 5; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 1000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 1, '应恰有 1 件放不下');
  assert.strictEqual(result.placements.length, 4);
});

test('锁定件保持固定，其余绕开', () => {
  const locked = [{ key: 'L1', verts: rect(0, 0, 500, 500), rot: 0, x: 250, y: 100, w: 500, h: 500 }];
  const pieces = [];
  for (let i = 0; i < 3; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 2000, defects: [], locked, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  typesByKey.set('L1', { verts: rect(0, 0, 500, 500), w: 500, h: 500 });
  verifyLayout({ W: 1000, L: 2000, defects: [], locked, result, typesByKey });
});

test('禁旋转件保持 0°，可旋转件角度合法', () => {
  const lshape = [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]];
  const pieces = [
    { key: 'a', maskKey: 'L', verts: lshape, allowRotate: true, w: 300, h: 300, area: 50000 },
    { key: 'b', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
    { key: 'c', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
  ];
  const result = optimize({ W: 400, L: 2000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0);
  for (const pl of result.placements) {
    if (pl.key === 'a') assert(pl.rotation === 0 || pl.rotation === 180);
    else assert.strictEqual(pl.rotation, 0, '禁旋转件不得旋转');
  }
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W: 400, L: 2000, defects: [], locked: [], result, typesByKey });
});

test('随机矩形压力测试（不变量）', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 6000;
  const defects = [
    { x: 700, y: 800, w: 150, h: 200 },
    { x: 200, y: 3000, w: 300, h: 120 },
  ];
  const pieces = [];
  for (let i = 0; i < 30; i++) {
    const w = 100 + Math.floor(rnd() * 400);
    const h = 100 + Math.floor(rnd() * 500);
    pieces.push({
      key: 'r' + i, maskKey: 'r' + i, verts: rect(0, 0, w, h),
      allowRotate: rnd() < 0.5, w, h, area: w * h,
    });
  }
  const result = optimize({ W, L, defects, locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
  assert(result.usedLength <= L);
  console.log(`    （随机测试：排入 ${result.placements.length}/30，占用长度 ${result.usedLength}mm）`);
});

test('随机多边形（含凹形/三角）压力测试（不变量）', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 8000;
  const shapes = [
    [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]], // L 形
    [[0, 0], [400, 0], [0, 300]],                                     // 三角形
    [[0, 0], [250, 0], [250, 150], [125, 220], [0, 150]],             // 五边形
  ];
  const pieces = [];
  for (let i = 0; i < 24; i++) {
    const verts = shapes[i % shapes.length];
    const w = Math.max(...verts.map((v) => v[0]));
    const h = Math.max(...verts.map((v) => v[1]));
    pieces.push({
      key: 's' + i, maskKey: 's' + (i % shapes.length), verts,
      allowRotate: rnd() < 0.5, w, h, area: Math.abs(geom.area2(verts)) / 2,
    });
  }
  const result = optimize({ W, L, defects: [], locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects: [], locked: [], result, typesByKey });
  console.log(`    （随机测试：排入 ${result.placements.length}/24，占用长度 ${result.usedLength}mm）`);
});

// ---------------- 多卷排样 ----------------
console.log('多卷排样');

/** 多卷结果不变量校验：各卷边界、两两不重叠、不压本卷瑕疵、锁定件不动、必用卷约束 */
function verifyMulti({ rolls, pieces, result }) {
  const rollByKey = new Map(rolls.map((r) => [r.key, r]));
  const pieceByKey = new Map(pieces.map((p) => [p.key, p]));
  const lockedByKey = new Map();
  for (const r of rolls) for (const l of r.locked) lockedByKey.set(l.key, { roll: r, l });
  const polys = result.placements.map((pl) => {
    const roll = rollByKey.get(pl.roll);
    assert(roll, `裁片 ${pl.key} 落在不存在的卷 ${pl.roll}`);
    const src = pieceByKey.get(pl.key) || lockedByKey.get(pl.key).l;
    const verts = src.verts;
    const w = src.w;
    const h = src.h;
    const abs = geom.toAbsolute(verts, pl.rotation, w, h, pl.x, pl.y);
    return { pl, roll, abs };
  });
  for (const { pl, roll, abs } of polys) {
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= roll.W && y >= 0 && y <= roll.L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出卷${pl.roll}`);
    }
    for (const d of roll.defects) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与卷${pl.roll}瑕疵区重叠`
      );
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (polys[i].roll !== polys[j].roll) continue; // 不同卷天然不重叠
      assert(
        !geom.polygonsInteriorOverlap(polys[i].abs, polys[j].abs),
        `裁片 ${polys[i].pl.key} 与 ${polys[j].pl.key} 在卷${polys[i].pl.roll} 内部重叠`
      );
    }
  }
  // 锁定件不动
  for (const [key, { roll, l }] of lockedByKey) {
    const got = result.placements.find((p) => p.key === key);
    assert(got, `锁定件 ${key} 丢失`);
    assert(got.roll === roll.key && got.x === l.x && got.y === l.y && got.rotation === l.rot, `锁定件 ${key} 被移动`);
  }
  // 必用卷约束
  for (const p of pieces) {
    if (p.requiredRoll == null) continue;
    const got = result.placements.find((x) => x.key === p.key);
    if (got) assert(got.roll === p.requiredRoll, `裁片 ${p.key} 未落在必用卷 ${p.requiredRoll}`);
  }
  return polys;
}

const mkRect = (key, w, h, extra) =>
  Object.assign({ key, maskKey: 'm' + key, verts: rect(0, 0, w, h), allowRotate: false, w, h, area: w * h, requiredRoll: null }, extra);

test('多卷：自由件按卷序填充，启用卷为前缀', () => {
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 1000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1000, L: 1000, defects: [], locked: [] },
    { key: 'R3', label: 3, W: 1000, L: 1000, defects: [], locked: [] },
  ];
  // 卷 1 恰好放 4 件 500×500，第 5 件应启用卷 2，卷 3 不启用
  const pieces = [];
  for (let i = 0; i < 5; i++) pieces.push(mkRect('p' + i, 500, 500));
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 0, '应全部排入');
  assert.strictEqual(result.rollsUsed, 2, `应启用 2 卷，实际 ${result.rollsUsed}`);
  const rollsUsed = new Set(result.placements.map((p) => p.roll));
  assert(rollsUsed.has('R1') && rollsUsed.has('R2') && !rollsUsed.has('R3'), '启用卷应为前缀 R1,R2');
  assert.strictEqual(result.usedLength, 1000 + 500, '总占用长度应为各卷之和');
  verifyMulti({ rolls, pieces, result });
});

test('多卷：全部装得下时不启用后续卷', () => {
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 2000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1000, L: 2000, defects: [], locked: [] },
  ];
  const pieces = [mkRect('a', 500, 500), mkRect('b', 500, 500)];
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  assert.strictEqual(result.rollsUsed, 1, '小批量不应启用第二卷');
  verifyMulti({ rolls, pieces, result });
});

test('多卷：必用卷约束生效，且必用卷放不下的进未排区', () => {
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 1000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1000, L: 1000, defects: [{ x: 0, y: 0, w: 1000, h: 900 }], locked: [] },
  ];
  const pieces = [
    mkRect('must2', 500, 500, { requiredRoll: 'R2' }),   // 必用卷2，卷2仅剩 1000×100 空间 → 放不下
    mkRect('free1', 500, 500),
    mkRect('free2', 500, 500),
  ];
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 1, '必用卷放不下的件应进未排区');
  assert.strictEqual(result.unplaced[0].key, 'must2');
  assert(/必用卷/.test(result.unplaced[0].reason), '未排原因应指明必用卷');
  assert.strictEqual(result.placements.length, 2, '自由件不受影响');
  assert(result.placements.every((p) => p.roll === 'R1'), '自由件应排在卷1');
  verifyMulti({ rolls, pieces, result });
});

test('多卷：宽件只容得下宽卷', () => {
  const rolls = [
    { key: 'R1', label: 1, W: 600, L: 2000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1200, L: 2000, defects: [], locked: [] },
  ];
  const pieces = [mkRect('wide', 900, 400), mkRect('narrow', 300, 300)];
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  const wide = result.placements.find((p) => p.key === 'wide');
  assert.strictEqual(wide.roll, 'R2', '宽件应落到宽卷');
  verifyMulti({ rolls, pieces, result });
});

test('多卷：所有卷都容不下的超宽件进未排区并说明原因', () => {
  const rolls = [
    { key: 'R1', label: 1, W: 600, L: 2000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 800, L: 2000, defects: [], locked: [] },
  ];
  const pieces = [mkRect('huge', 900, 100)];
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 1);
  assert(/超出所有卷/.test(result.unplaced[0].reason));
  assert.strictEqual(result.rollsUsed, 0);
});

test('多卷：锁定件跨卷保持固定，其余绕开', () => {
  const lockedVerts = rect(0, 0, 500, 500);
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 1000, defects: [], locked: [] },
    {
      key: 'R2', label: 2, W: 1000, L: 2000, defects: [{ x: 600, y: 0, w: 200, h: 200 }],
      locked: [{ key: 'L1', verts: lockedVerts, rot: 0, x: 100, y: 300, w: 500, h: 500 }],
    },
  ];
  const pieces = [mkRect('a', 500, 500), mkRect('b', 500, 500), mkRect('c', 400, 400)];
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  verifyMulti({ rolls, pieces, result });
});

test('多卷：绝不为减少用卷牺牲可排入的件', () => {
  // 两卷各 1000×1000，5 件 500×500：必须启用 2 卷才能排入全部
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 1000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1000, L: 1000, defects: [], locked: [] },
  ];
  const pieces = [];
  for (let i = 0; i < 5; i++) pieces.push(mkRect('p' + i, 500, 500));
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 0, '件数优先：不得为少用卷而留件未排');
  assert.strictEqual(result.rollsUsed, 2);
  verifyMulti({ rolls, pieces, result });
});

test('多卷：容量不足时未排件列出，已排件不受影响', () => {
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 1000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1000, L: 1000, defects: [], locked: [] },
  ];
  const pieces = [];
  for (let i = 0; i < 9; i++) pieces.push(mkRect('p' + i, 500, 500));
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.placements.length, 8, '两卷最多 8 件');
  assert.strictEqual(result.unplaced.length, 1);
  verifyMulti({ rolls, pieces, result });
});

test('多卷：必用卷件不被自由件挤占（件数优先于卷数）', () => {
  // 卷1 恰能被 4 件 500×500 自由件填满；必用卷件 R(600×400) 必须先落卷1，自由件溢出到卷2
  const rolls = [
    { key: 'R1', label: 1, W: 1000, L: 1000, defects: [], locked: [] },
    { key: 'R2', label: 2, W: 1000, L: 1000, defects: [], locked: [] },
  ];
  const pieces = [
    mkRect('R', 600, 400, { requiredRoll: 'R1' }),
    mkRect('A', 500, 500), mkRect('B', 500, 500), mkRect('C', 500, 500), mkRect('D', 500, 500),
  ];
  const result = optimizeMulti({ rolls, pieces });
  assert.strictEqual(result.unplaced.length, 0, '全部 5 件都应排入（不得为少启用卷而牺牲 R）');
  const r = result.placements.find((p) => p.key === 'R');
  assert.strictEqual(r.roll, 'R1', '必用卷件落在卷1');
  assert.strictEqual(result.rollsUsed, 2);
  verifyMulti({ rolls, pieces, result });
});

test('多卷：随机压力测试（不变量）', () => {
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rolls = [
    { key: 'R1', label: 1, W: 1200, L: 3000, defects: [{ x: 500, y: 400, w: 150, h: 150 }], locked: [] },
    { key: 'R2', label: 2, W: 1600, L: 4000, defects: [{ x: 100, y: 2000, w: 200, h: 100 }], locked: [] },
    { key: 'R3', label: 3, W: 900, L: 2500, defects: [], locked: [] },
  ];
  const pieces = [];
  for (let i = 0; i < 26; i++) {
    const w = 100 + Math.floor(rnd() * 350);
    const h = 100 + Math.floor(rnd() * 400);
    const req = rnd() < 0.2 ? rolls[Math.floor(rnd() * 3)].key : null;
    pieces.push(mkRect('r' + i, w, h, { allowRotate: rnd() < 0.5, requiredRoll: req }));
  }
  const result = optimizeMulti({ rolls, pieces });
  verifyMulti({ rolls, pieces, result });
  // 已排件数 + 未排件数 = 总件数
  assert.strictEqual(result.placements.length + result.unplaced.length, pieces.length);
  console.log(
    `    （随机多卷：排入 ${result.placements.length}/26，启用 ${result.rollsUsed} 卷，总占用 ${result.usedLength}mm）`
  );
});

// ---------------- 创建输入校验（多卷） ----------------
console.log('创建输入校验（多卷）');

test('多卷格式创建通过，旧字段为各卷最大值', () => {
  const { errors, value } = validateJobInput({
    name: 't',
    rolls: [
      { width: 1600, length: 5000, defects: [{ x: 10, y: 10, w: 50, h: 50 }] },
      { width: 1400, length: 4000, defects: [] },
    ],
    pieces: [{ name: 'a', vertices: rect(0, 0, 100, 100), quantity: 1, allowRotate: false }],
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(value.rolls.length, 2);
  assert.strictEqual(value.fabricWidth, 1600);
  assert.strictEqual(value.fabricLength, 5000);
  assert.strictEqual(value.rolls[0].defects.length, 1);
});

test('旧单卷格式兼容：归一为一卷', () => {
  const { errors, value } = validateJobInput({
    name: 'legacy',
    fabricWidth: 1600,
    fabricLength: 5000,
    defects: [{ x: 0, y: 0, w: 10, h: 10 }],
    pieces: [{ name: 'a', vertices: rect(0, 0, 100, 100), quantity: 2 }],
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(value.rolls.length, 1);
  assert.strictEqual(value.rolls[0].width, 1600);
  assert.strictEqual(value.rolls[0].defects.length, 1);
});

test('无效必用卷号被明确拒绝', () => {
  const { errors } = validateJobInput({
    rolls: [{ width: 1000, length: 1000 }],
    pieces: [{ name: 'a', vertices: rect(0, 0, 100, 100), quantity: 1, requiredRoll: 2 }],
  });
  assert(errors.length === 1 && /必用卷号/.test(errors[0]) && /无效/.test(errors[0]), errors.join(';'));
});

test('宽度容不下裁片的必用卷约束被明确拒绝', () => {
  const { errors } = validateJobInput({
    rolls: [{ width: 300, length: 5000 }, { width: 1000, length: 5000 }],
    pieces: [{ name: 'a', vertices: rect(0, 0, 500, 100), quantity: 1, requiredRoll: 1 }],
  });
  assert(errors.length === 1 && /必用卷1/.test(errors[0]) && /容不下/.test(errors[0]), errors.join(';'));
});

test('没有任何一卷容得下的裁片被拒绝', () => {
  const { errors } = validateJobInput({
    rolls: [{ width: 300, length: 5000 }, { width: 500, length: 5000 }],
    pieces: [{ name: 'a', vertices: rect(0, 0, 600, 100), quantity: 1 }],
  });
  assert(errors.length === 1 && /没有任何一卷容得下/.test(errors[0]), errors.join(';'));
});

test('瑕疵超出所属卷范围被拒绝并指明卷号', () => {
  const { errors } = validateJobInput({
    rolls: [{ width: 1000, length: 1000, defects: [{ x: 900, y: 0, w: 200, h: 10 }] }],
    pieces: [{ name: 'a', vertices: rect(0, 0, 100, 100), quantity: 1 }],
  });
  assert(errors.length === 1 && /卷1瑕疵区#1/.test(errors[0]), errors.join(';'));
});

console.log(`\n${passed} 项测试${process.exitCode ? '，存在失败' : '全部通过'}。`);