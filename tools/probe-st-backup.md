# SillyTavern 备份接口探测脚本

## 已经核实的结果（2026-10，SillyTavern 1.18.0）

> ⚠️ **2026-10-01 更正。** 这张表早先是照着一次控制台探测填的，其中关于"恢复"的两行**是错的**，
> 而且错在推理上——当时把"400"当成了"路由存在"的证据。之后逐文件核对了 1.18.0 的源码，
> 结论如下。源码位置一并列出，换版本后照着复核一遍，比再猜一次快。

| 接口 | 事实 | 依据 |
|---|---|---|
| `POST /api/users/backup` | ✅ 下载备份的正确接口。**但请求体必须带 `{"handle":"…"}`**，不带直接 400 `Missing required fields` | `src/endpoints/users-private.js:146`：`const handle = request.body.handle` |
| `GET /api/users/me` | 取当前用户 handle，用来喂上面那个参数 | `src/endpoints/users-private.js:35` |
| `POST /api/backups/restore` | ❌ **1.18.0 里没有这个路由** | `src/endpoints/backups.js` 全文只有 `chat/get`、`chat/delete`、`chat/download` 三条 |
| `POST /api/backups/download` | ❌ 旧路径，已不在这里 | 同上 |
| 任何"上传 zip 还原整份备份"的接口 | ❌ **不存在** | `src/users.js` 只有 `createBackupArchive`（写 zip），没有对应的解包函数；`public/scripts/user.js` 里前端只有 `backupUserData`（下载）和 `restoreSnapshot`（还原**服务端快照**，只含 settings），没有任何地方上传备份文件 |

三条教训：

1. **状态码不能代替读源码。** 空表单返回 400 被当成了"路由存在"，这是错的——兜底中间件同样会回 400。
   要确认路由在不在，去 `src/endpoints/` 里 `grep router.` 数一遍。
2. **`/api/backups` 下那个 `backups.js` 跟用户数据备份是两码事**，它只管聊天记录备份。
   用户数据的备份接口在 `src/endpoints/users-private.js` 里，别被路径前缀骗了。
3. **每个"已实测确认"都写清文件和行号**，否则下一个人（包括我自己）还得重猜一遍。

**当前结论：恢复这一半是缺的。** 浏览器侧没有任何受支持的方式把一份 zip 还原进酒馆数据目录，
需要另定方案（服务端插件，或改成按类型重新导入）。见仓库根目录 README 的「已知限制」。

---

## 为什么需要这个

SillyTavern 的备份/恢复接口在不同版本之间**路由和方法都变过**。如果按猜的路由写扩展，会出现"上传成功但恢复没反应"或者直接 404 这类难查的问题。

所以第一步是**在你的实际版本上实测一遍**，把真实路由、方法、CSRF 要求、上传字段名确定下来，再写死进扩展。

## 怎么用

1. 打开你的酒馆页面（TT 酒馆和云酒馆**各跑一次**，因为两边版本可能不同）。
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）**。
3. 如果控制台顶部有 "Warning: Don't paste code..." 之类的提示，需要先按提示输入 `allow pasting` 回车（Chrome 的安全限制）。
4. 把下面整段代码粘进去，回车。
5. 把输出的报告贴给我。

**这个脚本是只读的**：它只会尝试"生成备份"和"故意发一个没有文件的恢复请求"，**不会恢复、不会覆盖、不会删除你任何数据**。生成备份是安全操作（等于你手点一次"下载备份"）。

## 脚本

