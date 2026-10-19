# 本仓库的独立 git / gh 配置

本文件记录 `H:\coding\dsh-purge` 的仓库级配置，与全局配置**完全隔离**。
全局 `~/.gitconfig` 的身份是 `hzmhzau <zmhou@hotmail.com>`，本仓库不继承它。

## 1. git 仓库级配置（写在 `.git/config`，不进版本库）

参考另一台工作主机的 `~/.gitconfig`，按「仓库独立」落到 `--local` 作用域。

| 配置项 | 值 | 说明 |
| --- | --- | --- |
| `user.name` | `xlht4106` | 与 GitHub 账号一致 |
| `user.email` | `176675486+xlht4106@users.noreply.github.com` | GitHub 隐私邮箱 |
| `init.defaultBranch` | `main` | 新分支默认名 |
| `pull.rebase` | `false` | 合并式拉取 |
| `fetch.prune` | `true` | 拉取时清理已删除的远端分支 |
| `push.autoSetupRemote` | `true` | 首次推送自动建立上游 |
| `commit.verbose` | `true` | 提交时显示完整 diff |
| `merge.conflictstyle` | `zdiff3` | 冲突块带上共同祖先 |
| `rerere.enabled` / `rerere.autoupdate` | `true` | 复用已解过的冲突方案 |
| `diff.algorithm` | `histogram` | 更贴近人眼的 diff 切分 |
| `diff.colorMoved` | `zebra` | 移动代码着色 |
| `log.date` | `iso` | ISO 时间格式 |
| `branch.sort` | `-committerdate` | 分支按最近提交排序 |
| `tag.sort` | `version:refname` | 标签按版本号排序 |
| `checkout.defaultRemote` | `origin` | 同名分支优先跟 origin |
| `core.quotepath` | `false` | 中文路径不转义 |
| `help.autocorrect` | `10` | 命令打错 1 秒后自动纠正 |
| 别名 | `st` / `co` / `br` / `lg` / `last` | 同参考主机 |

编辑器一项**故意没有照搬**：参考主机是 Linux 的 `kate -b`，本机是 Windows 且没有 Kate，设了反而会让 `commit` 卡住。需要时用 `git commit -m` 或 `git -c core.editor=...` 临时指定。

凭据助手也改成仓库级，避免和全局 `manager` 抢：

```
credential.helper =                       # 先清空继承来的 manager
credential.helper = !GH_CONFIG_DIR=H:/coding/dsh-purge/.gh gh auth git-credential
```

## 2. gh 仓库级配置（`.gh/` 目录，已被忽略）

gh 没有官方的「仓库级配置文件」，但它认 `GH_CONFIG_DIR` 环境变量。因此本仓库的做法是：

- 配置目录：`H:\coding\dsh-purge\.gh`
  - `hosts.yml`：登录态（账号 `xlht4106`，HTTPS）
  - `config.yml`：gh 偏好
- token 本身由 gh 存进 Windows 凭据管理器，不在 `.gh` 里落明文。
- `.gh/` 通过 `.git/info/exclude` 排除，**不改动仓库的 `.gitignore`**，以免影响上游。

用法（当前 shell 生效）：

```powershell
$env:GH_CONFIG_DIR = "H:\coding\dsh-purge\.gh"
gh auth status
gh repo view xlht4106/dsh-purge
```

不设 `GH_CONFIG_DIR` 时 gh 回到默认目录（本机默认目录里没有任何登录态），所以仓库内外互不影响。

## 3. 远端

| 远端 | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `https://github.com/xlht4106/dsh-purge.git` | 自己的 fork，推送目标 |
| `upstream` | `https://github.com/YuJunZhiXue/dsh-purge.git` | 原作者仓库，只读对比 |

克隆方式（按用户要求走 `gh repo clone`）：

```powershell
$env:GH_CONFIG_DIR = "H:\coding\dsh-purge\.gh"
gh repo clone xlht4106/dsh-purge
```

`gh repo clone` 会自动把上游设为 `upstream` 远端，这也是 `upstream` 存在的原因。

## 4. 与参考主机配置的差异汇总

| 项 | 参考主机 | 本仓库 | 原因 |
| --- | --- | --- | --- |
| 作用域 | 全局 `~/.gitconfig` | 仓库级 `--local` | 用户要求「仓库独立」 |
| 编辑器 | `kate -b` | 不设置 | Windows 无 Kate |
| gh 配置 | 系统默认目录 + keyring | `GH_CONFIG_DIR` 指向仓库内 `.gh` | 仓库独立 |
| LFS | 全局启用 filter | 沿用系统级 LFS filter | 系统 `gitconfig` 已有，无需重复 |
| 凭据 | `/usr/bin/gh auth git-credential` | `gh auth git-credential` + 仓库级 GH_CONFIG_DIR | 平台差异 |

## 5. 校验

```powershell
cd H:\coding\dsh-purge
git config user.name                 # xlht4106
git config user.email                # 176675486+xlht4106@users.noreply.github.com
git config --get-all credential.helper
$env:GH_CONFIG_DIR = "H:\coding\dsh-purge\.gh"; gh auth status
cd C:\Users\Administrator; git config --global user.name   # hzmhzau，未被改动
```
