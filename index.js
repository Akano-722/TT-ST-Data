'use strict';

/**
 * 酒馆云同步 (ST Sync)
 *
 * 在本地 TT 酒馆和自建云酒馆之间，通过一个自建中转服务交换备份文件。
 * 全程只调用酒馆已有的 HTTP 接口，不改动任何酒馆后端代码。
 *
 * 这个文件刻意不用任何 ES import：所有能力都从 SillyTavern.getContext() 拿，
 * 这样文件放在哪个目录都能跑，也不会因为相对路径写错而整个扩展加载失败。
 */

const LOG = '[ST-Sync]';

/* ------------------------------------------------------------------ *
 * 已实测确认（SillyTavern 1.18.0，官方镜像 ghcr.io/sillytavern/sillytavern）：
 *   下载备份  POST /api/users/backup      —— 注意不是 /api/backups/download，那是旧路径
 *             请求体必须带 { handle }，不带就是 400（见 currentHandle 的注释）
 *   当前用户  GET  /api/users/me          —— 用来取上面那个 handle
 * 换版本后若失效，用 tools/probe-st-backup.md 重新探测。
 *
 * ⚠️ 恢复备份（ST_API.restore）在 1.18.0 的源码里查无此路由：酒馆前端只能下载备份，
 *    从来没有"上传备份还原"的接口。这条路径是坏的，见 README「已知限制」。
 * ------------------------------------------------------------------ */
const ST_API = {
    download: { method: 'POST', url: '/api/users/backup' },
    restore: { method: 'POST', url: '/api/backups/restore' },
    me: { method: 'GET', url: '/api/users/me' },
};

/**
 * 恢复接口的 multipart 字段名在各版本间变过，猜错会返回 400。
 * 与其写死一个值然后让用户对着 400 干瞪眼，不如按顺序试，
 * 第一个成功的记进设置，之后就直接用它。
 */
const RESTORE_FIELD_CANDIDATES = ['backup', 'file', 'upload', 'avatar'];

const DEFAULT_SETTINGS = {
    relayUrl: '',          // 中转服务地址，例如 https://sync.example.com
    token: '',             // 中转服务访问令牌
    namespace: 'A',        // 命名空间
    bucket: 'tavern',      // 桶名：酒馆备份放这里，别的用途可以另开
    deviceId: 'local',     // 本机标识，两台设备必须不同
    autoSync: false,       // 定时自动上传
    intervalMin: 30,       // 定时间隔（分钟）
    checkOnLoad: true,     // 打开页面时自动检查中转有没有更新的备份
    conflictPolicy: 'ask', // ask | newest | skip
    keepSnapshots: 5,      // 中转上为每台设备保留多少个历史快照
    restoreField: '',      // 恢复接口实测可用的字段名，自动探测一次后记住
    lastPulled: {},        // { 设备id: 已拉取过的版本标记 }，用于判断"对方有没有变"

    // 下面两个是运行状态，但必须落盘（见 markDirty 的注释）
    localDirty: false,     // 本机自上轮同步后有没有改动
    localDirtySince: 0,    // 首次变脏的时间，给 newest 策略比对用
};

const STATE = {
    busy: false,
    timer: null,
    lastResult: '',
    lastOk: null,
    suppressDirty: false, // 恢复数据期间挂起改动检测，避免把恢复本身误判成用户改动
};

let ui = {};

/* ---------------------------------------------------------------- 上下文 */

function ctx() {
    const c = window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
        ? window.SillyTavern.getContext()
        : null;
    if (!c) throw new Error('拿不到 SillyTavern 上下文（版本不兼容或加载过早）');
    return c;
}

const STORAGE_KEY = 'st-sync:settings';

let cachedSettings = null;

