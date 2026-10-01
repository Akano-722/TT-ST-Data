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

/** 改 index.js 就把这个抬一下。手机上点完「更新」先看这一行，确认跑的到底是哪一版 */
const EXT_VERSION = '2026-10-01.4';

/**
 * 日志也往面板里记一份。
 *
 * 手机上没有控制台，`console.debug` 打给人看等于没打 —— 出了事只能看到"点了没反应"，
 * 一点线索都拿不到。所以同一个 log() 既进控制台也进面板，出问题直接截图面板就行。
 */
const LOG_MAX_LINES = 200;
const LOG_LINES = [];
/** 面板里默认只显示最后几行，剩下的点「复制全部」拿走 */
const LOG_TAIL_LINES = 10;

function logArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
}

function log(...args) {
    const line = args.map(logArg).join(' ');
    try { console.debug(LOG, line); } catch { /* 控制台没了也得往下走 */ }
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    LOG_LINES.push(`${stamp} ${line}`);
    if (LOG_LINES.length > LOG_MAX_LINES) LOG_LINES.splice(0, LOG_LINES.length - LOG_MAX_LINES);
    renderLog();
}

function logText() {
    return LOG_LINES.join('\n');
}

function renderLog() {
    if (!ui.log) return;
    ui.log.textContent = LOG_LINES.slice(-LOG_TAIL_LINES).join('\n');
    ui.log.scrollTop = ui.log.scrollHeight;
}

/** 手机上没法开控制台，所以日志得能拿走：优先剪贴板，不行就把全文摊开让用户长按选 */
async function copyLog() {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(logText());
            notify('success', `已复制 ${LOG_LINES.length} 行日志`);
            return;
        }
        throw new Error('剪贴板不可用');
    } catch {
        // WebView 里的自定义协议通常不是安全上下文，navigator.clipboard 直接没有。
        // 退而求其次：把完整日志摊进 <pre>（不再只显示尾巴）并全选，长按就能复制。
        //
        // 顺序不能反：notify 会顺手 log() 一行，而 log() 又会把面板刷成"只显示尾巴"，
        // 先摊开再提示的话，刚摊开的全文和选区都会被自己刷掉。
        notify('info', '剪贴板用不了，已把完整日志摊开，长按复制');
        if (!ui.log) return;
        ui.log.textContent = logText();
        try {
            const range = document.createRange();
            range.selectNodeContents(ui.log);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch { /* 选不中也无所谓，字摊开了就行 */ }
    }
}

/* ------------------------------------------------------------------ *
 * 超时
 *
 * 每个 fetch 都必须有超时，这不是"防御性编程"，是 TT 手机端实测出来的硬需求：
 * 消费 `POST /api/users/backup` 那个带 `Content-Disposition: attachment` 的大二进制流时，
 * 移动端 WebView 里的 fetch promise 可能**永远不 settle**（见 tools/tt-tavern-api.md 第 3 节）。
 * 没有超时的话 STATE.busy 卡在 true，状态栏永远"正在同步"，之后点什么都只回"正在忙"——
 * 整个扩展看起来就是死了。有超时，最坏也只是这一次同步失败，界面还能用。
 * ------------------------------------------------------------------ */
const TIMEOUT_MS = {
    relay: 60 * 1000,
    st: 60 * 1000,
    // 服务端要先把自己几百 MB 的数据打包成 zip 才开始回包，比普通请求慢得多
    backup: 180 * 1000,
};

/** 超时是我们自己掐断的，跟"网络连不上"是两回事，上层要分开报错 */
function isAbort(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
}

function timeoutError(what, timeoutMs) {
    const seconds = timeoutMs / 1000;
    // 不取整：测试里挂的是几百毫秒，取整会变成"0 秒没有响应"
    const shown = Number.isInteger(seconds) ? seconds : seconds.toFixed(1);
    const err = new Error(`${what} 超时：${shown} 秒没有响应，已中断`);
    err.isTimeout = true;
    return err;
}

/**
 * 带超时的 fetch。
 *
 * 用 AbortController 而不是 Promise.race：race 只是"我不等了"，请求其实还挂在后台、
 * 连接不断；abort 才是真把这条连接掐掉。
 *
 * 计时器一直留到 **body 读完** 才清，不是在拿到响应头时清 —— 卡住的正是读 body 那一步，
 * 头早就回来了。所以这里给 text/json/blob/arrayBuffer 包一层，读完（或读挂）才放计时器。
 *
 * 每步都记一行日志，状态栏也会实时显示"卡在哪一步、已经多久"，手机上不用开控制台就能看。
 */
async function timedFetch(url, options = {}, { timeoutMs = TIMEOUT_MS.st, what = '请求' } = {}) {
    const controller = new AbortController();
    const started = Date.now();

    // 状态栏跟着走：卡住时至少能看出是卡在哪一步、卡了多久
    STATE.step = what;
    renderStatus();

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        log(`${what} 发出（超时 ${timeoutMs / 1000}s）：${url}`);
        res = await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        clearTimeout(timer);
        if (isAbort(err)) {
            log(`${what} 超时，用时 ${Date.now() - started}ms`);
            throw timeoutError(what, timeoutMs);
        }
        log(`${what} 失败，用时 ${Date.now() - started}ms`, err);
        throw err;
    }
    log(`${what} 响应头到达：HTTP ${res.status}，用时 ${Date.now() - started}ms`);

    for (const method of ['text', 'json', 'blob', 'arrayBuffer']) {
        const original = res[method].bind(res);
        res[method] = async (...args) => {
            try {
                const value = await original(...args);
                log(`${what} body 读完，总共 ${Date.now() - started}ms`);
                return value;
            } catch (err) {
                if (isAbort(err)) {
                    // 这个分支就是 TT 手机端卡死的形态：头回来了、body 永远不结束
                    log(`${what} 读 body 超时（响应头 ${Date.now() - started}ms 前就到了），已中断`);
                    throw timeoutError(what, timeoutMs);
                }
                log(`${what} 读 body 失败`, err);
                throw err;
            } finally {
                clearTimeout(timer);
            }
        };
    }
    return res;
}

/* ------------------------------------------------------------------ *
 * 酒馆接口清单（都在 1.18.0 源码里逐个核对过，出处写在对应实现旁边）
 *
 * 上传这一侧只有两个：
 *   POST /api/users/backup   下载整份备份。请求体必须带 { handle }，不带就是 400
 *                            （users-private.js:146 读的正是 request.body.handle）
 *   GET  /api/users/me       取当前用户的 handle
 *
 * 恢复这一侧原版 ST **没有**"上传 zip 还原"的接口 —— 1.18.0 里根本不存在这种路由
 * （/api/backups 下只有 chat/get、chat/delete、chat/download 三条，那是聊天记录备份，
 * 跟用户数据备份是两码事）。所以那边只能**按类写回**：把 zip 拆开，每一类数据用
 * 酒馆前端自己也在用的"保存"接口写回去，见下面的 writeXxx。
 *
 * TT 酒馆则自带整包导入，走 DM_API（见 restoreViaNativeImport）。
 * 两条路怎么选见 pullOne。出处和依据都在 tools/tt-tavern-api.md。
 * ------------------------------------------------------------------ */
const ST_API = {
    download: { method: 'POST', url: '/api/users/backup' },
    me: { method: 'GET', url: '/api/users/me' },

    // —— 恢复时用到的写入接口 ——
    characterImport: '/api/characters/import',
    chatSave: '/api/chats/save',
    groupChatSave: '/api/chats/group/save',
    groupEdit: '/api/groups/edit',
    worldImport: '/api/worldinfo/import',
    themeSave: '/api/themes/save',
    presetSave: '/api/presets/save',
    quickReplySave: '/api/quick-replies/save',
    movingUiSave: '/api/moving-ui/save',
    backgroundUpload: '/api/backgrounds/upload',
    avatarUpload: '/api/avatars/upload',
    imageUpload: '/api/images/upload',
    fileUpload: '/api/files/upload',
    settingsSave: '/api/settings/save',
};

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
    lastPulled: {},        // { 设备id: 已拉取过的版本标记 }，用于判断"对方有没有变"

    // 恢复进度。一次恢复是几百个请求，iOS 上随时可能被杀掉，所以每写完一个文件
    // 就落盘一次，下次接着写，不用从头再来（见 restoreFromZip）。
    restoreProgress: null, // { marker: <这份备份的标识>, done: [路径…] }

    // 下面两个是运行状态，但必须落盘（见 markDirty 的注释）
    localDirty: false,     // 本机自上轮同步后有没有改动
    localDirtySince: 0,    // 首次变脏的时间，给 newest 策略比对用
};

const STATE = {
    busy: false,
    timer: null,
    ticker: null,         // 忙的时候每秒刷一次状态栏，好让"已 N 秒"真的在走
    busySince: 0,         // 这一轮是什么时候开始的
    step: '',             // 当前卡在哪一步（timedFetch 每次请求都会更新）
    lastResult: '',
    lastOk: null,
    suppressDirty: false, // 恢复数据期间挂起改动检测，避免把恢复本身误判成用户改动
    restore: null,        // 恢复进行中时是 { label, done, total }，用来在状态栏显示进度
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
    // 也进面板日志：手机上没有 toastr 或者弹窗一闪而过时，这里还能翻到
    log(`[${kind}] ${message}`);
    renderStatus();

    const t = window.toastr;
    if (!t) return;
    const fn = { success: t.success, info: t.info, warn: t.warning, error: t.error }[kind] || t.info;
    fn.call(t, message, '酒馆云同步');
}

/**
 * 开始/结束一轮同步。
 *
 * 单独抽出来是因为状态栏要在忙的时候**每秒重画**：卡死时"已 137 秒"一直在涨，
 * 比一个静止的"正在同步…"信息量大得多 —— 静止的分不出是卡住了还是马上就好。
 */
function beginBusy(what = '') {
    STATE.busy = true;
    STATE.busySince = Date.now();
    STATE.step = what;
    if (!STATE.ticker) STATE.ticker = setInterval(renderStatus, 1000);
    renderStatus();
}

function endBusy() {
    STATE.busy = false;
    STATE.busySince = 0;
    STATE.step = '';
    if (STATE.ticker) {
        clearInterval(STATE.ticker);
        STATE.ticker = null;
    }
    renderStatus();
}

