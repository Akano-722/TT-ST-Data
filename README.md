# st-sync-relay 中转服务

酒馆云同步（ST Sync）的中转侧。

它是一个**通用文件桶**：磁盘布局就是 `<DATA_DIR>/<命名空间>/<桶>/<文件>`，外加命名空间隔离和
Bearer 令牌鉴权。它**不认识"酒馆备份"这个概念**——manifests、设备标识、快照保留策略那些语义
全在扩展侧（`../extension/st-sync/`）。所以你以后想拿它存别的东西（配置、图包、脚本），
新开一个桶就行，不用动这个服务。

完整的两端同步流程见仓库根目录的 [README](../README.md)，这里只讲服务本身。

> **想用别的语言重写一份中转、或者让已有的存储兼容**（WebDAV / S3 / 自建 API）：
> 该实现哪些接口、哪些不用管、客户端的时间预算、踩过的坑，都在主仓库的
> `tools/relay-api.md` 里。那份是从**扩展侧**写的契约，比这份 README 更适合当兼容实现的清单。
> （这份 README 在 `relay` 分支上，那个文件不在本分支，所以没法给链接——
> 去主仓库的 `main` 分支看，或者直接在 GitHub 上搜文件名。）

## 本地跑起来

```bash
npm install

# ⚠️ 服务**不读** .env 文件（代码里没有加载它的逻辑），变量得写在命令前面。
# 仓库里的 .env.example 只是一份变量清单，照抄，别指望复制成 .env 就生效。
ADMIN_TOKEN=换成一个长随机串 npm start     # 默认监听 :8080，数据落在 ./data
```

要一次给多个变量就都写前面：`DATA_DIR=./data PORT=8080 ADMIN_TOKEN=xxx npm start`。
生成随机串的办法见下面「环境变量」一节。

冒烟测试会起一个真实实例，把接口、鉴权、命名空间隔离、路径穿越全打一遍：

