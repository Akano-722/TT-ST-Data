# 酒馆云同步（ST Sync）

让**本地 TT 酒馆**和**自建云酒馆**的数据互通：本地定时或手动把备份推到中转服务，云端打开页面时自动发现并拉取最新备份。

设计上刻意**不碰任何酒馆后端代码**——两端都只装一个前端扩展，中转服务是独立的。

```
本地 TT 酒馆                     中转服务（可部署在 Zeabur）              云酒馆
┌────────────────┐              ┌──────────────────────┐            ┌────────────────┐
│ 前端扩展        │   PUT/GET    │  /v1/ns/{命名空间}/   │  GET/PUT   │ 前端扩展        │
│ 打包 → 上传     │ ───────────▶ │   {桶}/{文件}         │ ◀───────── │ 打开页面 → 拉取 │
└────────────────┘              │  命名空间隔离 + 令牌   │            └────────────────┘
                                └──────────────────────┘
```

数据流方向永远是「往外连」，所以两端都不需要公网 IP 或开放入站端口。

## 目录结构

| 路径 | 说明 |
|---|---|
| `relay/` | 中转服务（Node.js），部署到你的服务器 |
| `extension/st-sync/` | 酒馆前端扩展，两端各装一份 |
| `tools/probe-st-backup.md` | **上线前必跑**：探测你酒馆的真实备份接口 |
| `tools/probe-backup-contents.md` | **上线前建议跑**：确认备份包里到底有没有密钥 |

## 快速开始

### 1. 确认酒馆的备份接口

SillyTavern 的备份/恢复接口在不同版本间改过，猜错会表现为"上传成功但恢复没反应"这种难查的问题。

**已在 SillyTavern 1.18.0（官方镜像）上实测确认，扩展里已填好，通常不用再动：**

| 用途 | 接口 |
|---|---|
| 下载备份 | `POST /api/users/backup` |
| 恢复备份 | `POST /api/backups/restore` |

> 注意：两个接口**前缀不一样**——下载在 `/api/users/` 下，恢复在 `/api/backups/` 下。历史上 `POST /api/backups/download` 这个路径在 1.18.0 返回 404，别用。

换版本后如果失效，用 `tools/probe-st-backup.md` 重新探测一次，改 `extension/st-sync/index.js` 顶部的 `ST_API` 即可。

### 2. 部署中转服务

#### 2.1 推到你的 Git 仓库

Zeabur 是从 Git 仓库拉代码部署的，所以先得有个远程仓库。用它**明确支持的 GitHub**（GitLab 也行）
建一个**空仓库**——别勾「初始化 README」「添加 .gitignore」，那些会和仓库里已有的东西打架。然后在项目根目录：

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

#### 2.2 本地先跑通（可选，但建议）

```bash
cd relay
npm install
cp .env.example .env      # 至少把 ADMIN_TOKEN 换掉
npm start
```

```bash
npm test                  # 26 项冒烟测试：接口、鉴权、命名空间隔离、路径穿越全打一遍
```

#### 2.3 部署到 Zeabur

1. 新建服务，选刚推上去的仓库。**Root Directory 必须填 `relay`** —— 这是 monorepo，
   仓库根没有 `package.json`。不填的话 Zeabur 会在仓库根找 Dockerfile，找不到就走进自动识别，
   结果不对（比如当成纯 Node 项目跑 `npm start`，然后构建失败）。
2. **挂持久卷**：服务页 → Volumes → 挂载目录填 `/data`。
   ⚠️ 不做这步的话，容器一重启所有备份都没了。挂载时该目录会被清空，首次部署无所谓。
3. 配环境变量，`DATA_DIR=/data`、`BOOTSTRAP_NAMESPACE=A` 这两个是必须的，其余看下表。
4. 部署完成后看**日志**，第一次启动会打印命名空间 `A` 的访问令牌。**只打印这一次**，立刻复制保存。

#### 2.4 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `./data` | 数据落盘目录。**Zeabur 上必须填 `/data`**，和挂载的卷对上 |
| `PORT` | `8080` | 监听端口，Zeabur 自动注入，别写死 |
| `BOOTSTRAP_NAMESPACE` | 空 | 首次启动自动创建这个命名空间，并把令牌打进日志。平台上不方便开 shell，靠它初始化 |
| `ADMIN_TOKEN` | 空 | 管理令牌，**你自己编的**，见 2.5 |
| `ENABLE_INVITES` | `false` | 想给朋友开命名空间才需要打开 |
| `BOOTSTRAP_TOKEN` | 空 | 想固定引导命名空间的令牌就填这里，留空则每次随机生成 |

> 生成随机串：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

