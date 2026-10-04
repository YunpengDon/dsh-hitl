# 发布到 npm：OIDC 分阶段发布（trusted publishing + staged publishing）

> 本文记录本仓库**实际跑通**的发布链路，以及配通过程中真实踩到的坑。
> 目标读者是维护者：半年后这条流水线挂了，照着这份文档能自己修好。
> 放这个文件不会增加 npm 包体积——`docs/` 已在 `package.json` 的 `files` 之外。

---

## 1. 最终形态（一句话）

**推一个 `v*` tag → GitHub Actions 自检并 `npm stage publish`（OIDC 认证，仓库里没有任何 npm token）→ 版本进入 npm 暂存区 → 维护者用 2FA 批准 → 公开。**

```sh
npm version patch            # 0.1.2 → 0.1.3
git push && git push --tags  # 工作流自动暂存
npm stage list               # 拿到 stage-id
npm stage approve <stage-id> # 输入 2FA，公开
```

设计上的取舍：**工作流被篡改也只能"上传"，不能"发布"**。发布这个动作永远需要一个人 + 2FA。

---

## 2. 两个概念先分清

| | 传统做法 | 本仓库做法 |
|---|---|---|
| **认证** | 存一个 `NPM_TOKEN` secret，长期有效、需轮换、可能泄漏 | **OIDC trusted publishing**：CI 用 GitHub 签发的短期身份向 npm 换取一次性凭证；仓库里**没有**任何 npm 密钥 |
| **发布** | `npm publish` 直接公开 | **`npm stage publish`**：进暂存区，等维护者 2FA 批准才公开 |
| **provenance** | 需自行加 `--provenance` | OIDC 发布时**自动**签名并写入 sigstore 透明日志（npm ≥ 11.5.1） |

两者独立，可以只用其中一个；本仓库两个都用。

---

## 3. 一次性配置清单

### npm 侧（npmjs.com → 包 → Settings → Trusted Publisher）

| 字段 | 值 |
|---|---|
| Organization / User | `YunpengDon` |
| Repository | `dsh-hitl` |
| **Workflow filename** | **`release.yml`**（只写文件名，不带 `.github/workflows/`；写错 → 401/404） |
| Environment | 留空 |
| **Allowed actions** | **两个勾都不选**。`npm stage publish` 永远允许；勾 "publish directly" 会给工作流直接发布的权力，勾 "manage dist-tags" 会给改 dist-tag 的权力——我们都不需要 |

> 2026-09-03 之后新建的 trusted publisher **默认只允许 `npm stage publish`**，所以"两个都不勾"就是分阶段发布。

### GitHub 侧

**什么都不用配**（没有 secret）。工作流只需要 `permissions: id-token: write`。

---

## 4. 工作流在做什么（`.github/workflows/release.yml`）

1. `actions/checkout@v6` + `actions/setup-node@v6`（Node 24）——**不要**写 `registry-url`，原因见坑 #1。
2. `npm install --global npm@^11.21.0`：钉住 CLI 版本，保证 `npm stage` 一定存在（见坑 #2）。
3. tag ↔ `package.json` 版本校验：`v0.1.3` 必须等于 `version: 0.1.3`，否则 `::error::` 退出。
4. `npm run check`：153 个用例，红了就不发布。
5. `npm stage publish`：暂存。`workflow_dispatch` 也保留，用于**手动重跑而不用重新打 tag**。

---

## 5. 踩过的坑（按"如果再来一次我会怎么避"排序）

### 坑 #1（最坑）：`setup-node` 的 `registry-url` 会用空 token 抢先认证 → `E401`

**症状**：前面步骤全绿，`npm stage publish` 报
```
npm error code E401
npm error Unable to authenticate, your authentication token seems to be invalid.
```
而 runner 日志上一行明明是 `npm notice Staging to https://registry.npmjs.org/ with tag latest`——**说明 OIDC 与 trusted publisher 都正常，是认证方式被截胡了**。

