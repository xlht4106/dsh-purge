# 后端向优化分析：补丁引擎 / 宿主路径 / SQLite

> 方法论依据：《后端向软件优化方法.md》（串行改并行、消灭 N+1、批量化、核心链路剥离）+《软件优化方法.md》（度量先行、阿姆达尔定律、警惕过早优化）
> 代码范围：`lib/core.js`（补丁引擎，8083 行）、`lib/index.js`、`lib/desktop.js`、`lib/extract-asar.js`、`lib/update.js`、`lib/redteam/store-core.js`（5386 行）

---

## 一、摘要：先度量，再优化

按「度量先行，拒绝盲猜」，先给基线（真实桌面端 0.2.1-rc.2，57 个目标文件 / 62 个文件）：

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| `targetFiles()` 单次 | 241.9 ms | 146 ms（稳态）/ 211.5 ms（冷） | **−40%（稳态）** |
| `targetFiles` 的 `existsSync` | 906 次 | 329 次 | **−64%** |
| `targetFiles` 的 `statSync` | 356 次 | 43 次 | **−88%** |
| `patchStatus()` | 339.6 ms | 184~204 ms | **−42%** |
| `patchStatus` 的 `existsSync` | 1020 次 | 443 次 | **−57%** |
| 单次 Apply 点击总 fs 调用 | — | 9379 次 | 见 §四 |

**最刺眼的单点**：同一个路径 `...\DeepSeek Harness\DeepSeek Harness.exe` 在一次 `targetFiles()` 里被 `existsSync` 探测 **313 次**、`statSync` 313 次，累计 15.4 ms。这不是「N+1 查询」，而是**同一个查询重复 313 次**。

---

## 二、根因分析

### 2.1 重复探测的来源

`targetFiles()` 要为 57 个键各解析路径，而路径解析链里大量调用 `allowTargetForPatch(fp)` → `pathZone(fp)` → `desktop.isInsideDesktopInstall(fp)`。后者每次都要判断「这个路径是否在桌面安装目录内」，而判断方式是**重新定位桌面 exe**——于是对每个候选路径都重跑一遍 `firstExistingExe()`，每个 `firstExistingExe()` 又要探 12 个候选名。

调用链：

```
targetFiles()
  └─ firstExisting() × 57 个键 × 每个键若干候选路径
       └─ allowTargetForPatch()
            └─ pathZone()
                 └─ desktop.isInsideDesktopInstall()
                      └─ firstExistingExe()          ← 每次探 12 个文件名
                           └─ existsSync + statSync   ← 同一个 exe 被探 313 次
```

这属于阿姆达尔定律里典型的「热路径重复计算」：结果在进程内**根本不变**（除非用户移动了安装目录），却按调用次数线性放大。

### 2.2 已落地修复：`lib/desktop.js` 定位缓存

```js
const LOCATE_TTL_MS = 5000;
const exeBesideMemo = new Map();     // dir -> {at, v: exePath}
const installRootsMemo = new Map();  // 输入指纹 -> {at, v: string[]}

function exeBeside(dir) {
  const key = path.normalize(String(dir)).toLowerCase();
  const hit = exeBesideMemo.get(key);
  if (hit && Date.now() - hit.at < LOCATE_TTL_MS) return hit.v;
  // ... 探 12 个候选名，命中即返回
}
```

设计要点：

| 决策 | 理由 |
| --- | --- |
| 按**目录**缓存而非全局单值 | 多安装共存（便携版 + 安装版）时不会串味 |
| TTL 5 秒 | 与既有 asar 探针缓存一致；用户手动挪目录后最多 5s 自愈 |
| `clearDesktopLocateCache()` 清空 | 这是既有显式失效入口（点「应用」前会调用），保持旧语义 |
| `listDesktopInstallRoots()` 返回 `.slice()` | 防止调用方 `push` 污染缓存（已有回归断言） |
| 缓存键含全部输入 | `execPath`/`resourcesPath`/env/argv 都进 key，测试传不同 input 不互相污染 |
| 上限保护 | `exeBesideMemo` 4096、`installRootsMemo` 64，仅兜底防泄漏（候选总量本就有界） |

**正确性验证**（`scripts/tmp-verify-desktop-cache.mjs`）：

```
PASS roots stable cold/warm (0 roots)
PASS roots identical after cache clear
PASS exe stable: C:\Users\...\DeepSeek Harness.exe
PASS caller mutation did not leak into the cache
CACHE CORRECTNESS OK
```

---

