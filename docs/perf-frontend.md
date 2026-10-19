# 前端向优化分析：dsh-purge 侧栏 UI

> 方法论依据：《前端向软件优化方法.md》——物理耗时战（偷时间 / 并行化 / 砍体积）+ 心理感知战（骨架屏 / 乐观更新 / 按下即响应）
> 代码范围：`client.js`（构建产物）、`lib/redteam/client.js`（源）、`lib/redteam/ui.js`（HTTP 桥）、`scripts/build-client.mjs`

---

## 一、摘要

| # | 结论 | 类型 | 状态 |
| --- | --- | --- | --- |
| 1 | 长列表未做视口裁剪，82 条补丁 / 上百张复现卡一次性进布局树 | 物理耗时 | ✅ 已用 `content-visibility` 解决 |
| 2 | `/redteam/api` 裸 `fetch` 无超时，宿主重启时页签永久「加载中」 | 感知/稳定性 | ✅ 已加 25s 超时 + 可读错误 |
| 3 | 清洗页「应用/还原/卸载/保存提示词/保存名单」同样裸 `fetch` 无超时，按钮永久卡死 | 感知/稳定性 | ✅ 已统一走 `apiJson` |
| 4 | 下载报告后立刻 `revokeObjectURL`，部分浏览器会断流 | 正确性 | ✅ 已延后 1s |
| 5 | 更新弹窗的倒计时 `setInterval` 无法取消，关闭弹窗仍会 reload | 正确性/泄漏 | ✅ 已加 ref + cleanup |
| 6 | 状态轮询为「打开后 5s 再刷一次」，无 SWR 缓存直出 | 感知 | ⬜ 建议（未做） |

**最值得说的一条**：第 3 条不是「性能问题」而是「可用性问题」。`apply` 最长要 240 秒，`revert` 120 秒，期间宿主可能正在重启。裸 `fetch` 在这个窗口既不 resolve 也不 reject，`patchBusy` 永远停在 `true`，整排按钮变灰且不会恢复——用户唯一出路是刷新页面。这和之前修 `/redteam/api` 时解决的是同一类缺陷，只是发生在另一条代码路径上。

---

## 二、已落地改动

### 2.1 长列表：`content-visibility` 视口裁剪（P0，纯 CSS）

`lib/redteam/client.js` 的 CSS 段：

```css
.rt-table>.rt-row:not(.head){content-visibility:auto;contain-intrinsic-size:auto 52px}
.rt-table>.rt-vrow:not(.head){content-visibility:auto;contain-intrinsic-size:auto 40px}
.rt-table>.rt-score-row{content-visibility:auto;contain-intrinsic-size:auto 34px}
.rt-pane>.rt-rep,.rt-pane>.rt-kb,.rt-pane>.rt-score-group{content-visibility:auto;contain-intrinsic-size:auto 120px}
.rt-pane>.rt-sec-wrap{content-visibility:auto;contain-intrinsic-size:auto 60px}
.rt-list>.rt-item{content-visibility:auto;contain-intrinsic-size:auto 64px}
@media (prefers-reduced-motion:reduce){.rt-tab,.rt-btn,.rt-item,.rt-row,.rt-seg{transition:none!important}}
```

**为什么不用 JS 虚拟化**：这个界面大量依赖表格的自然高度（不同行高差异大）与 `Ctrl+F` 全文查找。自研窗口化要接管滚动、测量、焦点恢复，还会让浏览器原生查找失效——风险和收益不匹配。`content-visibility` 是浏览器原生实现，零 JS、零交互语义变更。

**为什么避开 `.rt-row.head`**：它是 sticky 表头，必须常驻渲染，否则滚动时会消失。

**收益**：屏幕外节点跳过样式计算、布局与绘制。按方法论里同类场景的经验值，首屏渲染可降 30%~50%（本项目未做前后 profile 对照，属预期值而非实测值，见「未做项」）。

### 2.2 桥接调用统一超时与错误翻译

`lib/redteam/client.js` 的 `api()`：

```js
const API_TIMEOUT_MS = 25000
const api = (req) => {
  const ctrl = canAbort ? new AbortController() : null
  // ... 25s 后 abort
  return fetch('/redteam/api', { ..., signal: ctrl ? ctrl.signal : undefined })
    .then(async (res) => {
      const text = await res.text().catch(() => '')     // 先取文本，避免 res.json() 直接炸
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { return { ok:false, error: res.status + ' non-json: ' + ... } }
      if (!res.ok) return Object.assign({}, data || {}, { ok:false, error: ... })
      return data === null ? { ok: true } : data         // 204/空体按成功处理
    }, (error) => {
      if (error?.name === 'AbortError') return { ok:false, error: '请求超时（25 秒）：宿主正忙或正在重启，稍后点「刷新」' }
      if (/failed to fetch|networkerror|load failed/i.test(msg)) return { ok:false, error: '连不上宿主接口：确认 dsh 还在跑，然后点「刷新」' }
      return { ok:false, error: message }
    }).finally(() => clearTimeout(timer))
}
```

三个设计要点：

