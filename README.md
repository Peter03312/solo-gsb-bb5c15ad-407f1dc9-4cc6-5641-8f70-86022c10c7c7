# 布料裁片排样系统

面向小型服装工作室的布料裁片排样（Nesting）Web 应用。登记一卷或多卷布料（各卷宽度、可用长度、矩形瑕疵区）与裁片多边形轮廓后，系统自动计算每件裁片的卷号、卷内位置与方向，给出启用卷数与总占用长度；支持必用卷约束、手动跨卷调整、锁定裁片并重新优化未锁定部分。

## 功能

- **多卷排样**：一个订单可登记多卷布（卷号、宽度、可用长度、各卷矩形瑕疵区）；优化结果给出每件裁片的卷号、卷内坐标与方向
- **排样优化**：先尽量排入全部裁片，再尽量减少启用卷数与总占用长度；**绝不为减少用卷牺牲本可排入的裁片**
- **裁片**：简单多边形轮廓（整数毫米顶点）、件数、可选是否允许旋转 180°；禁旋转件始终保持原方向
- **瑕疵区**：矩形，按卷登记，裁片自动避开；瑕疵区始终固定
- **必用卷**：可为单件裁片指定必用卷（创建时按型号指定，或之后逐件设置）；无效卷号、或卷容不下裁片外接尺寸的约束会被明确拒绝
- **约束保证**：裁片完整落在所在卷内；裁片之间、裁片与瑕疵区之间无内部重叠（边界接触允许）
- **手动调整**：画布上拖拽移动裁片，或输入精确坐标；可跨卷移动（须遵守必用卷约束，并按目标卷布边、瑕疵、已排裁片校验）；冲突时指出冲突对象并保留原方案
- **锁定重优化**：锁定件的卷号、位置、方向与各卷瑕疵区始终固定，仅重新排布未锁定裁片
- **部分方案**：无法排入全部裁片时明确列出未排入者，状态标记为「部分方案」，绝不标为完成
- **输入校验**：非法轮廓（自交、退化、非整数坐标）、非法尺寸、无效必用卷约束在创建时即指出具体对象并拒绝
- **兼容**：旧单卷方案自动迁移为单卷显示；旧的查询、移动、优化调用与响应字段保持不变

## 技术栈

- 后端：Node.js + Express，SQLite（better-sqlite3，WAL 模式）
- 前端：原生 HTML/Canvas/JS，无构建步骤
- 排样：1mm 占用栅格 + 左下启发式 + 接触周长优化 + 压实局部搜索；多卷按卷序逐卷填充；手动移动采用精确几何判定

## 快速开始

### 方式一：Docker Compose（推荐，一键启动）

```bash
docker compose up --build
```

启动后访问 **http://localhost:3000**

### 方式二：本地运行

```bash
npm install
npm start
```

访问 **http://localhost:3000**

### 运行测试

```bash
npm test        # 几何精确性、单卷/多卷排样不变量与创建校验共 39 项测试
```

## 配置

| 环境变量   | 默认值                | 说明                     |
| ---------- | --------------------- | ------------------------ |
| `PORT`     | `3000`                | HTTP 监听端口            |
| `DATA_DIR` | `./data`（容器内 `/app/data`） | SQLite 数据库文件目录 |

- 页面地址：`http://localhost:<PORT>`（Compose 默认映射 `3000:3000`，改左侧端口即可）
- Compose 使用命名卷 `nesting-data` 持久化数据；删除容器不丢数据

## 使用流程

1. 左侧「新建排样方案」：添加一卷或多卷布（每卷填写宽度、可用长度，整数 mm，并登记该卷的矩形瑕疵区），再添加裁片型号（名称、顶点、件数、是否允许旋转 180°、可选必用卷号，0 表示不限）。顶点每行一个 `x,y`。可点「填入示例」快速体验（两卷示例）。
2. 点击「创建方案」——非法输入（含无效必用卷约束）会逐条指出问题对象。
3. 点击「优化排样」——顶部出现各卷标签页，点击切换查看各卷：红色为瑕疵区，绿色虚线为该卷实际占用长度，🔒 为锁定件，紫色「必」为必用卷件。
4. 拖动裁片手动微调（锁定件需先解锁）；或在左侧选择**目标卷**并输入精确坐标后「应用位置」实现跨卷移动。跨卷移动会校验必用卷约束与目标卷的布边、瑕疵、已排裁片；冲突移动被拒绝并列出冲突对象，原方案不变。
5. 选中裁片后可在「必用卷」下拉设置/取消约束（无效卷号或卷容不下裁片会被拒绝）；勾选「锁定」后再次「优化排样」，仅重排未锁定裁片，锁定件的卷号与位置保持不变。
6. 顶部状态徽标：草稿 / 部分方案（列出未排入裁片）/ 完整方案；并显示启用卷数与总占用长度（各卷占用长度之和）。