## 三、core.js 的进一步优化方案（未落地，需维护者决策）

`lib/core.js` 由适配任务占用，本次只读分析。以下为可直接套用的片段。

### 3.1 P0：文本读取 LRU（消灭重复 readFileSync）

**问题**：`patchStatus` 对 82 条补丁逐个读目标文件；同一文件被多条补丁共用（如 `agent-instructions/lib/index.js` 被 #1/#2/#3 共用，`tool-bash` 被 #33/#48 共用）。一次状态查询里同一文件可能被读多次。

**方案**：在 `core.js` 模块级加一个带 TTL 的文本缓存，`applyPatches` 写文件后主动失效。

```js
// lib/core.js 模块级
const TEXT_TTL_MS = 2000;
const textCache = new Map(); // fp -> {at, mtimeMs, size, text}

async function loadTextCached(fp) {
  let st;
  try { st = fs.statSync(fp); } catch { throw new Error("missing"); }
  const hit = textCache.get(fp);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size
      && Date.now() - hit.at < TEXT_TTL_MS) return hit.text;
  const text = await fs.promises.readFile(fp, "utf8");
  if (textCache.size > 512) textCache.clear();
  textCache.set(fp, { at: Date.now(), mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

export function invalidateTextCache(fp) {
  if (fp) textCache.delete(fp); else textCache.clear();
}
```

关键约束：**用 `mtimeMs + size` 做校验**，不能只靠 TTL。否则 apply 写完文件后 2 秒内再读会拿到旧文本，`patchStatus` 会误报 pending。

**风险**：中等。必须在 `atomicWriteFile` / `revertAll` 之后调用 `invalidateTextCache(fp)`。建议先在 `patchStatus` 单点试用。

**预期收益**：基准显示 `patchStatusCachedRead` 已有 14.5% 提升（60 次读 → 缓存命中后），全量铺开后预计 20%~30%。

### 3.2 P1：`patchStatus` 的并行化

**现状**：`for (const p of patches)` 串行 `await loadText(fp)`。虽然 Node 单线程，但 `fs.promises.readFile` 是**真异步 I/O**，串行等待会白白浪费 I/O 并发窗口。

**方案**：先收集全部 `(patch, key, fp)` 三元组，按 `fp` 去重后 `Promise.all` 批量读，再纯 CPU 地做匹配。

```js
const pairs = [];
for (const p of patches) {
  if (!patchAppliesHere(p)) { status[p.id] = "na"; continue; }
  for (const key of fileKeysOf(p)) for (const fp of pathsOf(files, key)) pairs.push({ p, key, fp });
}
const uniqueFps = [...new Set(pairs.map((x) => x.fp))];
const texts = new Map(await Promise.all(
  uniqueFps.map(async (fp) => [fp, await loadTextCached(fp).catch(() => null)]),
));
// 之后全部同步匹配
```

**预期收益**：62 个文件并发读，理论上 I/O 等待从 `Σt` 降到 `max(t)`。但注意——**本项目里读文件占比不高**（`patchStatus` 339ms 里 `existsSync` 1020 次才是大头），所以这条的优先级应排在 3.3 之后。

### 3.3 P0：`existsSync` 批量预筛（收益最大）

**问题**：`targetFiles()` 里 906 次 `existsSync`、`patchStatus` 里 1020 次。其中大量是**同一路径重复探**（desktop.js 缓存后已降到 329/443）。

**方案**：给 `allowTargetForPatch` 加一层「路径→zone」的 Map 缓存，键用 `realNorm(fp)`。zone 结果在进程内同样不变。

```js
const zoneMemo = new Map();
function zoneOfCached(fp) {
  const key = realNorm(fp);
  if (zoneMemo.has(key)) return zoneMemo.get(key);
  const zone = pathZone(fp);
  if (zoneMemo.size > 4096) zoneMemo.clear();
  zoneMemo.set(key, zone);
  return zone;
}
```

`resetPathMemo()` 里同步清空即可（该函数已存在，正好是既有失效入口）。

**预期收益**：把 443 次 `existsSync` 里重复的部分砍掉，预计再降 30%~50%。

### 3.4 P2：启动路径剥离

**需要澄清的问题**：`targetFiles()` 到底在插件 `enable` 阶段调用，还是在用户点「应用」时调用？这决定 241ms 加在**宿主启动时间**上还是**交互延迟**上。

