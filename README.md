# 布料裁片排样系统

面向小型服装工作室的布料裁片排样（Nesting）Web 应用。**同一订单可由多卷布完成**：登记每卷的卷号、布幅宽度、可用长度和矩形瑕疵，系统自动把每件裁片排到具体卷的卷内坐标与方向上，尽量排入全部裁片，再尽量减少启用卷数和总占用长度。支持为裁片指定必用卷、锁定已确认的卷号与位置、手动跨卷移动。

## 功能

- **多卷排样**：一个方案登记多卷布（卷号、各卷宽度/可用长度、各卷矩形瑕疵）；排样结果给出每件裁片的**卷号、卷内坐标 (x,y) 与方向 (0°/180°)**
- **优化目标（字典序）**：① 先尽量排入全部裁片（绝不为减少用卷放弃可排入的件）→ ② 启用卷数最少 → ③ 各卷总占用长度最短 → ④ 接触周长等平局裁决
- **必用卷约束**：可为每件裁片（创建时也可按型号）指定必用卷；优化只在该卷内为其找位，手动跨卷移动不得违反；无效卷号、宽度/长度容不下裁片的必用卷约束明确拒绝
- **锁定重优化**：可锁定已确认裁片的**卷号和卷内位置**；锁定件与各卷瑕疵始终固定，仅重新排布未锁定裁片
- **裁片**：简单多边形轮廓（整数毫米顶点）、件数、可选是否允许旋转 180°；禁旋转件始终保持原方向
- **瑕疵区**：每卷独立登记矩形瑕疵，裁片自动避开
- **手动跨卷调整**：画布上卷内拖拽，或输入目标卷 + 卷内精确坐标/旋转；按**目标卷布边、该卷瑕疵及该卷已排裁片**精确校验，冲突时指出冲突对象（含卷名），原方案不变；锁定件须先解锁
- **未排区 / 部分方案**：无可行位置的裁片列入未排区并给出原因（如必用卷长度不足），方案保持「部分方案」状态，绝不标为完成
- **页面可切换查看各卷**：多卷方案顶部出现卷标签（卷号、尺寸、是否启用、本卷占用长度）；单卷方案与旧数据不显示切换条
- **输入校验**：非法轮廓（自交、退化、非整数坐标）、非法尺寸、重复卷号、瑕疵越界、必用卷不可行等在创建时即逐项指出对象并拒绝
- **向后兼容**：旧单卷入参（`fabricWidth/fabricLength/defects`）、旧的查询/移动/优化调用与单卷响应字段（`job.fabricWidth`、顶层 `defects`、不带 `rollId` 的 move）继续可用；旧库数据自动迁移为一卷「默认卷」按单卷显示

## 技术栈