function renderStatus() {
    if (!ui.status) return;
    const parts = [];
    if (STATE.restore) {
        // 恢复是几百个请求，得让人看见它在往前走，不然会以为卡死了
        parts.push(`⏳ 正在还原：${STATE.restore.label}　${STATE.restore.done}/${STATE.restore.total}`);
    } else if (STATE.busy) {
        const secs = STATE.busySince ? Math.floor((Date.now() - STATE.busySince) / 1000) : 0;
        parts.push(`⏳ ${STATE.step ? `${STATE.step}…` : '正在同步…'}　已 ${secs} 秒`);
    } else if (STATE.lastResult) parts.push(STATE.lastResult);

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
        return await timedFetch(base + pathname, { ...options, headers }, {
            timeoutMs: TIMEOUT_MS.relay,
            what: `中转 ${options.method || 'GET'} ${pathname}`,
        });
    } catch (err) {
        // 超时已经说清楚了是超时，别再包成"连不上"
        if (err && err.isTimeout) throw err;
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
        const res = await timedFetch(
            ST_API.me.url,
            { headers: ctx().getRequestHeaders() },
            { timeoutMs: TIMEOUT_MS.st, what: '取当前用户' },
        );
        if (res.ok) {
            const user = await res.json();
            handle = user && user.handle ? String(user.handle) : '';
        } else {
            log(`GET ${ST_API.me.url} 返回 HTTP ${res.status}，退回 default-user`);
        }
    } catch (err) {
        log('取当前用户失败，退回 default-user', err);
    }

    cachedHandle = handle || 'default-user';
    return cachedHandle;
}

async function buildLocalBackup() {
    // 平台分叉：TT 酒馆在 iOS 上拿不到 /api/users/backup 的字节（读 body 抛 forbidden path，
    // 见 tools/tt-tavern-api.md 第 3 节），只能逐类读、自己拼 zip；原版 ST 的备份接口是好的，
    // 保持原样别动 —— 那边后端直接打包，比逐类读快得多，也全得多。
    if (isTauriTavern()) return await buildTtBackup();

    const handle = await currentHandle();
    const res = await timedFetch(ST_API.download.url, {
        method: ST_API.download.method,
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ handle }),
    }, {
        timeoutMs: TIMEOUT_MS.backup,
        what: '酒馆生成备份',
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

/* ==================================================================== *
 * TT 酒馆的上传绕行：逐类读 + 自己拼 zip
 *
 * 为什么绕：iOS 上 `POST /api/users/backup` 的头能回来、body 读不出（TT 自己的 fs scope
 * 失误，`forbidden path`），这条路走不通了（tools/tt-tavern-api.md 第 3 节）。
 * 好在 TT 每个类都有"读"的接口，逐类读回来自己拼一个 zip 就行 ——
 * 布局照 restore 侧的规格来，云侧（原版 ST）的恢复逻辑一行都不用改。
 *
 * 接口全是 POST + JSON（和原版 ST 的 GET 不一样），出处 src/tauri/main/routes/*.js：
 *   /api/settings/get        整份设置。**世界书名单也在这里**（settings.world_names）
 *   /api/characters/all      角色卡列表（.avatar 是真实文件名，聊天目录名由它决定）
 *   /api/characters/export   {avatar_url, format:'png'} → 角色卡原始字节
 *   /api/characters/chats    {avatar_url} → 这个角色有哪些聊天
 *   /api/chats/get           {avatar_url, file_name} → 消息数组
 *   /api/groups/all          群组（.chats 是它的群聊 id 列表）
 *   /api/chats/group/get     {id} → 群聊消息数组
 *   /api/worldinfo/get       {name} → 世界书内容
 *
 * 读不出来的（TT 根本没提供读接口）：预设 / 主题 / 快捷回复 / 界面布局 / 图片 / 聊天附件。
 * 这几类跳过，并在日志里写明 —— 用户已经同意"尽力而为"，但得让人知道少了什么。
 * ==================================================================== */

const TT_API = {
    settingsGet: '/api/settings/get',
    charactersAll: '/api/characters/all',
    characterExport: '/api/characters/export',
    characterChats: '/api/characters/chats',
    chatGet: '/api/chats/get',
    groupsAll: '/api/groups/all',
    groupChatGet: '/api/chats/group/get',
    worldGet: '/api/worldinfo/get',
    backgroundsAll: '/api/backgrounds/all',
    avatarsGet: '/api/avatars/get',
};

/** TT 没有读接口的类，日志里点名跳过（接口名照抄源码，方便以后复核有没有补上） */
const TT_NO_READ_API = [
    ['/api/images/*', '图片'],
    ['/api/files/*', '聊天附件'],
];

/**
 * 预设类数据虽然各有 save/delete 接口，却都没有 list —— 但**全都平铺在
 * `/api/settings/get` 响应的兄弟字段上**（Rust 侧 `build_sillytavern_settings_response`
 * 逐个目录读盘再塞进响应），所以不需要新接口。
 *
 * 两种形状：
 *   - 对象数组：元素本身就是预设内容，名字在元素的 .name 里
 *   - 「内容 + 名字」两个平行数组：元素是文件的原始 JSON 文本，名字在 *_names 里
 *
 * 左边是响应字段名，右边是要落的 zip 目录 —— 目录名和云侧 `PRESET_DIRECTORIES` /
 * `classifyRestoreEntry` 完全一致，所以云侧一行都不用改。
 */
const TT_PRESET_FIELDS = [
    ['themes', 'themes'],
    ['movingUIPresets', 'movingUI'],
    ['quickReplyPresets', 'QuickReplies'],
    ['instruct', 'instruct'],
    ['context', 'context'],
    ['sysprompt', 'sysprompt'],
    ['reasoning', 'reasoning'],
];

const TT_AI_PRESET_FIELDS = [
    ['koboldai_settings', 'koboldai_setting_names', 'KoboldAI Settings'],
    ['novelai_settings', 'novelai_setting_names', 'NovelAI Settings'],
    ['openai_settings', 'openai_setting_names', 'OpenAI Settings'],
    ['textgenerationwebui_presets', 'textgenerationwebui_preset_names', 'TextGen Settings'],
];

/**
 * TT 的 JSON 读接口。
 * 复用 stFetch/stMustOk：同一份 getRequestHeaders、同一套超时和日志，
 * 而且这两个接口出错时都会老实回 `{error}`，stMustOk 认得出来。
 */
async function ttReadJson(url, body, what) {
    const { json } = await stMustOk(await stFetch(url, { json: body || {} }), what);
    return json;
}

/** 少数接口回的是原始字节（角色卡导出），走不了 JSON 那条路 */
async function ttReadBytes(url, body, what) {
    const res = await timedFetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body || {}),
    }, { timeoutMs: TIMEOUT_MS.st, what });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${what} 失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new Error(`${what}：酒馆回了个空文件`);
    return bytes;
}

/** 条目名里的单个文件名：带路径分隔符的一律不收，否则条目会跑到别的目录去 */
function ttSafeName(name) {
    const text = String(name === null || name === undefined ? '' : name);
    if (!text || text === '.' || text === '..' || /[\/\\]/.test(text)) return '';
    return text;
}

/** 相对路径（图片可能带子目录）：逐段检查，压平掉 '..' 这种 */
function ttSafePath(path) {
    const parts = String(path || '').split('/').map((part) => ttSafeName(part));
    return parts.every(Boolean) ? parts.join('/') : '';
}

/**
 * 从 `/api/settings/get` 的响应里取出真正的 settings 本体。
 *
 * TT 回的**不是**裸 settings，而是一个套壳：settings 本体被序列化成**字符串**放在
 * `.settings` 里，其余（world_names / themes / 各 AI 预设…）平铺成兄弟字段。
 * 直接把整个套壳当 settings.json 写进包，云侧恢复出来 `power_user` 就不存在了 ——
 * 用户人设的名字和描述（power_user.personas / persona_descriptions）会全空，
 * 只剩头像列表还在（那是另一个类）。真机恢复时踩到过。
 */
function ttSettingsBody(wrapper) {
    const raw = wrapper.settings;
    if (typeof raw === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new Error(`读设置：响应里的 settings 不是合法 JSON（${err.message}）`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('读设置：响应里的 settings 不是一个对象，读接口可能对不上');
        }
        return parsed;
    }
    // 万一哪天改成直接展开成对象，也认
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    throw new Error('读设置：响应里没有 settings 字段，读接口可能对不上');
}

/**
 * 预设文件的正文。
 * 平行数组里的元素是**文件的原始 JSON 文本**，对象数组里的元素是已经解析好的对象。
 * 文本要先验一下是不是合法 JSON：云侧 writePreset 会 stParseJson，塞进去一份坏文本
 * 只会让那一类的恢复整个失败，不如这里就不要它。
 */
function ttPresetData(value) {
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return null;
        try {
            JSON.parse(text);
        } catch {
            return null;
        }
        return text;
    }
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
    return null;
}

/** 预设的名字：对象看 .name，原始文本得先解开再看 .name */
function ttPresetName(value) {
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed.name === 'string' ? parsed.name : '';
        } catch {
            return '';
        }
    }
    if (value && typeof value === 'object' && typeof value.name === 'string') return value.name;
    return '';
}

/**
 * 把预设类写成 zip 条目。
 *
 * 目录名必须和云侧 `PRESET_DIRECTORIES` / `classifyRestoreEntry` 对得上，
 * 否则云侧认不出来，这一类就等于没备份。
 */
function collectTtPresets(wrapper, entries, skipped) {
    let ok = 0;
    let total = 0;

    const push = (dir, rawName, data) => {
        const safe = ttSafeName(rawName);
        if (!safe) {
            skipped.push(`${dir}：“${rawName}”名字里有路径分隔符，跳过`);
            return;
        }
        const name = `${dir}/${safe}.json`;
        // 同名预设只留第一条（真机上重名不该出现，但静默覆盖会让人以为备份全了）
        if (entries.some((entry) => entry.name === name)) {
            skipped.push(`${dir}：${safe} 重名，只留第一条`);
            return;
        }
        entries.push({ name, data });
        ok += 1;
    };

    for (const [field, dir] of TT_PRESET_FIELDS) {
        const list = Array.isArray(wrapper[field]) ? wrapper[field] : [];
        total += list.length;
        for (const item of list) {
            const data = ttPresetData(item);
            const name = ttPresetName(item);
            if (!data || !name) {
                skipped.push(`${dir}：有一条读不出内容或名字，跳过`);
                continue;
            }
            push(dir, name, data);
        }
    }

    for (const [field, namesField, dir] of TT_AI_PRESET_FIELDS) {
        const list = Array.isArray(wrapper[field]) ? wrapper[field] : [];
        const names = Array.isArray(wrapper[namesField]) ? wrapper[namesField] : [];
        total += list.length;
        for (let i = 0; i < list.length; i += 1) {
            const data = ttPresetData(list[i]);
            // 名字优先用平行数组里的（那是落盘文件名，最准），再退回内容里的 .name
            const name = ttSafeName(names[i]) || ttPresetName(list[i]);
            if (!data || !name) {
                skipped.push(`${dir}：有一条读不出内容或名字，跳过`);
                continue;
            }
            push(dir, name, data);
        }
    }

    if (total) log(`逐类读：预设/主题 ${ok}/${total} 条`);
}

