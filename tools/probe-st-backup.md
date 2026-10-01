# SillyTavern 备份接口探测脚本

## 已经测出来的结果（2026-10，SillyTavern 1.18.0，官方镜像）

在 `https://sillytarven.zeabur.app` 上实测确认：

| 接口 | 结果 | 结论 |
|---|---|---|
| `POST /api/users/backup` | 200，返回 zip | ✅ **下载备份的正确接口** |
| `POST /api/backups/restore` | 400（空表单） | ✅ **恢复备份的正确接口** |
| `POST /api/backups/download` | 404 | ❌ 旧路径，1.18.0 已不在这里 |
| `GET /api/backups/` | 404 | ❌ 不存在 |

两个关键教训，换版本重新探测时注意：

1. **下载和恢复不在同一个文件里**。下载挪到了 `/api/users/`，恢复还在 `/api/backups/`。
   看到 `/api/backups/` 前缀就以为下载也在那儿，会直接踩坑。
2. **400 不等于路由不存在**。恢复接口返回 400 是因为我们故意发了空表单（缺文件），
   这恰恰说明路由是存在的。区分"404 路由不存在"和"400 参数不对"很重要。

扩展里已经按这个结果改好了（`extension/st-sync/index.js` 顶部的 `ST_API`）。

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
  say('--- 3. 恢复接口（故意不传文件，只看路由存不存在）---');
  say('    404 = 路由不存在；400/500 = 路由存在但缺文件。此操作不会恢复任何数据。');
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
