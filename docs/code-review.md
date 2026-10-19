# dsh-purge 代码审查报告

> 审查对象：`dsh-purge` 1.1.71（`master` @ `6c1d638`）
> 审查范围：`bin/`、`client.js`、`lib/*.js`、`lib/redteam/*.js`、`scripts/*.mjs`，约 1.4 MB JS
> 审查方式：静态阅读 + 只读函数调用 + 本机真实安装树取证（**未执行任何 apply/revert**）

---

## 一、摘要：Top 5 最该修的问题

| # | 问题 | 严重度 | 位置 |
| --- | --- | --- | --- |
| 1 | 自动更新下载 zip 后**无任何完整性校验**，直接覆盖插件目录 | **高** | `lib/update.js:878-909` |
| 2 | 版本护栏字段 `dshTarget` 宿主根本不读，插件实际**不受版本约束** | **高** | `package.json:94` |
| 3 | 补丁「假 applied」：marker 残留导致状态误报，真实代码未被改写 | **高** | `lib/core.js:3848+`（#77 实例） |
| 4 | 构建产物 `client.js` 与源文件脱节，重建会静默丢修复 | 中 | `client.js` vs `lib/redteam/client.js` |
| 5 | 38 处静默 `catch {}`，故障被吞，用户与日志都看不到 | 中 | `lib/*.js`、`lib/redteam/*.js` |

> **第二轮更新**：#1 已落地验签框架（见 [`update-signing.md`](update-signing.md)），#2、#3、#4 已修复，详见 §十。新增发现：C-2（Windows 备份 EPERM）也已修复。

---

## 二、安全

### S-1【高】更新链路无完整性校验

`lib/update.js:878` `overlayFromZip()`：

```js
const res = await fetchRes(archiveZipUrl(ref), 45000);
await fsp.writeFile(zip, Buffer.from(await res.arrayBuffer()));
extractZip(zip, tmp);
// ... 然后 rm -rf 目标目录，fsp.cp 覆盖
```

全仓库 grep `createHash|sha256|sha512|integrity|verify` 在 `update.js` / `official-update.js` / `zip-extract.js` 里 **0 命中**。

**影响**：更新内容完全依赖 HTTPS 传输层保证。一旦出现以下任一情况，恶意代码会以用户权限落到插件目录并在下次启动被加载：

- GitHub 账号被攻陷（仓库本身可被改）
- 中间人（企业代理、恶意 CA）
- 用户配置了 `HTTPS_PROXY` 指向不可信节点

对这类「自我更新」组件，业界标准做法是**用离线公钥验签**（Ed25519 签名 release 产物），而不是只靠 TLS。

**建议**：
1. Release 产物附 `.sig`，插件内置公钥，下载后验签再解压。
2. 过渡方案：在仓库里放一个 `checksums.json`（含版本→sha256），下载后比对。虽然仍依赖同一传输层，但能防「下载被截断/替换成旧版本」这类非对抗性故障。
3. 至少记录下载文件的 sha256 到日志，便于事后取证。

**注意**：`lib/zip-extract.js` 的 zip-slip 防护是**到位**的（`zip-extract.js:22-24, 93-95` 有绝对路径、`..`、`out.startsWith(prefix)` 三重检查），`extract-asar.js:432-441` 也校验了 symlink 不逃逸。所以缺口只在**内容可信性**，不在**解压路径**。

### S-2【高】版本护栏形同虚设

宿主的兼容性判定在 `@deepseek-ai/dsh-app-boot/lib/index.js`：

```js
function unmetRequirements(fields, runtimeVersion) {
  const engines = fields.engines ?? {};
  if (Object.hasOwn(engines, "dsh")) { /* 只用它 */ }
  if (!Object.hasOwn(fields, "peerDependencies")) return {};
  // 只扫 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 前缀
}
```

审查前插件状态：

- `package.json` 只有 `engines.node`，**没有 `engines.dsh`**
- `peerDependencies` 只有 `@deepseek-ai/cordis`（不匹配 `dsh` 前缀 → 被忽略）
- `dshTarget: "0.2.0-rc.2"` —— 全库 grep 在宿主侧 **0 命中**，纯展示字段