#### 2.5 `ADMIN_TOKEN` 是什么？它和「访问令牌」不是一回事

这个项目里有**两个都叫"令牌"但完全不同**的东西，这是最容易填错的地方：

|  | `ADMIN_TOKEN` | 访问令牌 |
|---|---|---|
| 谁生成 | **你自己编一个长随机串**，填进服务端环境变量 | **中转服务生成**，首次启动打进日志，只显示一次 |
| 存在哪 | 服务端环境变量，不落盘、谁都不发 | 服务端只存 sha256，明文丢了找不回 |
| 给谁用 | 只有**你**，用来调 `/admin/*` 管理接口 | 填进两台酒馆扩展的「访问令牌」输入框 |
| 能干吗 | 建命名空间、签发邀请码 | 在自己那个命名空间里读写文件 |
| 不设会怎样 | 服务照常跑、扩展照常用，只是 `/admin/*` 返回 500 | 扩展连不上中转，必须填 |

**只做两台设备自己同步的话，`ADMIN_TOKEN` 可以完全不设** —— `BOOTSTRAP_NAMESPACE=A`
已经在首次启动时替你把命名空间建好、把令牌打出来了。需要它只有两种情况：想再建一个命名空间，
或者要签发邀请码给别人用（见下面「给朋友用」）。

⚠️ `ADMIN_TOKEN` 从头到尾**不会出现在酒馆扩展里**。扩展那个「访问令牌」框里填的是上面那张表右列的
**访问令牌**，填错了会直接连不上。

### 3. 装扩展

**方式一：从 GitHub 装。** 酒馆的「扩展」面板 → **安装扩展**，填：

| 字段 | 填什么 |
|---|---|
| URL | `https://github.com/Akano-722/TT-ST-Data` |
| Branch or tag name | `extension` |

⚠️ **分支那一栏必须填 `extension`。** 这是 monorepo，默认分支的根目录没有 `manifest.json`
（扩展在 `extension/st-sync/` 子目录下），而酒馆是**在仓库根目录找 manifest** 的。
填错或留空的话，酒馆会把整个 clone 删掉并报 500，界面上只显示"安装失败"。

`extension` 分支是 `git subtree split` 从 `extension/st-sync/` 切出来的，根目录就是扩展本身。
每次改完扩展要**重新切一次并推上去**（见下面「发布扩展更新」）。

**方式二：手动拷贝。** 把 `extension/st-sync/` 整个文件夹放到两台酒馆的：

```
<SillyTavern>/public/scripts/extensions/third-party/st-sync/
```

然后在酒馆里刷新页面，在「扩展」面板找到**酒馆云同步**，填：

- 中转地址：你 Zeabur 服务的地址
- 访问令牌：上一步日志里的令牌
- **本机标识：一台选 `local`，另一台选 `cloud`（必须不同）**

点「测试连接」确认通了。

## 日常使用

| 按钮 | 作用 |
|---|---|
| 测试连接 | 确认地址、令牌、命名空间都对 |
| 上传到中转 | 把本机数据打包上传，**不动本机数据** |
| 从中转恢复 | 拉对方的最新备份**覆盖本机**，会提示刷新页面 |
| 智能同步 | 先判断两边谁改了，再决定拉还是推 |

自动行为：

- **打开页面时**（默认开）：先判断云端最新那份备份是"本机传的"还是"对面传的"——
  云端更新就拉下来，本机有改动就推上去，两边都动过则走冲突策略。
- **使用期间定时上传**（默认关，间隔 30 分钟）：**只传不拉**。
  刻意不在这里拉取，是因为恢复会整份替换数据并要求刷新页面，在你聊天中途这么干太扰民。

### 两个容易踩的点

**改动标记是落盘的。** iOS 上 App 随时会被系统杀掉，如果"本机有未上传改动"这个标记只存内存，
下次打开就会误判成本机没动过，然后拿对面的备份把你的改动盖掉。所以它写在 localStorage 里。

**设置也存在 localStorage，不在 `extension_settings` 里。** 因为 `extension_settings` 会被写进
`settings.json`，而 `settings.json` 正是备份内容的一部分——一旦恢复备份，本机的中转地址、令牌、
设备标识就会被对面的值覆盖，设备标识一乱整个同步就废了。这些是"每台设备各自的"配置，
不该跟着数据被同步过去。

## 关于冲突

这里的同步是**整份覆盖**，不是逐文件合并。所以「智能同步」的逻辑是：

| 本机改动 | 中转更新 | 行为 |
|---|---|---|
| 无 | 无 | 什么都不做 |
| 有 | 无 | 上传（推送本地） |
| 无 | 有 | 恢复（拉取中转） |
| **有** | **有** | **冲突**，按「冲突处理」设置：每次问你 / 用较新的覆盖 / 跳过 |

