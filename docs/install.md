# 安装 dsh-purge

适用：本机 DeepSeek Harness **桌面端 0.2.1-rc.2**（Windows）。

---

## 先看清一件事：npm 上没有这个包

README 里写的

```sh
dsh plugin --profile desktop add dsh-purge
```

**用不了**。`dsh-purge` 从未发布到 npm，执行会报 `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST` 或 404。

只能用**本地目录**或 **Git 地址**安装。下面两种方式选一个。

---

## 准备工作

确认这几项：

```powershell
# dsh 在不在 PATH
Get-Command dsh | Select-Object Source
# 期望：C:\Users\Administrator\AppData\Roaming\npm\dsh.ps1

# 桌面端版本
(Get-Content "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\package.json" | ConvertFrom-Json).version
# 期望：0.2.1-rc.2（插件支持 >=0.2.0-rc.2 <0.3.0）

# profile 在不在
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object Name
# 期望：看到 desktop（和/或 web）
```

---

## 方式 A：本地仓库 + junction（开发推荐）

适合你正在改代码的情况：改完即时生效，不用重装。

### A1. 先备份 profile 配置

**不要跳过这步。** 后面要手改这个 JSON，格式错一个逗号插件就加载不了。

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
Copy-Item $p "$p.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-*"
```

### A2. 建 plugins 目录，用 junction 指向仓库

junction 是目录链接，不是复制。仓库改了，插件立刻看到新代码。

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\plugins" | Out-Null
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\plugins\dsh-purge" `
  -Target "H:\coding\dsh-purge"
```

验证：

```powershell
Get-Item "$env:USERPROFILE\.dsh\plugins\dsh-purge" | Select-Object LinkType,Target
# 期望：LinkType=Junction，Target=H:\coding\dsh-purge
```

> 已有同名目录时先删掉：`Remove-Item "$env:USERPROFILE\.dsh\plugins\dsh-purge" -Recurse -Force`
> （确认那是旧副本再删）

### A3. 改 profile 的 package.json

只加两处：`dependencies` 一项、`bundles` 末尾一项。

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$j = Get-Content $p -Raw | ConvertFrom-Json

# 1) 依赖
$j.dependencies | Add-Member -NotePropertyName "dsh-purge" `
  -NotePropertyValue "file:../../plugins/dsh-purge" -Force

# 2) bundle 列表（已有就不重复加）
if ($j.dsh.profile.bundles -notcontains "dsh-purge") {
    $j.dsh.profile.bundles += "dsh-purge"
}

$j | ConvertTo-Json -Depth 20 | Set-Content $p -Encoding utf8
```

**改完必须检查 JSON 合法性**，否则下次启动直接失败：

```powershell
try { Get-Content $p -Raw | ConvertFrom-Json | Out-Null; "JSON OK" } catch { "JSON 坏了，用备份还原: $($_.Exception.Message)" }
```

看一眼结果：

```powershell
$j = Get-Content $p -Raw | ConvertFrom-Json
$j.dependencies | Select-Object dsh-purge
$j.dsh.profile.bundles
```

### A4. 装依赖

**必须在 profile 目录里跑**，不要在仓库根或 `$DSH_HOME` 根：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

成功标志：

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-purge\package.json"
# 期望：True
```

`pnpm` 找不到时，用 dsh 自带的：

```powershell
$pnpm = "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
node $pnpm install
```

---

## 方式 B：从 GitHub 安装（当作正式插件用）

拉的是已推送的 `master`。**改代码后要重新 pull 才会更新**。

```powershell
dsh plugin --profile desktop add "https://github.com/xlht4106/dsh-purge.git"
```

这条命令会自己处理依赖与 bundle 注册，不用手改 JSON。

如果 Git 方式失败（网络/凭据），退回方式 A，把 junction 目标换成手工 clone 的目录：

```powershell
git clone https://github.com/xlht4106/dsh-purge.git "$env:USERPROFILE\.dsh\plugins\dsh-purge"
```

然后继续 A3、A4。

---

## 装完必须做的三步

**只装不改宿主 = 完全没效果。** 插件不会自动改 `@deepseek-ai`。

### 第 1 步：完全退出桌面端

托盘图标右键 → 退出。**不是关窗口**，关窗口进程还在。

确认进程没了：

```powershell
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue
# 期望：无输出
```

### 第 2 步：重新打开桌面端

等它加载完。

### 第 3 步：点「应用」

1. 找会话标题旁的 **dsh-purge** 按钮
2. 点开 → **清洗** 页
3. 点 **「应用」**

成功会自动重启一次。补丁没打完不会重启（这是保护，不是故障）。

---

## 装好之后怎么确认

### 界面

| 位置 | 应该看到 |
| --- | --- |
| 会话标题旁 | `dsh-purge` 按钮 |
| 右侧栏 | **dsh-purge** 页签，内含「清洗」与「演练台」 |
| 清洗页顶部 | **本会话注入** 开关 + 一次性升级横幅 |

### 命令行

```powershell
dsh-purge --status
```

关键行：

```
  补丁 82/86 已清洗, 4 待清洗          <- 数字非 0 就说明装上了
  会话注入       默认关闭；已记录 N 个会话
  发布源         xlht4106/dsh-purge
  更新验签       已配置公钥
```

### 会话内

```
/purge status
```

能打出 `DSH_HOME` 和补丁列表，路径应该是你正在用的那一份。

---

## 重要：注入默认是关闭的

这是 1.1.74 起的行为变更。装好后**所有会话都不会自动注入**，需要手动开：

```powershell
# 找到当前会话 id（面板里会显示前 12 位）
dsh-purge --session-inject status

# 开启某个会话
dsh-purge --session-inject on <sessionId>

# 或者直接在面板「本会话注入」里点「启用」
```

开启后**下一轮对话**生效，不用重启。

---

## 出问题时

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 没有 dsh-purge 按钮 | profile 改错 / 没重启 | 检查 A3 的 JSON，确认 `bundles` 里有 `dsh-purge`，然后完全退出重启 |
| `failed to import` | profile 的 `inject` 写了 `pluginPackages` | 删掉那一项，只留 `systemPrompt` + `tools` |
| `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST` | 用了 npm 包名 | 改用方式 A 或 Git 地址 |
| 应用后没重启 | 有补丁没打上 | `dsh-purge --status` 看哪条是 `pending` / `stale` |
| `unknown prompt variable "{{cwd}}"` | 插件版本低于 1.1.73 | 升到 1.1.73+ |
| 每轮对话崩 | 同上 | 同上 |

### 还原 profile 配置

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$bak = Get-ChildItem "$p.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $bak.FullName $p -Force
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

### 卸载插件

面板里 **dsh-purge** → **清洗** → **卸载**（会先还原补丁再删插件）。

或者命令行：

```powershell
dsh-purge --uninstall
```

---

## 两个 profile 都要装吗

- **只用桌面端** → 只装 `desktop`
- **也用 `dsh web`** → 再对 `web` 做一遍，命令里的 `desktop` 换成 `web`

两边**分开安装、分开应用**。Web 的包装不进桌面端，反之亦然。

---

## 版本说明

| 插件版本 | 对应宿主 |
| --- | --- |
| **1.1.73+** | dsh 0.2.1-rc.2（推荐） |
| 1.1.40 ~ 1.1.72 | dsh 0.2.0-rc.2 |
| 1.1.39 及更早 | dsh 0.1.7 |

1.1.72 及更早在 0.2.1 上会遇到「每轮对话崩溃」和「应用后不重启」两个问题。