/** 消息数组 → jsonl。云侧 stParseJsonl 是一行一条读回来的，格式必须对得上 */
function jsonlOf(messages, what) {
    if (!Array.isArray(messages)) throw new Error(`${what}：酒馆回的不是消息数组`);
    if (!messages.length) throw new Error(`${what}：没有任何消息`);
    return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

/**
 * 逐类把数据读出来，拼成 zip 条目的数组。
 *
 * 顺序照 RESTORE_ORDER 的意思来：角色卡 → 它的聊天 → 群组 → 群聊 → 世界书 → 设置（放最后）。
 * 每类都记一行日志：手机上出问题只能靠面板日志，必须看得出"读到哪一步、读到了多少"。
 *
 * @returns {Promise<{entries: Array, skipped: string[]}>}
 */
async function collectTtEntries() {
    const entries = [];
    const skipped = [];

    const step = (what) => {
        STATE.step = what;
        renderStatus();
    };

    // ---- 设置：整份最后的条目，但得先读，因为它里面还挂着世界书名单和各类预设 ----
    step('读设置');
    const wrapper = await ttReadJson(TT_API.settingsGet, {}, '读设置');
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
        throw new Error('读设置：酒馆回的不是一个对象，读接口可能对不上');
    }
    const settings = ttSettingsBody(wrapper);
    const worldNames = Array.isArray(wrapper.world_names) ? wrapper.world_names.filter(Boolean) : [];
    log(`逐类读：设置 1 份，里面记着 ${worldNames.length} 本世界书`);

    // ---- 角色卡 + 每个角色的聊天 ----
    const characters = await ttReadJson(TT_API.charactersAll, {}, '列角色卡');
    const cards = (Array.isArray(characters) ? characters : [])
        .map((item) => ({ avatar: ttSafeName(item && item.avatar) }))
        .filter((card) => card.avatar);
    log(`逐类读：角色卡 ${cards.length} 张`);

    for (const card of cards) {
        // 聊天目录名 = 头像文件名去掉 .png（TT 侧 resolveCharacterDirectoryId 的规则），
        // 云侧 writeChat 又拿它反推回 `<card>.png`，两头必须一致
        const stem = card.avatar.replace(/\.png$/i, '');
        step(`导出角色卡 ${card.avatar}`);
        try {
            const bytes = await ttReadBytes(
                TT_API.characterExport,
                { avatar_url: card.avatar, format: 'png' },
                `导出角色卡 ${card.avatar}`,
            );
            entries.push({ name: `characters/${card.avatar}`, data: bytes });
        } catch (err) {
            log(`跳过角色卡 ${card.avatar}`, err);
            skipped.push(`角色卡 ${card.avatar}：${err.message}`);
            continue; // 卡片都没读到，它的聊天也就不管了
        }

        let chats;
        try {
            chats = await ttReadJson(TT_API.characterChats, { avatar_url: card.avatar }, `列 ${stem} 的聊天`);
        } catch (err) {
            log(`列 ${stem} 的聊天失败`, err);
            skipped.push(`${stem} 的聊天列表：${err.message}`);
            continue;
        }

        for (const chat of Array.isArray(chats) ? chats : []) {
            const fileId = ttSafeName(chat && (chat.file_id || chat.file_name));
            if (!fileId) continue;
            const id = fileId.replace(/\.jsonl$/i, '');
            step(`读聊天 ${id}`);
            try {
                const messages = await ttReadJson(
                    TT_API.chatGet,
                    { avatar_url: card.avatar, file_name: `${id}.jsonl` },
                    `读聊天 ${id}`,
                );
                entries.push({ name: `chats/${stem}/${id}.jsonl`, data: jsonlOf(messages, `聊天 ${id}`) });
            } catch (err) {
                log(`跳过聊天 ${id}`, err);
                skipped.push(`聊天 ${stem}/${id}：${err.message}`);
            }
        }
    }

    // ---- 群组 + 群聊 ----
    const groups = await ttReadJson(TT_API.groupsAll, {}, '列群组');
    const groupList = Array.isArray(groups) ? groups : [];
    log(`逐类读：群组 ${groupList.length} 个`);

    for (const group of groupList) {
        const groupId = ttSafeName(group && (group.id || group.chat_id));
        if (!groupId) continue;
        entries.push({ name: `groups/${groupId}.json`, data: JSON.stringify(group, null, 2) });

        // 群聊 id 列表：chats 是历史，chat_id 是当前，取并集免得漏
        const chatIds = new Set(Array.isArray(group.chats) ? group.chats.filter(Boolean) : []);
        if (group.chat_id) chatIds.add(group.chat_id);

        for (const rawId of chatIds) {
            const chatId = ttSafeName(rawId);
            if (!chatId) continue;
            step(`读群聊 ${chatId}`);
            try {
                const messages = await ttReadJson(TT_API.groupChatGet, { id: chatId }, `读群聊 ${chatId}`);
                entries.push({ name: `group chats/${chatId}.jsonl`, data: jsonlOf(messages, `群聊 ${chatId}`) });
            } catch (err) {
                log(`跳过群聊 ${chatId}`, err);
                skipped.push(`群聊 ${chatId}：${err.message}`);
            }
        }
    }

    // ---- 世界书（名字来自 settings.world_names，TT 没有"列世界书"的接口）----
    let worldOk = 0;
    for (const name of worldNames) {
        const safe = ttSafeName(name);
        if (!safe) {
            skipped.push(`世界书 ${name}：名字里有路径分隔符，跳过`);
            continue;
        }
        step(`读世界书 ${safe}`);
        try {
            const data = await ttReadJson(TT_API.worldGet, { name }, `读世界书 ${safe}`);
            entries.push({ name: `worlds/${safe}.json`, data: JSON.stringify(data, null, 2) });
            worldOk += 1;
        } catch (err) {
            log(`跳过世界书 ${safe}`, err);
            skipped.push(`世界书 ${safe}：${err.message}`);
        }
    }
    log(`逐类读：世界书 ${worldOk}/${worldNames.length} 本`);

    // ---- 预设 / 主题 / 快捷回复 / 界面布局 / 各 AI 预设：平铺在设置响应的兄弟字段上 ----
    collectTtPresets(wrapper, entries, skipped);

    // ---- 背景图 / 用户头像：TT 只给"名字列表"，字节得自己按前端那套相对路径去取 ----
    await collectTtImages(entries, skipped);

    // ---- 设置放最后 ----
    entries.push({ name: 'settings.json', data: JSON.stringify(settings, null, 2) });

    // ---- 读不出来的类，点名跳过 ----
    for (const [api, label] of TT_NO_READ_API) {
        skipped.push(`跳过${label}：TT 没有读接口（${api}）`);
    }

    return { entries, skipped };
}

/**
 * `/api/backgrounds/all` 的 images[] 元素**是个对象** `{filename, isAnimated}`，
 * 不是字符串（TT 前端自己也有这层兼容，backgrounds.js:119）。
 * 早先这里 `String(raw)` 会拼成 `backgrounds/[object Object]`，28 张背景一张都取不到。
 */
function ttBackgroundName(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.filename === 'string') return entry.filename;
    return '';
}

/** 用户头像列表真机上是字符串数组；对象形状也认一手，别再赌形状 */
function ttAvatarName(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
        for (const key of ['filename', 'name', 'avatar']) {
            if (typeof entry[key] === 'string') return entry[key];
        }
    }
    return '';
}

/**
 * 图片的相对 URL。TT 前端的 `getBackgroundPath()` 走的是 `encodeURIComponent`，
 * 头像那条路（`User Avatars/<名字>`）在真机上也是编码过的 —— 服务端会解开。
 * 但背景图可能在子目录里，整段编码会把 '/' 也编掉，所以**逐段**编码：既转义空格和
 * 中文，又保住路径分隔符。
 */
