# TT 酒馆（TauriTavern）接口速查

> 排查手机端（TT 酒馆）上传/恢复时，从 `Darkatse/TauriTavern` 源码里核对出来的结论。
> 写这份是为了以后**不用再翻一遍 GitHub 源码**。所有结论都标了出处文件，要复核按路径去查。

## 0. 基本事实

- 仓库：`github.com/Darkatse/TauriTavern`，默认分支 `main`，共 2812 个条目。
- 定位：**用 Tauri/Rust 重写的 SillyTavern**（README 原话 "The classic Sillytavern, now has been rewritten in Tauri/Rust."）。所以它**不是**原版 ST 那套 `src/endpoints/*.js` 的 Express 路由。
- 后端路由在 **`src/tauri/main/routes/*.js`**（Tauri 主进程里一个自己的 router），前端脚本在 `src/scripts/`。
- 判运行时：**`window.__TAURITAVERN__`** 有值 = TT 酒馆；`undefined` = 原版 ST（出处 `docs/API/Migration.md`：`if (window.__TAURITAVERN__)`）。

### 怎么访问源码（本机网络限制）

- `raw.githubusercontent.com` 在本机解析不了（DNS 被挡，curl 返回 000）。
- `api.github.com` 能通。用 contents 接口 + raw 头拉文件：

```bash
curl -s "https://api.github.com/repos/Darkatse/TauriTavern/contents/<路径>?ref=main" \
  -H "Accept: application/vnd.github.raw"
```

- `gh` CLI 本机没装。
- 拉整棵树：`GET https://api.github.com/repos/Darkatse/TauriTavern/git/trees/HEAD?recursive=1`（返回 `.tree[].path`，`truncated=false`）。

## 1. `POST /api/users/backup` —— 存在，契约和原版一致

出处：`src/tauri/main/routes/user-routes.js`（这个文件**只有这一条路由**）+ `tests/user-backup-route-contract.test.mjs`。