1. **失败一律 resolve 成 `{ok:false}`**，不 throw。所有既有调用点本来就是「检查 `r.ok` 而不是 catch」的写法，所以这个改动与全部调用点兼容，无需改业务代码。
2. **先 `text()` 再 `JSON.parse`**。宿主重启窗口里路由会返回 HTML，`res.json()` 抛的是 `Unexpected token '<'`，和真实原因无关。
3. **空体按成功**。避免调用方拿到 `null` 再崩。

### 2.3 清洗页长操作改走 `apiJson`

`client.js` 里五处裸 `fetch(...).then(r => r.json())` 改为 `apiJson(...)`：

| 位置 | 路由 | 超时 |
| --- | --- | --- |
| `doAction` | `/dsh-purge/{apply,revert,uninstall}` | apply 240s / revert 120s / uninstall 90s |
| `saveOverride` | `/dsh-purge/override` | 默认 20s |
| 「自己的服务器」保存 | `/dsh-purge/own-servers` | 默认 20s |
| 重启宿主 | `/dsh-purge/restart` | 60s |

`apiJson` 本身已按路径分级设置超时（见 `apiTimeoutMs`），并统一把 abort 翻译成 `timeout`、把网络失败翻译成中文提示。改完之后 `patchBusy` 在 `.finally()` 里一定会被复位。

**刻意保留裸 `fetch` 的两处**（已在代码注释里说明，并由回归脚本守护）：

- `waitForRestart()` 的 `/dsh-purge/status` 轮询
- `waitHostAfterUninstall()` 的 `/` 探测

这两处是**业务超时驱动的重试循环**（外层用 `Date.now()` 卡 90s / 25s），探测失败是**预期路径**。套上 `apiJson` 的 60s 超时反而会让每次探测挂 60 秒，破坏重试节奏。

### 2.4 其他两处小修

- **下载断流**：`URL.revokeObjectURL(url)` 紧跟 `a.click()` 会让部分浏览器下载中断，改为 `setTimeout(..., 1000)`。
- **倒计时泄漏**：更新弹窗的 `setInterval` 原先只存在闭包里，关闭弹窗无法取消，到点仍会 `location.reload()` 把用户正在做的事冲掉。改为 `countdownRef` + `clearCountdown()` + 卸载 cleanup，并让「关闭」按钮与遮罩点击都走 `closeModal`。

---

## 三、重要工程发现：构建产物领先于源文件

`client.js` 是 `lib/redteam/client.js` 经 `scripts/build-client.mjs` 抽取生成的。排查中发现：

- **HEAD 版 `client.js` 里存在源文件没有的修复**（倒计时 cleanup 三件套：`countdownRef` / `clearCountdown` / `closeModal`）。
- 这意味着历史上有人**直接手改了构建产物而没回写源文件**。
- 后果：任何人执行 `node scripts/build-client.mjs` 都会**静默丢掉**这些修复。

本次处理：把这三处修复回填到 `lib/redteam/client.js`，再重新构建。验证方式是重建前后逐行比对 drill 片段：

```
lines in HEAD fragment: 3234
lines in NEW fragment : 3282
LOST lines: 5   ← 全部是被更好的版本替换（裸 fetch → apiJson、CSS 合并）
ADDED lines: 53 ← 本次新增加固
```

**建议**（未实施，属流程改进）：在 CI 里加一步「构建后 `git diff --exit-code client.js`」，产物一旦与源不一致就红灯。这能从根上杜绝同类漂移。

---

## 四、未做项与理由

| 项 | 现状 | 为什么不做 / 建议做法 |
| --- | --- | --- |
| 状态轮询的 SWR 缓存直出 | 打开侧栏后 `loadAll()`，5 秒后再刷一次 | 现状已可接受（首屏骨架屏 `dshp-skel` 已存在）。真正的 SWR 化需要把 `state` 持久化到 `localStorage` 并在首帧直出，涉及缓存失效语义，属架构改动 |
| 侧栏首屏 JS 体积 | `client.js` 约 464KB（未压缩） | DSH 客户端由宿主本地提供，不走网络，压缩收益低。若要瘦身，应把演练台拆成按需 `import()` |
| 长列表真正的虚拟化 | 用 `content-visibility` 替代 | 见 2.1，JS 虚拟化会破坏 `Ctrl+F` 与自然行高，收益不匹配 |
| 前后 profile 实测对比 | 未做 | 需要真实浏览器跑 Lighthouse / Performance 面板；本次环境无法稳定复现侧栏渲染场景，故只给方法论预期值，不虚报数字 |
| 动画改弹簧物理 | 未做 | 当前 UI 是工具型面板，过渡动画极少；改造成本高于收益 |
| 按键抢跑（pointerdown） | 未做 | 长操作是「提交型」而非「导航型」，提前触发会造成重复提交风险 |

---

## 五、验证

```powershell
cd H:\coding\dsh-purge
node --check lib/redteam/client.js    # 源
node scripts\build-client.mjs         # 重建
node --check client.js                # 产物
node scripts\tmp-verify-frontend.mjs  # 回归门禁
```

`tmp-verify-frontend.mjs` 断言 10 项必须存在、3 项必须不存在、2 项必须保留（刻意保留的轮询），当前全部 PASS。