function ttImageUrl(dir, rel) {
    return `${dir}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 背景图和用户头像的字节：TT 这两个类只提供"名字列表"接口，图片本身交给 Tauri 的
 * asset 协议 / 前端的相对路径去取（后端并没有一个"按路径读文件"的 HTTP 接口）。
 *
 * 所以这里是**尽力而为**：照前端用的相对路径取一次，取回来不是图片（多半是前端页面
 * 的 HTML，状态码还是 200）就当没有，记进 skipped。宁可少这一类，也不往包里塞垃圾。
 */
async function collectTtImages(entries, skipped) {
    const fetchImage = async (url, what) => {
        try {
            const res = await timedFetch(url, { method: 'GET' }, { timeoutMs: TIMEOUT_MS.st, what });
            if (!res.ok) return null;
            const type = String(res.headers.get('content-type') || '');
            if (!/^image\//i.test(type)) return null;
            const bytes = new Uint8Array(await res.arrayBuffer());
            return bytes.length ? bytes : null;
        } catch (err) {
            log(`${what} 取不到`, err);
            return null;
        }
    };

    let bgOk = 0;
    let bgTotal = 0;
    try {
        const list = await ttReadJson(TT_API.backgroundsAll, {}, '列背景图');
        const images = (list && Array.isArray(list.images)) ? list.images : [];
        bgTotal = images.length;
        for (const raw of images) {
            const rel = ttBackgroundName(raw);
            if (!rel) continue;
            // 自定义 URL（http 开头）本来就不在备份里，是用户外链
            if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
            const safe = ttSafePath(rel);
            if (!safe) continue;
            const bytes = await fetchImage(ttImageUrl('backgrounds', rel), `取背景图 ${rel}`);
            if (!bytes) continue;
            entries.push({ name: `backgrounds/${safe}`, data: bytes });
            bgOk += 1;
        }
    } catch (err) {
        log('列背景图失败', err);
        skipped.push(`背景图：${err.message}`);
    }
    if (bgTotal && bgOk < bgTotal) {
        skipped.push(`背景图：${bgTotal} 张里只取到 ${bgOk} 张`);
    }

    let avatarOk = 0;
    let avatarTotal = 0;
    try {
        const list = await ttReadJson(TT_API.avatarsGet, {}, '列用户头像');
        const names = (Array.isArray(list) ? list : []).map((item) => ttAvatarName(item)).filter(Boolean);
        avatarTotal = names.length;
        for (const raw of names) {
            const safe = ttSafeName(raw);
            if (!safe) continue;
            const bytes = await fetchImage(ttImageUrl('User Avatars', raw), `取用户头像 ${safe}`);
            if (!bytes) continue;
            entries.push({ name: `User Avatars/${safe}`, data: bytes });
            avatarOk += 1;
        }
    } catch (err) {
        log('列用户头像失败', err);
        skipped.push(`用户头像：${err.message}`);
    }
    if (avatarTotal && avatarOk < avatarTotal) {
        skipped.push(`用户头像：${avatarTotal} 张里只取到 ${avatarOk} 张`);
    }
}

/** TT 上传侧入口：逐类读 → 拼 zip → 交给 pushToRelay 原样 PUT */
async function buildTtBackup() {
    log('本机是 TT 酒馆：逐类读数据、自己拼 zip（iOS 上 /api/users/backup 读不出 body）');

    const { entries, skipped } = await collectTtEntries();
    if (!entries.length) throw new Error('没能从酒馆读到任何数据，先看面板日志');

    const blob = buildZip(entries);
    log(`拼好 zip：${entries.length} 个条目，${(blob.size / 1048576).toFixed(2)} MB`);

    if (skipped.length) {
        log(`有 ${skipped.length} 项没进包：`);
        for (const line of skipped) log(`  · ${line}`);
    }
    return blob;
}

/* ==================================================================== *
 * 浏览器端 zip 解包
 *
 * 为什么不用现成的库：这个文件一条 import 都不能有（见文件头），而且备份包动辄
 * 几百 MB，整包读进内存会让 iOS 的 WebView 直接崩。所以下面按需切片：
 * 只先把中央目录读出来，之后每读一个文件才 slice 一次 —— 内存里同时
 * 只有"当前这个文件"那么大。
 * ==================================================================== */
// ==== ZIP-READER-BEGIN ====

const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_SIG_EOCD64 = 0x06064b50;
const ZIP_SIG_EOCD64_LOCATOR = 0x07064b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_SIG_LOCAL = 0x04034b50;

/** zip 的注释最长 65535 字节，所以中央目录结尾一定落在末尾这么多个字节里 */
const ZIP_MAX_COMMENT = 0xffff;

const DEFLATE_LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const DEFLATE_LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DEFLATE_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEFLATE_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** 动态 Huffman 里"码长"那棵树的码长按这个顺序排放，不是按数值顺序 */
const DEFLATE_CODELEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function zipU16(view, offset) {
    return view.getUint16(offset, true);
}

function zipU32(view, offset) {
    return view.getUint32(offset, true);
}

/**
 * zip 规范里文件名要么是 UTF-8（置了 bit 11），要么是 CP437。
 * archiver 对非 ASCII 名字会置 bit 11 写 UTF-8，但别的打包器可能不置、直接写本地编码，
 * 中文名就会变成乱码。所以 UTF-8 解出替换字符时，再用 GBK 试一次。
 */
function decodeZipName(bytes) {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!utf8.includes('�')) return utf8;
    try {
        const gbk = new TextDecoder('gbk').decode(bytes);
        return gbk.includes('�') ? utf8 : gbk;
    } catch {
        return utf8;
    }
}

/* ---------------- 纯 JS 的 DEFLATE 解压 ---------------- */

function makeBitReader(input) {
    let pos = 0;
    let buf = 0;
    let count = 0;
    return {
        bit() {
            if (count === 0) {
                if (pos >= input.length) throw new Error('压缩数据提前结束');
                buf = input[pos];
                pos += 1;
                count = 8;
            }
            const value = buf & 1;
            buf >>= 1;
            count -= 1;
            return value;
        },
        bits(n) {
            let value = 0;
            for (let i = 0; i < n; i += 1) value |= this.bit() << i;
            return value;
        },
        align() {
            count = 0;
        },
        alignedByte() {
            if (count !== 0) throw new Error('内部错误：按字节读之前没有对齐');
            if (pos >= input.length) throw new Error('压缩数据提前结束');
            const value = input[pos];
            pos += 1;
            return value;
        },
    };
}

/** 按 DEFLATE 的规范构造一棵 Huffman 解码表（就是 zlib 里 puff 那套） */
function huffmanFromLengths(lengths) {
    const counts = new Int32Array(16);
    for (let i = 0; i < lengths.length; i += 1) counts[lengths[i]] += 1;
    counts[0] = 0;

    const offsets = new Int32Array(16);
    for (let i = 1; i < 16; i += 1) offsets[i] = offsets[i - 1] + counts[i - 1];

    const symbols = new Int32Array(lengths.length);
    for (let sym = 0; sym < lengths.length; sym += 1) {
        const len = lengths[sym];
        if (len) {
            symbols[offsets[len]] = sym;
            offsets[len] += 1;
        }
    }
    return { counts, symbols };
}

function decodeHuffman(bits, huffman) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len += 1) {
        code |= bits.bit();
        const count = huffman.counts[len];
        if (code - first < count) return huffman.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    throw new Error('压缩数据里的 Huffman 码无效');
}

let fixedHuffman = null;

function buildFixedHuffman() {
    const lit = new Uint8Array(288);
    for (let i = 0; i < 144; i += 1) lit[i] = 8;
    for (let i = 144; i < 256; i += 1) lit[i] = 9;
    for (let i = 256; i < 280; i += 1) lit[i] = 7;
    for (let i = 280; i < 288; i += 1) lit[i] = 8;
    const dist = new Uint8Array(30).fill(5);
    return { lit: huffmanFromLengths(lit), dist: huffmanFromLengths(dist) };
}

function readDynamicHuffman(bits) {
    const litCount = bits.bits(5) + 257;
    const distCount = bits.bits(5) + 1;
    const codeLenCount = bits.bits(4) + 4;

    const codeLenLengths = new Uint8Array(19);
    for (let i = 0; i < codeLenCount; i += 1) codeLenLengths[DEFLATE_CODELEN_ORDER[i]] = bits.bits(3);
    const codeLenHuffman = huffmanFromLengths(codeLenLengths);

    const lengths = new Uint8Array(litCount + distCount);
    let i = 0;
    while (i < lengths.length) {
        const sym = decodeHuffman(bits, codeLenHuffman);
        if (sym < 16) {
            lengths[i] = sym;
            i += 1;
            continue;
        }
        let repeat = 0;
        let value = 0;
        if (sym === 16) {
            if (i === 0) throw new Error('压缩数据里第一个码长就是"重复上一个"');
            value = lengths[i - 1];
            repeat = 3 + bits.bits(2);
        } else if (sym === 17) {
            repeat = 3 + bits.bits(3);
        } else {
            repeat = 11 + bits.bits(7);
        }
        if (i + repeat > lengths.length) throw new Error('重复的码长超过了声明的数量');
        for (let k = 0; k < repeat; k += 1) {
            lengths[i] = value;
            i += 1;
        }
    }

    return {
        lit: huffmanFromLengths(lengths.subarray(0, litCount)),
        dist: huffmanFromLengths(lengths.subarray(litCount)),
    };
}

/**
 * 解一段 raw deflate。
 *
 * 只在浏览器没有 DecompressionStream 时才会走到这里（iOS 上要 16.4 以上才有）。
 * expectedSize 是 zip 中央目录里记的原大小，有它就能一次性开好缓冲区 ——
 * 既省掉反复扩容，也能当场发现解压结果不对。
 */
function inflateRawJs(input, expectedSize) {
    const bits = makeBitReader(input);
    let out = new Uint8Array(expectedSize > 0 ? expectedSize : 1 << 16);
    let len = 0;

    const ensure = (need) => {
        if (len + need <= out.length) return;
        if (expectedSize > 0) throw new Error('解压出来的数据比 zip 里声明的还大，文件可能损坏');
        let size = out.length * 2;
        while (size < len + need) size *= 2;
        const bigger = new Uint8Array(size);
        bigger.set(out.subarray(0, len));
        out = bigger;
    };

    for (;;) {
        const isLast = bits.bit();
        const type = bits.bits(2);

        if (type === 0) {
            // 未压缩块：先对齐到字节边界，再读长度（含反码校验）
            bits.align();
            const size = bits.alignedByte() | (bits.alignedByte() << 8);
            const inverse = bits.alignedByte() | (bits.alignedByte() << 8);
            if (size !== (inverse ^ 0xffff)) throw new Error('未压缩块的长度校验失败，文件可能损坏');
            ensure(size);
            for (let i = 0; i < size; i += 1) {
                out[len] = bits.alignedByte();
                len += 1;
            }
        } else if (type === 1 || type === 2) {
            if (!fixedHuffman) fixedHuffman = buildFixedHuffman();
            const huffman = type === 1 ? fixedHuffman : readDynamicHuffman(bits);

            for (;;) {
                const sym = decodeHuffman(bits, huffman.lit);
                if (sym < 256) {
                    ensure(1);
                    out[len] = sym;
                    len += 1;
                    continue;
                }
                if (sym === 256) break;

                const lenIndex = sym - 257;
                if (lenIndex >= DEFLATE_LEN_BASE.length) throw new Error('压缩数据里的长度码超出范围');
                const copyLen = DEFLATE_LEN_BASE[lenIndex] + bits.bits(DEFLATE_LEN_EXTRA[lenIndex]);

                const distSym = decodeHuffman(bits, huffman.dist);
                if (distSym >= DEFLATE_DIST_BASE.length) throw new Error('压缩数据里的距离码超出范围');
                const distance = DEFLATE_DIST_BASE[distSym] + bits.bits(DEFLATE_DIST_EXTRA[distSym]);
                if (distance > len) throw new Error('回溯距离超出了已经解出的数据，文件可能损坏');

                ensure(copyLen);
                // 必须逐字节拷：源和目标是重叠的，这就是 deflate 表达重复内容的方式
                for (let i = 0; i < copyLen; i += 1) {
                    out[len] = out[len - distance];
                    len += 1;
                }
            }
        } else {
            throw new Error('压缩数据里有非法的块类型');
        }

        if (isLast) break;
    }

    return out.subarray(0, len);
}

/** 优先用浏览器原生解压，没有（或失败）就退回上面那份纯 JS 实现 */
async function inflateRaw(bytes, expectedSize) {
    if (typeof DecompressionStream === 'function') {
        try {
            const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        } catch (err) {
            console.warn(LOG, '浏览器原生解压失败，改用内置解压', err);
        }
    }
    return inflateRawJs(bytes, expectedSize);
}

/* ---------------- zip 读取器 ---------------- */

class ZipReader {
    constructor(blob) {
        this.blob = blob;
        this.entries = [];
    }

    /** 从尾部倒着找中央目录结尾，再看要不要读 Zip64 记录，最后把中央目录整段解出来 */
    async parse() {
        const tailLength = Math.min(this.blob.size, ZIP_MAX_COMMENT + 22);
        const tailStart = this.blob.size - tailLength;
        const tail = new DataView(await this.blob.slice(tailStart).arrayBuffer());

        let eocdAt = -1;
        for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
            if (zipU32(tail, i) !== ZIP_SIG_EOCD) continue;

            // 光认出这 4 个字节不够：zip 注释里可能就带着 PK\x05\x06，
            // 而注释排在真 EOCD 后面，从尾往前扫会先撞上它，把注释字节当成目录长度、
            // 目录偏移读，最后整个包被判成损坏。判据是：真 EOCD 后面跟的注释长度
            // 正好顶到文件末尾。对不上就继续往前找，别停在这个假货上。
            // （Python 的 zipfile 就栽在这里，它源码里明写了"假设注释不含这个魔数"，
            //   而这份假设在 1.18.0 上不成立 —— 见 tools/zip-reader-test/。）
            if (tailStart + i + 22 + zipU16(tail, i + 20) === this.blob.size) {
                eocdAt = i;
                break;
            }
        }
        if (eocdAt < 0) throw new Error('这不是一个 zip 文件（找不到中央目录结尾）');

        let total = zipU16(tail, eocdAt + 10);
        let centralSize = zipU32(tail, eocdAt + 12);
        let centralOffset = zipU32(tail, eocdAt + 16);

        // 条目数或偏移溢出时（>65535 个文件 / >4GB），真值在 Zip64 记录里
        if (total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
            const zip64 = await this.readZip64(tailStart + eocdAt);
            if (zip64) {
                total = zip64.total;
                centralSize = zip64.centralSize;
                centralOffset = zip64.centralOffset;
            }
        }

        if (centralOffset + centralSize > this.blob.size) {
            throw new Error('备份文件不完整（中央目录超出了文件末尾）');
        }

        const central = new DataView(
            await this.blob.slice(centralOffset, centralOffset + centralSize).arrayBuffer(),
        );

        let p = 0;
        for (let i = 0; i < total; i += 1) {
            // 尾部有脏数据就停在这儿，已经解析出来的照用，别为几个坏条目把整包丢掉
            if (p + 46 > central.byteLength || zipU32(central, p) !== ZIP_SIG_CENTRAL) {
                console.warn(LOG, `中央目录在第 ${i} 条中断，已解析 ${this.entries.length} 条`);
                break;
            }

            const method = zipU16(central, p + 10);
            let compSize = zipU32(central, p + 20);
            let uncompSize = zipU32(central, p + 24);
            const nameLength = zipU16(central, p + 28);
            const extraLength = zipU16(central, p + 30);
            const commentLength = zipU16(central, p + 32);
            let localOffset = zipU32(central, p + 42);

            const nameBytes = new Uint8Array(central.buffer, central.byteOffset + p + 46, nameLength);

            // Zip64：哪个字段是 0xFFFFFFFF，扩展区里就按顺序补哪个 8 字节值
            if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
                let ep = p + 46 + nameLength;
                const extraEnd = ep + extraLength;
                while (ep + 4 <= extraEnd) {
                    const headerId = zipU16(central, ep);
                    const dataSize = zipU16(central, ep + 2);
                    if (headerId === 0x0001) {
                        let dp = ep + 4;
                        const take = () => {
                            const value = Number(central.getBigUint64(dp, true));
                            dp += 8;
                            return value;
                        };
                        if (uncompSize === 0xffffffff) uncompSize = take();
                        if (compSize === 0xffffffff) compSize = take();
                        if (localOffset === 0xffffffff) localOffset = take();
                        break;
                    }
                    ep += 4 + dataSize;
                }
            }

            this.entries.push({
                name: decodeZipName(nameBytes),
                method,
                compSize,
                uncompSize,
                offset: localOffset,
            });

            p += 46 + nameLength + extraLength + commentLength;
        }

        return this.entries;
    }

    async readZip64(eocdAbs) {
        const locatorAt = eocdAbs - 20;
        if (locatorAt < 0) return null;

        const locator = new DataView(await this.blob.slice(locatorAt, locatorAt + 20).arrayBuffer());
        if (zipU32(locator, 0) !== ZIP_SIG_EOCD64_LOCATOR) return null;

        const recordAt = Number(locator.getBigUint64(8, true));
        if (recordAt + 56 > this.blob.size) return null;

        const record = new DataView(await this.blob.slice(recordAt, recordAt + 56).arrayBuffer());
        if (zipU32(record, 0) !== ZIP_SIG_EOCD64) return null;

        return {
            total: Number(record.getBigUint64(32, true)),
            centralSize: Number(record.getBigUint64(40, true)),
            centralOffset: Number(record.getBigUint64(48, true)),
        };
    }

    /** 只读这一个文件的字节：按中央目录记的偏移切出来，再按需解压 */
    async readBytes(entry) {
        const head = new DataView(await this.blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
        if (zipU32(head, 0) !== ZIP_SIG_LOCAL) {
            throw new Error(`中央目录指向的位置不是文件头：${entry.name}`);
        }
        const nameLength = zipU16(head, 26);
        const extraLength = zipU16(head, 28);
        const start = entry.offset + 30 + nameLength + extraLength;

        const raw = new Uint8Array(await this.blob.slice(start, start + entry.compSize).arrayBuffer());
        if (entry.method === 0) return raw;
        if (entry.method === 8) return await inflateRaw(raw, entry.uncompSize);
        throw new Error(`zip 用了不支持的压缩方式 ${entry.method}：${entry.name}`);
    }

    async readText(entry) {
        return new TextDecoder('utf-8').decode(await this.readBytes(entry));
    }

    async readBlob(entry, mime = 'application/octet-stream') {
        return new Blob([await this.readBytes(entry)], { type: mime });
    }
}

// ==== ZIP-READER-END ====

/* ==================================================================== *
 * 浏览器端 zip 打包（store-only）
 *
 * 只给 TT 酒馆的上传侧用：iOS 上拿不到 /api/users/backup 的字节（见 tools/tt-tavern-api.md
 * 第 3 节），只能自己逐类读、自己拼一个 zip。拼出来的包要能被**云侧那份 ZipReader**读回去，
 * 也要能和酒馆自己导出的包长得一样 —— 所以布局、文件名都得照 restore 侧的规格来。
 *
 * 为什么只 store（method 0）不 deflate：
 *   1. 压缩得引第三方库，而这个文件一条 import 都不能有（见文件头）；
 *   2. 包里主要是 PNG/JPEG（本来就压过）和聊天 JSONL，压不压体积差不了多少。
 * 代价是包比"酒馆自己导出的"大一些，换来的是零依赖、字节完全可预测。
 * 云侧 ZipReader 读到 method 0 是原样返回、不校验 CRC，兼容没问题。
 * ==================================================================== */
// ==== ZIP-WRITER-BEGIN ====

/** 解压需要的版本号：store 其实 1.0 就够，写 2.0 是所有解压器都吃的通用值 */
const ZIP_WRITER_VERSION = 20;
/** bit 11：文件名按 UTF-8 编码存（中文名/中文角色卡必须置，否则到处乱码） */
const ZIP_FLAG_UTF8 = 0x0800;
/** 条目数、单条目大小都用 16/32 位字段存，超了就要 Zip64 —— 这里不做，超了直接报错 */
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_BYTES = 0xffffffff;

const zipTextEncoder = new TextEncoder();

let crc32Table = null;

/**
 * 标准 CRC-32（IEEE 802.3，和 zlib/zip 用的是同一个多项式）。
 * zip 规范要求每个文件都带上内容的 CRC，校验不过的解压器会直接判包损坏。
 */
function crc32(bytes) {
    if (!crc32Table) {
        crc32Table = new Uint32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let c = i;
            for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            crc32Table[i] = c >>> 0;
        }
    }

    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** 条目的内容可以是字符串（当 UTF-8 文本）、Uint8Array 或 ArrayBuffer，统一成字节数组 */
function zipBytes(data) {
    if (typeof data === 'string') return zipTextEncoder.encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('zip 条目的内容只能是字符串、Uint8Array 或 ArrayBuffer');
}

/** DOS 时间戳：zip 头里用的是 1980 起的年月日 + 2 秒精度的时分秒 */
function zipDosStamp(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/**
 * 打一个 store-only 的 zip。
 *
 * 不建目录项：解压侧按路径前缀分类（classifyRestoreEntry），不需要目录条目，
 * 而目录条目有时还会被某些解压器当成"空文件"处理，多余。
 *
 * @param {Array<{name: string, data: string|Uint8Array|ArrayBuffer}>} entries
 * @param {{date?: Date}} [options] 时间戳，测试里固定住用
 * @returns {Blob}
 */
function buildZip(entries, { date } = {}) {
    const list = (entries || []).filter((item) => item && item.name);
    if (list.length > ZIP_MAX_ENTRIES) {
        throw new Error(`条目太多（${list.length} 个），超过 zip 的 65535 上限，需要 Zip64 —— 不做了`);
    }

    const stamp = zipDosStamp(date);
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const item of list) {
        const nameBytes = zipTextEncoder.encode(String(item.name));
        const data = zipBytes(item.data);
        if (data.length > ZIP_MAX_BYTES || offset + data.length > ZIP_MAX_BYTES) {
            throw new Error(`条目 ${item.name} 太大，超过 4GB 上限，需要 Zip64 —— 不做了`);
        }
        const sum = crc32(data);

        // 局部头 + 内容：解压器实际是顺着中央目录找过来的，但头部字段必须自洽
        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, ZIP_SIG_LOCAL, true);
        lv.setUint16(4, ZIP_WRITER_VERSION, true);
        lv.setUint16(6, ZIP_FLAG_UTF8, true);
        lv.setUint16(8, 0, true);                 // method 0 = store
        lv.setUint16(10, stamp.time, true);
        lv.setUint16(12, stamp.date, true);
        lv.setUint32(14, sum, true);
        lv.setUint32(18, data.length, true);      // 未压缩大小
        lv.setUint32(22, data.length, true);      // 压缩后大小（store 时两者相同）
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);                // 扩展区长度
        local.set(nameBytes, 30);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, ZIP_SIG_CENTRAL, true);
        cv.setUint16(4, ZIP_WRITER_VERSION, true);   // version made by（高字节 0 = MS-DOS/FAT）
        cv.setUint16(6, ZIP_WRITER_VERSION, true);   // version needed
        cv.setUint16(8, ZIP_FLAG_UTF8, true);
        cv.setUint16(10, 0, true);                   // method
        cv.setUint16(12, stamp.time, true);
        cv.setUint16(14, stamp.date, true);
        cv.setUint32(16, sum, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);                   // 扩展区长度
        cv.setUint16(32, 0, true);                   // 注释长度
        cv.setUint16(34, 0, true);                   // 起始磁盘号
        cv.setUint16(36, 0, true);                   // 内部属性
        cv.setUint32(38, 0, true);                   // 外部属性（没建目录项，权限位无所谓）
        cv.setUint32(42, offset, true);              // 对应局部头的偏移
        central.set(nameBytes, 46);

        localParts.push(local, data);
        centralParts.push(central);
        offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((n, part) => n + part.length, 0);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, ZIP_SIG_EOCD, true);
    ev.setUint16(4, 0, true);                        // 本磁盘号
    ev.setUint16(6, 0, true);                        // 中央目录起始磁盘号
    ev.setUint16(8, list.length, true);              // 本磁盘上的条目数
    ev.setUint16(10, list.length, true);             // 总条目数
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);                  // 中央目录起始偏移
    ev.setUint16(20, 0, true);                       // 注释长度

    // 内容直接进 Blob（浏览器里按引用算，不会先拷进 JS 堆），只有头是现拼的
    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

// ==== ZIP-WRITER-END ====

/* ==================================================================== *
 * 恢复：把备份拆开，按类用酒馆自己的"保存"接口写回去
 *
 * 有两个地方必须在脑子里记住：
 *  1. 这是**合并式还原**，只覆盖同名文件，不删除本机多出来的东西。
 *     全量接口本来就不提供"删掉备份里没有的"，所以别指望它把本机清成对面的样子。
 *  2. 顺序不能乱：聊天记录是按"角色卡文件名"分目录存的，
 *     所以角色卡必须先落地，否则聊天会全部对不上号。settings.json 放最后。
 * ==================================================================== */

/**
 * 酒馆接口的通用调用。multipart 时不能带 Content-Type，否则浏览器补不上 boundary。
 * method 只有 data-migration 的 job 查询要用 GET，其余全是 POST。
 */
async function stFetch(url, { json, multipart, method = 'POST' } = {}) {
    const headers = { ...ctx().getRequestHeaders() };
    let body;
    if (multipart) {
        delete headers['Content-Type'];
        delete headers['content-type'];
        body = multipart;
    } else if (json !== undefined) {
        body = JSON.stringify(json);
    }
    return timedFetch(url, { method, headers, body }, {
        timeoutMs: TIMEOUT_MS.st,
        what: `酒馆 ${method} ${url}`,
    });
}

/**
 * 检查酒馆的响应。
 * 注意 `/api/characters/import` 出错时**HTTP 状态码仍然是 200**，只在 body 里放
 * `{ error: true }`（characters.js:1595），所以光看 res.ok 会把失败当成功。
 */
async function stMustOk(res, what) {
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            // 有些接口（背景图上传）成功时回的是纯文本文件名，不是 JSON
        }
    }

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
    }
    if (json && json.error) {
        throw new Error(`酒馆拒绝了这次请求：${JSON.stringify(json).slice(0, 200)}`);
    }
    return { json, text };
}

function stParseJson(text, what) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`${what} 不是合法的 JSON：${err.message}`);
    }
}

/** jsonl → 消息数组。酒馆写盘时是一行一个 JSON，读回来要还原成数组。 */
function stParseJsonl(text) {
    const messages = [];
    let broken = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            messages.push(JSON.parse(trimmed));
        } catch {
            // 单行坏掉就跳过它，把剩下的救回来，最后统计一次报告出去
            broken += 1;
        }
    }
    return { messages, broken };
}

function base64FromBytes(bytes) {
    let binary = '';
    const chunk = 0x8000; // 分块拼字符串，绕开 apply 的参数个数上限
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** assets/ 和 extensions/ 之类没有写入接口的目录会被跳过，这里也顺带挡掉打包工具的垃圾 */
const RESTORE_SKIP_PREFIXES = [
    'thumbnails/',  // 纯缩略图缓存，删了酒馆会自己重建
    'vectors/',     // 向量库，重建要重跑 embedding，代价太大
    'backups/',     // 酒馆自己产生的快照
    'extensions/',  // 扩展私有文件，没有写入口
    'assets/',      // 角色画廊/贴纸，酒馆只提供了读和删的接口，没有写
    'user/workflows/', // ComfyUI 工作流，没有写入口
    '__MACOSX/',    // 打包工具塞进来的垃圾
];

/** 预设是分散在好几个目录里的，接口靠 apiId 区分往哪个目录写（presets.js:16-38） */
const PRESET_DIRECTORIES = {
    'OpenAI Settings': 'openai',
    'TextGen Settings': 'textgenerationwebui',
    'KoboldAI Settings': 'kobold',
    'NovelAI Settings': 'novel',
    'instruct': 'instruct',
    'context': 'context',
    'sysprompt': 'sysprompt',
    'reasoning': 'reasoning',
};

const RESTORE_ORDER = [
    'character', 'world', 'group', 'chat', 'groupChat',
    'theme', 'preset', 'quickReply', 'movingUI',
    'background', 'userAvatar', 'userImage', 'userFile',
    'settings', // 放最后：它引用了前面那些东西（头像、角色卡、预设名）
];

const RESTORE_LABELS = {
    character: '角色卡', world: '世界书', group: '群组', chat: '聊天记录',
    groupChat: '群聊记录', theme: '主题', preset: '预设', quickReply: '快捷回复',
    movingUI: '界面布局', background: '背景图', userAvatar: '用户头像',
    userImage: '图片', userFile: '聊天附件', settings: '设置',
};

/** 单个附件超过这个大小就不还原了：要转成 base64 塞进 JSON，大文件会把内存顶爆 */
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/** 把备份里的一个路径归类到"用哪个接口写回去"；返回 null 表示这类不管 */
function classifyRestoreEntry(name) {
    if (name.endsWith('/')) return null; // 目录项本身

    const parts = name.split('/');
    const base = parts[parts.length - 1];
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
    const stem = dot < 0 ? base : base.slice(0, dot);
    const top = parts[0];

    if (name === 'settings.json') return { kind: 'settings' };

    if (top === 'characters' && parts.length >= 2) {
        return ['png', 'json', 'yaml', 'yml', 'charx', 'byaf'].includes(ext)
            ? { kind: 'character', base } : null;
    }
    // chats/<角色卡文件名>/<聊天文件名>.jsonl
    if (top === 'chats' && parts.length >= 3 && ext === 'jsonl') {
        return { kind: 'chat', base, stem, card: parts[1] };
    }
    if (top === 'group chats' && parts.length === 2 && ext === 'jsonl') {
        return { kind: 'groupChat', base, stem };
    }
    if (top === 'groups' && parts.length === 2 && ext === 'json') {
        return { kind: 'group', base, stem };
    }
    if (top === 'worlds' && parts.length === 2 && ext === 'json') return { kind: 'world', base, stem };
    if (top === 'themes' && parts.length === 2 && ext === 'json') return { kind: 'theme', base, stem };
    if (top === 'QuickReplies' && parts.length === 2 && ext === 'json') return { kind: 'quickReply', base, stem };
    if (top === 'movingUI' && parts.length === 2 && ext === 'json') return { kind: 'movingUI', base, stem };
    if (top === 'backgrounds' && parts.length >= 2 && base) return { kind: 'background', base };
    if (top === 'User Avatars' && parts.length === 2 && base) return { kind: 'userAvatar', base };
    if (top === 'user' && parts[1] === 'images' && parts.length >= 3 && base) {
        return { kind: 'userImage', base, stem, dir: parts.length > 3 ? parts.slice(2, -1).join('/') : '' };
    }
    if (top === 'user' && parts[1] === 'files' && parts.length === 3 && base) {
        return { kind: 'userFile', base };
    }
    if (PRESET_DIRECTORIES[top] && parts.length === 2 && ext === 'json') {
        return { kind: 'preset', base, stem, apiId: PRESET_DIRECTORIES[top] };
    }
    return null;
}

/* ---------------- 每一类的写法 ---------------- */

async function writeCharacter(entry, reader, info) {
    const blob = await reader.readBlob(entry);
    const ext = info.base.slice(info.base.lastIndexOf('.') + 1).toLowerCase();
    const form = new FormData();
    form.append('avatar', blob, info.base);
    form.append('file_type', ext);
    // preserved_name 决定卡片最终叫什么名字。聊天记录是按"卡片文件名"分目录存的，
    // 这里不保住名字，恢复完的聊天就会全部挂到别的卡上（characters.js:1552）。
    form.append('preserved_name', info.base);
    await stMustOk(await stFetch(ST_API.characterImport, { multipart: form }), `导入角色卡 ${info.base}`);
}

async function writeChat(entry, reader, info) {
    const text = await reader.readText(entry);
    const { messages, broken } = stParseJsonl(text);
    if (broken) console.warn(LOG, `${entry.name} 里有 ${broken} 行解析失败，已跳过`);
    if (!messages.length) throw new Error('聊天文件里没有任何消息');

    await stMustOk(await stFetch(ST_API.chatSave, {
        json: {
            // 服务端只做 avatar_url.replace('.png','') 来推卡片名，所以必须带上 .png
            avatar_url: `${info.card}.png`,
            file_name: info.stem,
            chat: messages,
            // 旧聊天文件带 integrity 元数据，不传 force 会被拦成 400 {error:'integrity'}
            force: true,
        },
    }), `写入聊天 ${entry.name}`);
}

async function writeGroupChat(entry, reader, info) {
    const { messages, broken } = stParseJsonl(await reader.readText(entry));
    if (broken) console.warn(LOG, `${entry.name} 里有 ${broken} 行解析失败，已跳过`);
    if (!messages.length) throw new Error('群聊文件里没有任何消息');

    await stMustOk(await stFetch(ST_API.groupChatSave, {
        json: { id: info.stem, chat: messages, force: true },
    }), `写入群聊 ${entry.name}`);
}

async function writeGroup(entry, reader, info) {
    const group = stParseJson(await reader.readText(entry), entry.name);
    // edit 是把整个 body 原样写成 groups/<id>.json，所以 id 必须补上（groups.js:190）
    if (!group.id) group.id = info.stem;
    await stMustOk(await stFetch(ST_API.groupEdit, { json: group }), `写入群组 ${info.stem}`);
}

async function writeWorld(entry, reader, info) {
    const form = new FormData();
    // 服务端拿上传的文件名当世界书的名字，所以文件名要原样带上
    form.append('avatar', await reader.readBlob(entry), info.base);
    await stMustOk(await stFetch(ST_API.worldImport, { multipart: form }), `导入世界书 ${info.base}`);
}

async function writeTheme(entry, reader, info) {
    const theme = stParseJson(await reader.readText(entry), entry.name);
    if (!theme.name) theme.name = info.stem;
    await stMustOk(await stFetch(ST_API.themeSave, { json: theme }), `写入主题 ${theme.name}`);
}

async function writePreset(entry, reader, info) {
    const preset = stParseJson(await reader.readText(entry), entry.name);
    await stMustOk(await stFetch(ST_API.presetSave, {
        json: { preset, name: info.stem, apiId: info.apiId },
    }), `写入预设 ${info.stem}`);
}

async function writeQuickReply(entry, reader, info) {
    const set = stParseJson(await reader.readText(entry), entry.name);
    if (!set.name) set.name = info.stem;
    await stMustOk(await stFetch(ST_API.quickReplySave, { json: set }), `写入快捷回复 ${set.name}`);
}

async function writeMovingUI(entry, reader, info) {
    // 这个文件本身就是接口的请求体（服务端原样写盘），所以原样发回去就行
    const body = stParseJson(await reader.readText(entry), entry.name);
    if (!body.name) body.name = info.stem;
    await stMustOk(await stFetch(ST_API.movingUiSave, { json: body }), `写入界面布局 ${body.name}`);
}

async function writeBackground(entry, reader, info) {
    const form = new FormData();
    // 服务端用上传的文件名当落盘名；背景目录里的子目录会被 sanitize 拍平，这里只传文件名
    form.append('avatar', await reader.readBlob(entry), info.base);
    await stMustOk(await stFetch(ST_API.backgroundUpload, { multipart: form }), `上传背景图 ${info.base}`);
}

async function writeUserAvatar(entry, reader, info) {
    const form = new FormData();
    form.append('avatar', await reader.readBlob(entry), info.base);
    // 不给 overwrite_name 的话，服务端会拿时间戳当文件名，恢复完头像就全变了
    form.append('overwrite_name', info.base);
    await stMustOk(await stFetch(ST_API.avatarUpload, { multipart: form }), `上传用户头像 ${info.base}`);
}

async function writeUserImage(entry, reader, info) {
    const bytes = new Uint8Array(await reader.readBytes(entry));
    const body = {
        image: base64FromBytes(bytes),
        format: info.base.slice(info.base.lastIndexOf('.') + 1).toLowerCase(),
    };
    if (info.dir) body.ch_name = info.dir;
    body.filename = info.stem;
    await stMustOk(await stFetch(ST_API.imageUpload, { json: body }), `上传图片 ${entry.name}`);
}

async function writeUserFile(entry, reader, info) {
    const bytes = new Uint8Array(await reader.readBytes(entry));
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return { skipped: `附件 ${info.base} 有 ${(bytes.length / 1048576).toFixed(1)} MB，超过上限已跳过` };
    }
    await stMustOk(await stFetch(ST_API.fileUpload, {
        json: { name: info.base, data: base64FromBytes(bytes) },
    }), `上传附件 ${info.base}`);
    return null;
}

async function writeSettings(entry, reader) {
    // 这个接口把 body 原样写成 settings.json（settings.js:206），所以必须原封不动发回去
    const body = stParseJson(await reader.readText(entry), 'settings.json');
    await stMustOk(await stFetch(ST_API.settingsSave, { json: body }), '写入 settings.json');
}

const RESTORE_WRITERS = {
    character: writeCharacter,
    world: writeWorld,
    group: writeGroup,
    chat: writeChat,
    groupChat: writeGroupChat,
    theme: writeTheme,
    preset: writePreset,
    quickReply: writeQuickReply,
    movingUI: writeMovingUI,
    background: writeBackground,
    userAvatar: writeUserAvatar,
    userImage: writeUserImage,
    userFile: writeUserFile,
    settings: writeSettings,
};

/**
 * 把一份备份 zip 还原到本机。
 *
 * 每一步都往 localStorage 记进度：一次恢复是几百个请求，iOS 上随时可能被系统杀掉，
 * 没有进度就得从头再来一遍。marker 是这份备份的标识，换了备份就重新开始。
 */
async function restoreFromZip(blob, { marker, fileName }) {
    notify('info', '正在读取备份…');

    const reader = new ZipReader(blob);
    await reader.parse();

    const tasks = [];
    for (const entry of reader.entries) {
        if (RESTORE_SKIP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
        const info = classifyRestoreEntry(entry.name);
        if (info) tasks.push({ ...info, entry, name: entry.name });
        else console.debug(LOG, '备份里这个文件不认识，跳过：', entry.name);
    }
    if (!tasks.length) throw new Error('这份备份里没有能还原的数据（可能不是酒馆的用户备份？）');

    const orderOf = new Map(RESTORE_ORDER.map((kind, index) => [kind, index]));
    tasks.sort((a, b) => (orderOf.get(a.kind) - orderOf.get(b.kind)) || a.name.localeCompare(b.name));

    const s = settings();
    const progress = (s.restoreProgress && s.restoreProgress.marker === marker)
        ? s.restoreProgress
        : { marker, done: [] };
    s.restoreProgress = progress;
    const done = new Set(progress.done);
    const alreadyDone = tasks.filter((task) => done.has(task.name)).length;

    const skipped = [];
    let written = 0;

    try {
        for (let i = 0; i < tasks.length; i += 1) {
            const task = tasks[i];
            if (done.has(task.name)) continue;

            STATE.restore = { label: RESTORE_LABELS[task.kind] || task.kind, done: i + 1, total: tasks.length };
            renderStatus();

            try {
                const result = await RESTORE_WRITERS[task.kind](task.entry, reader, task);
                if (result && result.skipped) skipped.push(result.skipped);
                // 只有写成功的才记进度；失败的留着，下次同步会再试一遍
                done.add(task.name);
                progress.done = [...done];
            } catch (err) {
                // 单个文件失败不该让整次恢复前功尽弃：记下来接着写下一个，最后一次性报告
                log(`还原失败 ${task.name}`, err);
                skipped.push(`${task.name}：${err.message}`);
            }

            persist();
            written += 1;
        }
    } finally {
        STATE.restore = null;
    }

    // 记账用完就清掉，免得下次换一份备份时拿它当进度
    s.restoreProgress = null;
    persist();

    return { written, skipped, alreadyDone, total: tasks.length, fileName };
}

/* ------------------------------------------------------------ TT 原生整包导入 */

/**
 * 是不是 TT 酒馆（Tauri/Rust 重写版）。
 * 出处：TT 源码 docs/API/Migration.md —— `if (window.__TAURITAVERN__)`。原版 ST 这里是 undefined。
 */
function isTauriTavern() {
    return !!window.__TAURITAVERN__;
}

/**
 * 恢复方式的说明文案。
 * 两条路的语义不一样，不能拿"按类写回"那套保证去描述原生整包导入 ——
 * 后端怎么合并是它的事，我们只知道它接受了这份包。
 */
function restoreModeHint() {
    return isTauriTavern()
        ? '交给酒馆原生的「数据迁移」整包导入，由酒馆后端自己拆包落盘'
        : '按类把对面的数据写回本机，同名覆盖';
}

const DM_API = {
    import: '/api/extensions/data-migration/import',
    job: '/api/extensions/data-migration/job',
};

const JOB_POLL_INTERVAL_MS = 1200;     // 官方前端 JOB_POLL_INTERVAL_MS 就是这个值
const JOB_TIMEOUT_MS = 15 * 60 * 1000; // 整包导入要落盘几百个文件，给足时间
/** 终态就这三个，其余都算还在跑 */
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TT 酒馆专属的恢复路径：把 zip 整包交给内置的「数据迁移」扩展，让后端自己拆包落盘。
 *
 * 为什么分叉：原版 ST 根本没有"导入备份"这个接口，只能靠 restoreFromZip 按类写回
 * （几百个请求、几百次判断）；而 TT 的 data-migration 后端本来就直接吃原版 ST 导出的 zip
 * （manifest 里的 SILLYTAVERN_MIGRATION_COPY_KEY 写得很明白），一条请求搞定，
 * 快得多，也不怕中途某个写入失败。
 *
 * 代价：进度在服务端，进程被杀就没了 —— 不像 restoreFromZip 能靠 localStorage 续传。
 */
async function restoreViaNativeImport(blob, fileName) {
    notify('info', '正在把备份交给酒馆导入…');

    const form = new FormData();
    // 第三个参数是文件名，后端 materializeUploadFile 拿它当 preferredName
    form.append('archive', blob, fileName || 'backup.zip');

    const submitted = await stMustOk(
        await stFetch(DM_API.import, { multipart: form }),
        '提交导入任务',
    );
    const jobId = submitted.json && submitted.json.job_id;
    if (!jobId) {
        throw new Error(`酒馆没返回 job_id，导入没跑起来：${String(submitted.text || '').slice(0, 200)}`);
    }

    log('导入任务已提交：', jobId);
    return waitForImportJob(jobId, fileName);
}

async function waitForImportJob(jobId, fileName) {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let lastStage = '';

    try {
        for (;;) {
            if (Date.now() > deadline) {
                throw new Error(`导入等了 ${JOB_TIMEOUT_MS / 60000} 分钟还没结束，已放弃（酒馆那边可能还在跑）`);
            }

            // 先查再睡（和酒馆自带的 data-migration 一个顺序），别白等一个间隔
            // 这里刻意不用 stMustOk：job 状态体在失败时**本身就带 `error` 字段**，
            // 而 stMustOk 一见 error 就当成"酒馆拒绝了这次请求"，会把失败原因吃掉。
            const res = await stFetch(`${DM_API.job}?id=${encodeURIComponent(jobId)}`, { method: 'GET' });
            const text = await res.text().catch(() => '');
            if (!res.ok) {
                throw new Error(`查询导入进度失败 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
            }
            const json = text ? stParseJson(text, '导入进度') : {};
            // 有的版本把状态包在 job/status 里，有的直接平铺，两种都认
            const job = (json && json.state) ? json : ((json && (json.job || json.status)) || {});

            if (job.stage && job.stage !== lastStage) {
                lastStage = job.stage;
                log(`导入阶段：${job.stage}${job.message ? ` — ${job.message}` : ''}`);
            }
            const percent = Number(job.progress_percent);
            STATE.restore = {
                label: job.stage || '酒馆导入中',
                done: Number.isFinite(percent) ? Math.round(percent) : 0,
                total: 100,
            };
            renderStatus();

            if (!TERMINAL_JOB_STATES.has(job.state)) {
                await sleep(JOB_POLL_INTERVAL_MS);
                continue;
            }

            if (job.state === 'completed') {
                // 数据已经落盘了，但没对上账，得让下次同步重来一遍
                const skipped = job.reconcile_error ? [`对账失败：${job.reconcile_error}`] : [];
                return { native: true, written: 0, total: 0, alreadyDone: 0, skipped, fileName };
            }
            if (job.state === 'cancelled') throw new Error('导入被取消了');
            throw new Error(`导入失败：${job.error || job.message || '酒馆没给出原因'}`);
        }
    } finally {
        STATE.restore = null;
    }
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
        log(`读 ${device} 的 latest.json 失败`, err);
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

    // TT 酒馆有原生整包导入，一条请求搞定；原版 ST 没有这个接口，只能拆开按类写回。
    const report = isTauriTavern()
        ? await restoreViaNativeImport(blob, latest.fileName)
        : await restoreFromZip(blob, {
            marker: markerOf(latest) || latest.fileName,
            fileName: latest.fileName,
        });

    // 有文件没写成，就先别记账。记了账等于"这份已经拿过了"，失败的那些再没机会重试；
    // 不记账的话下次同步会重拉一遍，把没写完的补上（写过的会按进度跳过）。
    if (!report.skipped.length) rememberPulled(device, markerOf(latest));

    return report;
}