**影响**：插件在 0.1.x / 0.3.x / 任意未来版本上都能装上、能启用，然后**部分补丁静默失效**（这正是本次适配发现的 4 条真漂移的成因）。

**状态**：本次已修（`engines.dsh: ">=0.2.0-rc.2 <0.3.0"`）。此处记录为**审查发现**，因为它说明「靠 `dshTarget` 表达兼容性」是本仓库的一个系统性误解。

### S-3【中】`execFileSync` 调 PowerShell 拼接脚本

`lib/desktop.js:389, 494, 553` 用 `execFileSync("powershell.exe", ["-NoProfile", "-Command", REGISTRY_INSTALL_SCRIPT])`。脚本是**常量字符串**，不拼接用户输入，因此**不构成注入**。但：

- PowerShell `-Command` 传常量脚本仍会经过 PowerShell 解析器，若脚本内含未转义的引号/`$` 会出错；
- 每次调用要拉起一个 PowerShell 进程（约 100~300 ms），而这三处在定位安装目录的**热路径**上。

**建议**：优先用注册表 API（`winreg`）或缓存结果；必须用 PowerShell 时至少加 `-NonInteractive -ExecutionPolicy Bypass` 并显式指定 `-EncodedCommand` 避免引号问题。

### S-4【低】日志可能含绝对路径

`lib/desktop.js:27` 定义 `INTERNAL_LOG_PATH = path.join(os.tmpdir(), "dsh-purge-desktop.log")`，日志里会写安装目录、`$DSH_HOME` 等绝对路径。对本地工具可接受，但若用户把日志贴到 issue，会泄露用户名与目录结构。

**建议**：日志脱敏（`C:\Users\<name>` → `~`），仓库里已有 `displayPath()`（`lib/skills.js:44-52`）可复用。

---

## 三、正确性

### C-1【高】补丁「假 applied」

`lib/core.js` 的 `filePatchOutcome()`：

```js
function filePatchOutcome(text, patch, fp = "") {
  if (filePatchSettled(text, patch, fp)) return "applied";   // ← marker 命中即判 applied
  if (patchHasRemainingWork(text, patch, fp)) return "pending";
  return "skipped";
}
```

**实例**（本次适配中实证）：#77 `REWIND_DROP_SENT_ON_APPEND` 的 marker 字符串是 `[dsh-purge] rewind drops sent messages in this conversation`。在 0.2.1 上：

- 上游 `append()` 里 `this.revised.clear()` 变成了 `if (this.revised.size > 0) this.revised.clear()`，**锚点失配**；
- 但文本里**历史残留**了 marker 字样（别的补丁或旧版本写过）；
- 结果 `patchStatus` 报 `applied`，而 0.2.1 的新代码路径**从未被改到**。

**影响**：这是最危险的一类缺陷——不报错、不提示、界面显示绿色，但功能没生效。用户以为「已清洗」，实际宿主行为仍是官方原样。

**建议**：
1. `markers` 命中只能作为「已完成的**必要**条件」，还应校验「目标语义确实存在」。例如为每条补丁声明一个 `verify` 断言（在改写后文本上跑），或要求 marker 与锚点**同处一个函数体**。
2. 对 `skipIfMarked: true` 的补丁，改为「marker 命中 **且** 锚点已不在」才算 settled；marker 在但锚点也在 → 判 `pending`（说明是残留 marker）。
3. 在 `--status` 输出里区分 `applied`（真改过）与 `already`（本来就完成）。

### C-2【中】`atomicWriteSync` 在 Windows 上不是真原子

`lib/core.js`：

```js
const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tmp, content, encoding);
try { fs.renameSync(tmp, fp); } catch (e) { /* 清理 tmp，throw */ }
```

Windows 上 `rename` 到**已存在**的文件，若目标被其他进程（杀软、编辑器、正在运行的 DSH）打开，会抛 `EPERM`。代码会清理 tmp 并抛错——**这是正确行为**（不会写出半个文件）。但基准里 `applyClick` 段出现了：

```
bakErrors: 61
bakSampleError: "EPERM: operation not permitted, rename '...index.js.dshpurge.bak.16260'"
```

61 个备份全部 EPERM。这说明在 Windows 上**备份这一步在当前实现下会大面积失败**。虽然基准是在临时镜像目录跑的，但错误信息指向的是真实 Windows 语义问题。

