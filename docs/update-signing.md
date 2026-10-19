# 更新验签：原理、落地与密钥轮换

> 对应代码：`lib/release-signature.js`（验签）、`lib/update.js`（下载链路）、
> `scripts/generate-signing-key.mjs`（生成密钥）、`scripts/sign-release.mjs`（签名）、
> `.github/workflows/release.yml`（发布时签名）

---

## 一、为什么需要验签

`overlayFromZip()` 会下载一个 zip，然后 `rm -rf` 覆盖正在运行的插件目录，下次启动即执行新代码。在加验签之前，唯一的完整性保证是 TLS。以下任一情况都能让攻击者代码以用户权限落地：

- GitHub 仓库或账号被攻陷；
- 企业代理 / 恶意 CA 终止 TLS；
- `HTTPS_PROXY` 指向不可信节点。

**为什么不能用 checksum**：从同一个源拿到的校验和只能防传输损坏，防不了刻意替换 —— 攻击者既然能改 payload，也能改 checksum。必须用**安装副本已经信任的公钥**验签。

---

## 二、一个必须先讲清的技术前提

当前的下载源是 GitHub 的**自动 archive**：

```
https://codeload.github.com/YuJunZhiXue/dsh-purge/zip/refs/heads/master
https://codeload.github.com/YuJunZhiXue/dsh-purge/zip/refs/tags/v1.1.72
```

GitHub 官方说明：自动生成的 archive 其校验和**会随时间变化**（内部打包实现调整），因此**无法预先签名**。

所以验签不是「给现有下载源加几行代码」，而是**必须换成自己控制的固定产物**。好在 `release.yml` 本来就在 `git archive` 打包并上传 `dsh-purge-${version}.zip` 到 Release —— 产物已经有了，只是更新代码没用它。

本次改动：

| 通道 | 下载源 | 验签 |
| --- | --- | --- |
| tag 发布版（`v1.1.72`） | `releases/download/v1.1.72/dsh-purge-1.1.72.zip` | **强制** |
| 分支 / commit（`master`、`abc123…`） | `codeload.github.com/.../zip/...` | 可选，未签名则标记 `unverified` |

---

## 三、分级策略

| 场景 | 行为 |
| --- | --- |
| tag 版，签名有效 | 安装，`verification.verified = true` |
| tag 版，**无**签名 | **拒绝安装**，提示该通道要求签名 |
| tag 版，签名无效 | **拒绝安装**（比无签名更可疑） |
| 分支版，无签名 | 允许安装，标记 `verified: false`，status/UI 显示「未验签（开发通道）」 |
| 分支版，**签名存在但无效** | **拒绝安装**（签名不对说明被篡改或版本被换） |
| 目标版本 < 当前版本 | **拒绝**（防降级攻击） |

「签名无效」在任何通道都致命，因为那意味着字节被改过或版本被替换；「没有签名」在开发通道是可接受的，只是要如实告知。

---

## 四、签名载荷设计

签名覆盖的不是裸 zip，而是：

```
"dsh-purge-release-v1\n" || uint32be(len(version)) || version || zipBytes
```

**为什么把版本号放进签名载荷**：单纯的签名只证明「字节是真的」，不能证明「不是旧的」。把版本纳入载荷后，攻击者无法拿一个签名有效的旧版本重放（降级攻击）。`checkRelease()` 还会额外比对 `runningVersion`，双保险。

---

## 五、密钥怎么生成（你问的「怎么更新」）

### 5.1 首次生成

在一台你信任的机器上：

```powershell
cd H:\coding\dsh-purge
node scripts/generate-signing-key.mjs
```

输出：

```
Generated Ed25519 signing key pair.

  private : ...\dsh-purge-signing.key
  public  : ...\dsh-purge-signing.key.pub
```

脚本会做一次自测（签名再验签），确保密钥对可用。

### 5.2 三个去处

**① 私钥 → GitHub Secrets**

```powershell
gh secret set RELEASE_SIGNING_KEY < dsh-purge-signing.key
```

**② 公钥 → 代码里**

把脚本打印的 `publicKey` 填进 `lib/release-signature.js` 的 `TRUSTED_KEYS`：

```js
export const TRUSTED_KEYS = [
  {
    id: "release-2026",
    publicKey: "MCowBQYDK2VwAyEA...",
  },
];
```

**③ 私钥离线备份，然后删掉本地文件**