- 后端：Node.js + Express，SQLite（better-sqlite3，WAL 模式）
- 前端：原生 HTML/Canvas/JS，无构建步骤
- 排样：每卷独立 1mm 占用栅格 + 左下启发式 + 跨卷压实局部搜索（可腾空整卷）；手动移动采用精确几何判定

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
npm test        # 几何、单卷/多卷排样不变量、输入校验与 HTTP API 共 45 项测试
```

## 配置

| 环境变量   | 默认值                | 说明                     |
| ---------- | --------------------- | ------------------------ |
| `PORT`     | `3000`                | HTTP 监听端口            |
| `DATA_DIR` | `./data`（容器内 `/app/data`） | SQLite 数据库文件目录 |

## 使用流程（多卷）

1. 左侧「新建排样方案」：点 **＋添加卷** 登记每一卷——卷号（如 A卷/B卷）、布幅宽度、可用长度，并为该卷添加矩形瑕疵 (x,y,宽,高)。可点「填入示例」生成两卷示例。
2. 在「裁片型号」中填写名称、顶点（每行 `x,y`）、件数、是否允许旋转 180°，以及可选的**必用卷**（按卷序号选择，或留空表示不限卷，由优化器自动选卷）。
3. 点击「创建方案」——非法输入（含无效必用卷、必用卷太窄、卷号重复）会逐条指出问题对象。
4. 点击「优化排样」——顶部卷标签与画布展示各卷结果：红块为该卷瑕疵，绿色虚线为该卷实际占用长度，🔒 为锁定件；徽标区显示启用卷数/总占用长度。
5. 顶部卷标签切换查看各卷；在卷内可直接拖动裁片微调。**跨卷移动**：选中裁片后在左侧「目标卷」选目标卷、填卷内坐标后「应用位置」。
6. 冲突移动（压目标卷布边/瑕疵/已排件，或违反必用卷）会被拒绝并列出冲突对象，原方案不变。
7. 勾选「锁定」后再次「优化排样」，锁定件的卷号与位置保持固定。
8. 顶部状态徽标：草稿 / 部分方案（列出未排入裁片及原因）/ 完整方案。

## HTTP API

所有接口均以 JSON 收发；端口默认 3000。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/jobs` | 方案列表（含 `rollCount`、`pieceCount`，保留 `fabricWidth/fabricLength`） |
| POST | `/api/jobs` | 创建方案（多卷 `rolls` 或旧单卷字段；校验失败 400 + 逐项原因） |
| GET | `/api/jobs/:id` | 方案完整状态（`rolls`、`defectsByRoll`、每件 `rollId/requiredRollId`，并保留旧字段） |
| DELETE | `/api/jobs/:id` | 删除方案（级联删除其卷） |
| POST | `/api/jobs/:id/optimize` | 优化排样（保留锁定件与各卷瑕疵；先排全、再省卷、再省长度） |
| POST | `/api/jobs/:id/placements/:pid/move` | 移动/旋转/手动排入（可跨卷，`rollId` 指定目标卷；冲突 409 + 冲突对象，原方案不变） |
| POST | `/api/jobs/:id/placements/:pid/lock` | 锁定/解锁 `{locked: bool}` |
| POST | `/api/jobs/:id/placements/:pid/unplace` | 移回未排区（保留必用卷约束） |
| POST | `/api/jobs/:id/placements/:pid/require-roll` | 设置/取消单件必用卷 `{rollId}` / `{rollId: null}` |

### 创建方案（多卷）

```bash
curl -s -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "夹克 M 码",
    "rolls": [
      {"label": "A卷", "width": 1600, "length": 5000,
       "defects": [{"x": 1150, "y": 300, "w": 200, "h": 250}]},
      {"label": "B卷", "width": 1500, "length": 4000, "defects": []}
    ],
    "pieces": [
      {"name": "前片", "vertices": [[0,0],[620,0],[620,950],[0,950]],
       "quantity": 2, "allowRotate": true},
      {"name": "袖片", "vertices": [[0,0],[360,0],[360,560],[180,460],[0,560]],
       "quantity": 2, "allowRotate": true, "requiredRoll": 2}
    ]
  }'
```

- `rolls[].label`：卷号（可省略，默认 `卷1/卷2…`，同方案内唯一）；`requiredRoll` 可用**卷序号（1 起）或卷号文本**。
- 旧单卷调用继续支持：`{"name","fabricWidth","fabricLength","defects":[...],"pieces":[...]}`，系统自动建一卷「默认卷」。

### 优化排样

```bash
curl -s -X POST http://localhost:3000/api/jobs/1/optimize
```

返回（节选）：

```json
{
  "job": {"id": 1, "rollCount": 2, "status": "complete", "usedLength": 1600,
          "fabricWidth": 1600, "fabricLength": 5000},
  "rolls": [
    {"id": 1, "seq": 1, "label": "A卷", "width": 1600, "length": 5000, "used": false, "usedLength": 0},
    {"id": 2, "seq": 2, "label": "B卷", "width": 1500, "length": 4000, "used": true,  "usedLength": 1600}
  ],
  "placements": [
    {"id": 1, "rollId": 2, "requiredRollId": 2, "name": "袖片", "seq": 1,
     "x": 0, "y": 0, "rotation": 0, "placed": true, "locked": false, "bw": 360, "bh": 560, "reason": null}
  ],
  "unplaced": []
}
```

部分方案时 `job.status="partial"`，`unplaced` 中每件带 `reason`（如「必用卷「B卷」可用长度 4000mm 内找不到可行位置……」）。