- 请求体：`{ handle }`（trim 后，缺了直接 400，错误文案 `"Bad request: User handle is required for backup"`）。
- **默认 handle = `'default-user'`**（契约测试里就是这么传的）。
- 可选 `native: true`：不流式回传，改走原生保存，返回 JSON `{ ok, mode, file_name, saved_target, includes_secrets }`（mode = `desktop-native` / `mobile-native` / `ios-native-share`）。**我们用不上**——我们要字节。
- **默认（不带 native）**：流式返回 `Response`，头是
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="<encodeURI 后的文件名>"`
  - body 是 `PK\x03\x04` 开头的 zip。
- 内部流程：`read_secret_settings`（读 `allowKeysExposure` → `include_secrets`）→ `export_user_backup_archive { handle, include_secrets }` → `createReadableFileStream` 流回 → 流完 `cleanup_user_backup_archive`。
- **`user-routes.js` 里没有 `/api/users/me`**（这个文件只有 `/api/users/backup` 一条路由）。所以本以为是 404，但 **2026-10-01 真机实测：`GET /api/users/me` 回的是 `HTTP 200`，只是 body 读不出来**（WebKit 抛 `SyntaxError: The string did not match the expected pattern.`）。像是被别的处理器/兜底路由接走了。`currentHandle()` 因此落到 fallback `'default-user'` —— 正好和 TT 默认 handle 对得上，无副作用，但"会 404"这个说法是错的，别照抄。

## 2. 内置「数据迁移」扩展（Data Migration）—— 整包导入/导出

出处：扩展本体 `src/scripts/extensions/data-migration/index.js` + `manifest.json`（`display_name: "Data Migration"`，`loading_order: 23`，author Darkatse）；路由在 `src/tauri/main/routes/extensions-routes.js`；契约测试 `tests/data-migration-route-contract.test.mjs`。

**它接受两类归档**（manifest 里两条 copy key）：

- `SILLYTAVERN_MIGRATION_COPY_KEY` = "Import a **SillyTavern** data archive (zip, tar, tar.gz, or tgz) and migrate it to TauriTavern."
- `TAURITAVERN_MIGRATION_COPY_KEY` = "Import a **TauriTavern** data zip archive from another device..."

⇒ 手机（TT）可以直接吃云酒馆（原版 ST）导出的 zip，后端自己转布局落盘。这正是我们恢复侧分叉的依据。

### 全路由表

| 方法 | 路径 | 请求 | 返回 |
|---|---|---|---|
| POST | `/api/extensions/data-migration/export` | 无 | `{ ok, job_id }` |
| GET | `/api/extensions/data-migration/job?id=` | query `id` | job 状态（见下） |
| POST | `/api/extensions/data-migration/job/cancel` | `{ job_id }` | `{ ok }` |
| POST | `/api/extensions/data-migration/export/save` | `{ job_id }` | 桌面保存对话框 |
| POST | `/api/extensions/data-migration/export/android/save` | `{ job_id }` | Android SAF 保存 |
| POST | `/api/extensions/data-migration/export/ios/share` | `{ job_id }` | iOS 分享面板 |
| POST | `/api/extensions/data-migration/export/cleanup` | `{ job_id }` | `{ ok }` |
| **POST** | **`/api/extensions/data-migration/import`** | **FormData 字段 `archive`（Blob/File）**，或 JSON `{ archive_path }`（桌面选择器路径） | `{ ok, job_id }` |
| POST | `/api/extensions/data-migration/import/android` | `{ content_uri }` | `{ ok, job_id }` |
| POST | `/api/extensions/data-migration/import/android/pick` | 无 | `{ ok, content_uri }` |
| POST | `/api/extensions/data-migration/import/ios` | `{}` | `{ ok, cancelled, job_id, file_name }` |

### 导入（我们用这条）

```
POST /api/extensions/data-migration/import
Content-Type: multipart/form-data   ← 别手动设，浏览器补 boundary
字段 archive = <zip 的 Blob/File>     ← 第三个参数带文件名时后端拿它当 preferredName
```

- 后端 `materializeUploadFile(archive, { kind: 'data-archive', preferredName })` 把 Blob 落成临时文件，再 `start_import_data_archive { archive_path, archive_is_temporary: true }`，返回 `job_id`。
- 回：`{ ok: true, job_id }`。

### 轮询 job 状态

```
GET /api/extensions/data-migration/job?id=<job_id>
```

状态结构（`get_data_archive_job_status` 返回原样透传）：

```js
{
  kind,             // 'export' | 'import'
  state,            // 运行中… | 'completed' | 'failed' | 'cancelled'
  stage,            // 阶段文案
  message,          // 提示
  progress_percent, // 数字
  error,            // 失败时
  reconcile_error,  // 落盘后对账错误
  local_applied,    // 已写入本地数据
  result: { file_name, archive_path, artifact_state, saved_path, ... }
}
```

- **终态只有三个**：`completed` / `failed` / `cancelled`（`TERMINAL_JOB_STATES`）。
- 轮询间隔官方是 1200ms（`JOB_POLL_INTERVAL_MS`）。
- 结束后若 `local_applied` 或 `reconcile_error` 为真 → 需要 `location.reload()`（数据已落盘、内存仍旧）。

## 3. 关键结论（以后直接引用）

1. **导出不回 JS 字节**。data-migration 的导出全走原生（SAF / 分享面板 / 桌面对话框），没有一条路由把 zip 字节流回 WebView。全仓库唯一把用户备份 zip 流回 JS 的就是 `POST /api/users/backup`。
   ⇒ **上传侧只能继续用 `POST /api/users/backup` 流式**，没别的路拿到字节去 PUT 到 relay。
2. **恢复侧可以整包导入**。手机（TT）拉对面备份时，用 `POST /api/extensions/data-migration/import`（FormData `archive`）一条搞定，不用再拆开按 14 类写回。
3. **手机上传失败的真正根因（2026-10-01 真机坐实，推翻了之前的"WebView 卡死不 settle"假设）**：
   手机（iOS TT）上 `POST /api/users/backup` **响应头正常 200 回来，但读 body 时抛 `forbidden path`**，指向的就是 TT 自己刚打包出来的那个 zip：

   ```
   酒馆生成备份 响应头到达：HTTP 200，用时 2671ms
   酒馆生成备份 读 body 失败 forbidden path:
     /private/var/mobile/Containers/Data/Application/<uuid>/Library/Caches/
     com.tauritavern.client/tauritavern-export-staging/user-backups/
     .user-backup-<hex>-default-user-<stamp>.zip
   ```

   链路（每一环都在源码里核过）：
   - 路由 `src/tauri/main/routes/user-routes.js`：`export_user_backup_archive` 打包 → `createUserBackupArchiveStream` → `context.createReadableFileStream(archivePath)` → 立刻 `return new Response(stream, ...)`。**头是路由发的，body 才去读文件**，所以故障一定出现在"头回来之后"。
   - `src/tauri/main/services/files/readable-file-stream-service.js`：`createReadableFileStream` 内部调 Tauri 的 **`plugin:fs|open`**。scope 校验不通过 → `forbidden path: <路径>`（tauri-plugin-fs 的 `ForbiddenPath` 文案）。
   - 注意 `plugin:fs|open` 的 promise 是在 `ReadableStream.pull()` 里才 await 的 → 被拒时 Response 头早已发出，表现就是"头 200、body 炸"。

   **为什么 scope 会拒**：`src-tauri/crates/tauritavern/capabilities/default.json` 里，给 appcache 的只有 `fs:allow-appcache-write-recursive`（**写**）；读靠 `fs:default`。而 tauri-plugin-fs 的 `fs:default` = `create-app-specific-dirs` + `read-app-specific-dirs-recursive` + `deny-default`，描述里明说覆盖 AppConfig/AppData/AppLocalData/**AppCache**/AppLog —— 也就是说**这里本该放行，实际却被拒**。属于 TT 自己的失误，不是我们 scope 没配。
     （注：该 capability 里显式列出的两条 `fs:scope` 是 Android 路径；iOS 的读全靠 `fs:default`。）

   **对我们代码的影响**：Tauri v2 的 `invoke` 用一个**裸字符串** rejected，一路穿到我们的 `res.blob()`。于是 `err.message === undefined` → `notify('error', undefined)` → **弹一个空白 toast**（这就是用户早期看到的"空白弹窗"）。面板日志里能看到原文（`logArg` 对字符串原样输出），但 toast 是空的。
   ⇒ **未修**：理论上可以在 push 出错时把非 Error 的抛出物包成 Error，好让 toast 有内容。真正的问题是路径/scope，我们改不了。

   **同一家族的 TT 已知 bug**：[issue #193](https://github.com/Darkatse/TauriTavern/issues/193)（2026-08-19 报，08-24 关）——`/api/backups/chat/download` 的读取被错误路由进 `.staging/chat-commits` 物化流程，同样报 `forbidden path`。维护者回复原文：「确实是我们这边的一个失误，已经改成了更简单的形式读取，直接解压思路，不再需要 `.staging` 了」，并让报告者跟 iOS TestFlight 内测版。**但那修的是 chat 备份那条路由，不是 `users/backup` 这条**；搜遍 issue 也只有 #193 提过 `forbidden`，**我们这条路径（`Caches/.../tauritavern-export-staging`）截至 2026-10-01 没人报过**。
   - 相关源码变动：`readable-file-stream-service.js` 在 2026-09-13 改过两次（`5ca99a87a` 按文件大小限流、`44d3a04df`），都进了 2026-09-19 的 **v2.3.0**；而 `user-routes.js` 自 2026-05-17 起没动过。

   **下一步（未定）**：先确认用户的 TT 版本、升到 v2.3.0 或更新的 TestFlight 再试；仍失败就把上面这份日志原样提给 TT 仓库。**别再往"超时值不够"或"WebView 卡死"方向查了**——都不是。

## 4. 已实现（对应 extension/st-sync/index.js）

1. **超时 + 计时日志**：统一 `timedFetch(url, opts, { timeoutMs, what })`，内部 AbortController + `console.debug` 打三个时间点（发出 / 响应头到达 / body 读完），替换四处裸 fetch：`relayFetch`（60s）、`buildLocalBackup`（180s，服务端要先打包）、`currentHandle`（60s）、`stFetch`（60s）。
   - **计时器一直留到 body 读完才清**，不是在拿到响应头时清 —— 卡住的正是读 body 那一步，头早就回来了（`hang-body` 那个用例专测这条）。
   - 用 AbortController 不用 `Promise.race`：race 只是"我不等了"，连接还在后台挂着；abort 才真掐断（测试断言服务端确实收到 closed）。
   - 超时错误带 `isTimeout` 标记，`relayFetch` 见到它就直接抛，不再包成"连不上中转服务"——否则会把排查方向带偏。
2. **恢复按平台分叉**：`isTauriTavern()`（= `!!window.__TAURITAVERN__`）为真时，`pullOne` 走 `restoreViaNativeImport`（FormData 上传 → 轮询 job → 终态）；否则走原 `restoreFromZip`。`restoreFromZip` 那一整套**保留不删**。
   - 轮询查询**刻意不用 `stMustOk`**：job 状态体在失败时本身就带 `error` 字段，而 `stMustOk` 一见 `error` 就当"酒馆拒绝了这次请求"，会把失败原因吃掉。
   - `reconcile_error` 非空时返回一条 `skipped`，于是 `pullOne` 不记账（`rememberPulled` 只在无 skipped 时调）→ 下次同步会把这份重拉一遍。
   - 出错路径上 `STATE.restore` 一律在 `finally` 里清空，否则状态栏永远卡在"正在还原 N/100"。
3. **界面文案跟着分叉走**：`restoreModeHint()` 按平台给不同说明。原生整包导入的合并语义我们**不知道**，所以不许再写"不会删掉本机多出来的角色卡和聊天"。
4. **诊断改到面板里，不再只打控制台**（`EXT_VERSION = '2026-10-01.2'`）。起因是手机上报"点了上传，relay 日志里什么都没显示、也没超时"——而**手机上打不开控制台**，`console.debug` 那几行诊断对用户等于不存在。所以：
   - `log()` 除了 `console.debug`，还往一个 200 行的内存缓冲 `LOG_LINES` 里塞，面板底部 `<pre id="st_sync_log">` 常驻显示**最后 10 行**，旁边有「复制全部」。
   - 面板底部有一行**版本号**（`st_sync_version`）。点完「更新」后先看这里变没变——没变就是扩展根本没更上（要硬刷新 / 重开 App），不用再往下猜。
   - `timedFetch` 里把 `STATE.step` 设成当前步骤名，`beginBusy`/`endBusy` 配一个 1 秒的 ticker，状态栏于是显示 `⏳ 酒馆生成备份…　已 N 秒`。**秒数在跳**就说明扩展活着、正卡在某一步；秒数不动就是扩展压根没跑起来。
   - 三个按钮的点击都记一条日志（`点击「上传到中转」`）。**点了却连这条都没有**，说明点击没能进到处理函数（多半是面板里的确认框渲染到屏幕外了——`askUser` 现在会 `scrollIntoView` 并在状态栏写"⚠️ 等你确认"）。
   - `init()` 落盘一行 `扩展已加载，版本 …　运行时=TT 酒馆/原版 ST`，用来确认扩展到底加载没加载、跑在哪条运行时上。

## 5. 实测（tools/sync-restore-test/）

`node tools/sync-restore-test/run.js`。做法和 zip 解包器那个测试一样：整份 `index.js` 丢进 `new Function`，把 `window`/`document`/`jQuery`/`fetch`/`location` 换成桩，末尾 return 出内部函数 —— 测的就是线上那份代码。

覆盖：正常响应、头都不回、**头回了 body 永不结束**（TT 上的原样，用一个"发一半就不 end"的本机服务器复现）、abort 真的掐断了连接、备份走 180s 而不是 60s、两条恢复路径各走各的（用一个**故意不是 zip** 的载荷区分：TT 分支不解析它所以成功，原版分支必然在解包处炸）、job 的 completed/failed/cancelled/对账失败四种收尾、以及出错后状态栏不留残影。

诊断设施那一组（`testDiagnostics`，断言 `EXT_VERSION` / `log` 累积 / 缓冲封顶 / `beginBusy`↔`endBusy` 不泄漏 ticker / `STATE.step` 反映在途步骤 / 超时能进面板日志）：**已实跑通过（42 项断言全过，进程自己退出 → 没漏 ticker）。**

- 它是靠进程能否**自己退出**来兜"ticker 泄漏"的——`endBusy` 没清掉 `setInterval` 的话进程会挂住不退出。
- 踩过的坑：测缓冲封顶原先写的是 `while (LOG_LINES.length < LOG_MAX_LINES + 50) log('灌')`，但 `log()` 自己就会把缓冲裁到 200 行，`length` 永远够不到阈值 → **死循环**（跑飞过一次，输出文件涨到 80 MB 还在涨）。改成 `for (let i = 0; i < LOG_MAX_LINES + 50; i++)` 才对。**凡是循环条件读的是"被测代码自己会裁剪的量"，都要警惕这种恒真。**

## 6. 还没证实的

- **原生整包导入到底怎么合并**：TT 那个后端只说了"import and migrate"，是覆盖、合并还是清空重来，源码里没读出结论。所以恢复前的确认框只敢说"交给酒馆原生导入"，不敢做"不会删本机多出来的东西"这种承诺。
- **超时值是否够**：60s / 180s 是拍的，没有真实设备上的耗时数据。真机跑一次看 `[ST-Sync]` 那几行"用时 XXXXms"再定。

## 7. 交接状态（2026-10-01 当天就走完了）

**结果：诊断一轮就查出根因，且根因不在我们这边 —— 是 TT 自己的 `forbidden path`（见 §3.3）。**

时间线：

1. 原始症状：手机上点「上传到中转」，relay 日志一条记录都没有，也没有任何超时提示。
2. 加诊断（§4.4）后观察到：**手机上面板只显示"测试连接"的两条记录（`GET /v1/meta`、`GET /v1/ns/A/tavern`），上传那条请求压根没到 relay。**测试连接是通的 ⇒ 网络、令牌、命名空间都没问题，卡点在上传路径本身。
3. 中间卡了一下：手机上**面板底部既没有日志框也没有版本号** ⇒ 扩展没更上。原因是点完「更新」**必须重新加载页面/重开 App**（TT 前端更新成功的 toast 原文就是 "Reload the page to apply updates"），只切后台不够。
4. 更上之后一次复现就拿到决定性日志（`EXT_VERSION = 2026-10-01.2`）：

   ```
   21:41:50 [info] 正在打包并上传…
   21:41:50 取当前用户 发出（超时 60s）：/api/users/me
   21:41:50 取当前用户 响应头到达：HTTP 200，用时 10ms
   21:41:50 取当前用户 读 body 失败 SyntaxError: The string did not match the expected pattern.
   21:41:50 取当前用户失败，退回 default-user SyntaxError: The string did not match the expected pattern.
   21:41:50 酒馆生成备份 发出（超时 180s）：/api/users/backup
   21:41:53 酒馆生成备份 响应头到达：HTTP 200，用时 2671ms
   21:41:53 酒馆生成备份 读 body 失败 forbidden path: /private/var/mobile/.../tauritavern-export-staging/user-backups/.user-backup-<hex>-default-user-<stamp>.zip
   21:41:53 同步出错 forbidden path: ...
   21:41:53 [error] undefined
   ```

   顺带两条副产品观察：
   - **`GET /api/users/me` 不是 404**，而是 **200 但 body 读不出来**（WebKit 报 `SyntaxError: The string did not match the expected pattern.`，注意那不是 `JSON.parse` 的错——`readJsonSafe` 已经把 JSON 错吞了，说明是 `res.text()` 自己抛的）。反正落到 fallback `default-user`，和 TT 默认值一致，无副作用；但 §1 那条"没有 `/api/users/me`，会 404"**在用户的 TT 版本上不成立**，记一笔。
   - 那句 `[error] undefined` 就是早期用户看到的"空白弹窗"的成因：rejected 的是裸字符串，`err.message` 是 undefined。

**下一步（还没做）：**

1. **确认用户的 TT 版本**，升到 v2.3.0（2026-09-19 发布，含 09-13 的流读取改动）或更新的 TestFlight 内测版，再试一次上传。
2. 若仍失败：把上面那段日志原样提给 `Darkatse/TauriTavern`（**目前全仓库 issue 里只有 #193 提过 `forbidden`，我们这条路径没人报过**，见 §3.3）。
3. 可选的小改进：push 出错时把非 Error 的抛出物包成 Error，好让 toast 不再是空白（现在信息只在面板日志里）。

**不用再查的方向**：超时值不够（不是）、WebView 消费流不 settle（不是）。§5 里 `hang-body` 那个用例复现的是另一种形态，与本 bug 无关。

用户是在**手机上装扩展**测试的，那里没有任何控制台——**以后这个项目所有诊断都必须落在面板 UI 里**，`console.*` 只能当附带。