async function pullUpdates(updates) {
    // 恢复期间酒馆会甩出一堆事件，那些不是用户改动，先挂起检测
    STATE.suppressDirty = true;
    let files = 0;
    let nativeCount = 0;
    const skipped = [];
    try {
        for (const item of updates) {
            const report = await pullOne(item.device, item.latest);
            if (report.native) nativeCount += 1;
            files += report.written;
            skipped.push(...report.skipped);
        }
        clearDirty();
    } finally {
        // 数据换掉后前端内存还是旧的，事件可能还在往外冒，多压一会儿再放开
        setTimeout(() => { STATE.suppressDirty = false; }, 5000);
    }

    // 原生整包导入是在服务端落盘的，前端拿不到"写了几个文件"，只能按份数报
    const summary = nativeCount
        ? `已整包导入 ${nativeCount} 份备份`
        : `已还原 ${files} 个文件`;

    if (skipped.length) {
        notify('warn',
            `${summary}，${skipped.length} 项有问题（下次同步会重试）：\n` +
            skipped.slice(0, 5).join('\n') +
            (skipped.length > 5 ? `\n…还有 ${skipped.length - 5} 项，详见控制台` : ''));
    } else {
        notify('success', summary);
    }
    await offerReload();
}

/**
 * 恢复完之后必须尽快刷新页面，而不只是"建议刷新"：
 * 酒馆内存里的设置还是旧的，而它是会往 settings.json 回写的 ——
 * 拖得越久，刚还原好的设置越可能被内存里那份旧设置覆盖回去。
 */