**原因**：`registry-url` 会往 `.npmrc` 写一行
```
//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
```
我们没有 `NODE_AUTH_TOKEN` 这个 secret，于是 npm 拿着**空 token** 去认证并且在 OIDC 之前就失败了。

**修法**：删掉 `registry-url`（默认 registry 本来就是 `registry.npmjs.org`，`npm stage publish` 的日志也会把它打印出来）。**配了 trusted publishing 就不要配 `registry-url`。**

**诊断套路**：先看日志里有没有 `Staging to …` / `Publishing to …`。
- **有** → 命令、权限、trusted publisher 都对，问题在认证方式（先怀疑 `.npmrc` / token / OIDC 权限）。
- **没有** → 命令没跑到，问题在 CLI 版本、权限声明或 trusted publisher 字段不匹配。

### 坑 #2：`npm stage` 是**目录**不是单文件，别用"文件存在与否"判断版本

我最初用 `.../lib/commands/stage.js` 探测某个 npm 版本是否支持暂存发布，得到 404，差点误判"11.x 不支持、必须 12"。实际结构是：

```
lib/commands/stage/{index,publish,list,view,download,approve,reject}.js
```

**结论**：npm **11.21.0** 与 **12.2.0** 都带这套命令（逐版本查过文件清单）。工作流因此钉 `npm@^11.21.0`。
**教训**：判断某个 npm 版本有没有一条命令，去看它在 registry 上的**完整文件清单**（`https://unpkg.com/npm@<version>/?meta`），不要猜路径。

### 坑 #3：actions 版本对齐官方示例

npm 官方 trusted-publishing 文档的示例用的是 `actions/checkout@v6` / `actions/setup-node@v6`。我一开始写 v4（也能跑，但没必要落在后面）。照官方示例抄，并且 release 构建**关缓存**（`package-manager-cache: false`）。

### 坑 #4：`package.json` 里的 `private: true` 会让暂存发布直接失败

`npm stage publish` 与 `npm publish` 行为一致，会尊重 `"private": true` 并拒绝。**发布前必须去掉**（本仓库是在 0.1.0 → 0.1.1 之间去掉的）。

### 坑 #5：暂存版本与已发布版本**共用同一个 semver 唯一索引**

- 同一个版本不能既暂存又发布；失败重试时**不要**为了"重来一次"改版本号。
- 想重跑：用 `workflow_dispatch` 手动触发（不重新打 tag），或者 `npm stage reject <stage-id>` 后重试。
- 反过来也成立：你可以在有暂存版本挂着的时候正常发布别的版本。

### 坑 #6：批准这一步**一定**需要 2FA，这是设计目的

`npm stage publish` 不要求 2FA（任何 token 类型都行），`npm stage approve` 要求 2FA（会提示输入）。
命令族：

```sh
npm stage list                  # 列出暂存版本与 stage-id
npm stage view <stage-id>       # 看详情
npm stage download <stage-id>   # 下载 tarball 先检查
npm stage approve <stage-id>    # 批准（要 2FA）→ 公开
npm stage reject <stage-id>     # 驳回
```

也可以在 npmjs.com 的包页面上批准。

### 坑 #7：`unpublish` 不能"删了重发同一个版本"

npm 明文规定：**同一个 name + version 一旦被 unpublish，就永久不可复用**；要重发必须换新版本号（整个包 unpublish 另有 24 小时冷却）。
所以"包发大了想删掉重发 0.1.0"这条路是死的——**只能发新版本**（本仓库就是这样从 0.1.0 的 1.2 MB 走到 0.1.2 的 94.5 kB）。

### 坑 #8（流程类，不是 npm 的锅）：`git add -A` 会把别人的未提交改动卷进你的提交

真实事故：我提交 landing page 文档时用了 `git add -A`，把维护者**尚未写完 message** 的 `index.js` / `lib/resolve.js` / `tests/resolve.test.js` 一起提交并推送了。