## API 一览

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/jobs` | 方案列表（含卷数 `rollCount`、启用卷数 `rollsUsed`） |
| POST | `/api/jobs` | 创建方案（多卷 `rolls` 或旧单卷 `fabricWidth/fabricLength` 两种格式；校验失败返回 400 + 逐项原因） |
| GET | `/api/jobs/:id` | 方案完整状态（含 `rolls` 数组；裁片含 `roll`、`requiredRoll`） |
| DELETE | `/api/jobs/:id` | 删除方案 |
| POST | `/api/jobs/:id/optimize` | 优化排样（仅未锁定件；保留锁定件与各卷瑕疵） |
| POST | `/api/jobs/:id/placements/:pid/move` | 移动/旋转/手动排入，可带 `roll` 跨卷（冲突返回 409 + 冲突对象，原方案不变；无效卷号返回 400） |
| POST | `/api/jobs/:id/placements/:pid/required-roll` | 设置/取消必用卷 `{roll: 卷号 \| null}`（无效约束返回 400） |
| POST | `/api/jobs/:id/placements/:pid/lock` | 锁定/解锁 `{locked: bool}`（锁定件的卷号与位置在优化中固定） |
| POST | `/api/jobs/:id/placements/:pid/unplace` | 移回未排区（解除锁定，必用卷约束保留） |

### 响应结构（GET /api/jobs/:id）

```jsonc
{
  "job": {
    "id": 1, "name": "秋季夹克 M 码",
    "fabricWidth": 1600, "fabricLength": 5000,  // 兼容字段：各卷最大宽度/最大长度
    "status": "complete",                        // draft | partial | complete
    "usedLength": 7300,                          // 各启用卷占用长度之和
    "rollsUsed": 2,                              // 启用卷数
    "createdAt": "2026-10-04 12:00:00"
  },
  "rolls": [
    { "id": 1, "seq": 1, "width": 1600, "length": 5000, "usedLength": 4200, "pieceCount": 5 },
    { "id": 2, "seq": 2, "width": 1400, "length": 4000, "usedLength": 3100, "pieceCount": 3 }
  ],
  "defects": [ { "id": 1, "roll": 1, "x": 1150, "y": 300, "w": 200, "h": 250 } ],
  "pieceTypes": [ { "id": 1, "name": "前片", "vertices": [[0,0],[620,0],[620,950],[0,950]], "quantity": 2, "allowRotate": true, "bw": 620, "bh": 950 } ],
  "placements": [
    { "id": 1, "pieceTypeId": 1, "name": "前片", "seq": 1,
      "roll": 1,            // 卷号（未排入为 null）
      "x": 0, "y": 0, "rotation": 0,
      "placed": true, "locked": false,
      "requiredRoll": null, // 必用卷号（null 表示不限）
      "allowRotate": true, "bw": 620, "bh": 950 }
  ],
  "unplaced": [ { "id": 9, "name": "领片", "seq": 3, "requiredRoll": null } ]
}
```

旧单卷方案自动迁移为一卷（卷号 1），以上字段均按单卷呈现；旧客户端不传的 `roll` 字段在移动时缺省为原卷/卷 1，行为与旧版一致。

## API 调用示例（curl）

以下示例假设服务运行在 `http://localhost:3000`。

### 1. 创建多卷方案

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "秋季夹克 M 码",
    "rolls": [
      { "width": 1600, "length": 5000,
        "defects": [ { "x": 1150, "y": 300, "w": 200, "h": 250 } ] },
      { "width": 1400, "length": 4000,
        "defects": [ { "x": 100, "y": 1000, "w": 150, "h": 200 } ] }
    ],
    "pieces": [
      { "name": "前片", "vertices": [[0,0],[620,0],[620,950],[0,950]],
        "quantity": 2, "allowRotate": true },
      { "name": "领片", "vertices": [[0,0],[320,0],[160,130]],
        "quantity": 3, "allowRotate": false, "requiredRoll": 2 }
    ]
  }'