/**
 * 设置存在 localStorage，刻意不用 ST 的 extension_settings。
 *
 * 原因：extension_settings 会写进 settings.json，而 settings.json 正是备份内容的一部分。
 * 一旦从对面恢复备份，本机的中转地址、令牌、设备标识就会被对面的值覆盖掉 —— 设备标识一乱，
 * 整个同步就废了。这些本来就是"每台设备各自的"配置，不该跟着数据一起被同步过去。
 */
function settings() {
    if (cachedSettings) return cachedSettings;

    let stored = {};
    try {
        stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (err) {
        console.warn(LOG, '读取本地设置失败，改用默认值', err);
    }

    cachedSettings = { ...DEFAULT_SETTINGS };
    for (const [key, value] of Object.entries(stored)) {
        if (value !== undefined) cachedSettings[key] = value;
    }
    if (!cachedSettings.lastPulled || typeof cachedSettings.lastPulled !== 'object') {
        cachedSettings.lastPulled = {};
    }
    return cachedSettings;
}

function persist() {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings()));
    } catch (err) {
        console.error(LOG, '写入本地设置失败', err);
    }
}

/**
 * 改动标记必须落盘，不能只放内存。
 * iOS 上 App 随时会被系统杀掉，内存里的标记一丢，下次打开就会误判成"本机没动过"，
 * 然后拿对面的备份把本机改动覆盖掉 —— 正是要防的那种丢数据。
 */
function isDirty() {
    return !!settings().localDirty;
}

function markDirty(reason) {
    // 恢复数据时本身会触发一堆事件，那些不是用户改动，不能算数
    if (STATE.suppressDirty) {
        console.debug(LOG, '恢复期间忽略事件:', reason);
        return;
    }
    const s = settings();
    if (s.localDirty) return;
    s.localDirty = true;
    s.localDirtySince = Date.now();
    persist();
    console.debug(LOG, '标记为已改动:', reason);
    renderStatus();
}

function clearDirty() {
    const s = settings();
    s.localDirty = false;
    s.localDirtySince = 0;
    persist();
}

/* ---------------------------------------------------------------- 状态显示 */

function notify(kind, message) {
    STATE.lastResult = message;
    // success 绿色、error 红色、info/warn 中性色
    STATE.lastOk = kind === 'success' ? true : (kind === 'error' ? false : null);
    renderStatus();

    const t = window.toastr;
    if (!t) {
        console.log(LOG, `[${kind}] ${message}`);
        return;
    }
    const fn = { success: t.success, info: t.info, warn: t.warning, error: t.error }[kind] || t.info;
    fn.call(t, message, '酒馆云同步');
}

function renderStatus() {
    if (!ui.status) return;
    const parts = [];
    if (STATE.busy) parts.push('⏳ 正在同步…');
    else if (STATE.lastResult) parts.push(STATE.lastResult);

    const s = settings();
    parts.push(`本机标识：${s.deviceId}　本地改动：${s.localDirty ? '有（未上传）' : '无'}`);
    if (s.localDirty && s.localDirtySince) {
        parts.push(`改动时间：${new Date(s.localDirtySince).toLocaleString()}`);
    }
    ui.status.textContent = parts.filter(Boolean).join('\n');
    ui.status.classList.toggle('is-error', STATE.lastOk === false);
    ui.status.classList.toggle('is-ok', STATE.lastOk === true);
}

/* ------------------------------------------------------------ 中转服务客户端 */

function requireConfig() {
    const s = settings();
    if (!String(s.relayUrl || '').trim()) throw new Error('还没填中转服务地址');
    if (!String(s.token || '').trim()) throw new Error('还没填访问令牌');
    if (!String(s.deviceId || '').trim()) throw new Error('还没填本机标识');
    return s;
}

/** 把 key 逐段编码后再拼；整段编码会把 "/" 编掉，破坏服务端的分层路径 */
function encodeKey(key) {
    return String(key).split('/').map(encodeURIComponent).join('/');
}