**补救**（内容一个字节不变，只改提交边界）：
```sh
git reset --soft HEAD~1                       # 退回暂存，工作树不动
git restore --staged <属于对方的那几个文件>
git commit -F <我的 message>
git add <对方的那几个文件> && git commit -F <他的 message>
git push --force-with-lease                   # 只重写 tip、且确认远端没被别人动过
```
**校验**：前后 `git rev-parse HEAD^{tree}` 必须相同（本地、远端各查一次），证明"只改了提交边界"。
**预防**：提交前先 `git status`，并且**只用显式路径** `git add <file>`，不要 `git add -A`。

### 坑 #9：本机没装 `gh`，以及 GitHub 主站偶发连不上

- 没有 `gh` 也能干活：建仓/发布 Release/查 Actions 都能走 REST API，认证用 keychain 里已有的凭据
  （`printf "protocol=https\nhost=github.com\n\n" | git credential fill`，**不要把 token 打到屏幕上**）。
- `github.com:443` 偶发超时（`api.github.com` 与 `registry.npmjs.org` 同时正常）时，用 **SSH over 443** 推送：
  ```sh
  git remote add ssh ssh://git@ssh.github.com:443/<owner>/<repo>.git
  git push ssh main        # 或 git push --force-with-lease ssh main
  ```

---

## 6. 排错表

| 症状 | 多半是什么 | 怎么办 |
|---|---|---|
| `E401 Unable to authenticate`，但日志里有 `Staging to …` | `.npmrc` 里的空 `NODE_AUTH_TOKEN` 抢在 OIDC 前认证（坑 #1） | 删掉工作流里的 `registry-url` |
| `E401`/`404`，且日志里**没有** `Staging to …` | trusted publisher 没配 / 字段不匹配（尤其 workflow filename） | 按 §3 逐字核对 |
| `npm error This package has been marked as private` | `package.json` 的 `private: true` | 去掉该字段（坑 #4） |
| `npm error You cannot publish over the previously published versions` | 版本号已存在（含**暂存**的） | 换新版本号；重试请用 `workflow_dispatch`（坑 #5） |
| `npm error Unknown command: "stage"` | runner 上的 npm 太旧 | 保留 `npm install --global npm@^11.21.0` 这一步（坑 #2） |
| tag 推送了但工作流没跑 | tag 与 `package.json` 版本不一致（第 3 步会退出） | 对齐版本号，或手动 `workflow_dispatch` |
| `npm view dsh-hitl version` 还是旧版 | 版本还在**暂存区**没批准 | `npm stage list` → `npm stage approve <id>`（要 2FA） |
| 批准后立刻查看还是旧版 | registry/CDN 缓存延迟 | 等一两分钟；或带 `--prefer-online` 查 |
| 推送 `fatal: unable to access … Failed to connect to github.com port 443` | 主站被挡/抖动 | 走 `git push ssh …`（坑 #9） |

---

## 7. 日常发布 checklist

```sh
cd dsh-hitl
npm run check                                   # 153 个用例必须全绿
git status --short                              # 确认只有本次该动的文件（坑 #8）
npm version patch                               # 或 minor/major；会顺手打 tag
git push && git push --tags                     # 触发工作流
# 等 Actions 绿 → 然后：
npm stage list && npm stage approve <stage-id>  # 输入 2FA
npm view dsh-hitl version --registry https://registry.npmjs.org
```

验收到位的话，`npm view dsh-hitl dist.unpackedSize` 应该与本地 `npm pack --dry-run` 的解包体积一致（当前 ~314 kB）。

---

## 8. 参考

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)（Allowed actions 的三种取值、四字段配置、官方工作流示例）
- [Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing)（暂存语义、2FA 边界）
- [npm stage CLI](https://docs.npmjs.com/cli/v12/commands/npm-stage/)（与 `npm@11.21.0` 自带的 `man/man1/npm-stage.1` 一致）
- [npm Unpublish Policy](https://docs.npmjs.com/policies/unpublish)（同名+版本永久不可复用）
- [npm trusted publishing with OIDC is generally available](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)（自动 provenance、CLI ≥ 11.5.1）
