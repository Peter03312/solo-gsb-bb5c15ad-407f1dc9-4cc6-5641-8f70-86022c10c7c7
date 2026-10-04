'use strict';

const geom = require('./geom');

/** 规模限制（小型工作室量级，同时约束栅格内存与计算时间） */
const LIMITS = {
  maxWidth: 5000,          // 单卷最大宽度 5m
  maxLength: 100000,       // 单卷可用长度最大 100m
  maxAreaCells: 150000000, // 单卷 宽度×长度 栅格上限（约 150MB）
  maxTotalAreaCells: 150000000, // 全部卷合计栅格上限
  maxRolls: 50,
  maxDefectsPerRoll: 100,
  maxDefects: 100,         // 旧格式（单卷平铺 defects）上限
  maxPieceTypes: 200,
  maxQuantityPerType: 200,
  maxTotalPieces: 1000,
};

function isInt(v) {
  return Number.isInteger(v);
}

/** 校验单个瑕疵矩形，返回错误字符串或 null；合法时把结果推入 out */
function checkDefect(d, tag, W, L, out) {
  if (!d || !isInt(d.x) || !isInt(d.y) || !isInt(d.w) || !isInt(d.h)) {
    return `${tag}：坐标与尺寸必须为整数毫米`;
  }
  if (d.w < 1 || d.h < 1) {
    return `${tag}：宽度与高度必须 ≥ 1mm`;
  }
  if (isInt(W) && isInt(L) && (d.x < 0 || d.y < 0 || d.x + d.w > W || d.y + d.h > L)) {
    return `${tag}：矩形 (${d.x},${d.y},${d.w}×${d.h}) 超出卷范围（${W}×${L}mm）`;
  }
  out.push({ x: d.x, y: d.y, w: d.w, h: d.h });
  return null;
}

/**
 * 校验创建方案的输入。返回 { errors: [string], value }。
 * 所有错误均指明出错对象；errors 非空时 value 为 null。
 *
 * 支持两种输入格式：
 *  - 多卷：{ name, rolls: [{width, length, defects: [...]}], pieces: [...] }（卷号为数组顺序 1..n）
 *  - 旧单卷：{ name, fabricWidth, fabricLength, defects: [...], pieces: [...] }（自动归一为 1 卷）
 * 裁片可带 requiredRoll（必用卷号，整数；0/缺省表示不限）。
 * value 统一为 { name, rolls: [{width, length, defects}], pieces: [..., requiredRoll] }，
 * 另附兼容字段 fabricWidth/fabricLength（各卷最大宽度/最大长度）。
 */
function validateJobInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { errors: ['请求体为空或格式不正确'], value: null };
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : '未命名方案';

  // ---- 布卷（多卷格式，或旧单卷格式归一化） ----
  const rolls = [];
  let totalCells = 0;
  if (Array.isArray(body.rolls) && body.rolls.length > 0) {
    if (body.rolls.length > LIMITS.maxRolls) {
      errors.push(`卷数过多（最多 ${LIMITS.maxRolls} 卷）`);
    }
    body.rolls.slice(0, LIMITS.maxRolls).forEach((r, i) => {
      const tag = `卷${i + 1}`;
      const W = r && r.width;
      const L = r && r.length;
      let bad = false;
      if (!isInt(W) || W < 1 || W > LIMITS.maxWidth) {
        errors.push(`${tag}：宽度必须为 1~${LIMITS.maxWidth} 的整数毫米`);
        bad = true;
      }
      if (!isInt(L) || L < 1 || L > LIMITS.maxLength) {
        errors.push(`${tag}：可用长度必须为 1~${LIMITS.maxLength} 的整数毫米`);
        bad = true;
      }
      if (!bad && W * L > LIMITS.maxAreaCells) {
        errors.push(`${tag}：面积 ${W}×${L}mm 超出单卷上限（${LIMITS.maxAreaCells} 平方毫米）`);
        bad = true;
      }
      if (bad) return;
      totalCells += W * L;
      const defects = [];
      const rawDefects = Array.isArray(r.defects) ? r.defects : [];
      if (rawDefects.length > LIMITS.maxDefectsPerRoll) {
        errors.push(`${tag}：瑕疵区数量过多（每卷最多 ${LIMITS.maxDefectsPerRoll} 个）`);
      }
      rawDefects.slice(0, LIMITS.maxDefectsPerRoll).forEach((d, j) => {
        const err = checkDefect(d, `${tag}瑕疵区#${j + 1}`, W, L, defects);
        if (err) errors.push(err);
      });
      rolls.push({ width: W, length: L, defects });
    });
    if (totalCells > LIMITS.maxTotalAreaCells) {
      errors.push(`全部卷合计面积超出系统上限（${LIMITS.maxTotalAreaCells} 平方毫米）`);
    }
  } else {
    // 旧格式：fabricWidth/fabricLength + 平铺 defects → 归一为单卷
    const W = body.fabricWidth;
    const L = body.fabricLength;
    let bad = false;
    if (!isInt(W) || W < 1 || W > LIMITS.maxWidth) {
      errors.push(`布幅宽度：必须为 1~${LIMITS.maxWidth} 的整数毫米`);
      bad = true;
    }
    if (!isInt(L) || L < 1 || L > LIMITS.maxLength) {
      errors.push(`可用长度：必须为 1~${LIMITS.maxLength} 的整数毫米`);
      bad = true;
    }
    if (!bad && W * L > LIMITS.maxAreaCells) {
      errors.push(`布幅面积 ${W}×${L}mm 超出系统上限（${LIMITS.maxAreaCells} 平方毫米）`);
      bad = true;
    }
    if (!bad) {
      const defects = [];
      const rawDefects = Array.isArray(body.defects) ? body.defects : [];
      if (rawDefects.length > LIMITS.maxDefects) {
        errors.push(`瑕疵区数量过多（最多 ${LIMITS.maxDefects} 个）`);
      }
      rawDefects.slice(0, LIMITS.maxDefects).forEach((d, i) => {
        const err = checkDefect(d, `瑕疵区#${i + 1}`, W, L, defects);
        if (err) errors.push(err);
      });
      rolls.push({ width: W, length: L, defects });
    }
  }

  // ---- 裁片型号 ----
  const pieces = [];
  const rawPieces = Array.isArray(body.pieces) ? body.pieces : [];
  if (rawPieces.length < 1) errors.push('至少需要一种裁片');
  if (rawPieces.length > LIMITS.maxPieceTypes) {
    errors.push(`裁片型号过多（最多 ${LIMITS.maxPieceTypes} 种）`);
  }
  let totalPieces = 0;
  rawPieces.slice(0, LIMITS.maxPieceTypes).forEach((p, i) => {
    const pname = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 50) : `裁片${i + 1}`;
    const tag = `裁片「${pname}」`;
    let bad = false;

    const err = geom.validatePolygon(p.vertices);
    if (err) {
      errors.push(`${tag}：${err}`);
      bad = true;
    }
    if (!isInt(p.quantity) || p.quantity < 1 || p.quantity > LIMITS.maxQuantityPerType) {
      errors.push(`${tag}：件数必须为 1~${LIMITS.maxQuantityPerType} 的整数`);
      bad = true;
    }
    // 必用卷（可选）：0 / 缺省表示不限
    let requiredRoll = null;
    const rr = p.requiredRoll;
    if (rr !== undefined && rr !== null && rr !== 0) {
      if (!isInt(rr) || rr < 1 || rr > rolls.length) {
        errors.push(`${tag}：必用卷号 ${JSON.stringify(rr)} 无效（本方案共 ${rolls.length} 卷，有效卷号 1~${rolls.length}）`);
        bad = true;
      } else {
        requiredRoll = rr;
      }
    }
    if (bad) return;

    const norm = geom.normalize(p.vertices);
    // 至少存在一卷容得下（旋转 180° 不改变外接尺寸）
    if (rolls.length > 0 && !rolls.some((r) => norm.w <= r.width && norm.h <= r.length)) {
      errors.push(
        `${tag}：外接尺寸 ${norm.w}×${norm.h}mm 没有任何一卷容得下（各卷宽度 ${rolls.map((r) => r.width).join('/')}mm），永远无法排入`
      );
      return;
    }
    if (requiredRoll != null) {
      const roll = rolls[requiredRoll - 1];
      if (norm.w > roll.width || norm.h > roll.length) {
        errors.push(
          `${tag}：必用卷${requiredRoll}（${roll.width}×${roll.length}mm）容不下裁片外接尺寸 ${norm.w}×${norm.h}mm，约束无效已拒绝`
        );
        return;
      }
    }
    totalPieces += p.quantity;
    pieces.push({
      name: pname,
      vertices: norm.pts,
      quantity: p.quantity,
      allowRotate: p.allowRotate === true,
      bw: norm.w,
      bh: norm.h,
      requiredRoll,
    });
  });
  if (totalPieces > LIMITS.maxTotalPieces) {
    errors.push(`裁片总件数 ${totalPieces} 超出上限（${LIMITS.maxTotalPieces} 件）`);
  }

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      name,
      rolls,
      // 兼容字段：各卷最大宽度 / 最大长度（旧单卷方案即原布幅尺寸）
      fabricWidth: Math.max(...rolls.map((r) => r.width)),
      fabricLength: Math.max(...rolls.map((r) => r.length)),
      pieces,
    },
  };
}

module.exports = { validateJobInput, LIMITS };