function nsPath(bucket, key) {
    const s = requireConfig();
    const parts = [
        '/v1/ns',
        encodeURIComponent(s.namespace),
        encodeURIComponent(bucket || s.bucket),
    ];
    if (key) parts.push(encodeKey(key));
    return parts.join('/');
}

async function relayFetch(pathname, options = {}) {
    const s = requireConfig();
    const headers = { ...(options.headers || {}) };
    headers.Authorization = `Bearer ${s.token}`;
    const base = String(s.relayUrl).replace(/\/+$/, '');
    try {
        return await fetch(base + pathname, { ...options, headers });
    } catch (err) {
        throw new Error(`连不上中转服务（${err.message}）。检查地址是否正确、服务是否在跑、是否被跨域拦住`);
    }
}

async function readJsonSafe(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text.slice(0, 300) };
    }
}

async function relayPut(key, body, contentType) {
    const res = await relayFetch(nsPath(null, key), {
        method: 'PUT',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body,
    });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(`上传 ${key} 失败 HTTP ${res.status}：${json.error || JSON.stringify(json).slice(0, 200)}`);
    return json;
}

async function relayGetBlob(key) {
    const res = await relayFetch(nsPath(null, key));
    if (!res.ok) throw new Error(`下载 ${key} 失败 HTTP ${res.status}`);
    return res.blob();
}

async function relayList() {
    const res = await relayFetch(nsPath(null, null));
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(`列目录失败 HTTP ${res.status}：${json.error || ''}`);
    return json.files || [];
}

async function relayDelete(key) {
    const res = await relayFetch(nsPath(null, key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
        console.warn(LOG, '删除失败', key, res.status);
        return false;
    }
    return true;
}

/* -------------------------------------------------------------- 酒馆备份接口 */

/**
 * 当前用户的 handle。
 *
 * 下载备份的接口只认请求体里的 handle：`POST /api/users/backup` 读的是 `request.body.handle`，
 * 不带就立刻 400 Missing required fields —— 不是路由不对，是缺参数。
 * 酒馆自己的前端也是这么传的（public/scripts/user.js：backupUserData → getCurrentUserHandle）。
 *
 * 拿不到时退回 'default-user'，和酒馆前端的兜底保持一致：没开账号系统时服务端看到的
 * 也正是这个 handle，两边对得上。
 */
let cachedHandle = '';

async function currentHandle() {
    if (cachedHandle) return cachedHandle;

    let handle = '';
    try {
        const res = await fetch(ST_API.me.url, { headers: ctx().getRequestHeaders() });
        if (res.ok) {
            const user = await res.json();
            handle = user && user.handle ? String(user.handle) : '';
        } else {
            console.warn(LOG, `GET ${ST_API.me.url} 返回 HTTP ${res.status}，退回 default-user`);
        }
    } catch (err) {
        console.warn(LOG, '取当前用户失败，退回 default-user', err);
    }

    cachedHandle = handle || 'default-user';
    return cachedHandle;
}

async function buildLocalBackup() {
    const handle = await currentHandle();
    const res = await fetch(ST_API.download.url, {
        method: ST_API.download.method,
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ handle }),
    });
    if (!res.ok) {
        // 服务端出错时回的是 JSON（比如 {"error":"Missing required fields"}），
        // 把它带进错误里，省得下次又只能对着一个状态码猜。
        const detail = await res.text().catch(() => '');
        throw new Error(
            `酒馆生成备份失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}。` +
            `接口可能对不上，先跑 tools/probe-st-backup.md 确认路由`,
        );
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('酒馆返回的备份是空的');
    return blob;
}

/** 发一次恢复请求，把结果原样回报，是否重试交给调用方判断 */
async function postRestore(blob, fileName, fieldName) {
    const headers = { ...ctx().getRequestHeaders() };
    // getRequestHeaders() 里带着 Content-Type: application/json，
    // 直接拿来发 FormData 会让浏览器无法自动补 multipart 的 boundary，服务端就解析不出文件。
    delete headers['Content-Type'];
    delete headers['content-type'];

    const form = new FormData();
    form.append(fieldName, blob, fileName || 'backup.zip');

    const res = await fetch(ST_API.restore.url, {
        method: ST_API.restore.method,
        headers,
        body: form,
    });
    if (res.ok) return { ok: true, status: res.status };

    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text: text.slice(0, 200) };
}

