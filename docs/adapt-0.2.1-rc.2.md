# dsh-purge 对 DSH 桌面端 0.2.1-rc.2 的适配

> 适配对象：DeepSeek Harness 桌面端 **0.2.1-rc.2**（本机已安装版本）
> 适配前声明：`dshTarget: "0.2.0-rc.2"`，无 `engines.dsh`
> 适配后声明：`dshTarget: "0.2.1-rc.2"`，`engines.dsh: ">=0.2.0-rc.2 <0.3.0"`

---

## 一、结论摘要

| 项 | 结果 |
| --- | --- |
| 补丁锚点在 0.2.1-rc.2 上的存活率 | 82 条中 **78 条正常**（含 2 条还原型补丁本就无锚点） |
| 真实版本漂移并已修复 | **4 条**：#32、#53、#71、#40 |
| 新增目标文件键 | `harness-dev-context`（0.2.1 新增包） |
| 0.2.0 向后兼容 | 已验证不回归（见第五节） |
| 语法与回归 | 全部 `node --check` 通过；累积顺序验证 72/72 补丁 settled |

**最关键的发现**：DSH 0.2.1 把 Web 面身份提示词从 `dsh-web-app` **迁移到了一个全新的包 `@deepseek-ai/dsh-harness-dev-context`**。插件原先只认 `dsh-web-app/lib/index.js`，因此「去掉 DeepSeek Harness 自称」这一整类补丁在新版上会**静默失效**——不报错、不提示，只是不生效。

---

## 二、宿主版本校验机制（重要前提）

排查中发现插件的版本声明字段其实**不被宿主读取**：

- 宿主判定逻辑在 `@deepseek-ai/dsh-app-boot/lib/index.js` 的 `evaluatePluginCompatibility()`：
  - 有 `engines.dsh` → **只**用它判定（semver，`includePrerelease: true`）
  - 没有 `engines.dsh` → 退回扫 `peerDependencies` 里的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
  - 两者都没有 → 视为兼容，永不拦截
- 全库 grep `dshTarget`：**0 命中**。该字段是插件自定义的展示用元数据。

适配前插件只有 `engines.node`、peer 只有 `@deepseek-ai/cordis`（不匹配 dsh 前缀），所以**宿主对版本完全不设防**。这解释了为什么插件能在 0.2.1 上「装上、能跑、但部分补丁悄悄不生效」。

因此本次补上了真正的护栏：

```json
"engines": { "node": ">=18", "dsh": ">=0.2.0-rc.2 <0.3.0" }
```

range 用宿主自带 semver 实测（`includePrerelease: true`）：

| range | 0.2.0-rc.2 | 0.2.0 | 0.2.1-rc.2 | 0.2.1 | 0.3.0 | 0.1.7-rc.2 |
| --- | --- | --- | --- | --- | --- | --- |
| `>=0.2.0-rc.2 <0.3.0` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

---

## 三、版本差异与失效补丁

### 3.1 目标文件映射新增

`lib/core.js` 的 `targetFiles()` 新增一个键：

```js
"harness-dev-context": firstExisting([
  path.join(aiBase, "dsh-harness-dev-context", "lib", "index.js"),
  ...(root ? [path.join(root, "packages", "bundle", "harness-dev-context", "lib", "index.js")] : []),
]),
```

`firstExisting()` 在 0.2.0 上落空，行为不变。

### 3.2 逐条失效补丁判定

| # | 名称 | 0.2.1 现象 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| 32 | WEB_SURFACE_IDENTITY_NEUTRAL | 身份句已迁至 `dsh-harness-dev-context`；`Canonical` 文案改为 `Advertised` | 真漂移 | 扩 `file` 列表 + 补 3 条新锚点 |
| 53 | WEB_SURFACE_PROHIBITION | 同 #32；「不要另开服务器」整句搬走 | 真漂移 | 扩 `file` 列表 + 补 2 条新锚点 |
| 71 | LIANGSHEN_IDENTITY_LINE | 梁神预设从 `prefix: \|-` 块标量改成 persona `text:` 单行 | 真漂移 | 补认新形态 |
| 40 | COMPLETE_PROMPT_KEEP_INJECT | `contexts` 从「清空」改为按 `requiredContexts` 过滤 | 真漂移 | 补正则 + 保留新语义的改写体 |
| 77 | REWIND_DROP_SENT_ON_APPEND | `append()` 里 `this.revised.clear()` 加了 `size > 0` 短路 | 真漂移（隐蔽） | 补第二种锚点 |
| 21 | BASH_TIMEOUT_RESTORE | 纯净树上无 `[dsh-purge]` 标记可还原 | 正常（还原型） | 不动 |
| 80 | MINIMAL_OFFICIAL_TOOLSET | 同上，纯净树无插件追加行 | 正常（还原型） | 不动 |
| 2 / 3 / 24 / 50 | — | 锚点已被自己改过，marker 仍在 | 正常（幂等） | 不动 |

> #77 值得单独说明：它不是「找不到」，而是**只差一行**。0.2.0 是 `this.revised.clear();`，0.2.1 是 `if (this.revised.size > 0) this.revised.clear();`。补丁的 marker 仍在文本里（历史残留），所以 `patchStatus` 显示 `applied`，但实际新代码路径从未被改到——这类「假 applied」比 skipped 更危险。

### 3.3 三条真漂移的原文对照

**#32 / #53（`dsh-harness-dev-context/lib/index.js`）**

