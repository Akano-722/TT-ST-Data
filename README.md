# st-sync-relay 中转服务

酒馆云同步（ST Sync）的中转侧。

它是一个**通用文件桶**：磁盘布局就是 `<DATA_DIR>/<命名空间>/<桶>/<文件>`，外加命名空间隔离和
Bearer 令牌鉴权。它**不认识"酒馆备份"这个概念**——manifests、设备标识、快照保留策略那些语义
全在扩展侧（`../extension/st-sync/`）。所以你以后想拿它存别的东西（配置、图包、脚本），
新开一个桶就行，不用动这个服务。

完整的两端同步流程见仓库根目录的 [README](../README.md)，这里只讲服务本身。

## 本地跑起来

```bash
npm install
cp .env.example .env     # 至少把 ADMIN_TOKEN 换成随机串
npm start                # 默认监听 :8080，数据落在 ./data
```

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

1. 新建服务选仓库。**本仓库是 monorepo，Root Directory 必须设成 `relay`**，
   Zeabur 才会用这里的 `Dockerfile` 构建。
2. **挂持久卷**：服务页 → Volumes → 挂载目录填 `/data`（和 `DATA_DIR` 一致）。
   ⚠️ 不做这步，容器一重启所有备份全没。挂载时该目录会被清空，首次部署无所谓。
3. 配环境变量：`ADMIN_TOKEN`、`DATA_DIR=/data`、`BOOTSTRAP_NAMESPACE=A`。
4. 部署完成看**日志**：首次启动会打印命名空间 `A` 的访问令牌。
   **只打印这一次**，立刻复制保存。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，无需令牌 |
| GET | `/v1/meta` | 返回当前令牌对应的命名空间 |
| PUT | `/v1/ns/:ns/:bucket/*key` | 上传，返回 `size` / `mtime` / `sha256` |
| GET | `/v1/ns/:ns/:bucket/*key` | 下载 |
| GET | `/v1/ns/:ns/:bucket` | 列出文件与总用量 |
| DELETE | `/v1/ns/:ns/:bucket/*key` | 删除 |
| GET | `/admin/namespaces` | 列出命名空间（管理员令牌） |
| POST | `/admin/namespace` | 创建命名空间，返回令牌（管理员令牌） |
| POST | `/admin/invite` | 签发邀请码（管理员令牌 + `ENABLE_INVITES=true`） |
| POST | `/v1/invite/redeem` | 用邀请码换令牌 |

根路径 `/` 会返回这份清单和当前版本号，方便部署完确认服务活着。

## 运维注意

- **令牌只以 sha256 落盘**，明文仅在签发那一刻返回一次。丢了找不回，只能重建命名空间。
- **`auth.json` 是单点。** 所有令牌哈希和邀请码都在它里面，就在 `DATA_DIR` 下。
  持久卷丢了 = 所有设备都要重新配令牌。
- **写入是先写 `.tmp` 再 `rename`**，所以下游不会读到半截文件并把它当成一份完整备份。
- **跨域放开了 `Access-Control-Allow-Origin: *`**。扩展跑在酒馆页面的源上，访问中转必然跨域。
  这里安全的前提是**用 Bearer 令牌而不是 Cookie**——没有 Cookie，就不存在 CSRF 面。
  如果哪天改成 Cookie 鉴权，这一条必须跟着收紧。
- **路径逐段校验 + 落盘前二次确认**（`lib/paths.js`），挡住 `..` 穿越和 `%2F` 编码绕过。
- **配额只是统计，不做强制**。`GET /v1/ns/:ns/:bucket` 返回的 `usage` 是给上层显示用的，
  服务端不会因为超量拒绝写入。