async function restoreFromBlob(blob, fileName) {
    const s = settings();
    const candidates = [];
    if (s.restoreField) candidates.push(s.restoreField);
    for (const name of RESTORE_FIELD_CANDIDATES) {
        if (!candidates.includes(name)) candidates.push(name);
    }

    let last = null;
    for (const field of candidates) {
        const result = await postRestore(blob, fileName, field);
        if (result.ok) {
            if (s.restoreField !== field) {
                s.restoreField = field;
                persist();
                console.debug(LOG, `恢复接口的字段名确认为 "${field}"，已记住`);
            }
            return true;
        }
        last = result;
        // 400 多半就是字段名不对，换下一个继续试；
        // 其它状态码（401 未登录、500 服务端炸了）换字段名也救不回来，直接停。
        if (result.status !== 400) break;
        console.debug(LOG, `恢复字段名 "${field}" 试失败（HTTP ${result.status}），换下一个`);
    }

    throw new Error(
        `恢复失败 HTTP ${last ? last.status : '?'}：${last ? last.text : '无响应'}。` +
        `已试过的字段名：${candidates.join(', ')}。` +
        `若持续失败，用 tools/probe-st-backup.md 重新确认接口`,
    );
}

/* ---------------------------------------------------------------- 同步逻辑 */

const latestKeyOf = (device) => `devices/${device}/latest.json`;
const snapshotKeyOf = (device, fileName) => `devices/${device}/snapshots/${fileName}`;

/** 版本标记：优先用中转算出的 sha256，退而求其次用 大小+时间 */
function markerOf(latest) {
    if (!latest) return '';
    return latest.sha256 || `${latest.size || 0}:${latest.createdAt || ''}`;
}

function seenMarker(device) {
    const pulled = settings().lastPulled || {};
    return pulled[device] || '';
}

function rememberPulled(device, marker) {
    const s = settings();
    if (!s.lastPulled) s.lastPulled = {};
    s.lastPulled[device] = marker;
    persist();
}

async function readRemoteLatest(device) {
    try {
        const res = await relayFetch(nsPath(null, latestKeyOf(device)));
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn(LOG, `读 ${device} 的 latest.json 失败`, err);
        return null;
    }
}

/** 中转上除了本机之外，还有哪些设备留过备份 */
async function discoverOtherDevices() {
    const me = settings().deviceId;
    const files = await relayList();
    const found = new Set();
    for (const file of files) {
        const match = /^devices\/([^/]+)\/latest\.json$/.exec(file.key);
        if (match && match[1] !== me) found.add(match[1]);
    }
    return [...found];
}

function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function pushToRelay() {
    const s = requireConfig();
    notify('info', '正在打包并上传…');

    const blob = await buildLocalBackup();
    const fileName = `${stamp()}.zip`;

    const put = await relayPut(snapshotKeyOf(s.deviceId, fileName), blob, 'application/zip');

    const latest = {
        device: s.deviceId,
        createdAt: new Date().toISOString(),
        fileName,
        size: put.size,
        sha256: put.sha256 || '',
    };
    await relayPut(
        latestKeyOf(s.deviceId),
        JSON.stringify(latest, null, 2),
        'application/json',
    );

    clearDirty();

    const removed = await pruneSnapshots(s.deviceId);
    const sizeMb = (put.size / 1024 / 1024).toFixed(1);
    notify('success', `已上传备份 ${fileName}（${sizeMb} MB）${removed ? `，清理了 ${removed} 个旧快照` : ''}`);
    return latest;
}