async function offerReload() {
    const reload = await askUser(
        '数据已还原。酒馆内存里还是旧内容，必须刷新才能加载。\n' +
        '⚠️ 别在这时候继续操作 —— 酒馆会把旧的设置写回磁盘，把刚还原好的覆盖掉。',
        '立即刷新',
        '稍后自己刷（有风险）',
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
    beginBusy('智能同步');

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
        log('同步出错', err);
        notify('error', err.message);
    } finally {
        endBusy();
    }
}

/** 只上传，不拉取。给"使用期间每 30 分钟备份一次"用 —— 定时拉取会在聊天中途替换数据。 */
async function pushIfDirty() {
    if (STATE.busy) return;
    if (!isDirty()) {
        log('定时检查：本机没有改动，跳过');
        return;
    }
    beginBusy('定时备份');
    try {
        requireConfig();
        await pushToRelay();
    } catch (err) {
        log('定时备份出错', err);
        notify('error', `定时备份失败：${err.message}`);
    } finally {
        endBusy();
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
        `本地有还没上传的改动，云端「${who}」也有新的备份。\n` +
        '两边都动过了，只能选一边：选中的这方会覆盖另一方改过的那些文件。\n' +
        '本机独有的内容不会被删掉（还原是按类写回，不是清空重来）。',
        `用「${who}」的写回本机`,
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

      <div class="st-sync-logbox">
        <div class="st-sync-loghead">
          <span>运行日志（手机上出问题就截图这里）</span>
          <span id="st_sync_log_copy" class="st-sync-logcopy">复制全部</span>
        </div>
        <pre id="st_sync_log" class="st-sync-log"></pre>
      </div>

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
        恢复方式：<span id="st_sync_restore_mode">（加载中…）</span>。<br />
        两边都改过时会先问你，不会闷头覆盖。
      </div>

      <div class="st-sync-hint">
        版本 <b id="st_sync_version">?</b>　—　点完「更新」后确认这里变了，没变就是没更上（要硬刷新/重开 App）
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
        // 确认框要是滚出可视区了，看起来就跟"点了没反应"一模一样。
        // 状态栏先喊一声，至少让人知道还差一步。
        ui.confirmBox[0]?.scrollIntoView?.({ block: 'nearest' });
        STATE.lastResult = `⚠️ 等你确认：点下面的「${okLabel}」`;
        STATE.lastOk = null;
        renderStatus();

        const finish = (value) => {
            ui.confirmBox.hide();
            ui.confirmOk.off('click');
            ui.confirmCancel.off('click');
            STATE.lastResult = '';
            renderStatus();
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
        restoreMode: document.getElementById('st_sync_restore_mode'),
        log: document.getElementById('st_sync_log'),
        logCopy: document.getElementById('st_sync_log_copy'),
        version: document.getElementById('st_sync_version'),
        confirmBox: $('#st_sync_confirm'),
        confirmText: $('#st_sync_confirm_text'),
        confirmOk: $('#st_sync_confirm_ok'),
        confirmCancel: $('#st_sync_confirm_cancel'),
    };

    if (ui.version) ui.version.textContent = EXT_VERSION;
    if (ui.logCopy) $(ui.logCopy).on('click', copyLog);
    renderLog();   // 面板晚于最早那几条日志建好，把之前记下的补画上去

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

    // 两条恢复路径的语义不一样，如实写出来，别让人以为哪台都是"只覆盖不删除"
    if (ui.restoreMode) ui.restoreMode.textContent = restoreModeHint();

    $('#st_sync_btn_test').on('click', testConnection);

    $('#st_sync_btn_push').on('click', async () => {
        // 点一下就得有痕迹：手机上"什么都没发生"最难查，先落一行再说
        log('点击「上传到中转」');
        if (STATE.busy) { notify('info', '正在忙，等当前操作结束'); return; }
        const go = await askUser('把本机数据打包上传到中转？只会新增一个快照，不动本机数据。', '上传', '取消');
        log(`确认框：${go ? '确认上传' : '已取消'}`);
        if (!go) return;
        beginBusy('打包上传');
        try {
            requireConfig();
            await pushToRelay();
        } catch (err) {
            notify('error', err.message);
        } finally {
            endBusy();
        }
    });

    $('#st_sync_btn_pull').on('click', async () => {
        log('点击「从中转恢复」');
        if (STATE.busy) { notify('info', '正在忙，等当前操作结束'); return; }
        try {
            requireConfig();
        } catch (err) {
            notify('error', err.message);
            return;
        }

        const s = settings();
        const other = s.deviceId === 'local' ? 'cloud' : 'local';

        // 这个是"我就是要拉对面那份"，所以不看"有没有新备份"——直接读对面的 latest.json。
        // 上次还原到一半被打断的话，进度会让人接着写，不用从头再来。
        let latest = null;
        try {
            latest = await readRemoteLatest(other);
        } catch (err) {
            notify('error', err.message);
            return;
        }
        if (!latest || !latest.fileName) {
            notify('warn', `中转上没有「${other}」的备份，先在对面点一次「上传到中转」`);
            return;
        }

        const go = await askUser(
            `从中转拉取「${other}」的备份（${latest.fileName}）？\n` +
            `${restoreModeHint()}。\n` +
            '结束后需要刷新页面。',
            '开始还原',
            '取消',
        );
        log(`确认框：${go ? '确认还原' : '已取消'}`);
        if (!go) return;

        beginBusy('还原');
        try {
            await pullUpdates([{ device: other, latest }]);
        } catch (err) {
            notify('error', err.message);
        } finally {
            endBusy();
        }
    });

    $('#st_sync_btn_sync').on('click', () => {
        log('点击「智能同步」');
        syncNow();
    });

    renderStatus();
}

async function testConnection() {
    if (STATE.busy) { notify('info', '正在忙，等当前操作结束'); return; }
    beginBusy('测试连接');
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
        endBusy();
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

    // 这行最先要看到：确认手机上跑的到底是哪一版。update 之后没变就是没更上。
    log(`扩展已加载，版本 ${EXT_VERSION}`);
    log(`origin=${location.origin}　运行时=${isTauriTavern() ? 'TT 酒馆' : '原版 ST'}`
        + `　AbortController=${typeof AbortController === 'function' ? '有' : '没有！'}`
        + `　fetch=${typeof fetch === 'function' ? '有' : '没有！'}`);

    const s = settings();
    if (s.checkOnLoad && String(s.relayUrl || '').trim() && String(s.token || '').trim()) {
        console.debug(LOG, '打开页面，检查云端最新备份是本地还是对面的');
        // 走完整的智能同步：云端更新就拉，本机有改动就推，两边都动了就走冲突策略。
        // 不会闷头覆盖 —— 只要两边都变过就会先问你。
        syncNow();
    }

}

jQuery(async () => {
    try {
        await init();
    } catch (err) {
        console.error(LOG, '初始化失败', err);
    }
});