```bash
npm test
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | 空 | 管理接口令牌。不设则 `/admin/*` 全部不可用 |
| `DATA_DIR` | `./data` | 数据落盘目录。**Zeabur 上必须挂持久卷到这个路径** |
| `PORT` | `8080` | 监听端口，Zeabur 会自动注入，别写死 |
| `ENABLE_INVITES` | `false` | 打开后才允许签发邀请码 |
| `BOOTSTRAP_NAMESPACE` | 空 | 首次启动自动创建这个命名空间（为了方便在平台上初始化） |
| `BOOTSTRAP_TOKEN` | 空 | 给引导命名空间指定固定令牌；留空则随机生成 |

生成一个够长的令牌：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 部署到 Zeabur

1. 新建服务选仓库。**分支填 `relay`，Root Directory 留空。**
   仓库是 monorepo，但 `relay` 分支是把本目录 `git subtree split` 出来的，
   **根目录就是服务本身**（`Dockerfile`、`package.json`、`server.js` 都在根上）。
   所以 Root Directory 再填 `relay` 反而会错——那样 Zeabur 会去找 `relay/relay/`，
   找不到就走自动识别，构建出来的东西不对。
2. **挂持久卷**：服务页 → Volumes → 挂载目录填 `/data`（和 `DATA_DIR` 一致）。
   ⚠️ 不做这步，容器一重启所有备份全没。挂载时该目录会被清空，首次部署无所谓。
3. 配环境变量：`ADMIN_TOKEN`、`DATA_DIR=/data`、`BOOTSTRAP_NAMESPACE=A`。
4. 部署完成看**日志**：首次启动会打印命名空间 `A` 的访问令牌。
   **只打印这一次**，立刻复制保存。

## 更新已部署的中转

Zeabur 拉的是 **`relay` 分支**，不是 `main`。所以在本目录改完代码后**光推 `main` 不会生效**，
必须重新切一次子树分支推上去：

```bash
# 在仓库根目录跑
git add relay
git commit -m "中转：xxx"

git branch -D relay
git subtree split --prefix=relay -b relay
git push origin relay
```

推完 Zeabur 会自动重新部署。**只改扩展（`extension/st-sync/`）就不用走这套**，
中转那边没变，不需要重新部署。

> 和扩展的 `extension` 分支同理：`git subtree split` 是确定性的，只要 `main` 的历史是只追加的，
> 推上去就是快进。如果 rebase / amend 过已推的 `main`，推 `relay` 就会变成非快进，得加 `--force`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，无需令牌 |
| GET | `/v1/meta` | 返回当前令牌对应的命名空间 |
| PUT | `/v1/ns/:ns/:bucket/*key` | 上传，返回 `size` / `mtime` / `sha256` |
| GET | `/v1/ns/:ns/:bucket/*key` | 下载 |
| GET | `/v1/ns/:ns/:bucket` | 列出文件与总用量 |
| DELETE | `/v1/ns/:ns/:bucket/*key` | 删除 |
| GET | `/admin` | **管理后台页面**，见下节 |
| GET | `/admin/namespaces` | 列出命名空间（管理员令牌） |
| POST | `/admin/namespace` | 创建命名空间，返回令牌（管理员令牌） |
| GET | `/admin/namespaces/:ns/buckets` | 列出某命名空间下的桶，含创建时间（管理员令牌） |
| GET | `/admin/namespaces/:ns/buckets/:bucket` | 列出桶内文件（管理员令牌） |
| GET | `/admin/namespaces/:ns/buckets/:bucket/files/*key` | 下载文件（管理员令牌） |
| POST | `/admin/invite` | 签发邀请码（管理员令牌 + `ENABLE_INVITES=true`） |
| POST | `/v1/invite/redeem` | 用邀请码换令牌 |

根路径 `/` 会返回这份清单和当前版本号，方便部署完确认服务活着。

## 管理后台

浏览器打开 `http://<你的中转地址>/admin`，填 `ADMIN_TOKEN`，然后：

**选命名空间 → 看桶 → 看文件 → 点 JSON 直接读内容，其余点「下载」。**

页面本身**不需要令牌**（它就是一张静态 HTML，数据全靠接口现拿），令牌只在你点「连接」之后
由页面带着去请求接口，存在这台浏览器的 `localStorage` 里。点「忘记令牌」可以清掉。

几个说明：

- **这是只读页面。** 不能删文件、不能建桶——删除不可逆，不做。
- **桶的「新增时间」是推算的。** 磁盘上没有"创建桶"这个动作，第一次写入时目录才出现，
  没有任何地方记着创建时间。页面显示的是**桶内最早那个文件的 mtime**。桶被清空后这个值会变成 `—`。
- **它能看到所有人的数据。** `/admin/namespaces/:ns/...` 这几条接口按设计绕过了命名空间隔离——
  这是管理员该有的权限，但也意味着 `ADMIN_TOKEN` 等于全部数据的钥匙，别随便给人。
- 页面的核心用途之一是排查同步问题：直接打开 `tavern/devices/<设备>/latest.json`，
  看看某台设备最近一次上传到底写进去没有。

## 运维注意

- **令牌只以 sha256 落盘**，明文仅在签发那一刻返回一次。丢了找不回，只能重建命名空间。
  这里**没有"重置令牌"接口**（`POST /admin/namespace` 对已存在的命名空间回 409），
  所以换令牌的办法就是重新创建一次：停服务 → 删掉 `DATA_DIR/auth.json`（或只删掉
  `namespaces` 里那个键）→ 带着 `BOOTSTRAP_NAMESPACE` 重启，会重新建命名空间并重新打印令牌。
  **`DATA_DIR` 下的备份数据不受影响**，但**所有命名空间的令牌都作废了**，每台设备都要重填。
- **`auth.json` 是单点。** 所有令牌哈希和邀请码都在它里面，就在 `DATA_DIR` 下。
  持久卷丢了 = 所有设备都要重新配令牌。**建议把 `DATA_DIR` 定期备份一份**。
- **磁盘占用 = 保留快照数 × 单包大小 × 设备数**（扩展默认每台设备留 5 份完整备份）。
  两份 100 MB 的备份就是 1 GB 级别。**盘写满的表现是上传失败**，日志里不一定直说，
  所以小盘机器（20–40 GB 的 VPS 很常见）要留意这个目录。
- **不为写入做配额强制**（见下面最后一条），所以磁盘写满时不会提前拒绝，而是写一半失败。
- **写入是先写 `.tmp` 再 `rename`**，所以下游不会读到半截文件并把它当成一份完整备份。
- **别给响应加缓存头。** 现在这些接口**刻意**不回 `Cache-Control` / `ETag` / `Last-Modified`
  （只回一个自造的 `X-Mtime`），因为扩展读 `latest.json` 时不做任何缓存控制，
  一旦浏览器把这些响应缓存住，扩展就会一直读到旧的那份 `latest.json`、
  表现为"A 推了备份但 B 说云端没更新"这种极难排查的静默失效。
  想改就往 `no-store` 方向改，别往 `max-age` 方向改。
- **跨域放开了 `Access-Control-Allow-Origin: *`**。扩展跑在酒馆页面的源上，访问中转必然跨域。
  这里安全的前提是**用 Bearer 令牌而不是 Cookie**——没有 Cookie，就不存在 CSRF 面。
  如果哪天改成 Cookie 鉴权，这一条必须跟着收紧。
- **路径逐段校验 + 落盘前二次确认**（`lib/paths.js`），挡住 `..` 穿越和 `%2F` 编码绕过。
- **没做限流，也没做失败锁定。** 挡爆破完全靠令牌长度：默认
  `crypto.randomBytes(32)`（256 位），实际不可爆破；比较走 `lib/auth.js` 的
  `timingSafeEqualStr`（定长比较，长度不同会提前返回 —— 那只是泄漏"长度"，而长度是固定的，
  不算有效信息）。所以风险不在"被猜出来"，而在**令牌泄漏**：泄漏之后服务端**没有任何补救层**，
  只能删 `auth.json` 重建命名空间。
- **配额只是统计，不做强制**。`GET /v1/ns/:ns/:bucket` 返回的 `usage` 是给上层显示用的，
  服务端不会因为超量拒绝写入。因此**任何有效令牌都能一直写直到把磁盘写满**，
  而盘满之后**整个服务一起不可用**（别的命名空间、别人的设备一起挂）。
  也就是说"给别人开命名空间"本质上是**信任对方**。要兜底就在反代层挂
  `limit_req` / `limit_conn`，或者自己加一个每命名空间的 `usage` 上限（列表接口已经算了
  `usage`，拿它判断即可）。