### 手动移动 / 跨卷移动

```bash
# 卷内移动（单卷方案或仍在本卷时 rollId 可省略；多卷省略=保持原卷）
curl -s -X POST http://localhost:3000/api/jobs/1/placements/3/move \
  -H 'Content-Type: application/json' \
  -d '{"rollId": 2, "x": 400, "y": 1200, "rotation": 180}'
```

冲突响应（HTTP 409，原方案不变）：

```json
{"error": "裁片「袖片#1」移动后与以下对象冲突，已保留原方案",
 "conflicts": ["卷「B卷」瑕疵区#2（100,100 200×200mm）", "卷「B卷」裁片「前片#2」"]}
```

违反必用卷：`409 {"error":"裁片「袖片#1」指定了必用卷「B卷」，不能移动到卷「A卷」", ...}`；
无效目标卷：`400 {"error":"目标卷不存在：方案中没有 rollId=9 的卷（可用卷：1=A卷、2=B卷）"}`。

### 设置 / 取消必用卷

```bash
curl -s -X POST http://localhost:3000/api/jobs/1/placements/3/require-roll \
  -H 'Content-Type: application/json' -d '{"rollId": 1}'     # 必用A卷
curl -s -X POST http://localhost:3000/api/jobs/1/placements/3/require-roll \
  -H 'Content-Type: application/json' -d '{"rollId": null}'  # 取消
```

必用卷容不下裁片时返回 400：`"裁片「前片#1」外接尺寸 620×950mm 超过必用卷「窄卷」（500×5000mm），必用卷约束不可能满足，已拒绝"`。

### 兼容说明

- 旧客户端仍可用：创建用 `fabricWidth/fabricLength/defects`；`GET` 响应保留 `job.fabricWidth/fabricLength`（=首卷）与顶层 `defects`（=首卷瑕疵）；`placements[].x/y/rotation/placed/locked` 语义不变（坐标即其所在卷内坐标）。
- 旧 move 请求不带 `rollId`：单卷方案自动用唯一卷；多卷方案已排入件保持原卷，未排入件需显式给 `rollId`。
- 旧数据库首次启动时自动迁移：每个旧方案生成一卷「默认卷」，原瑕疵与裁片挂到该卷。

## 规则与算法说明

- 坐标与尺寸一律为**整数毫米**；旋转仅支持 0°/180°（旋转不改变外接矩形尺寸）。
- 每卷独立 1mm 占用栅格：栅格判定保守（宁可留缝也不重叠），结果**保证**卷内无内部重叠、不压该卷瑕疵、不出该卷布边；斜边附近约 1mm 空隙属正常余量。
- 手动移动使用精确几何判定，**边界接触（共点/共边）完全允许**；跨卷只校验目标卷。
- 多卷选择：每件在所有（必用约束允许的）卷的可行候选位置中，按全局元组 `[启用卷数, 总占用长度, -接触周长, x, 卷序号, 角度]` 取最优；必用卷件优先排入以提前打开其必用卷；压实时允许跨卷迁移从而腾空整卷。
- 规模上限（可在 `src/validate.js` 调整）：每方案 ≤ 50 卷，单卷布幅 ≤ 5000mm、长度 ≤ 100000mm，单卷面积 ≤ 1.5 亿 mm²，裁片总数 ≤ 1000 件，单型号顶点 ≤ 200 个。

## 项目结构

```
src/geom.js      精确几何：轮廓校验、内部重叠判定（边界接触允许）
src/nest.js      排样优化器：栅格掩码、左下放置、optimizeRolls 多卷压实；optimize 为单卷兼容封装
src/validate.js  创建输入校验（多卷/旧单卷、必用卷，逐项指明问题对象）
src/db.js        SQLite 模式、连接与旧库自动迁移（rolls 表与多卷字段）
src/server.js    Express 路由（多卷状态、跨卷 move、require-roll 等）
public/          单页前端（卷标签、卷卡片、画布拖拽、跨卷面板）
test/run.js      45 项几何/排样/校验/HTTP API 测试
```