```

旧单卷格式仍然可用（自动归一为卷 1）：

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "旧格式方案",
    "fabricWidth": 1600, "fabricLength": 5000,
    "defects": [ { "x": 0, "y": 0, "w": 100, "h": 100 } ],
    "pieces": [ { "name": "前片", "vertices": [[0,0],[620,0],[620,950],[0,950]], "quantity": 2, "allowRotate": true } ]
  }'
```

### 2. 优化排样

```bash
curl -X POST http://localhost:3000/api/jobs/1/optimize
```

### 3. 跨卷手动移动（裁片 5 移到卷 2 的 (0, 3200)，保持 0°）

```bash
curl -X POST http://localhost:3000/api/jobs/1/placements/5/move \
  -H 'Content-Type: application/json' \
  -d '{ "roll": 2, "x": 0, "y": 3200, "rotation": 0 }'
```

- 目标卷布边/瑕疵/已排裁片冲突 → `409` + `conflicts` 列表，原方案不变
- 违反该件必用卷约束 → `409`
- 卷号不存在 → `400`（无效卷号）
- 裁片已锁定 → `409`，须先解锁

### 4. 设置 / 取消必用卷

```bash
# 设置裁片 5 必用卷 2
curl -X POST http://localhost:3000/api/jobs/1/placements/5/required-roll \
  -H 'Content-Type: application/json' -d '{ "roll": 2 }'

# 取消必用卷
curl -X POST http://localhost:3000/api/jobs/1/placements/5/required-roll \
  -H 'Content-Type: application/json' -d '{ "roll": null }'
```

无效卷号、或该卷宽度/长度容不下裁片外接尺寸时返回 `400` 并说明原因，约束不生效。

### 5. 锁定 / 解锁 / 移回未排区

```bash
curl -X POST http://localhost:3000/api/jobs/1/placements/5/lock \
  -H 'Content-Type: application/json' -d '{ "locked": true }'

curl -X POST http://localhost:3000/api/jobs/1/placements/5/unplace
```

## 规则与算法说明

- 坐标与尺寸一律为**整数毫米**；旋转仅支持 0°/180°（旋转不改变外接矩形尺寸）。
- 自动排样在 1mm 占用栅格上进行：栅格判定是保守的（宁可留缝也不重叠），因此结果**保证**无内部重叠、不压瑕疵、不出布边；斜边附近可能留约 1mm 空隙，属正常排样余量。
- 手动移动使用精确几何判定，**边界接触（共点/共边）完全允许**。
- 优化目标（字典序）：**排入件数最多 → 启用卷数最少 → 总占用长度最小**。实现上按卷号顺序逐卷填充：每卷先排该卷的必用卷裁片，再尽量排入剩余自由裁片；放不下的自由裁片顺延到下一卷，全部卷都放不下的进入未排区。启用卷始终为前缀，且不会为少用卷而把本可排入的裁片留到未排区。
- 单卷内：面积降序 + 左下法则 + 接触周长平局裁决 + 压实局部搜索。
- 锁定件与各卷瑕疵区在优化中始终固定；必用卷裁片只会落到指定卷。
- 规模上限（可在 `src/validate.js` 调整）：单卷宽度 ≤ 5000mm，单卷长度 ≤ 100000mm，单卷面积 ≤ 1.5 亿 mm²，全部卷合计 ≤ 1.5 亿 mm²，卷数 ≤ 50，裁片总数 ≤ 1000 件，单型号顶点 ≤ 200 个。

## 项目结构

```
src/geom.js      精确几何：轮廓校验、内部重叠判定（边界接触允许）
src/nest.js      排样优化器：栅格掩码、左下放置、压实搜索、多卷驱动
src/validate.js  创建输入校验（多卷/旧单卷两种格式，逐项指明问题对象）
src/db.js        SQLite 模式、连接与旧库迁移（自动回填单卷）
src/server.js    Express 路由
public/          单页前端（多卷标签页、画布、拖拽、表单）
test/run.js      39 项几何、单卷/多卷排样与校验测试
```