/** 只保留最近 N 个快照，避免中转被撑爆 */
async function pruneSnapshots(device) {
    const keep = Math.max(1, Number(settings().keepSnapshots) || 5);
    const prefix = `devices/${device}/snapshots/`;
    const files = (await relayList())
        .filter((file) => file.key.startsWith(prefix))
        .sort((a, b) => b.key.localeCompare(a.key)); // 文件名是时间戳，倒序即最新在前

    const stale = files.slice(keep);
    for (const file of stale) {
        await relayDelete(file.key);
    }
    return stale.length;
}

async function pullOne(device, latest) {
    notify('info', `正在从 ${device} 拉取备份…`);
    const blob = await relayGetBlob(snapshotKeyOf(device, latest.fileName));
    if (latest.size && blob.size !== latest.size) {
        throw new Error(`下载的备份大小对不上（期望 ${latest.size}，实际 ${blob.size}），可能传输中断，已放弃恢复`);
    }
    await restoreFromBlob(blob, latest.fileName);
    rememberPulled(device, markerOf(latest));
    return blob.size;
}

async function pullUpdates(updates) {
    // 恢复会整份替换磁盘数据，过程中酒馆会甩出一堆事件，那些不是用户改动，先挂起检测
    STATE.suppressDirty = true;
    let restored = 0;
    try {
        for (const item of updates) {
            await pullOne(item.device, item.latest);
            restored += 1;
        }
        clearDirty();
    } finally {
        // 数据换掉后前端内存还是旧的，事件可能还在往外冒，多压一会儿再放开
        setTimeout(() => { STATE.suppressDirty = false; }, 5000);
    }

    notify('success', `已恢复 ${restored} 个备份`);
    await offerReload();
}

/** 恢复是覆盖式的，酒馆内存里还是旧数据，必须刷新页面才看得到 */
async function offerReload() {
    const reload = await askUser(
        '数据已恢复。酒馆页面里还是旧内容，必须刷新才能加载新数据。',
        '立即刷新',
        '稍后自己刷',
    );
    if (reload) location.reload();
}

async function collectRemoteUpdates() {
    const devices = await discoverOtherDevices();
    const updates = [];
    for (const device of devices) {
        const latest = await readRemoteLatest(device);
        if (!latest || !latest.fileName) continue;
        if (markerOf(latest) !== seenMarker(device)) {
            updates.push({ device, latest });
        }
    }
    return updates;
}

/**
 * 智能同步：先看云端最新那份是"自己的"还是"对面设备的"，再决定拉还是推。
 * 拉之前先确认本机没有未上传的改动，避免把本机改动覆盖掉。
 */
async function syncNow() {
    if (STATE.busy) { notify('info', '正在同步中，请稍候'); return; }
    STATE.busy = true;
    renderStatus();

    try {
        requireConfig();
        const updates = await collectRemoteUpdates();
        const dirty = isDirty();

        if (!updates.length && !dirty) {
            notify('info', '云端没有更新，本机也没有改动，无需同步');
            return;
        }

        if (updates.length && dirty) {
            await resolveConflict(updates);
            return;
        }

        if (updates.length) { await pullUpdates(updates); return; }
        await pushToRelay();
    } catch (err) {
        console.error(LOG, err);
        notify('error', err.message);
    } finally {
        STATE.busy = false;
        renderStatus();
    }
}

/** 只上传，不拉取。给"使用期间每 30 分钟备份一次"用 —— 定时拉取会在聊天中途替换数据。 */
async function pushIfDirty() {
    if (STATE.busy) return;
    if (!isDirty()) {
        console.debug(LOG, '定时检查：本机没有改动，跳过');
        return;
    }
    STATE.busy = true;
    renderStatus();
    try {
        requireConfig();
        await pushToRelay();
    } catch (err) {
        console.error(LOG, err);
        notify('error', `定时备份失败：${err.message}`);
    } finally {
        STATE.busy = false;
        renderStatus();
    }
}