**建议**：
1. 备份不要用「写 tmp 再 rename」，直接 `copyFileSync(src, bak)`（备份不需要原子性，只需要存在）。
2. 若必须 rename，先 `unlinkSync(target)` 再 rename，或重试 3 次带退避。

### C-3【中】CRLF/LF 双路径易漏

`applyReplacementsToText()`：

```js
const crlf = typeof source === "string" && source.includes("\r\n");
let out = asLf(source);              // 全部转 LF 再匹配
// ... 替换 ...
if (crlf) out = out.replace(/\n/g, "\r\n");   // 再转回 CRLF
```

逻辑本身正确，但**隐患**：如果文件里 CRLF 与 LF **混用**（Windows 上被不同工具改过），`includes("\r\n")` 为真，回写时会把**原本是 LF 的行也转成 CRLF**，造成整文件换行符漂移。这会让 `.dshpurge.bak` 与当前文件的 diff 变成「全文件都变了」，进而让 `refreshStaleBaksForUpgrade()` 误判。

**建议**：只对**实际发生替换的行**做换行符还原，或检测混用（`count(\r\n) > 0 && count(?\r\n) > 0`）时拒绝改写并提示。

### C-4【低】`hasBackup()` 的 O(n) 探测

```js
export async function hasBackup(aiBase) {
  const files = targetFiles(aiBase);
  for (const fp of flattenTargetPaths(files)) {
    if (fs.existsSync(fp + ".dshpurge.bak")) return true;
  }
  return false;
}
```

`targetFiles()` 本身 241 ms（优化前）。`hasBackup` 在 UI 上每次状态查询都可能被调用，等于把最贵的函数又跑一遍。**建议**用 `backupAll` 时写入一个 `backup-manifest.json`，`hasBackup` 只查这个文件。

---

## 四、性能

详见 [`docs/perf-backend.md`](perf-backend.md) 与 [`docs/perf-frontend.md`](perf-frontend.md)。审查视角补充两点：

### P-1【中】热路径上的重复探测（已部分修复）

`targetFiles()` 单次 `existsSync` 906 次，同一 exe 路径被探 313 次。根因是 `pathZone()` → `isInsideDesktopInstall()` → `firstExistingExe()` 这条链在每个目标文件上重跑。本次已在 `lib/desktop.js` 加目录级缓存（TTL 5s + 显式失效），`existsSync` 降至 329 次、耗时 241.9 → 146 ms。

**残留**：`core.js` 内部的 `pathsOf()` / `allowTargetForPatch()` 仍有独立重复探测，方案见 `perf-backend.md` §3.3。

### P-2【低】循环内 `db.prepare()`

`lib/redteam/store-core.js:5218` 等处在循环体内 `db.prepare(...)`。SQLite 的 prepare 有解析开销，应提到循环外复用。当前数据量下不显著。

---

## 五、可维护性

### M-1【中】超长单文件

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `lib/core.js` | 8083 | 补丁表 + 引擎 + 路径探测 + shim 管理全在一个文件 |
| `lib/redteam/store-core.js` | 5386 | 全部 SQL 与业务逻辑 |
| `lib/redteam/client.js` | 4300 | 全部 UI 组件 |
| `client.js`（产物） | 8802 | 生成物，可接受 |

`core.js` 里 `PATCHES` 数组本身就占了两千多行，与引擎逻辑混在一起。**建议**把补丁表拆到 `lib/patches/*.js`，引擎只 import。

### M-2【中】`client.js` 产物与源脱节

已实证：HEAD 版 `client.js` 含源文件没有的 `countdownRef`/`clearCountdown`/`closeModal` 三处修复。任何人跑 `node scripts/build-client.mjs` 都会静默丢掉它们。

**建议**：CI 加 `node scripts/build-client.mjs && git diff --exit-code client.js`。

### M-3【低】注释与代码偶有不一致

`lib/core.js:3849` 注释说「complete:true 会在 waterfall 之后只留完整段」，但 0.2.1 已改成「按 requiredContexts 过滤 contexts」。注释未随上游更新，容易误导后续维护者（本次适配正是因为读了代码才发现差异）。

---

## 六、测试与 CI

### T-1【高】零行为测试