```js
(async () => {
  const ctx = window.SillyTavern?.getContext?.();
  const getHeaders = (typeof getRequestHeaders === 'function' && getRequestHeaders)
    || (ctx && ctx.getRequestHeaders)
    || (() => ({}));

  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  say('===== SillyTavern 备份接口探测 =====');
  say('页面地址: ' + location.origin);

  // 版本
  try {
    const r = await fetch('/version', { headers: getHeaders() });
    say('GET /version -> ' + r.status + ' : ' + (await r.text()).slice(0, 120));
  } catch (e) {
    say('GET /version 失败: ' + e.message);
  }
  say('ctx.version = ' + (ctx?.version ?? '(取不到)'));

  const headers = getHeaders();
  say('请求头字段: ' + Object.keys(headers).join(', '));
  say('');

  // ---- 1. 列出备份（只读，最安全）----
  say('--- 1. 列出服务端已有备份 ---');
  for (const method of ['GET']) {
    try {
      const r = await fetch('/api/backups/', { method, headers });
      const text = await r.text();
      say(`${method} /api/backups/ -> ${r.status} ${r.headers.get('content-type') || ''}`);
      say('  响应前 200 字符: ' + text.slice(0, 200));
    } catch (e) {
      say(`${method} /api/backups/ 失败: ${e.message}`);
    }
  }
  say('');

  // ---- 2. 下载备份（会生成一个备份，安全）----
  say('--- 2. 生成并下载备份 ---');

  // ★ 1.18.0 的正确姿势：先拿 handle，再带上 JSON body 请求。
  // 少了 body 里的 handle 就是 400，这一条踩过一次坑，别删。
  try {
    const me = await fetch('/api/users/me', { headers });
    const user = me.ok ? await me.json() : {};
    const handle = user.handle || 'default-user';
    const r = await fetch('/api/users/backup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ handle }),
    });
    say(`POST /api/users/backup (handle=${handle}) -> ${r.status}  ` +
        `type=${r.headers.get('content-type') || ''}  disp=${r.headers.get('content-disposition') || ''}`);
    try { await r.body?.cancel(); } catch {}
  } catch (e) {
    say('POST /api/users/backup 失败: ' + e.message);
  }

  // 下面这些是历史候选，留着是为了换版本时还能自动扫一遍
  const downloadCandidates = [
    ['POST', '/api/backups/download'],
    ['GET',  '/api/backups/download'],
    ['POST', '/api/backups/backup'],
  ];
  let foundDownload = null;
  for (const [method, url] of downloadCandidates) {
    try {
      const r = await fetch(url, { method, headers });
      const ct = r.headers.get('content-type') || '';
      const len = r.headers.get('content-length') || '?';
      const cd = r.headers.get('content-disposition') || '';
      say(`${method} ${url} -> ${r.status}  type=${ct}  len=${len}  disp=${cd}`);
      if (r.ok && /zip|octet-stream/i.test(ct)) {
        say('  ★ 这个就是下载接口，filename 线索: ' + cd);
        foundDownload = [method, url];
      }
      // 不要真的把几百 MB 读进内存
      try { await r.body?.cancel(); } catch {}
    } catch (e) {
      say(`${method} ${url} 失败: ${e.message}`);
    }
  }
  say('下载接口结论: ' + (foundDownload ? foundDownload.join(' ') : '未找到，需要人工判断'));
  say('');

  // ---- 3. 恢复接口探测（故意不带文件，看路由是否存在）----
  // ⚠️ 已知 1.18.0 这三条全都不存在，下面必然是 404。留着的意义只有一个：
  //    如果哪天某条开始回非 404，说明上游终于加了"上传备份还原"的接口，那就有救了。
  //    注意别再把 400 当成"路由存在"——那是上一版文档犯过的错。
  say('--- 3. 恢复接口（故意不传文件，只看路由存不存在）---');
  say('    404 = 路由不存在。1.18.0 预期全部 404。此操作不会恢复任何数据。');
  const restoreCandidates = [
    ['POST', '/api/backups/restore'],
    ['POST', '/api/backups/upload'],
    ['PUT',  '/api/backups/restore'],
  ];
  for (const [method, url] of restoreCandidates) {
    try {
      // 发一个空的 multipart，服务端解析不出文件，会在"取文件"那步报错 —— 正是我们想看到的
      const fd = new FormData();
      const r = await fetch(url, { method, headers, body: fd });
      const text = await r.text();
      say(`${method} ${url} -> ${r.status} : ${text.slice(0, 200)}`);
    } catch (e) {
      say(`${method} ${url} 失败: ${e.message}`);
    }
  }
  say('');

  say('===== 探测结束，请把以上全部内容复制给我 =====');
})();
```

## 我要从报告里读什么

| 看什么 | 用途 |
|---|---|
| `/api/backups/download` 的**方法和状态码** | 决定扩展用 GET 还是 POST 拉备份 |
| 返回的 `content-type` 是不是 zip | 确认拿到的是完整备份而不是错误 JSON |
| `content-disposition` 里的文件名 | 对齐服务端命名规则 |
| `/api/backups/restore` 返回 **404 还是 400/500** | 404 说明路由名不对，需要换候选或另找 |
| 请求头里有没有 `x-csrf-token` | 确认 CSRF 要求，扩展必须带上 |

拿到报告后我会把扩展里的接口调用改成**实测通过的那一套**，而不是猜的。