async function resolveConflict(updates) {
    const policy = settings().conflictPolicy;

    if (policy === 'skip') {
        notify('warn', '本地和中转都有改动，按设置「跳过」处理，本次未做任何操作');
        return;
    }

    if (policy === 'newest') {
        const remoteNewest = Math.max(...updates.map((u) => Date.parse(u.latest.createdAt) || 0));
        if (remoteNewest > (settings().localDirtySince || 0)) {
            notify('info', '中转的备份更新，采用中转版本');
            await pullUpdates(updates);
        } else {
            notify('info', '本地的改动更新，采用本地版本');
            await pushToRelay();
        }
        return;
    }

    const who = updates.map((u) => u.device).join('、');
    const useRemote = await askUser(
        `本地有还没上传的改动，云端「${who}」也有新的备份。\n两边都动过了，必须选一边，另一边的改动会丢掉。`,
        `用「${who}」的覆盖本机`,
        '用本机的覆盖云端',
    );
    if (useRemote) {
        await pullUpdates(updates);
    } else {
        await pushToRelay();
    }
}

/* ------------------------------------------------------------------- 界面 */

const PANEL_HTML = `
<div class="st-sync-panel">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>酒馆云同步</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <div class="st-sync-grid">
        <label for="st_sync_relay">中转地址</label>
        <input id="st_sync_relay" type="text" placeholder="https://你的中转服务域名" />

        <label for="st_sync_token">访问令牌</label>
        <input id="st_sync_token" type="password" placeholder="命名空间的令牌" />

        <label for="st_sync_namespace">命名空间</label>
        <input id="st_sync_namespace" type="text" placeholder="A" />

        <label for="st_sync_bucket">桶名</label>
        <input id="st_sync_bucket" type="text" placeholder="tavern" />

        <label for="st_sync_device">本机标识</label>
        <select id="st_sync_device">
          <option value="local">local（本地 TT 酒馆）</option>
          <option value="cloud">cloud（云酒馆）</option>
        </select>

        <label for="st_sync_auto">定时自动上传</label>
        <input id="st_sync_auto" type="checkbox" />

        <label for="st_sync_interval">间隔（分钟）</label>
        <input id="st_sync_interval" type="number" min="1" max="1440" />

        <label for="st_sync_onload">打开页面时自动检查</label>
        <input id="st_sync_onload" type="checkbox" />

        <label for="st_sync_conflict">冲突处理</label>
        <select id="st_sync_conflict">
          <option value="ask">每次询问我</option>
          <option value="newest">用较新的覆盖</option>
          <option value="skip">跳过，什么都不做</option>
        </select>

        <label for="st_sync_keep">保留快照数</label>
        <input id="st_sync_keep" type="number" min="1" max="50" />
      </div>

      <div class="st-sync-buttons">
        <div id="st_sync_btn_test" class="menu_button">测试连接</div>
        <div id="st_sync_btn_push" class="menu_button">上传到中转</div>
        <div id="st_sync_btn_pull" class="menu_button">从中转恢复</div>
        <div id="st_sync_btn_sync" class="menu_button">智能同步</div>
      </div>

      <div id="st_sync_status" class="st-sync-status">未同步</div>

      <div id="st_sync_confirm" class="st-sync-confirm" style="display: none;">
        <div id="st_sync_confirm_text" class="st-sync-confirm-text"></div>
        <div class="st-sync-buttons">
          <div id="st_sync_confirm_ok" class="menu_button"></div>
          <div id="st_sync_confirm_cancel" class="menu_button"></div>
        </div>
      </div>

      <div class="st-sync-hint">
        两台酒馆各装一份本扩展，<b>本机标识必须不同</b>（一台 local，一台 cloud）。<br />
        <b>打开页面时</b>：自动判断云端最新备份是本机还是对面的，云端更新就拉，本机有改动就推。<br />
        <b>使用期间</b>：按上面设定的间隔自动上传（只传不拉，不会打断你聊天）。<br />
        恢复是<b>整份覆盖</b>，不是合并。两边都改过时会先问你，不会闷头覆盖。
      </div>
    </div>
  </div>
</div>
`;