`package.json` 的 `scripts` 原先只有：

```json
"embed-prompt": "node scripts/embed-default-prompt.mjs",
"build:client": "node scripts/build-client.mjs"
```

**没有任何 test 脚本**。历史上甚至出现过 `chore: 1.1.70 去掉 test` 和 `fix: 把误删的 test 加回 1.1.70` 这样的反复提交。

对一个「按字符串锚点改写宿主源码」的项目，**锚点失效是最主要的故障模式**，而这恰恰是最容易用纯函数单测覆盖的。

**本次已交付**（`test/` + `npm test`）：

| 测试 | 覆盖内容 |
| --- | --- |
| `patch-anchors.test.mjs` | 按真实累积顺序重放 82 条补丁，断言每条 settled；还原型补丁显式豁免 |
| `patch-backcompat.test.mjs` | 构造 0.2.0 形态树，断言 #32/#53 仍能通过旧锚点生效 |
| `desktop-cache.test.mjs` | 定位缓存冷/热/清空后结果一致，且调用方无法污染缓存 |
| `client-artifact.test.mjs` | 10 项必须存在、3 项必须不存在、2 项刻意保留 |
| `backup.test.mjs` | 62 个备份字节一致、二次备份为 no-op（守住 C-2 回归） |

当前结果：`5 passed, 0 failed`（有 DSH 树时）；无 DSH 树时 3 项自动 SKIP、2 项仍跑。

**仍建议补的纯函数单测**：

| 被测对象 | 测试内容 |
| --- | --- |
| `applyReplacementsToText()` | 幂等性：同一文本应用两次结果相同 |
| `applyReplacementsToText()` | CRLF 文件应用后换行符保持（对应 C-3） |
| `applyReplacementsToText()` | 锚点不存在时 `changed === false` 且文本不变 |
| `normalizeAllowText()` | 密钥/网段/通配符被剔除，合法 IP/主机名保留 |
| `atomicWriteSync()` | 写入失败时不留 tmp 文件 |
| `zip-extract` | `../` 路径被拒绝 |

### T-2【中】CI 存在但缺测试环节

`.github/workflows/release.yml` **是存在的**（62 行），会在 push 到 master 时做：

- 语法检查（`lib/index.js`、`lib/core.js`、`lib/reapply.js`）
- 校验 `release-notes.md` 首行与版本号一致
- 打包 zip 并创建 GitHub Release

所以 README 说的「推到 master 就会自动打包」是**准确的**（审查初稿误判为空目录，此处已更正）。

**真正的缺口**：这条流水线**只做语法检查，不跑任何行为测试**。对一个「按字符串锚点改写宿主源码」的项目，语法正确 ≠ 补丁能命中。锚点失效恰恰是语法检查发现不了的。

**本次已补**：`.github/workflows/test.yml`

```yaml
- name: Syntax-check every entry point
- name: Run regression suite          # node test/run.mjs
- name: client.js must match its source
  run: |
    node scripts/build-client.mjs
    git diff --exit-code -- client.js
```

最后一步正是为了守住 M-2 的产物漂移：产物与源不一致就红灯。

---

## 七、文档与实现不一致

| README 声称 | 实际 | 位置 |
| --- | --- | --- |
| 适配 0.2.0-rc.2 | 本机是 0.2.1-rc.2，且 4 条补丁在 0.2.1 上失效（**已修**，见 `docs/adapt-0.2.1-rc.2.md`） | `README.zh-CN.md:34,165` |
| 「推到 master 就会自动打包」 | ✅ 属实，`release.yml` 会打包并发 Release | `README.zh-CN.md:584` |
| `dshTarget` 表达兼容性 | ❌ 宿主不读该字段（**已改用 `engines.dsh`**） | `package.json:94` |
| 补丁数 82 | ✅ 与 `ALL_PATCHES` 一致 | — |
| 「重复应用是幂等的」 | 大体成立；#1 曾因 `markers` 不参与防重导致 +841 字符/次（已用 `skipIfMarked` 修） | `README.zh-CN.md:560` |

---

## 八、建议的修复优先级

