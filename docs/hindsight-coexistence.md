# 与 @vectorize-io/hindsight-coding-agents 共存

> 对应代码：`lib/hindsight-compat.js`、`bin/dsh-purge.js`（`--status` 第三方插件段）
> 验证对象：hindsight 0.8.1（本机实装）/ 0.8.2（npm latest）

---

## 一、结论先说

**不需要给 hindsight 打任何补丁。** 两边机制不重叠，可以安全共存。

dsh-purge 要做的是**识别与报告**，而不是改写。已落地为 `lib/hindsight-compat.js` 探测 + `--status` 展示。

---

## 二、hindsight 到底怎么接入 DSH

读 `@vectorize-io/hindsight-coding-agents@0.8.1` 的 `dist/dsh.js`：

```js
var inject = ["agents"];

function createDshHooks(resolve) {
  return {
    async preStep({ agent, signal }, next) {
      const decision = await next();
      if (decision.kind !== "enter" || signal.aborted) return decision;
      ...
      const injection = workspace.core.getInjection(sessionId);
      if (!injection) return decision;
      if (injection === lastInjected.get(sessionId)) return decision;  // 去重
      lastInjected.set(sessionId, injection);
      return { kind: "enter", messages: [...decision.messages, injectionMessage(injection)] };
    },
    async turnStopping({ agent }) { ... },
    disposed({ agent }) { ... },
  };
}

ctx.on("agent/session-start", hooks.sessionStart);
ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
ctx.on("agent/turn-stopping", hooks.turnStopping);
ctx.on("agent/disposed", hooks.disposed);
ctx.inject(["tools"], (toolCtx) => { registerTools(toolCtx, process.cwd()); });
```

注入的消息形状：

```js
function injectionMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: `plugin:${HINDSIGHT_PLUGIN}`, form: "recall" },
  };
}
```

它注册 8 个工具：`hindsight_sync_status`、`hindsight_diagnose`、
`hindsight_search_knowledge_pages`、`hindsight_list_knowledge_pages`、
`hindsight_read_knowledge_page`、`hindsight_reflect`、
`hindsight_capture_initiative`、`hindsight_ingest_document`。

---

## 三、为什么不会与 dsh-purge 冲突

### 3.1 dsh-purge 改的是 systemPrompt，hindsight 改的是 messages

dsh-purge 的提示词类补丁（#25 身份、#32/#53 Web 面、#43 预设身份、#55 head 替换）
全部作用在 **`systemPrompt` 段**上，通过 `ctx.systemPrompt.section()` / waterfall 生效。

hindsight **完全不碰 `systemPrompt`** —— 对 `dist/dsh.js` grep `systemPrompt` 零命中。
它只往 `decision.messages` 追加一条 user 消息。

两者是不同的数据结构、不同的 hook、不同的生命周期，**没有可冲突的交叉点**。

### 3.2 注入消息带 `source.kind`，不会踩 #68

dsh-purge 的 #68 `SYSTEM_NODES_CONTENT_GUARD` 存在的原因是：

```js
// agent-loop/lib/index.js:1067
if (firstAttempt) for (const message of decision.messages)
  if (message.source.kind === "runtime-context") { ... }
```

宿主直接读 `message.source.kind`，如果某条消息没有 `source` 就会抛异常。

hindsight 的注入消息**带 `source: { kind: "plugin:hindsight", form: "recall" }`**，
所以不会触发这个空指针。#68 在这里是**护栏**，不是阻碍。

### 3.3 pre-step 顺序不冲突

hindsight 用 `{ prepend: true }` 注册，dsh-purge 的 #74 只在 `agent-loop` 内部
`inbox.claim()` 之后插一个 `__dshPurgePrepareAssemble` 调用（改的是 assemble 时机），
两者操作的对象不同（一个是 messages 数组尾部追加，一个是 assemble 前置），互不干扰。

---

## 四、真正会坏的情况（这才是要防的）

| 故障 | 现象 | 探测方式 |
| --- | --- | --- |
| profile 的 `dsh.profile.bundles` 丢了 hindsight 行 | 插件在 node_modules 里但**不加载**，用户以为「记忆坏了」 | `state: "not-mounted"` |
| 依赖声明了但 node_modules 没装 | 同上 | `state: "not-installed"`，提示跑 `pnpm install` |
| 用户在 profile patch 层写了 `disabled: true` | 主动关闭，属正常 | `state: "disabled"` |
| hindsight 大版本更新，注入形状变了 | 可能不再带 `source.kind` | `verified: false`，提示超出已验证范围 |
| dsh-purge 的 apply 覆盖了 profile 文件 | bundles 行被冲掉（这是 #43 的教训） | `checkHindsightPreserved()` |

**#43 的教训很关键**：dsh-purge 有一条明确约束 —— 不把 `profiles/<name>/cordis.patch.yml`
放进 `targetFiles`，否则 `backupAll` / `revertAll` 会在版本升级自愈时把用户后来追加的
`insert` 盖掉。hindsight 的挂载行正是靠 profile 的 bundle 列表 + 用户 patch 层维持的，
所以这条约束同时保护了 hindsight。

`checkHindsightPreserved(before, after)` 就是用来断言这个不变量在 apply 前后没有被破坏。

---

## 五、实际使用

```powershell
cd H:\coding\dsh-purge
$env:DSH_SURFACE="desktop"
node bin/dsh-purge.js --status
```

本机实测输出：

```
  第三方插件 / third-party
  hindsight     正常 / ok  v0.8.1
                coexists with dsh-purge patches
```

四种状态都会如实显示：

| state | 显示 |
| --- | --- |
| `ok` | 正常 / ok + 版本号 |
| `disabled` | 已禁用 / disabled |
| `not-mounted` | 已安装但未挂载 / not mounted |
| `not-installed` | 未安装 / not installed |

未安装时如果该 profile 根本没装过 hindsight，这一段**不显示**（避免噪音）。

---

## 六、已验证版本

| 版本 | 状态 |
| --- | --- |
| 0.8.1 | ✅ 本机实装，`dist/dsh.js` 逐行核对过注入形状 |
| 0.8.2 | ✅ npm latest，同一大版本，形状一致 |

超出这个范围时探测会返回 `verified: false` 并在 note 里写明，不会假装没事。

---

## 七、测试

```powershell
node test/hindsight-compat.test.mjs
```

23 项断言，覆盖：

- 健康安装（0.8.1 / 0.8.2）
- 未验证版本被标记但不阻断
- 依赖声明但未装（提示 pnpm install）
- 装了但 bundle 行被删（`not-mounted`）
- profile patch 层 `disabled: true`
- **`disabled: false` 不被误判**
- **别的插件的 `disabled: true` 不串味**
- profile 不存在
- `checkHindsightPreserved` 能检出 bundle 行丢失