function bindField(selector, key, { number = false, checkbox = false } = {}) {
    const el = $(selector);
    const s = settings();
    if (checkbox) el.prop('checked', !!s[key]);
    else el.val(s[key]);

    const handler = () => {
        const s2 = settings();
        s2[key] = checkbox ? el.prop('checked') : (number ? Number(el.val()) || 0 : String(el.val()).trim());
        persist();
        if (key === 'deviceId' || key === 'autoSync' || key === 'intervalMin') {
            restartTimer();
            renderStatus();
        }
    };
    el.on(checkbox ? 'change' : 'input', handler);
}

/**
 * 面板内的确认框。
 *
 * 不用 window.confirm：在 Tauri 的 WebView 里它很可能不弹窗、直接返回 false，
 * 表现就是"点了按钮没反应"，或者在冲突时被静默当成选了"取消"而把数据推错方向。
 * 自己画两个按钮虽然土，但行为完全可控。
 */
function askUser(message, okLabel = '确定', cancelLabel = '取消') {
    if (!ui.confirmBox) {
        // 极端情况下面板还没建好，退回原生对话框
        return Promise.resolve(window.confirm(message));
    }

    return new Promise((resolve) => {
        ui.confirmText.textContent = message;
        ui.confirmOk.text('').text(okLabel);
        ui.confirmCancel.text('').text(cancelLabel);
        ui.confirmBox.show();

        const finish = (value) => {
            ui.confirmBox.hide();
            ui.confirmOk.off('click');
            ui.confirmCancel.off('click');
            resolve(value);
        };
        ui.confirmOk.on('click', () => finish(true));
        ui.confirmCancel.on('click', () => finish(false));
    });
}

function buildUI() {
    $('#extensions_settings').append(PANEL_HTML);
    ui = {
        status: document.getElementById('st_sync_status'),
        confirmBox: $('#st_sync_confirm'),
        confirmText: $('#st_sync_confirm_text'),
        confirmOk: $('#st_sync_confirm_ok'),
        confirmCancel: $('#st_sync_confirm_cancel'),
    };

    bindField('#st_sync_relay', 'relayUrl');
    bindField('#st_sync_token', 'token');
    bindField('#st_sync_namespace', 'namespace');
    bindField('#st_sync_bucket', 'bucket');
    bindField('#st_sync_device', 'deviceId');
    bindField('#st_sync_auto', 'autoSync', { checkbox: true });
    bindField('#st_sync_interval', 'intervalMin', { number: true });
    bindField('#st_sync_onload', 'checkOnLoad', { checkbox: true });
    bindField('#st_sync_conflict', 'conflictPolicy');
    bindField('#st_sync_keep', 'keepSnapshots', { number: true });

    $('#st_sync_btn_test').on('click', testConnection);
    $('#st_sync_btn_push').on('click', async () => {
        const go = await askUser('把本机数据打包上传到中转？只会新增一个快照，不动本机数据。', '上传', '取消');
        if (!go) return;
        STATE.busy = true; renderStatus();
        try {
            requireConfig();
            await pushToRelay();
        } catch (err) {
            notify('error', err.message);
        } finally {
            STATE.busy = false; renderStatus();
        }
    });
    $('#st_sync_btn_pull').on('click', async () => {
        try {
            requireConfig();
        } catch (err) {
            notify('error', err.message);
            return;
        }
        const s = settings();
        const other = s.deviceId === 'local' ? 'cloud' : 'local';
        const go = await askUser(
            `从中转拉取「${other}」的最新备份并覆盖本机？\n本机现有数据会被整份替换掉。`,
            '覆盖本机',
            '取消',
        );
        if (!go) return;
        STATE.busy = true; renderStatus();
        try {
            const updates = await collectRemoteUpdates();
            if (!updates.length) {
                notify('info', '没有可拉取的新备份');
            } else {
                await pullUpdates(updates);
            }
        } catch (err) {
            notify('error', err.message);
        } finally {
            STATE.busy = false; renderStatus();
        }
    });
    $('#st_sync_btn_sync').on('click', () => syncNow());

    renderStatus();
}