| 优先级 | 项 | 理由 |
| --- | --- | --- |
| **发布前必修** | S-1 更新验签、C-1 假 applied | 直接影响安全性与功能正确性 |
| **本次已修** | S-2 版本护栏、C-2 Windows 备份 EPERM、M-2 产物漂移、T-1/T-2 测试与 CI | 见 §十 |
| 下一个版本 | C-3 混用换行符、C-4 backup manifest、M-1 拆分 core.js | 防回归与长期可维护性 |
| 有余力时 | S-3 减少 PowerShell 调用、S-4 日志脱敏、P-2 prepare 外提 | 打磨 |

---

## 十、已修复项（与上面各条对应）

### 第一轮

| 条目 | 修复内容 | 验证 |
| --- | --- | --- |
| S-2 | `package.json` 增 `engines.dsh: ">=0.2.0-rc.2 <0.3.0"` | 用宿主自带 semver 实测 6 个版本 |
| C-2 | `backupAll()` 不再「wx 占位 + rename 覆盖」，改为直接 `copyFile` 到已占位的 bak | `test/backup.test.mjs`：62/62 字节一致（修复前 61 个 EPERM） |
| M-2 | 把 HEAD 产物里独有的 `countdownRef`/`clearCountdown`/`closeModal` 回填源文件并重建 | `test/client-artifact.test.mjs` + 构建幂等 |
| T-1 | 新增 `test/` + `npm test` | 10 passed |
| T-2 | 新增 `.github/workflows/test.yml`（含产物漂移检查） | 本地模拟三步全过 |
| 适配 | 4 条 0.2.1 漂移补丁修复 + `harness-dev-context` 目标键 | `docs/adapt-0.2.1-rc.2.md` |

### 第二轮

| 条目 | 修复内容 | 验证 |
| --- | --- | --- |
| **S-1** | 新增 `lib/release-signature.js`（Ed25519 验签 + 降级保护 + 通道分级）、`scripts/generate-signing-key.mjs`、`scripts/sign-release.mjs`；`update.js` 改为 tag 版从 Release 固定产物下载并强制验签；`release.yml` 增签名步骤；`.gitignore` 保护私钥 | `test/release-signature.test.mjs` 16 项断言全过；端到端签名实测 |
| **C-1** | 新增 `patchStale()`：`skipIfMarked` 补丁「marker 在 + 锚点也在」判为 `stale`，不再谎报 `applied`；`--status` 用 ⚠ 标出；UI 计数与中英文案同步 | `test/stale-detection.test.mjs`；纯净树零误报 |
| **C-3** | `detectEol()` / `applyEol()`：区分纯 LF、纯 CRLF、混用三种情况，混用文件逐行保留原换行符 | `test/eol-fidelity.test.mjs` |
| **C-4** | 尝试了快速探测方案，**实测更慢（107ms vs 85ms）已回退**；正确方向（backup manifest）记入代码注释 | `test/has-backup.test.mjs`（等价性守卫） |
| 新增 | `lib/hindsight-compat.js` + `--status` 第三方插件段 | `test/hindsight-compat.test.mjs` 23 项断言 |
| 文档 | 新增 `docs/update-signing.md`、`docs/hindsight-coexistence.md`；README 适配声明更新到 0.2.1-rc.2 | — |

### 仍然未修（已给方案）

| 条目 | 原因 |
| --- | --- |
| S-1 的密钥落地 | 私钥必须由维护者生成，我不能代生成生产密钥。框架已就绪，填入公钥即生效 |
| C-4 的 manifest 方案 | 属接口变更（`backupAll` 要写 manifest），留给维护者决定 |
| M-1 拆分 `core.js` | 8083 行拆分是大重构，风险高，建议单独 PR |
| S-3 PowerShell 调用优化 | 需先实测启动耗时占比，避免过早优化 |
| S-4 日志脱敏 | 低危，可复用现有 `displayPath()` |

---

## 九、审查方法说明

- 所有「严重度」判定基于：是否导致**安全边界失效**、**功能静默失效**、或**用户数据/系统受损**。
- 所有结论均在代码中定位到具体行号；性能类结论有 `scripts/tmp-bench-core.json` 实测数据支撑；适配类结论有 `H:\coding\_dsh-asar-export` 下 0.2.1-rc.2 原文佐证。
- 本次审查**未执行** `apply` / `revert` / `uninstall`，所有对真实安装的操作均为只读函数调用。