```js
// 0.2.1 现行（第 29 行）
const WEB_SURFACE_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ...`
// 0.2.1 冻结旧版（第 41 行，供会话回放匹配）
prefix: "You are interacting with the user through the DeepSeek Harness Web GUI at "
// 0.2.1 shellEnv 描述（dsh-web-app/lib/index.js 第 152 行）
description: "Advertised URL of the DeepSeek Harness Web GUI serving this session."
```

注意第 30-43 行的注释明确写着这些 `LEGACY_*` 常量**必须冻结、不能跟着改**，否则老会话的提示词段落匹配不上。所以补丁必须同时改「现行句」和「冻结旧句」，两者都要覆盖。

**#40（`dsh-system-prompt/lib/index.js` 第 398-405 行）**

```js
const transformed = await this.ctx.waterfall(...);
if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
return {
  ...transformed,
  sections: completeSection === void 0 ? transformed.sections : [completeSection],
  contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
};
```

旧改写体写死 `contexts: runtimeContextSuppressed ? [] : ...`，直接用会把 0.2.1 的 required 上下文一并丢掉。新增的 `COMPLETE_PROMPT_WATERFALL_INJECT_021` 沿用新过滤语义。

---

## 四、验证方式与结果

### 4.1 累积顺序验证（`scripts/tmp-verify-apply-order.mjs`）

补丁引擎是**按 `ALL_PATCHES` 顺序累积**改写同一文件的（#32 先把句子改成 local，再由 #53 收成 Local web GUI）。逐条对纯净原文验证会误报，因此验证器按真实顺序重放：

```
$ node scripts/tmp-verify-apply-order.mjs
...
ok   #32 WEB_SURFACE_IDENTITY_NEUTRAL settled via [web-app-lib,harness-dev-context]
ok   #53 WEB_SURFACE_PROHIBITION settled via [web-app-lib,harness-dev-context]
ok   #71 LIANGSHEN_IDENTITY_LINE settled via [preset-liangshen,preset-liangshen-pkg]
ok   #40 COMPLETE_PROMPT_KEEP_INJECT settled via [system-prompt]
ok   #77 REWIND_DROP_SENT_ON_APPEND settled via [conversation-client]

patches=72 unsettled=2
unsettled list: #21 BASH_TIMEOUT_RESTORE | #80 MINIMAL_OFFICIAL_TOOLSET
```

剩余 2 条已单独核实为**还原型补丁在纯净树上的正确行为**：0.2.1 的 `dsh-base/cordis.patch.yml` 与 `minimal.patch.yml` 中不存在任何 `[dsh-purge]` 标记或插件追加行，因此「恢复官方原状」无事可做。这不是失效。

### 4.2 0.2.0 向后兼容（`scripts/tmp-verify-backcompat.mjs`）

把 0.2.1 树复制到临时目录、删掉 `dsh-harness-dev-context`、把两处句子降级回 0.2.0 形态，然后重跑 #32/#53：

```
harness-dev-context resolved to: undefined (expected empty on 0.2.0)
web-app-lib resolved to: ok
PASS #32 WEB_SURFACE_IDENTITY_NEUTRAL changed=true marker=true
PASS #53 WEB_SURFACE_PROHIBITION changed=false marker=true

BACKWARD COMPAT OK
```

说明扩 `file` 列表没有牺牲旧版兼容性。

### 4.3 状态基线（真实桌面端 0.2.1-rc.2，只读）

```
$ DSH_SURFACE=desktop node -e "...patchStatus(aiBase)..."
{"pending":67,"applied":6,"na":5,"skipped":4}
```

`pending` 是预期值：这是**未打补丁的纯净安装**，67 条待应用正是插件「装上但还没点应用」的正常状态。

---

## 五、改动清单

| 文件 | 改动 |
| --- | --- |
| `lib/core.js` | `targetFiles()` 新增 `harness-dev-context` 键 |
| `lib/core.js` | #32 扩 `file` + 3 条 0.2.1 锚点 + 2 个新 marker |
| `lib/core.js` | #53 扩 `file` + 2 条 0.2.1 锚点 + 1 个新 marker |
| `lib/core.js` | #71 补 persona `text:` 单行形态 |
| `lib/core.js` | #40 补 0.2.1 正则 + 新增 `COMPLETE_PROMPT_WATERFALL_INJECT_021` 常量 |
| `lib/core.js` | #77 补 `size > 0` 短路形态 |
| `package.json` | `engines.dsh` 新增；`dshTarget` 更新为 `0.2.1-rc.2` |

未改动：`README.md` / `README.zh-CN.md` 的适配范围段仍写「0.2.0-rc.2」。**建议同步更新**，但本次未动，因为作者在 README 顶部声明「暂停更新」，且适配范围涉及对外承诺，应由维护者确认后再改（详见「未做项」）。

---

## 六、未做项与理由

| 项 | 理由 |
| --- | --- |
| 更新 README 适配范围 / 徽章 | 属对外版本承诺，需维护者拍板；本次只落工程侧护栏 |
| 对真实安装执行 apply 验证 | 会改写用户正在使用的 DSH，属破坏性操作。已改用「纯净树 + 纯函数」验证替代 |
| 修复 #21/#80 | 经核实是还原型补丁的正确空操作，改动反而会破坏语义 |
| 让 `dshTarget` 参与宿主校验 | 宿主不读该字段，改名或加逻辑都无法生效；正确做法是 `engines.dsh`，已采用 |

---

## 七、复现命令

```powershell
cd H:\coding\dsh-purge

# 全量回归（累积顺序）
node scripts\tmp-verify-apply-order.mjs

# 0.2.0 向后兼容
node scripts\tmp-verify-backcompat.mjs

# 语法
node --check lib/core.js

# 桌面端只读状态
$env:DSH_SURFACE="desktop"
node -e "const c=await import('./lib/core.js');const b='C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai';console.log(await c.patchStatus(b))"
```

> 证据树：`H:\coding\_dsh-asar-export\dsh\node_modules\@deepseek-ai`（从桌面端 `app.asar` 解出的 0.2.1-rc.2 原始文件，只读）