从 `lib/index.js` 的调用点看，`patchStatus` 只在状态查询/应用时触发，不在模块顶层。但 `findAiBase()` / `findDshHome()` 这类路径探测确实可能在 enable 阶段跑。**建议维护者实测启动耗时**（在 `apply()` 首尾打点），再决定是否需要把非必要的探测延后到 `requestIdleCallback` / 首次面板打开时。

按「警惕过早优化」：如果启动路径上没有这些调用，这条就不用做。

---

## 四、一次 Apply 的成本画像

`scripts/tmp-bench-core.json` 里 `applyClick` 段（在临时镜像目录上模拟，非真实安装）：

```
gatherMs       1236.2      ← 收集目标文件（targetFiles + 备份准备）
backupAndApply 2086.9      ← 备份 + 逐补丁改写
totalMs        3323.8
fs 调用         existsSync 9379 / statSync 466 / realpathSync 925 / openSync 61
mirrorFiles    62
applyStatusCounts { applied: 59, already: 8, missing_file: 10, skipped: 5 }
```

**解读**：

- 9379 次 `existsSync` 是最大单项。desktop.js 缓存已能覆盖其中一部分，但 `applyPatches` 内部还有独立的探测循环（每条补丁每个文件都重新 `pathsOf` → `fs.existsSync`）。
- `realpathSync` 925 次同样值得缓存（它比 `existsSync` 贵，要解析整条路径）。
- 3.3 秒的 Apply 对「点一次、等重启」的交互来说**可接受**，但 1.2 秒的 gather 阶段是纯浪费——用户点完按钮后 1.2 秒内界面没有任何反馈。这正是前端报告里「按下即响应」要解决的问题（已通过按钮忙碌态覆盖，但数据收集本身还能更快）。

**建议**：Apply 前先给 UI 一个即时反馈（已有 `setPatchBusy(true)`），然后 gather 阶段并行化。

---

## 五、SQLite（`lib/redteam/store-core.js`）结论

**结论：用法规范，未发现明显性能问题。**

| 检查项 | 结果 |
| --- | --- |
| 批量导入是否包事务 | ✅ `importBundle()` 用 `BEGIN` / `COMMIT` / `ROLLBACK`（5209/5269/5271 行） |
| 索引覆盖 | ✅ 45 个索引，含组合索引 `ix_asset_segment_state`、`ix_score_hit_time`、`ix_service_name` |
| 是否有循环内单条查询 | ⚠️ 有，但已批量化：`port`/`fingerprint`/`asset_name` 都用 `WHERE asset_id IN (${ph})` 一次取回，再在内存里 `Map` 组装（1203/1209/1215 行）——**这是正确的 N+1 消除写法** |
| 写入幂等 | ✅ `ON CONFLICT(...) DO UPDATE SET` |
| 是否有全表扫描 | 未发现明显的 `SELECT * FROM big_table` 无 `WHERE`；`GROUP BY day` 类聚合走的是 `ix_*_time` |
| 预处理语句复用 | ⚠️ 部分 `db.prepare(...)` 写在循环体内（如 5218 行每条 name 都重新 prepare）。SQLite 的 `prepare` 有解析开销，**建议把循环内的 prepare 提到循环外**。收益取决于导入数据量，属 P2 |

**唯一可优化点**：`importBundle` 里循环内 `db.prepare()`。改法是把 SQL 提到循环外复用 statement 对象：

```js
const insName = db.prepare(`INSERT INTO asset_name(...) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`);
for (const n of a.names || []) { insName.run(...) }
```

按「警惕过早优化」：只有导入上万条时才明显，当前不紧急。

---

## 六、未做项

| 项 | 理由 |
| --- | --- |
| core.js 的 3.1/3.2/3.3 实际落地 | `lib/core.js` 被适配任务占用（同一文件多写者会冲突）。方案与片段已给出，建议由维护者按 3.3 → 3.1 → 3.2 顺序合入 |
| 启动路径实测打点 | 需要重启真实宿主并采集耗时，属破坏性操作 |
| `realpathSync` 缓存 | 与 3.3 同源，建议一并做；单独做收益小于风险（符号链接场景需失效） |
| SQLite prepare 外提 | P2，当前数据量下收益不显著 |

---

## 七、复现

```powershell
cd H:\coding\dsh-purge
node scripts\tmp-bench-core.mjs          # 生成 tmp-bench-core.json（基线）
node scripts\tmp-verify-desktop-cache.mjs # 缓存正确性
```

> 注：`scripts/tmp-*` 前缀已被 `.gitignore` 忽略，属本地测量脚本，不随包发布。