async function testConnection() {
    STATE.busy = true;
    renderStatus();
    try {
        requireConfig();
        const res = await relayFetch('/v1/meta');
        const json = await readJsonSafe(res);
        if (!res.ok) throw new Error(`HTTP ${res.status}：${json.error || ''}`);
        const files = await relayList();
        notify('success', `连接正常，令牌属于命名空间「${json.namespace}」，桶内现有 ${files.length} 个文件`);
    } catch (err) {
        notify('error', err.message);
    } finally {
        STATE.busy = false;
        renderStatus();
    }
}

/* --------------------------------------------------------------- 定时与事件 */

function restartTimer() {
    if (STATE.timer) {
        clearInterval(STATE.timer);
        STATE.timer = null;
    }
    const s = settings();
    if (!s.autoSync) return;
    const minutes = Math.max(1, Number(s.intervalMin) || 30);
    // 定时只做上传。定时拉取会在聊天途中把数据整份换掉，还会要求刷新页面，太扰民。
    STATE.timer = setInterval(() => {
        console.debug(LOG, '定时备份触发');
        pushIfDirty();
    }, minutes * 60 * 1000);
    console.debug(LOG, `已开启定时备份，每 ${minutes} 分钟一次`);
}

function subscribeEvents() {
    const context = ctx();
    const { eventSource, eventTypes } = context;
    if (!eventSource || !eventTypes) {
        console.warn(LOG, '拿不到 eventSource/eventTypes，本机改动将不会被自动标记');
        return;
    }

    // 这些事件都代表"本机数据真的变了"，用来置脏标记。
    // 不同版本事件名有增减，所以先过滤掉不存在的。
    //
    // 刻意不收 CHAT_CHANGED：那只是"切换了聊天"，数据没变。
    // 收进来会导致"打开看两眼就被判定成有改动"，进而把陈旧的本地数据推上去盖掉对面。
    const names = [
        'MESSAGE_SENT',
        'MESSAGE_RECEIVED',
        'MESSAGE_EDITED',
        'MESSAGE_DELETED',
        'CHAT_DELETED',
        'GROUP_CHAT_DELETED',
        'CHARACTER_EDITED',
        'CHARACTER_DELETED',
        'CHARACTER_DUPLICATED',
        'WORLDINFO_UPDATED',
        'SETTINGS_UPDATED',
    ];

    let bound = 0;
    for (const name of names) {
        const type = eventTypes[name];
        if (!type) continue;
        eventSource.on(type, () => markDirty(name));
        bound += 1;
    }
    console.debug(LOG, `已绑定 ${bound} 个事件用于检测改动`);
}

/* ------------------------------------------------------------------- 启动 */

async function init() {
    settings();

    // 等上下文就绪：扩展有可能比 app 初始化更早跑起来
    for (let i = 0; i < 40; i += 1) {
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            try {
                ctx();
                break;
            } catch { /* 继续等 */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    buildUI();
    subscribeEvents();
    restartTimer();

    const s = settings();
    if (s.checkOnLoad && String(s.relayUrl || '').trim() && String(s.token || '').trim()) {
        console.debug(LOG, '打开页面，检查云端最新备份是本地还是对面的');
        // 走完整的智能同步：云端更新就拉，本机有改动就推，两边都动了就走冲突策略。
        // 不会闷头覆盖 —— 只要两边都变过就会先问你。
        syncNow();
    }

    console.log(LOG, '扩展已加载');
}

jQuery(async () => {
    try {
        await init();
    } catch (err) {
        console.error(LOG, '初始化失败', err);
    }
});
