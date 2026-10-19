# 本仓库的维护说明（独立分叉版）

本仓库是 [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) 的 fork，
维护的是**上游改为商业许可之前**的 MIT 版本，自 **1.1.72** 起**独立演进**。

---

## 零、独立化的边界（重要）

独立指的是「不再跟随上游」，**不是**「另起一个项目」。以下边界不要越：

| 项 | 规则 |
| --- | --- |
| `LICENSE` 的 `Copyright (c) 2026 小杨` | **不得删除或改写**。MIT 要求保留原版权声明 |
| README 的「署名要求」段落 | **必须保留**。原作者要求借用名称/思路/代码/提示词须署名并写明来源 |
| 徽章、赞助地址、原作者联系方式 | 保留。那是原作者的内容，本仓库不代为接收 |
| `package.json` 的 `repository`/`homepage`/`bugs` | 已改指本 fork —— 这三个字段表示「问题报给谁」，不是署名 |
| `package.json` 的 `description` | 已加来源说明，标明是 fork |
| 补丁标记 `[dsh-purge]`（274 处） | **永不改名**。这是写进宿主文件的二进制契约，改名会让旧补丁失联、回滚失败 |
| 数据目录 `$DSH_HOME/dsh-purge` | **不改**。改名等于迁移用户数据，有丢数据风险，收益不抵成本 |
| npm 包名 `dsh-purge` | **不改**。已安装用户不会断崖，且市场登记按此名反查 |

一句话：**对外元数据可以指向本仓库，署名与运行时标识一律不动。**

---

## 一、为什么不再合并上游

上游在 2026-10-19 把许可从 MIT 改成了商业软件许可：

```
dsh-purge 商业软件许可
Copyright (c) 2026 小杨 (YuJunZhiXue)
保留所有权利。
本软件不是开源软件。当前分支也不是 MIT。
未经我书面授权，不得复制、修改、再分发、出售、出租、白标或公开提供源码。
```

`package.json` 的 `license` 也从 `MIT` 改成了 `SEE LICENSE IN LICENSE`。

本仓库保留的是分叉时的 MIT 版本（`LICENSE` 仍是 MIT）。**继续合并上游会同时带来两个问题**：

1. **条款冲突** —— 上游新条款禁止「复制、修改、再分发」，而合并本身就是复制与修改；
2. **许可状态不清** —— 混合了 MIT 与商业许可代码的仓库，无法对外说清适用哪套条款。

所以本仓库从 `dfced59` 起**独立演进，不再跟踪上游**。

> MIT 的既往授权不可撤销：从 MIT 时期取得的代码，按 MIT 条款仍可使用、修改、分发。
> 这不是法律意见，涉及商用或公开分发请咨询专业人士。

---

## 二、分支布局

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| 本地 `master` | MIT 版本，跟踪 `origin/mit-1.1.72` | 日常工作分支 |
| `origin/mit-1.1.72` | 同上，远端备份 | 发布与 CI 的分支 |
| `origin/master` | **上游的商业许可版本** | 仅作历史参考，**不要合并** |

**注意**：`origin/master` 与本地 `master` 同名但内容不同源。本地的 `master` 跟踪的是
`origin/mit-1.1.72`，不是 `origin/master`。

---

## 三、已做的防误操作配置

| 配置 | 值 | 作用 |
| --- | --- | --- |
| `upstream` 远端 | **已移除** | 从根源上消除误 pull 上游的可能 |
| 本地 `master` 的上游 | `origin/mit-1.1.72` | 默认 pull/push 走自己的分支 |
| `push.autoSetupRemote` | `true` | 首次推送自动建立上游 |
| `fetch.prune` | `true` | 清理已删除的远端分支 |

如果以后确实需要参考上游（**只读**，不要合并）：

```powershell
git remote add upstream-ref https://github.com/YuJunZhiXue/dsh-purge.git
git fetch upstream-ref --no-tags          # 只看，不建本地分支
git log --oneline upstream-ref/master -5   # 浏览
git remote remove upstream-ref             # 看完即删
```

---

## 四、日常流程

```powershell
# 拉取自己的远端
git pull                                  # 等价于 git pull origin mit-1.1.72

# 提交
git add -A
git commit -m "..."

# 推送（推到自己 fork 的 mit-1.1.72）
git push                                  # push.autoSetupRemote 已开，无需写全
```

### 发布新版本

1. 改 `package.json` 的 `version`
2. 在 `release-notes.md` **顶部**加一节，**第一行必须是 `# <version>`**（CI 硬性校验，不一致直接失败）
3. 推送 —— `release.yml` 会打包、签名、上传 `.zip` 与 `.zip.sig`

签名用 GitHub Secret `RELEASE_SIGNING_KEY`，对应公钥在 `lib/release-signature.js` 的
`TRUSTED_KEYS`。密钥轮换见 [`docs/update-signing.md`](docs/update-signing.md)。

---

## 五、发布通道

| 项 | 值 |
| --- | --- |
| 发布源仓库 | `xlht4106/dsh-purge`（`lib/update.js` 的 `DEFAULT_REPO`，可用 `DSH_PURGE_REPO` 覆盖） |
| 稳定通道分支 | `mit-1.1.72`（`lib/update.js` 的 `STABLE_REF`） |
| CI 触发分支 | `mit-1.1.72`、`master`（`.github/workflows/*.yml`） |

**这四处必须保持一致**，改分支名时一起改，否则会出现「更新去 A 找、CI 在 B 签名」的错配。

---

## 六、署名

上游 README 的「署名要求」仍然有效，本仓库保留：

- `package.json` 的 `repository` / `homepage` / `bugs` 指向原作者仓库
- README 的徽章、署名段落、赞助与广告位信息保持原样
- `LICENSE` 保留原作者版权行

改动这些等于抹去来源。本仓库只维护代码，不主张原作者身份。

---

## 七、上游最后被合并的提交

最后一个合并进来的上游提交是 `ec69166`（2026-10-19，`docs: README 默认中文，停更说明与广告位`），
它带来了 #89–#92 四个 0.2.0 注入修复补丁。

此后的上游提交（`52e8c68`、`43a9a4a`、`8df4406`）**未合并**，因为它们引入了商业许可。