```powershell
Remove-Item dsh-purge-signing.key
```

`dsh-purge-signing.key`、`*.pem`、`*.key` 已加入 `.gitignore`，不会误提交。

> **现在代码里是占位公钥（`id: "dev-placeholder"`, `publicKey: ""`）。** 在你填入真实公钥之前，tag 版更新会被拒绝并提示「没有可用的信任公钥」。这是刻意的 fail-closed：宁可装不上，也不装不可信的字节。

### 5.3 发布时自动签名

`release.yml` 新增一步，在打包上传后立刻签名：

```yaml
- name: Sign release archive
  env:
    RELEASE_SIGNING_KEY: ${{ secrets.RELEASE_SIGNING_KEY }}
  run: |
    node scripts/sign-release.mjs "$zip" "$version"
    gh release upload "$tag" "${zip}.sig" --clobber
```

如果 Secret 没配，这一步**直接失败**（不会悄悄发布未签名产物）。

---

## 六、密钥轮换（这是关键，不是事后补丁）

**公钥绝对不能只写一个然后原地替换** —— 老版本客户端只认老公钥，你换了公钥它就会拒绝所有新版本。

### 正确流程

```
1. 生成新密钥对 K2
2. 代码里 TRUSTED_KEYS = [K1, K2]   ← 两个都在，同时信任
3. 发一个版本（比如 1.1.73），用 K1 或 K2 签都行
4. 用户升级到 1.1.73 后，他们的客户端就同时信任 K1 和 K2
5. 确认绝大多数用户已过 1.1.73（看下载量/版本分布）
6. 之后某个版本才可以把 K1 从 TRUSTED_KEYS 移除
7. 私钥 K1 销毁
```

### 为什么不能一步到位

如果 1.1.73 直接只信任 K2，那么所有还在 1.1.72 的用户升级时会发现「签名对不上任何可信公钥」——**全体锁死**，只能手动重装。

### 应急吊销

如果私钥泄露：

1. 立刻生成 K2，发布一个用 K1 签名的版本（因为老客户端只认 K1），该版本内置 `TRUSTED_KEYS = [K1, K2]`；
2. 该版本发布后，再用 K2 签名后续版本；
3. 等用户升上来后移除 K1。

如果泄露时已经来不及走这个流程，只能在 README / Release notes 里公告，让用户手动重装。

---

## 七、验证

```powershell
cd H:\coding\dsh-purge
node test/release-signature.test.mjs
```

覆盖 16 项断言：

| 类别 | 断言 |
| --- | --- |
| 密钥环 | `hasTrustedKey` 与占位公钥行为 |
| 正常路径 | 有效签名通过、报告 key id |
| 篡改 | payload 被改拒绝、签名绑定版本、缺签名、长度错误、非 semver 版本 |
| 通道分级 | tag 强制、无签名拒绝、分支放行但标未验签、无效签名在开发通道也致命 |
| 降级保护 | 低版本拒绝、同版本允许重装 |
| 占位状态 | 空公钥无法验签 |

端到端手工验证（用临时密钥对）：

```powershell
# 1. 生成临时密钥（在临时目录，别在仓库里）
cd $env:TEMP
node H:\coding\dsh-purge\scripts\generate-signing-key.mjs

# 2. 造一个假产物并签名
"fake release" | Out-File test-rel.zip -Encoding ascii -NoNewline
$env:RELEASE_SIGNING_KEY="$env:TEMP\dsh-purge-signing.key"
node H:\coding\dsh-purge\scripts\sign-release.mjs test-rel.zip 1.1.72
```

实测输出：

```
signed   test-rel.zip
version  1.1.72
sha256   3488ede35e825afd07315ebef5cd7ca1f9b2f5ee36cd3769af9edb08011c6490
signature test-rel.zip.sig (64 bytes)
```

---

## 八、限制与未覆盖的部分

| 项 | 说明 |
| --- | --- |
| 分支通道无签名 | 技术上限，不是遗漏。已在 UI/status 明确标注 |
| 首次安装（npm / tarball） | 不走 `overlayFromZip`，仍依赖 npm registry 的完整性机制，本次未改 |
| 私钥保管 | 只能由你完成，我不能代生成生产密钥 |
| 时间戳 / 证书链 | 未引入。Ed25519 裸签名没有过期概念，靠版本号做降级保护 |