冲突时选"用较新的覆盖"，判断依据是本机首次改动的时间 vs 中转备份的 `createdAt`。

如果你在两边都改了同一段内容，无论选哪个都会丢掉一份。这是全量覆盖的固有代价——真要避免，只能别在两端同时编辑同一段对话。

## 中转服务 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/v1/meta` | 返回当前令牌对应的命名空间 |
| PUT | `/v1/ns/:ns/:bucket/*key` | 上传，返回 `size`/`mtime`/`sha256` |
| GET | `/v1/ns/:ns/:bucket/*key` | 下载 |
| GET | `/v1/ns/:ns/:bucket` | 列出文件与总用量 |
| DELETE | `/v1/ns/:ns/:bucket/*key` | 删除 |
| POST | `/admin/namespace` | 创建命名空间（需管理员令牌） |
| POST | `/admin/invite` | 签发邀请码（需 `ENABLE_INVITES=true`） |
| POST | `/v1/invite/redeem` | 用邀请码换令牌 |

它是**通用文件桶**，不认识"酒馆备份"这个概念——酒馆的 `manifest` 之类语义全在扩展侧。所以你以后想拿它存别的东西（配置、图包、脚本），直接开个新桶就行。

### 给朋友用

1. 服务端设 `ENABLE_INVITES=true` 重启。
2. 用管理员令牌调 `POST /admin/invite`，body `{"namespace":"B","ttlHours":24}`，拿到 `code`。
3. 把 `code` 给对方，对方调 `POST /v1/invite/redeem` 换取令牌。
4. 对方的令牌只能读写 `B` 命名空间，**物理上碰不到你的 `A`**。

## 安全

- 令牌只以 sha256 存盘，明文只在签发时返回一次，丢了找不回，只能重建命名空间。
- 路径经过逐段校验 + 落盘前二次确认，挡住 `..` 穿越。
- 跨域放开 `Access-Control-Allow-Origin: *`，因为用的是 Bearer 令牌而非 Cookie，这样做是安全的。
- **备份默认不含 API key。** ST 1.18.0 的备份是把用户数据目录整个打包，但 `secrets.json`
  （所有 `api_key_*` 都存在这里）被排除在外——见 `src/users.js` 的 `createBackupArchive`，
  `allowKeysExposure` 为 false 时的 `ignore` 列表就是 `[SECRETS_FILE, 'backups/secrets_migration_*.json']`。
  **只有**服务端 `config.yaml` 显式开了 `allowKeysExposure: true`，密钥才会跟着备份走。
- **但 `settings.json` 确实在备份里。** 从很老的版本一路升级上来的实例，可能在 `settings.json`
  里残留 `api_key_*` 字段（老版本密钥直接存这儿），那种残留是会被同步走的。
  `tools/probe-backup-contents.md` 跑一次就能确认，别猜。
- **中转服务上仍然存着你全部的酒馆数据**（聊天记录、角色卡、世界书、`settings.json`）。
  它不是你的服务器就没人管了——别把令牌泄漏出去，也别把这个服务开放给不信任的人。

## 发布扩展更新

扩展在 `extension/st-sync/` 下改完后，酒馆那边**不会自动看到**——要把它切到 `extension` 分支推上去：

```bash
# 1. 提交改动
git add extension/st-sync
git commit -m "扩展：xxx"

# 2. 重新切分支（分支已存在，先删再切）
git branch -D extension
git subtree split --prefix=extension/st-sync -b extension

# 3. 推上去（不要加 --force）
git push origin extension
```

装好扩展的酒馆，在「扩展」面板里点它的**更新**按钮就能拉到新版本。

> **`git subtree split` 是确定性的**：只要 `main` 的历史是只追加的，重新切出来的提交和上次
> **前 n 个完全相同**，所以推上去是快进。如果你 rebase / amend 过 `main` 的已推历史，
> 推 `extension` 就会变成非快进，需要 `--force`——而**已经装过扩展的酒馆再点更新会失败**
> （两边历史分叉），只能删掉重装。所以定稿之后尽量别再改已推上去的历史。

> 想发固定版本的话，给切出来的提交打个 tag：
> `git tag v0.1.0 extension && git push origin v0.1.0`，
> 安装时「Branch or tag name」填 tag 名即可——那个输入框**分支和 tag 都认**。

## 已知限制

- 同步是整份覆盖，不做文件级合并。
- 恢复后需要刷新页面，酒馆内存里还是旧数据。
- 传输未加密（依赖 HTTPS）。中转服务本身不做端到端加密。
- 自动上传靠浏览器定时器，只在**页面开着**时才跑。
