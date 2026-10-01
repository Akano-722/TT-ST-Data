# 备份包里到底有什么？（密钥在不在里面）

## 为什么需要这个

SillyTavern 的完整备份**可能出于安全考虑剔除了密钥**（`secrets.json` 里的 API key、反代密码）。
这件事直接决定同步方案：

- 备份**含**密钥 → 恢复会把对面的密钥覆盖到你本机，这是**要防的**问题。
- 备份**不含**密钥 → 每次恢复都不会动你本机的密钥，反而是**安全**的。

网上各种说法互相矛盾，且不同版本行为不同。**别猜，在你自己的实例上跑一次。**

## 怎么用

1. 打开酒馆页面，`F12` → Console。
2. 需要的话先按提示输入 `allow pasting` 回车。
3. 整段粘贴，回车。等几秒（会生成一份完整备份）。
4. 把输出全部贴回来。

**这个脚本是只读的**：它只调"生成备份"这一个接口（等于你手点一次"下载备份"），
**不会恢复、不会覆盖、不会删除**任何东西。文件名是从 zip 的目录区读的，**不解压内容**。

> 备份可能有几百 MB，会短暂占用内存。跑完刷新一下页面就释放了。

## 脚本

```js
(async () => {
  const ctx = window.SillyTavern?.getContext?.();
  const getHeaders = (typeof getRequestHeaders === 'function' && getRequestHeaders)
    || (ctx && ctx.getRequestHeaders)
    || (() => ({}));

  console.log('正在生成备份（只读，不会动你的数据）…');
  const res = await fetch('/api/users/backup', { method: 'POST', headers: getHeaders() });
  if (!res.ok) {
    console.warn('拿不到备份:', res.status, (await res.text()).slice(0, 200));
    return;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  console.log(`备份大小: ${(buf.length / 1048576).toFixed(1)} MB`);

  // 解析 zip 的中央目录。文件名在 zip 里是明文存的，所以不用解压库也能列出清单。
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { console.warn('没找到 zip 结尾记录，返回的可能不是 zip'); return; }

  const total = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const files = [];
  for (let i = 0; i < total && off + 46 <= buf.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    files.push({
      name: dec.decode(buf.subarray(off + 46, off + 46 + nameLen)),
      size: dv.getUint32(off + 24, true),
    });
    off += 46 + nameLen + extraLen + cmtLen;
  }

  console.log(`备份里共 ${files.length} 个条目\n`);

  for (const target of ['secrets.json', 'settings.json', 'config.yaml']) {
    const hit = files.find((f) => f.name === target || f.name.endsWith('/' + target));
    console.log(hit ? `✅ 含   ${hit.name}  (${hit.size} 字节)` : `❌ 不含 ${target}`);
  }

  console.log('\n--- 全部条目 ---');
  for (const f of files) console.log(`${String(f.size).padStart(10)}  ${f.name}`);

  console.log('\n===== 结束，把以上全部复制给我 =====');
})();
```

## 我要从结果里读什么

| 看到什么 | 结论 | 对应处理 |
|---|---|---|
| 有 `secrets.json` | 密钥会跟着备份走 | **要防**恢复把本机密钥覆盖掉 |
| 没有 `secrets.json` | 密钥留在本机，不被同步 | 只需再确认"恢复后密钥还在不在" |
| 两个都跑一遍（本地 TT 和云酒馆） | 两边版本可能不同，行为可能不一样 | — |

另外留意 `settings.json` 里有没有 `api_key_*` 之类的字段残留（老版本密钥直接存在这里）。

## 待确认的第二个问题：恢复会不会清掉本机的密钥

如果备份里没有 `secrets.json`，恢复时它不在"要覆盖的名单"里，按理就动不到它。
但酒馆恢复前的警告文案写的是"会覆盖你当前的数据"，是覆盖还是清空重来，值得实测。

**安全的实测方法**：先在设置面板手动下载一份当前备份保底 → 用扩展恢复一次 → 看 API 连接测试还能不能通过。

## 已知结论（会随实测更新）

- `allowKeysExposure` 默认为 `false`：**前端读不到密钥明文**。
  所以"让扩展自动帮你同步密钥"这条路，必须先把它改成 `true` 并重启，否则前端根本拿不到值。
