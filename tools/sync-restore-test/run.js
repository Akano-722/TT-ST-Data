#!/usr/bin/env node
'use strict';

/**
 * 「超时」和「TT 原生导入分叉」的实测。
 *
 * 测的是 `extension/st-sync/index.js` 的**真实源码**：整份文件丢进 new Function，
 * 把 window / document / jQuery / fetch / location 这几个浏览器全局换成可控的桩，
 * 末尾追加一个 return 把内部函数抠出来。所以这里跑的就是线上那份代码，改一行这里立刻变。
 *
 * 为什么要测：
 *   1. TT 手机端上 `POST /api/users/backup` 的大二进制流会让 fetch 永不 settle，
 *      没有超时 → STATE.busy 卡死 → 整个扩展变砖。这是最容易悄悄回归的地方。
 *   2. 「头回来了、body 不结束」正是 TT 上卡住的那个形态，普通超时测试测不到它 ——
 *      所以这里专门起一个"发一半就不发了"的服务器。
 *   3. 分叉走错（比如 TT 上仍去拆 zip）不会报错，只会慢或者数据不对，必须钉死。
 *
 * 用法：node tools/sync-restore-test/run.js
 *      （ST_SYNC_INDEX=别的副本 node tools/sync-restore-test/run.js 可以做变异测试）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const INDEX_JS = process.env.ST_SYNC_INDEX
    ? path.resolve(process.env.ST_SYNC_INDEX)
    : path.join(ROOT, 'extension', 'st-sync', 'index.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, detail = '') {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? `　${detail}` : ''}`);
}

function bad(label, detail) {
    fail += 1;
    failures.push(`${label}\n      ${detail}`);
    console.log(`  ✗ ${label}\n      ${detail}`);
}

/* ------------------------------------------------------------ 装载被测代码 */

/** 从源码里抠出来的内部函数。加名字之前确认它确实是顶层函数声明/const。 */
const EXPORTS = [
    'timedFetch', 'relayFetch', 'relayGetBlob', 'buildLocalBackup', 'stFetch', 'stMustOk',
    'pullOne', 'restoreFromZip', 'restoreViaNativeImport', 'waitForImportJob',
    'isTauriTavern', 'restoreModeHint', 'settings', 'STATE', 'TIMEOUT_MS', 'DM_API',
    'JOB_POLL_INTERVAL_MS', 'JOB_TIMEOUT_MS',
    // 分片并发下载
    'fetchChunk', 'downloadChunked', 'isRangeUnsupported',
    'DOWNLOAD_CHUNK_SIZE', 'DOWNLOAD_CONCURRENCY', 'DOWNLOAD_CHUNK_RETRIES',
    'DOWNLOAD_PARALLEL_MIN_BYTES',
    'EXT_VERSION', 'log', 'LOG_LINES', 'LOG_MAX_LINES', 'logText', 'beginBusy', 'endBusy',
    'fmtBytes', 'uploadTimeoutFor',
    // 上传绕行：拼 zip + 逐类读
    'buildZip', 'crc32', 'ZipReader', 'collectTtEntries', 'buildTtBackup', 'TT_API', 'TT_NO_READ_API',
    // 云侧的分类，用来验"上传拼出来的目录名云侧认不认"
    'classifyRestoreEntry',
];

/**
 * 把真实扩展加载进一个假的浏览器环境。
 *
 * @param {object}   o
 * @param {Function} o.fetchImpl   替代 fetch（按 url 分发）
 * @param {boolean}  o.tav         要不要装成 TT 酒馆（挂不挂 window.__TAURITAVERN__）
 * @param {object}   o.seed        localStorage 里的初始值
 */
function loadExtension({ fetchImpl, tav = false, seed = {} } = {}) {
    const src = fs.readFileSync(INDEX_JS, 'utf8');
    const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));

    const win = {
        // 酒馆前端上下文：getRequestHeaders 是扩展唯一用到的能力
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-Test': '1' }) }) },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => void store.set(k, String(v)),
            removeItem: (k) => void store.delete(k),
        },
    };
    if (tav) win.__TAURITAVERN__ = { version: 'test' };

    const calls = [];
    const routing = (url, opts) => {
        calls.push({ url: String(url), opts: opts || {} });
        return fetchImpl(String(url), opts || {});
    };

    // document 只在 buildUI 里用，测试不建界面；jQuery 是个空壳，文件末尾那句
    // jQuery(async () => init()) 因此不会真的跑起来。
    const factory = new Function(
        'window', 'document', 'jQuery', 'fetch', 'location',
        `${src}\nreturn { ${EXPORTS.join(', ')} };`,
    );
    const api = factory(
        win,
        { getElementById: () => null },
        () => {},
        routing,
        { reload() {} },
    );
    return { api, win, calls, store };
}

/** 每次加载都配一份能过 requireConfig 的设置 */
function configSeed(relayUrl) {
    return {
        'st-sync:settings': JSON.stringify({
            relayUrl,
            token: 'test-token',
            namespace: 'A',
            bucket: 'tavern',
            deviceId: 'local',
        }),
    };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
});

/** 等一个条件成立。掐连接是异步的，服务端要过一会儿才看得到，不能查得太急 */
async function waitFor(predicate, ms = 1500) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return !!predicate();
}

/** 把 console.debug 静音跑一段，顺便收集日志 */
async function withLogs(fn) {
    const lines = [];
    const real = console.debug;
    console.debug = (...args) => lines.push(args.map(String).join(' '));
    try {
        return { value: await fn(), lines };
    } finally {
        console.debug = real;
    }
}

/* ------------------------------------------------------ 一个"发一半就不发"的服务器 */

/**
 * 起一个可以精确控制"卡在哪一步"的服务器。
 *
 * mode:
 *   hang-headers —— 连响应头都不回（最朴素的卡死）
 *   hang-body    —— 回了头、发了一小段就再也不发（**TT 上就是这么卡的**）
 *   slow-body    —— 带着 Content-Length 一块一块慢慢发完（模拟手机上下大备份）
 *   ok           —— 正常回一段 JSON
 */
const SLOW_BODY_SIZE = 5 * 4096;   // 5 块 × 4 KB，够看出进度在涨

function startServer(mode) {
    const state = { aborted: false, requests: [] };
    const server = http.createServer((req, res) => {
        state.requests.push({ url: req.url, method: req.method });
        req.on('aborted', () => { state.aborted = true; });
        res.on('close', () => {
            if (!res.writableEnded) state.aborted = true;
        });

        if (mode === 'hang-headers') return; // 什么都不写，晾着

        if (mode === 'hang-body') {
            res.writeHead(200, { 'Content-Type': 'application/zip' });
            res.write('PK\x03\x04');   // 头和数据都出去了，fetch 会 resolve
            return;                     // 但永远不 end()
        }

        if (mode === 'slow-body') {
            const chunk = Buffer.alloc(4096, 0x41);
            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Length': String(SLOW_BODY_SIZE),
            });
            let sent = 0;
            const tick = setInterval(() => {
                res.write(chunk);
                sent += chunk.length;
                if (sent >= SLOW_BODY_SIZE) {
                    clearInterval(tick);
                    res.end();
                }
            }, 20);
            res.on('close', () => clearInterval(tick));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, namespace: 'A', files: [] }));
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                state,
                port: server.address().port,
                url: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

/* ------------------------------------------------------------------ 用例 */

/** 正常响应：不该超时，而且日志里要有用时 */
async function testNormal(bad_) {
    console.log('\n── timedFetch：正常响应 ──');
    const srv = await startServer('ok');
    try {
        const { api } = loadExtension({ fetchImpl: (url, opts) => fetch(url, opts) });
        const { value: text, lines } = await withLogs(() => api.timedFetch(
            `${srv.url}/v1/meta`, {}, { timeoutMs: 5000, what: '测试请求' },
        ).then((res) => res.text()));

        const body = JSON.parse(text);
        if (body.ok !== true) bad('拿到的 body 不对', text);
        else ok('响应体正常读到', `${text.length} 字节`);

        if (!lines.some((l) => l.includes('响应头到达'))) bad('没有计时日志', lines.join(' | '));
        else if (!lines.some((l) => l.includes('body 读完'))) bad('没有 body 计时日志', lines.join(' | '));
        else ok('发请求/回头/读完 body 三个时间点都有日志');
    } finally {
        await srv.close();
    }
}

/** 头都不回：必须超时，且错误要标明是超时不是"连不上" */
async function testTimeoutNoHeaders(bad_) {
    console.log('\n── timedFetch：服务端不回响应头 ──');
    const srv = await startServer('hang-headers');
    try {
        const { api } = loadExtension({ fetchImpl: (url, opts) => fetch(url, opts) });
        const started = Date.now();
        let err = null;
        try {
            await api.timedFetch(`${srv.url}/x`, {}, { timeoutMs: 400, what: '测试请求' });
        } catch (e) {
            err = e;
        }
        const ms = Date.now() - started;

        if (!err) bad('居然没超时', '请求一直挂着没回来');
        else if (!err.isTimeout) bad('抛错了但没标成超时', err.message);
        else if (!err.message.includes('超时')) bad('错误文案里没有"超时"', err.message);
        else ok('按预期超时', `${ms}ms：${err.message}`);

        if (ms < 300) bad('超时得太早了', `才 ${ms}ms，可能根本没等到超时`);
        if (!(await waitFor(() => srv.state.aborted))) {
            bad('超时后连接没被真正掐断', 'AbortController 没生效，请求还在后台跑');
        } else {
            ok('超时后把连接真掐断了（不是只 promise.race 掉）');
        }
    } finally {
        await srv.close();
    }
}

/**
 * 头回来了、body 永远不结束 —— **这就是 TT 手机端卡死的形态**。
 * fetch 本身会成功 resolve，卡住的是读 body 那一步；计时器必须一直留到 body 读完。
 */
async function testTimeoutHangingBody(bad_) {
    console.log('\n── timedFetch：头回了、body 永不结束（TT 上的原样）──');
    const srv = await startServer('hang-body');
    try {
        const { api } = loadExtension({ fetchImpl: (url, opts) => fetch(url, opts) });

        const res = await api.timedFetch(`${srv.url}/api/users/backup`, {}, {
            timeoutMs: 500, what: '测试备份流',
        });
        if (res.status !== 200) bad('响应头不对', String(res.status));
        else ok('响应头正常回来（说明卡的是 body，不是建连）');

        let err = null;
        const started = Date.now();
        try {
            await res.blob();
        } catch (e) {
            err = e;
        }
        const ms = Date.now() - started;

        if (!err) bad('body 一直不结束却没超时', '计时器在拿到响应头时就被清掉了 —— 卡死会重现');
        else if (!err.isTimeout) bad('body 读挂了但没标成超时', err.message);
        else ok('读 body 按预期超时', `${ms}ms：${err.message}`);

        if (!(await waitFor(() => srv.state.aborted))) {
            bad('body 超时后连接没被掐断', '那个大流还在占着连接');
        } else {
            ok('body 超时后连接也被掐断了');
        }
    } finally {
        await srv.close();
    }
}

/**
 * 下载整份备份：走逐块读，进度要报出来，超时要用放宽后的那个值。
 * 起因：手机上 80 MB 的包在 60s 里传不完，而状态栏只有一个"已 N 秒"，
 * 分不出是网慢还是卡死 —— 所以既要放宽超时，也要能把字节数显出来。
 */
async function testDownloadProgress(bad_) {
    console.log('\n── relayGetBlob：下载进度 ──');
    const srv = await startServer('slow-body');
    try {
        const { api } = loadExtension({
            fetchImpl: (url, opts) => fetch(url, opts),
            seed: configSeed(srv.url),
        });

        const seen = [];
        const { value: blob, lines } = await withLogs(() => api.relayGetBlob(
            'devices/cloud/snapshots/x.zip',
            {
                expectedSize: SLOW_BODY_SIZE,
                onProgress: (done, total) => seen.push([done, total]),
            },
        ));

        if (!(blob instanceof Blob)) bad('没返回 Blob', String(blob));
        else if (blob.size !== SLOW_BODY_SIZE) {
            bad('逐块读回来的字节数不对', `${blob.size} ≠ ${SLOW_BODY_SIZE}`);
        } else ok('逐块读回来的字节和 Content-Length 一致', `${blob.size} 字节`);

        if (seen.length < 2) bad('进度回调没被多次调用', `只调了 ${seen.length} 次`);
        else ok('进度回调按块触发', `${seen.length} 次`);

        const rising = seen.every(([d], i) => i === 0 || d > seen[i - 1][0]);
        if (!rising) bad('进度不是单调递增的', JSON.stringify(seen));
        else ok('进度单调递增', `${seen[0][0]} → ${seen[seen.length - 1][0]}`);

        if (!seen.every(([, t]) => t === SLOW_BODY_SIZE)) {
            bad('total 没用调用方给的 expectedSize', JSON.stringify(seen.slice(0, 2)));
        } else ok('total 用的是调用方给的 expectedSize（不是等 Content-Length）');

        if (!lines.some((l) => l.includes('超时 300s'))) {
            bad('下载没挂上放宽后的 300s 超时', lines.join(' | ') || '（没有日志）');
        } else ok('下载按 300s 计时，不再被别人的 60s 掐断');
    } finally {
        await srv.close();
    }
}

/** body 半路卡住时，报错和日志都要带上"已经收了多少"，否则没法判断是死了还是慢 */
async function testDownloadStallKeepsBytes(bad_) {
    console.log('\n── 下载半路卡住：得说清卡在哪、收了多少 ──');
    const srv = await startServer('hang-body');
    try {
        const { api } = loadExtension({
            fetchImpl: (url, opts) => fetch(url, opts),
            seed: configSeed(srv.url),
        });

        // 这里刻意不走 relayGetBlob：它现在挂的是 300s，真等下去测试要跑五分多钟。
        // 测的是同一条 readBlob 代码路径，只是自己指定一个能立刻触发的小超时。
        const res = await api.timedFetch(`${srv.url}/v1/ns/A/tavern/x.zip`, {}, {
            timeoutMs: 500, what: '测试下载流',
        });

        const seen = [];
        let err = null;
        const { lines } = await withLogs(async () => {
            try {
                await res.readBlob((done, total) => seen.push([done, total]), 123456);
            } catch (e) {
                err = e;
            }
        });

        if (!err) bad('body 一直不结束却没超时', '计时器被提前清掉了 —— 卡死会重现');
        else if (!err.isTimeout) bad('body 读挂了但没标成超时', err.message);
        else if (!err.message.includes('已收 4 B')) {
            bad('报错没说清已经收了多少', `${err.message}；手机上只能看这行，分不出卡住还是慢`);
        } else ok('卡住的下载按预期超时，且报错带上了已收字节', err.message);

        if (!seen.length || seen[0][0] !== 4) {
            bad('卡住前收到的字节没报给进度回调', JSON.stringify(seen));
        } else ok('卡住前收到的 4 字节已经报出去了', JSON.stringify(seen));

        if (!lines.some((l) => l.includes('已收 4 字节'))) {
            bad('超时日志里没写已收字节', lines.join(' | ') || '（没有日志）');
        } else ok('超时日志带上了已收字节，能看出是"卡住"而不是"慢"');

        if (!(await waitFor(() => srv.state.aborted))) {
            bad('卡住后连接没被掐断', '那个流还占着连接');
        } else ok('超时后连接也被掐断了');
    } finally {
        await srv.close();
    }
}

/** 中转请求超时，不能被包成"连不上中转服务"（那会把人往错误方向查） */
async function testRelayTimeoutWording(bad_) {
    console.log('\n── relayFetch：超时的文案要能区分开 ──');
    const srv = await startServer('hang-headers');
    try {
        const { api } = loadExtension({
            fetchImpl: (url, opts) => fetch(url, opts),
            seed: configSeed(srv.url),
        });
        let err = null;
        try {
            await api.relayFetch('/v1/meta');
        } catch (e) {
            err = e;
        }
        if (!err) bad('没超时', '');
        else if (err.message.includes('连不上中转服务')) {
            bad('超时被误报成"连不上"', `实际：${err.message}；这会把排查方向带偏`);
        } else if (!err.message.includes('超时')) bad('文案里没提超时', err.message);
        else ok('超时报成了超时', err.message);
    } finally {
        await srv.close();
    }
}

/** 各条路径挂的超时值必须真的是各自那个，别串了 */
async function testTimeoutWiring(bad_) {
    console.log('\n── 超时值接线：备份 180s / 其它 60s ──');
    const srv = await startServer('ok');
    try {
        const { api } = loadExtension({
            fetchImpl: async (url) => json({ ok: true, handle: 'default-user' }),
            seed: configSeed(srv.url),
        });
        if (api.TIMEOUT_MS.backup !== 180000) bad('备份超时不是 180s', String(api.TIMEOUT_MS.backup));
        else ok('TIMEOUT_MS.backup = 180s（服务端要先打包整份数据）');
        if (api.TIMEOUT_MS.relay !== 60000 || api.TIMEOUT_MS.st !== 60000) {
            bad('中转/酒馆超时不是 60s', JSON.stringify(api.TIMEOUT_MS));
        } else ok('TIMEOUT_MS.relay / st = 60s');
        // 下载整份备份走的是单独放宽的那个值，不能和普通中转请求共用一个 60s
        if (api.TIMEOUT_MS.relayDownload !== 300000) {
            bad('下载备份的超时不是 300s', String(api.TIMEOUT_MS.relayDownload));
        } else ok('TIMEOUT_MS.relayDownload = 300s（手机上 80 MB 的包 60s 传不完）');
        // 分片是每块单独计时的，不能和整份的那个 300s 共用一个值
        if (api.TIMEOUT_MS.chunk !== 120000) {
            bad('分片超时不是 120s', String(api.TIMEOUT_MS.chunk));
        } else ok('TIMEOUT_MS.chunk = 120s（每块单独预算，慢块能跑完、死块才被换掉）');

        // 上传的预算得按体积算。固定 60s 意味着 150 MB 要跑 2.5 MB/s 才不超时 ——
        // 真机上手机慢到 100 KB/s 时，传到 6 MB 就被自己的表掐了（链路其实还在动）。
        const t = api.uploadTimeoutFor;
        const cases = [
            [0, 60000, '没给体积时退回 60s'],
            [1024 * 1024, 60000, '小文件不放大（60s 就是下限）'],
            [150 * 1024 * 1024, Math.ceil((150 * 1024 * 1024) / (32 * 1024)) * 1000, '150 MB 按 32 KB/s 折算'],
        ];
        const wrong = cases.find(([size, want]) => t(size) !== want);
        if (typeof t !== 'function') bad('uploadTimeoutFor 没导出', String(t));
        else if (wrong) bad('上传预算算错了', `${wrong[0]} 字节 → ${t(wrong[0])}ms（期望 ${wrong[1]}ms，${wrong[2]}）`);
        else if (t(150 * 1024 * 1024) <= 60000) bad('大文件上传预算没放大', '固定 60s 会把"慢但在动"的上传掐死');
        else ok(`上传预算按体积放：150 MB → ${Math.round(t(150 * 1024 * 1024) / 1000)}s（原来固定 60s）`);

        // 真正打一次，从日志里确认走的是 180s 那个值
        const { value, lines } = await withLogs(() => api.buildLocalBackup());
        if (!(value instanceof Blob)) bad('buildLocalBackup 没返回 Blob', String(value));
        else ok('buildLocalBackup 正常返回 Blob');
        if (!lines.some((l) => l.includes('超时 180s'))) {
            bad('下载备份没挂上 180s 超时', lines.join(' | ') || '（没有日志）');
        } else ok('下载备份确实按 180s 计时');
    } finally {
        await srv.close();
    }
}

/**
 * 造一套假的"TT 酒馆"：给什么发什么。
 * 返回的 fetch 会记录每一次请求，用来断言"走的是哪条路"。
 */
function makeTavFetch({ jobStates, onImport }) {
    const zipBlobContent = 'PK-not-really-a-zip';  // 故意不是 zip：走 zip 路径必炸
    const seen = { imported: false, pollCount: 0, archiveName: '', archiveType: '' };

    const impl = async (url, opts) => {
        if (url.includes('/api/users/backup')) {
            throw new Error('TT 分支不该再去下载备份');
        }
        if (url.includes('/api/extensions/data-migration/import')) {
            seen.imported = true;
            const form = opts.body;
            const file = form && typeof form.get === 'function' ? form.get('archive') : null;
            if (!file) throw new Error('FormData 里没有 archive 字段');
            seen.archiveName = file.name || '';
            seen.archiveType = file.type || '';
            if (onImport) await onImport();
            return json({ ok: true, job_id: 'job-1' });
        }
        if (url.includes('/api/extensions/data-migration/job')) {
            const state = jobStates[Math.min(seen.pollCount, jobStates.length - 1)];
            seen.pollCount += 1;
            return json(state);
        }
        // 中转那边：拉快照
        if (url.includes('/snapshots/')) {
            return new Response(zipBlobContent, { headers: { 'Content-Type': 'application/zip' } });
        }
        if (url.includes('latest.json')) {
            return json({ device: 'cloud', fileName: 'x.zip' });
        }
        return json({ ok: true });
    };

    return { impl, seen, zipSize: Buffer.byteLength(zipBlobContent) };
}

/** TT 酒馆：pullOne 必须走原生整包导入，不能去拆 zip */
async function testTavBranch(bad_) {
    console.log('\n── 分叉：TT 酒馆走原生整包导入 ──');
    const { impl, seen, zipSize } = makeTavFetch({
        // 第一次还在跑（顺带验证轮询会继续），第二次完成
        jobStates: [
            { kind: 'import', state: 'running', stage: '写入数据', progress_percent: 42 },
            { kind: 'import', state: 'completed', stage: '完成', progress_percent: 100, local_applied: true },
        ],
    });
    const { api } = loadExtension({ fetchImpl: impl, tav: true, seed: configSeed('http://relay.test') });

    const report = await api.pullOne('cloud', { fileName: 'x.zip', size: zipSize, sha256: 'sha-cloud-1' });

    if (!seen.imported) bad('没调 data-migration/import', 'TT 分支没生效');
    else ok('调了 /api/extensions/data-migration/import');
    if (seen.archiveName !== 'x.zip') bad('FormData 里的文件名不对', seen.archiveName);
    else ok('FormData 的 archive 带了文件名 x.zip（后端拿它当 preferredName）');
    if (seen.pollCount < 2) bad('没有轮询 job', `只查了 ${seen.pollCount} 次`);
    else ok(`轮询到终态，共 ${seen.pollCount} 次`);

    if (!report.native) bad('报告里没标 native', JSON.stringify(report));
    else ok('报告标了 native（前端据此说"整包导入"而不是"还原 N 个文件"）');
    if (report.skipped.length) bad('不该有 skipped', JSON.stringify(report.skipped));
    else ok('没有 skipped');

    if (api.settings().lastPulled.cloud !== 'sha-cloud-1') {
        bad('没有记账（下次会重复拉）', JSON.stringify(api.settings().lastPulled));
    } else ok('记账了，下次不会重复拉');
}

/** 原版 ST：没有原生导入，必须还走老的按类写回 */
async function testClassicBranch(bad_) {
    console.log('\n── 分叉：原版 ST 仍走按类写回 ──');
    const { impl, seen, zipSize } = makeTavFetch({ jobStates: [{ state: 'completed' }] });
    const { api, calls } = loadExtension({
        fetchImpl: impl, tav: false, seed: configSeed('http://relay.test'),
    });

    let err = null;
    try {
        await api.pullOne('cloud', { fileName: 'x.zip', size: zipSize, sha256: 'sha-cloud-2' });
    } catch (e) {
        err = e;
    }

    if (seen.imported) bad('原版 ST 居然去调了 data-migration', 'TT 专属接口在不该走的时候被走了');
    else ok('没碰 data-migration 接口');
    if (!err) {
        bad('给了一份不是 zip 的数据却没报错', '说明根本没走解包，数据会被静默丢掉');
    } else if (!err.message.includes('不是')) {
        bad('报错文案对不上（预期是解包报的错）', err.message);
    } else {
        ok('按预期在解包处报错（证明走的是 restoreFromZip）', err.message);
    }
    const wrote = calls.filter((c) => /\/api\/(characters|chats|worldinfo)/.test(c.url));
    if (wrote.length) bad('还没解包就发写入请求了', JSON.stringify(wrote.map((w) => w.url)));
}

/** 失败 / 取消 / 对账失败，三种收尾都得对 */
async function testJobOutcomes(bad_) {
    console.log('\n── 导入任务的三种收尾 ──');

    const cases = [
        {
            name: 'failed',
            states: [
                { state: 'running', stage: '解包', progress_percent: 10 },
                { state: 'failed', error: '磁盘满了' },
            ],
            expect: (err, report) => err && err.message.includes('磁盘满了'),
            want: '抛出并带上酒馆给的原因',
        },
        {
            name: 'cancelled',
            states: [{ state: 'cancelled' }],
            expect: (err) => err && err.message.includes('取消'),
            want: '抛出"被取消"',
        },
        {
            name: 'completed+reconcile_error',
            states: [{ state: 'completed', local_applied: true, reconcile_error: 'settings.json 对不上' }],
            expect: (err, report) => !err && report && report.skipped.length === 1
                && report.skipped[0].includes('settings.json'),
            want: '不抛错，但记一条 skipped（好让下次同步重试）',
        },
    ];

    for (const c of cases) {
        const { impl, zipSize } = makeTavFetch({ jobStates: c.states });
        const { api } = loadExtension({ fetchImpl: impl, tav: true, seed: configSeed('http://relay.test') });

        let err = null;
        let report = null;
        try {
            report = await api.pullOne('cloud', { fileName: 'x.zip', size: zipSize, sha256: `sha-${c.name}` });
        } catch (e) {
            err = e;
        }

        if (!c.expect(err, report)) {
            bad(`job ${c.name}：${c.want} —— 没做到`,
                `err=${err ? err.message : 'null'} report=${JSON.stringify(report)}`);
        } else {
            ok(`job ${c.name}：${c.want}`);
        }

        // 对账失败时不能记账，否则这份备份再没机会补
        if (c.name.startsWith('completed+') && api.settings().lastPulled.cloud === `sha-${c.name}`) {
            bad('对账失败却记了账', '下次同步不会再拉这份，没写对的东西永远补不上');
        } else if (c.name.startsWith('completed+')) {
            ok('对账失败时不记账，留给下次重试');
        }

        // 不管成没成，还原进度都得从状态栏撤掉，否则永远卡在"正在还原 10/100"
        if (api.STATE.restore !== null) {
            bad(`job ${c.name}：出错后 STATE.restore 没清空`,
                JSON.stringify(api.STATE.restore) + ' —— 状态栏会永远卡住');
        } else {
            ok(`job ${c.name}：STATE.restore 已清空（状态栏不会卡死）`);
        }
        if (api.STATE.busy === false) ok(`job ${c.name}：没把 STATE.busy 弄脏`);
    }
}

/**
 * 诊断设施本身。
 *
 * 这一组是被真实事故逼出来的：手机上点了上传"什么都没发生"，而代码里所有排查线索
 * 都只往 console 写 —— 手机上没有控制台，等于一条线索都没有。
 * 所以面板日志、忙碌秒表、状态栏步骤这几样必须greppy得住，坏一个就又回到"点了没反应"。
 */
async function testDiagnostics(bad_) {
    console.log('\n── 诊断设施：面板日志 / 忙碌秒表 / 状态栏步骤 ──');

    const srv = await startServer('hang-headers');
    try {
        const { api } = loadExtension({
            fetchImpl: (url, opts) => fetch(url, opts),
            seed: configSeed(srv.url),
        });

        if (typeof api.EXT_VERSION !== 'string' || !api.EXT_VERSION.trim()) {
            bad('没有版本号', `EXT_VERSION=${JSON.stringify(api.EXT_VERSION)}；更新后没法确认跑的是哪一版`);
        } else {
            ok('有版本号，更新后能对着面板确认跑的是哪一版', api.EXT_VERSION);
        }

        // 面板日志：log() 得真的攒下来，不然手机上没东西可截图
        const before = api.LOG_LINES.length;
        api.log('测试行一', '附加');
        if (api.LOG_LINES.length !== before + 1) bad('log() 没往缓冲里记', String(api.LOG_LINES.length));
        else if (!api.LOG_LINES[api.LOG_LINES.length - 1].includes('测试行一 附加')) {
            bad('日志内容不对', api.LOG_LINES[api.LOG_LINES.length - 1]);
        } else {
            ok('log() 记进了面板缓冲（手机上可截图/复制）');
        }

        // 缓冲要有上限，否则跑一天会把内存吃光。
        // 次数必须写死：log() 自己就会裁剪，拿 length 当循环条件会永远停不下来。
        for (let i = 0; i < api.LOG_MAX_LINES + 50; i++) api.log('灌');
        if (api.LOG_LINES.length > api.LOG_MAX_LINES) {
            bad('日志缓冲没有上限', `${api.LOG_LINES.length} 行 > ${api.LOG_MAX_LINES}`);
        } else {
            ok(`日志缓冲有上限（最多 ${api.LOG_MAX_LINES} 行）`);
        }

        // 忙碌秒表：状态栏要能显示"已 N 秒"，卡死才看得出来
        api.beginBusy('测试步骤');
        if (!api.STATE.busy || !api.STATE.busySince) bad('beginBusy 没起作用', JSON.stringify(api.STATE.busySince));
        else if (!api.STATE.ticker) bad('没有起秒表', '状态栏上的秒数不会走');
        else ok('beginBusy：忙碌标记 + 秒表都起来了');

        api.endBusy();
        if (api.STATE.busy || api.STATE.busySince || api.STATE.step) {
            bad('endBusy 没清干净', JSON.stringify({ busy: api.STATE.busy, step: api.STATE.step }));
        } else if (api.STATE.ticker) {
            // 泄漏的 setInterval 在页面里会一直跑，也会让测试进程不退出
            bad('endBusy 没停秒表', '定时器泄漏，页面里会一直空转');
        } else {
            ok('endBusy：忙碌标记、步骤、秒表全清干净（不泄漏定时器）');
        }

        // 卡住的时候，状态栏得知道卡在哪一步 —— 这是"点了没反应"唯一的线索
        const pending = api.timedFetch(`${srv.url}/hang`, {}, { timeoutMs: 600, what: '测试步骤标签' })
            .catch((err) => err);
        await new Promise((r) => setTimeout(r, 150));
        if (api.STATE.step !== '测试步骤标签') {
            bad('请求进行中时状态栏没拿到步骤名', `STATE.step=${JSON.stringify(api.STATE.step)}`);
        } else {
            ok('请求进行中时状态栏显示当前步骤', api.STATE.step);
        }
        const err = await pending;
        if (!err || !err.isTimeout) bad('那次请求没按预期超时', String(err && err.message));
        else ok('超时后仍然是超时错误（不是别的）');

        if (api.LOG_LINES.some((l) => l.includes('测试步骤标签 超时'))) {
            ok('超时这件事也进了面板日志');
        } else {
            bad('超时没进面板日志', '手机上还是什么都看不到');
        }
    } finally {
        await srv.close();
    }
}

/** 导入接口本身的失败（HTTP 非 200、或 ok:false）要能报出来 */
async function testImportSubmitFailure(bad_) {
    console.log('\n── 提交导入任务失败 ──');
    const { api } = loadExtension({
        fetchImpl: async (url) => {
            if (url.includes('/data-migration/import')) {
                return json({ ok: false, error: '不认识的归档格式' });
            }
            return new Response('PK-nope');
        },
        tav: true,
        seed: configSeed('http://relay.test'),
    });

    let err = null;
    try {
        await api.restoreViaNativeImport(new Blob(['PK-nope']), 'x.zip');
    } catch (e) {
        err = e;
    }
    if (!err) bad('提交失败却没报错', '会当成导入成功');
    else if (!err.message.includes('不认识的归档格式')) bad('没把酒馆给的原因带出来', err.message);
    else ok('把酒馆给的原因带出来了', err.message);
    if (api.STATE.restore !== null) bad('提交失败后 STATE.restore 没清空', '状态栏会卡住');
}

/** 没挂 __TAURITAVERN__ 就是原版 ST —— 判定本身别写反 */
async function testDetect(bad_) {
    console.log('\n── 运行时判定 ──');
    const classic = loadExtension({ fetchImpl: async () => json({}) });
    const tav = loadExtension({ fetchImpl: async () => json({}), tav: true });
    if (classic.api.isTauriTavern()) bad('原版 ST 被认成了 TT 酒馆', '');
    else ok('没有 __TAURITAVERN__ → 判定为原版 ST');
    if (!tav.api.isTauriTavern()) bad('TT 酒馆没被认出来', '会退化成几百个请求的老路');
    else ok('有 __TAURITAVERN__ → 判定为 TT 酒馆');

    // 界面上给用户的说明必须跟着平台变：两条路的合并语义不一样，
    // 拿"只覆盖不删除"去描述原生整包导入就是在编
    if (classic.api.restoreModeHint() === tav.api.restoreModeHint()) {
        bad('两个平台的恢复说明文案一模一样', '对原生整包导入做了没根据的承诺');
    } else if (!tav.api.restoreModeHint().includes('原生')) {
        bad('TT 的说明没提原生导入', tav.api.restoreModeHint());
    } else {
        ok('恢复说明分平台，TT 侧如实说是原生整包导入');
    }
}

/* ------------------------------------------------ 分片并行下载（Range） */

/**
 * 造一份**会处理 Range** 的中转下载桩。
 *
 * 为什么要自己造：真实中转的限速是"按连接"的，本地起服务器复现不了那种形态；
 * 但分片这条路上真正要钉死的是**逻辑**——切块对不对、并发有没有超、进度单不单调、
 * 失败换不换连接、拿到 200 会不会降级。这些用桩都能精确验，而且可控（哪个块失败自己说了算）。
 *
 * @param {number} o.size        文件总字节
 * @param {boolean} o.ignoreRange true → 当"中转没升级"，无视 Range 回整份 200
 * @param {number} o.failChunk   这一块的前 failTimes 次请求返回 500（验换新连接重试）
 * @param {number} o.failTimes   默认 1：只第一次失败
 * @param {number|Function} o.delayMs 每块的延迟（可给 index 的函数），用来控制谁先跑完
 * @param {number} o.stallChunk  这一块回 206 但**体永远不结束**（验"卡住时报不报已收字节"）
 * @param {number} o.stallBytes  stallChunk 卡住前先吐这么多字节；0 = 一个字节都没有
 */
function makeRangeStub({
    size, ignoreRange = false, failChunk = -1, chunkSize, failTimes = 1, delayMs = 15, dangling = false,
    stallChunk = -1, stallBytes = 0,
}) {
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) body[i] = i & 0xff;

    const state = {
        inFlight: 0, maxInFlight: 0, requests: 0, attempts: new Map(),
        ok: 0, aborted: 0, dangling: 0, cancelled: 0, stalling: 0,
    };
    const delayOf = (index) => (typeof delayMs === 'function' ? delayMs(index) : delayMs);

    const impl = async (url, opts) => {
        state.inFlight += 1;
        state.requests += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);

        // 盯着调用方的 abort 信号：被掐断的请求不算"跑完"，也单独记一笔 ——
        // "整批拉闸有没有真的把在途请求掐掉"只能从这里验出来
        // （桩自己的定时器不会因为 fetch 被 abort 就停，所以不能拿 ok 计数当证据）。
        const ac = opts && opts.signal;
        if (ac) {
            if (ac.aborted) state.aborted += 1;
            else ac.addEventListener('abort', () => { state.aborted += 1; }, { once: true });
        }

        try {
            const headers = (opts && opts.headers) || {};
            const range = headers.Range || headers.range;
            if (ignoreRange || !range) {
                // 一点延迟，保证并发请求真的会重叠，maxInFlight 才有意义
                await new Promise((r) => setTimeout(r, delayOf(-1)));
                if (ignoreRange && range && dangling) {
                    // 「带着 Range 却被当整份回」：体故意不结束，模拟那份几十 MB 的完整响应。
                    // 客户端不主动取消它就会一直悬着 —— 每一条都占着一根连接不放。
                    state.dangling += 1;
                    return new Response(new ReadableStream({
                        start(controller) { controller.enqueue(body); },
                        cancel() { state.cancelled += 1; },
                    }), { status: 200, headers: { 'Content-Type': 'application/zip' } });
                }
                return new Response(body, { status: 200, headers: { 'Content-Type': 'application/zip' } });
            }

            const match = /^bytes=(\d+)-(\d+)$/.exec(range);
            if (!match) throw new Error(`桩收到了不认识的 Range：${range}`);
            const start = Number(match[1]);
            const end = Number(match[2]);
            const index = Math.floor(start / chunkSize);

            await new Promise((r) => setTimeout(r, delayOf(index)));

            const n = (state.attempts.get(index) || 0) + 1;
            state.attempts.set(index, n);
            if (index === failChunk && n <= failTimes) return new Response('boom', { status: 500 });

            if (index === stallChunk) {
                // 头按 206 正常回，体先吐 stallBytes 字节，然后**就这么悬着**。
                // 这正是真机上的形态：响应头到了、字节一个都不再涨。
                state.stalling += 1;
                return new Response(new ReadableStream({
                    start(controller) {
                        const head = body.subarray(start, Math.min(end + 1, start + stallBytes));
                        if (head.length) controller.enqueue(head);
                        // 真实 fetch 被 abort 时，读 body 也会立刻跟着报 AbortError；
                        // 桩不照做的话 readBlob 会永远等下去，用例直接挂死。
                        if (ac) {
                            ac.addEventListener('abort', () => {
                                controller.error(new DOMException('Aborted', 'AbortError'));
                            }, { once: true });
                        }
                    },
                    cancel() { state.cancelled += 1; },
                }), {
                    status: 206,
                    headers: {
                        'Content-Range': `bytes ${start}-${end}/${size}`,
                        'Content-Type': 'application/octet-stream',
                    },
                });
            }

            if (!ac || !ac.aborted) state.ok += 1;
            return new Response(body.subarray(start, end + 1), {
                status: 206,
                headers: {
                    'Content-Range': `bytes ${start}-${end}/${size}`,
                    'Content-Type': 'application/octet-stream',
                },
            });
        } finally {
            state.inFlight -= 1;
        }
    };

    return { impl, state, body };
}

/** 大文件：必须切块并发拉，拼回来的字节和进度都要对，某块失败要换连接重试 */
async function testChunkedDownload(bad_) {
    console.log('\n── relayGetBlob：分片并发下载 ──');

    const { api } = loadExtension({ fetchImpl: async () => json({}), seed: configSeed('http://relay.test') });
    const CHUNK = api.DOWNLOAD_CHUNK_SIZE;
    const CONC = api.DOWNLOAD_CONCURRENCY;
    const size = CHUNK * (CONC + 3);          // 比并发数多几块，好看出工作池轮转
    const failChunk = 3;

    const { impl, state, body } = makeRangeStub({ size, failChunk, chunkSize: CHUNK });
    const ext = loadExtension({ fetchImpl: impl, seed: configSeed('http://relay.test') });

    const seen = [];
    const { value: blob, lines } = await withLogs(() => ext.api.relayGetBlob(
        'devices/cloud/snapshots/big.zip',
        { expectedSize: size, onProgress: (done, total) => seen.push([done, total]) },
    ));

    if (!(blob instanceof Blob)) {
        bad_('没返回 Blob', String(blob));
        return;
    }
    const got = Buffer.from(await blob.arrayBuffer());
    if (got.length !== size) bad_('拼回来的大小不对', `${got.length} ≠ ${size}`);
    else if (!got.equals(body)) bad_('拼回来的字节和源不一致', '分片顺序或切片范围错了');
    else ok(`分片拼回的字节与源完全一致（${size} 字节 / ${Math.ceil(size / CHUNK)} 块）`);

    // 现在每块**中途**也会报（在途字节），所以回调次数不再恰好等于块数，
    // 只能要求"不少于块数"——比块数还少就说明有块回来时没报进度。
    const blocks = Math.ceil(size / CHUNK);
    if (seen.length < blocks) {
        bad_('进度回调次数少于块数', `${seen.length} 次，块数 ${blocks}`);
    } else if (!seen.every(([, t]) => t === size)) {
        bad_('total 没用调用方给的 expectedSize', JSON.stringify(seen.slice(0, 2)));
    } else {
        ok(`进度每块至少报一次（共 ${seen.length} 次 / ${blocks} 块），total 用的是 expectedSize`);
    }
    const rising = seen.every(([d], i) => i === 0 || d >= seen[i - 1][0]);
    const finalDone = seen.length ? seen[seen.length - 1][0] : 0;
    if (!rising) bad_('进度有回退', JSON.stringify(seen));
    else if (finalDone !== size) bad_('进度最终值不等于文件大小', `${finalDone} ≠ ${size}`);
    else ok(`进度单调不减且收满（${finalDone} 字节）`);

    if (state.maxInFlight > CONC) {
        bad_('并发连接超过了上限', `峰值 ${state.maxInFlight} > ${CONC}`);
    } else if (state.maxInFlight < 2) {
        bad_('根本没并发起来', `峰值 ${state.maxInFlight}；这条路上并行才是重点`);
    } else {
        ok(`并发峰值 ${state.maxInFlight} ≤ ${CONC}，确实并发在拉`);
    }

    // 某块第一次失败：必须换新连接重试，而且最终要成功
    if ((state.attempts.get(failChunk) || 0) !== 2) {
        bad_('失败块没有重试', `第 ${failChunk} 块请求了 ${state.attempts.get(failChunk) || 0} 次`);
    } else {
        ok(`第 ${failChunk} 块首失败后换新连接重试并成功`);
    }

    // 走上分片就该先打日志说明，手机上出问题能对着面板看
    if (!lines.join('\n').includes('分片下载：')) {
        bad_('没在日志里说明走了分片下载', lines.join(' | ') || '（没有日志）');
    } else {
        ok('日志里说明了这次走的是分片下载');
    }

    if (typeof api.isRangeUnsupported !== 'function' || api.isRangeUnsupported(new Error('x'))) {
        bad_('isRangeUnsupported 判定写反了', '普通的错会被当成"中转不支持 Range"去降级');
    } else {
        ok('isRangeUnsupported 只认带标记的错误，普通错误不会被误判');
    }
}

/** 中转没升级（无视 Range 回 200）：不能死，要降级回单条流式，最终仍拿到完整数据 */
async function testChunkedFallback(bad_) {
    console.log('\n── 中转没升级：分片降级回单条流式 ──');

    const { api } = loadExtension({ fetchImpl: async () => json({}), seed: configSeed('http://relay.test') });
    const size = api.DOWNLOAD_PARALLEL_MIN_BYTES;   // 刚好踩到并行阈值

    // dangling: 把"带 Range 却回整份 200"的响应体做成永远不结束的 —— 只有客户端主动取消，
    // 那根连接才会松开。不取消的话，真机上就是 6 根连接被占死、后面全部超时。
    const { impl, state, body } = makeRangeStub({
        size, ignoreRange: true, chunkSize: api.DOWNLOAD_CHUNK_SIZE, dangling: true,
    });
    const ext = loadExtension({ fetchImpl: impl, seed: configSeed('http://relay.test') });

    const seen = [];
    const { value: blob, lines } = await withLogs(() => ext.api.relayGetBlob(
        'devices/cloud/snapshots/big.zip',
        { expectedSize: size, onProgress: (done, total) => seen.push([done, total]) },
    ));

    const got = blob instanceof Blob ? Buffer.from(await blob.arrayBuffer()) : Buffer.alloc(0);
    if (!(blob instanceof Blob)) bad_('降级后没返回 Blob', String(blob));
    else if (got.length !== size || !got.equals(body)) {
        bad_('降级后拿到的数据不对', `${got.length} 字节 ≠ ${size}，或内容不一致`);
    } else {
        ok(`中转回 200 时降级成功，仍拿到完整的 ${size} 字节`);
    }

    if (!lines.join('\n').includes('降级')) {
        bad_('没在日志里说明降级了', '手机上分不出"慢"是网的问题还是中转没升级');
    } else {
        ok('日志里写明了降级回单条流式');
    }

    // 这条是真机事故的核心：拿到不要的 200 之后必须把体取消掉，否则连接被占死
    if (!state.dangling) {
        bad_('桩没造出"带 Range 回 200"的响应', '这条用例没验到该验的东西');
    } else if (state.cancelled !== state.dangling) {
        bad_('不要的 200 响应体没被取消',
            `${state.dangling} 份里只取消了 ${state.cancelled} 份 —— 剩下的会一直占着连接，`
            + '后面的请求全得排队（真机上就是"进度 0、每条都超时"）');
    } else {
        ok(`不要的 200 响应体全部被取消（${state.cancelled}/${state.dangling}），连接会松开`);
    }

    // 小文件不该走分片：请求里一个 Range 都不该有
    const small = makeRangeStub({ size: 4096, chunkSize: 4096 });
    const smallExt = loadExtension({ fetchImpl: small.impl, seed: configSeed('http://relay.test') });
    const smallBlob = await smallExt.api.relayGetBlob('devices/cloud/snapshots/small.zip', {
        expectedSize: 4096, onProgress: () => {},
    });
    if (smallBlob.size !== 4096) bad_('小文件下载坏了', String(smallBlob.size));
    else if (small.state.requests !== 1) bad_('小文件也切了块', `发了 ${small.state.requests} 个请求`);
    else ok('小文件仍走单条流式（一次请求，不切块）');
}

/**
 * 一块反复失败 → 整批拉闸，在途的分片必须被掐断。
 *
 * 这是真机事故逼出来的：中转还没升级时分片拿到的 200 响应体没人取消，6 个 80 MB 的
 * 僵尸下载把同源那几条连接全占死，之后**任何**请求都只能排队 —— 现象是"进度一直 0、
 * 每条都 120 秒超时"，跟服务器挂了长得一模一样。所以失败时必须主动收场。
 */
async function testChunkedFailureAbortsSiblings(bad_) {
    console.log('\n── 分片失败：整批拉闸，不留下在途请求 ──');

    const { api } = loadExtension({ fetchImpl: async () => json({}), seed: configSeed('http://relay.test') });
    const CHUNK = api.DOWNLOAD_CHUNK_SIZE;
    const CONC = api.DOWNLOAD_CONCURRENCY;
    const RETRIES = api.DOWNLOAD_CHUNK_RETRIES;
    const size = CHUNK * (CONC + 3);
    const failChunk = 2;

    // 坏块秒回 500（好让它快速耗尽重试）；好块故意慢，保证拉闸时它们还在途，
    // 这样"有没有被掐断"才验得出来。
    const { impl, state } = makeRangeStub({
        size, failChunk, failTimes: 99, chunkSize: CHUNK,
        delayMs: (index) => (index === failChunk ? 5 : 400),
    });
    const ext = loadExtension({ fetchImpl: impl, seed: configSeed('http://relay.test') });

    let err = null;
    let requestsAtFailure = 0;
    try {
        await ext.api.relayGetBlob('devices/cloud/snapshots/big.zip', {
            expectedSize: size, onProgress: () => {},
        });
    } catch (e) {
        err = e;
        requestsAtFailure = state.requests;
    }

    if (!err) {
        bad_('一块反复失败却没报错', '会拿缺块的数据去拼出一个坏包');
    } else if (!err.message.includes('重试 3 次仍失败')) {
        bad_('报错没写清重试了几次', err.message);
    } else if (!err.message.includes(`字节 ${failChunk * CHUNK}`)) {
        bad_('报错没带上字节区间，手机上定位不到是哪块', err.message);
    } else {
        ok(`按预期失败，且说清了是哪一块：${err.message.slice(0, 70)}…`);
    }

    if ((state.attempts.get(failChunk) || 0) !== RETRIES + 1) {
        bad_('坏块重试次数不对', `试了 ${state.attempts.get(failChunk) || 0} 次（期望 ${RETRIES + 1}）`);
    } else {
        ok(`坏块试满 1 次 + ${RETRIES} 次重试才放弃`);
    }

    // 别的分片只该发过一次请求：失败一确定，它们就该被掐断，而不是接着拉完
    const others = [...state.attempts.keys()].filter((k) => k !== failChunk);
    const retriedOthers = others.filter((k) => state.attempts.get(k) > 1);
    if (retriedOthers.length) {
        bad_('坏块之外的分片还在继续跑', `分片 ${retriedOthers} 有重试，说明整批没拉闸`);
    } else if (state.aborted !== CONC - 1) {
        bad_('坏块定死之后在途分片没被掐断',
            `只 abort 了 ${state.aborted} 条（期望 ${CONC - 1}）；没掐掉的会接着把字节拉完，白占连接`);
    } else {
        ok(`拉闸及时：在途的 ${state.aborted} 条分片请求全被 abort，不再往下拉`);
    }

    // 拉闸之后不该再有新请求冒出来（在途的也被 abort 了）
    await new Promise((r) => setTimeout(r, 700));
    if (state.requests !== requestsAtFailure) {
        bad_('拉闸后还有请求在途或新发', `${requestsAtFailure} → ${state.requests}；这些连接会被白占`);
    } else {
        ok(`失败即收场，请求数停在 ${requestsAtFailure}（= ${CONC} 条首发 + ${RETRIES} 次坏块重试）`);
    }
}

/**
 * 分片卡住时，日志和进度必须说得出"已经收了多少字节"。
 *
 * 2026-10-02 真机第二轮全卡死，最要命的是**看不出是哪种卡**：`fetchChunk` 那时用
 * `res.arrayBuffer()`，中途一个反馈都没有，于是"按 20 KB/s 慢慢爬"和"一个字节都没来"
 * 在日志里长得一模一样（都只报一句"超时"）。这条用例把两种形态分开钉死：
 * 卡住的块要在超时错误里带上已收字节数，并且这些**在途字节要先进进度**。
 */
async function testChunkStallReportsBytes(bad_) {
    console.log('\n── 分片卡住：报出已收字节（分清"慢"和"死"）──');

    const { api } = loadExtension({ fetchImpl: async () => json({}), seed: configSeed('http://relay.test') });
    const CHUNK = api.DOWNLOAD_CHUNK_SIZE;
    const CONC = api.DOWNLOAD_CONCURRENCY;
    const size = CHUNK * (CONC + 3);
    const stallChunk = 1;
    const STALL_BYTES = 12345;

    const { impl, state } = makeRangeStub({
        size, chunkSize: CHUNK, stallChunk, stallBytes: STALL_BYTES, delayMs: 5,
    });
    const ext = loadExtension({ fetchImpl: impl, seed: configSeed('http://relay.test') });

    // 只关心"卡住时报什么"，把每块预算压到 400ms，别让用例真等 2 分钟
    ext.api.TIMEOUT_MS.chunk = 400;

    const seen = [];
    let err = null;
    const { lines } = await withLogs(async () => {
        try {
            await ext.api.relayGetBlob('devices/cloud/snapshots/big.zip', {
                expectedSize: size, onProgress: (done) => seen.push(done),
            });
        } catch (e) {
            err = e;
        }
    });

    if (!state.stalling) {
        bad_('桩没造出"头回来了体不结束"的分片', '这条用例没验到该验的东西');
    } else if (!err) {
        bad_('分片卡住了却没报错', '会拿缺块的数据去拼出一个坏包');
    } else if (!err.message.includes('超时')) {
        // 抛出来的是"重试耗尽"的汇总错误，不是内层那条超时，所以看文案而不看标记
        bad_('卡住报的不是超时', err.message);
    } else if (!err.message.includes('已收')) {
        bad_('超时错误里没写已收字节', `${err.message}；手机上分不出"慢"和"死"，只能瞎猜`);
    } else if (!err.message.includes(api.fmtBytes(STALL_BYTES))) {
        bad_('已收字节数不对', `期望 ${api.fmtBytes(STALL_BYTES)}，实际：${err.message}`);
    } else {
        ok(`卡住的块说清了已收 ${api.fmtBytes(STALL_BYTES)}：${err.message.slice(0, 72)}…`);
    }

    // 关键的一半：那 12 KB 在途字节得**先进过进度条**。只报落账字节的话，
    // 卡住的块到死都是 0，状态栏从头到尾不动 —— 用户看到的还是"卡死了"。
    const peak = seen.length ? Math.max(...seen) : 0;
    if (peak < STALL_BYTES) {
        bad_('在途字节没进进度', `进度峰值 ${peak} < 卡住块已收的 ${STALL_BYTES}；状态栏分不出慢和死`);
    } else {
        ok(`卡住块的 ${STALL_BYTES} 字节在途就已计入进度（峰值 ${peak}）`);
    }

    const logText_ = lines.join('\n');
    if (!/读 body 超时（已收 \d+ 字节/.test(logText_)) {
        bad_('日志里没有"已收 N 字节"的那一行', logText_ || '（没有日志）');
    } else {
        ok('日志里留下了"读 body 超时（已收 N 字节…）"');
    }

    // "总预算到点了"和"中途没数据了"必须能分开。原来那句"N 秒没有新数据"打的是
    // timeoutMs（总预算），不是真的静默时长 —— 会把人往"中途卡住"上带。
    if (!/最后一块数据是 [\d.]+ 秒前/.test(logText_)) {
        bad_('日志没说"最后一块数据是多久前"', `分不出"从头就没动"和"跑到一半停住"：${logText_}`);
    } else {
        ok('日志里记了最后一块数据距今多久（idle 和"总预算"分得开）');
    }

    // 假日志比没日志更坏：原来这里打的是 `Date.now() - started`（请求至今多久），
    // 却写成"响应头 N ms 前就到了"——一超时必然打印成一个巨大的数，看着像"头早到了"。
    if (!logText_.includes('响应头到达')) {
        bad_('日志里没有记录响应头到达时刻', '这句本身不一定有问题，但少了它就没法核对');
    } else if (/响应头 \d+ms 前就到了/.test(logText_)) {
        bad_('又打出了"响应头 N ms 前就到了"这种不实的话', '那是请求至今的耗时，不是头的到达时刻');
    } else {
        ok('响应头到达时刻是真记的（用时 Xms），没有拿总耗时冒充');
    }
}

/* ---------------------------------------------- 上传绕行：拼 zip + 逐类读 */

/**
 * 造一份"假 TT 酒馆"的读接口。
 *
 * 值为的一个是形状对得上，另一个是把边角料都塞进来：带路径分隔符的角色卡名、
 * 读不出来的群聊、外部链接的背景图 —— 这些在生产上一定会遇到，出事了才知道该跳过。
 */
function makeTtReadFetch({ imageType = 'image/png' } = {}) {
    const seen = [];
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const impl = async (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        seen.push({ url: String(url), method, body });

        // 上传侧的老路，TT 分叉里一次都不该出现
        if (url.includes('/api/users/backup')) throw new Error('TT 分叉不该再去下载备份');

        if (url.includes('/api/settings/get')) {
            // TT 回的是套壳：settings 本体是**字符串**，其余是平铺的兄弟字段。
            // 形状照 Rust 侧 SillyTavernSettingsResponseDto 抄，别自己发明。
            return json({
                settings: JSON.stringify({
                    username: 'u',
                    theme: 'dark',
                    power_user: {
                        personas: { 'me.png': '我' },
                        persona_descriptions: { 'me.png': { description: '人设正文' } },
                    },
                }),
                world_names: ['WorldA', 'Bad/Name'],
                themes: [{ name: '暗色主题', main_text_color: '#fff' }, { name: 'Bad/Name' }],
                movingUIPresets: [{ name: '布局A' }],
                quickReplyPresets: [{ name: '快捷集', qrList: [] }],
                context: [{ name: '上下文预设', story_string: 'x' }],
                instruct: [{ name: '指令预设' }],
                sysprompt: [{ name: '系统提示' }],
                reasoning: [{ name: '推理模板' }],
                // 平行的「内容 + 名字」数组里，内容是该文件的原始 JSON 文本
                koboldai_settings: ['{"name":"K预设","temp":0.5}'],
                koboldai_setting_names: ['K预设'],
                novelai_settings: ['{"name":"N预设"}', '这不是 JSON'],
                novelai_setting_names: ['N预设', '坏预设'],
                openai_settings: ['{"name":"O预设"}'],
                openai_setting_names: ['O预设'],
                textgenerationwebui_presets: ['{"name":"T预设"}'],
                textgenerationwebui_preset_names: ['T预设'],
            });
        }
        if (url.includes('/api/characters/all')) {
            return json([
                { avatar: 'Alice.png', name: 'Alice' },
                { avatar: 'Bad/Name.png', name: '名字里带斜杠' },   // 该被 ttSafeName 挡掉
            ]);
        }
        if (url.includes('/api/characters/export')) {
            if (body.avatar_url !== 'Alice.png') return json({ error: 'Character not found' }, 404);
            return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.includes('/api/characters/chats')) {
            return json([{ file_id: 'chat1', file_name: 'chat1.jsonl' }]);
        }
        if (url.includes('/api/chats/get')) {
            return json([{ mes: '你好', is_user: true }, { mes: '在' }]);
        }
        if (url.includes('/api/groups/all')) {
            return json([{ id: 'g1', name: '群一', chat_id: 'gc1', chats: ['gc1', 'gc2'] }]);
        }
        if (url.includes('/api/chats/group/get')) {
            // gc2 故意读不出来：单个失败不能连累别的
            if (body.id === 'gc2') return json({ error: 'Failed to load group chat' }, 500);
            return json([{ mes: '群聊一句' }]);
        }
        if (url.includes('/api/worldinfo/get')) {
            if (body.name === 'Bad/Name') return json({ error: 'bad name' }, 400);
            return json({ entries: { e1: { key: ['k'], content: '世界书正文' } } });
        }
        if (url.includes('/api/backgrounds/all')) {
            // 真机上 images[] 的元素是**对象** {filename,isAnimated}；字符串形状也混一条进来，
            // 加上一条外链、一条没有 filename 的脏数据 —— 三种都得扛住。
            return json({
                images: [
                    { filename: 'bg1.jpg', isAnimated: false },
                    'folder/bg2.png',
                    { filename: 'https://cdn.example/x.png', isAnimated: false },
                    { isAnimated: true },
                ],
            });
        }
        if (url.includes('/api/avatars/get')) {
            // 真机上是字符串数组，顺手混一条对象形状：别再赌形状
            return json(['me.png', { filename: 'other.png' }]);
        }

        // 图片字节：TT 那边是前端相对路径，不是 /api/...
        if (url.startsWith('backgrounds/') || url.startsWith('User Avatars/')) {
            return new Response(PNG, { headers: { 'Content-Type': imageType } });
        }
        return json({});
    };

    return { impl, seen, PNG };
}

/** 解析出来的条目按名字查一条，读回它的字节 */
async function readZipEntry(reader, name) {
    const entry = reader.entries.find((item) => item.name === name);
    if (!entry) return null;
    return Buffer.from(await reader.readBytes(entry));
}

/** TT 酒馆：buildLocalBackup 必须走逐类读，拼出来的包要能被云侧那份 ZipReader 读回去 */
async function testTtBackupBuild(bad_) {
    console.log('\n── 上传绕行：TT 上逐类读 + 拼 zip ──');
    const { impl, seen, PNG } = makeTtReadFetch();
    const { api } = loadExtension({ fetchImpl: impl, tav: true, seed: configSeed('http://relay.test') });

    const { value: blob, lines } = await withLogs(() => api.buildLocalBackup());

    if (!(blob instanceof Blob)) {
        bad('buildLocalBackup 没返回 Blob', String(blob));
        return;
    }
    if (seen.some((c) => c.url.includes('/api/users/backup'))) {
        bad('TT 分叉还在调 /api/users/backup', 'iOS 上这条路读不出 body，等于白跑');
    } else {
        ok('没碰 /api/users/backup（走的逐类读）');
    }

    const reader = new api.ZipReader(blob);
    await reader.parse();
    const names = reader.entries.map((e) => e.name);

    // 该进包的
    const wanted = [
        'characters/Alice.png',
        'chats/Alice/chat1.jsonl',
        'groups/g1.json',
        'group chats/gc1.jsonl',
        'worlds/WorldA.json',
        'backgrounds/bg1.jpg',
        'backgrounds/folder/bg2.png',
        'User Avatars/me.png',
        // 预设类：全都来自 /api/settings/get 的兄弟字段，目录名必须和云侧对得上
        'themes/暗色主题.json',
        'movingUI/布局A.json',
        'QuickReplies/快捷集.json',
        'context/上下文预设.json',
        'instruct/指令预设.json',
        'sysprompt/系统提示.json',
        'reasoning/推理模板.json',
        'KoboldAI Settings/K预设.json',
        'NovelAI Settings/N预设.json',
        'OpenAI Settings/O预设.json',
        'TextGen Settings/T预设.json',
        'settings.json',
    ];
    const missing = wanted.filter((n) => !names.includes(n));
    if (missing.length) bad('该进包的条目少了', `缺 ${JSON.stringify(missing)}；实际 ${JSON.stringify(names)}`);
    else ok(`条目齐了（${names.length} 条）：角色卡/聊天/群组/群聊/世界书/预设/图片/设置`);

    // 不该进包的
    const unwanted = [
        'characters/Bad/Name.png', 'worlds/Bad/Name.json', 'group chats/gc2.jsonl',
        'themes/Bad/Name.json',      // 名字里带斜杠的主题
        'NovelAI Settings/坏预设.json', // 内容是坏 JSON，塞进去只会让这一类恢复整个失败
        'backgrounds/[object Object]', // 老 bug：把对象当字符串拼
    ];
    const leaked = unwanted.filter((n) => names.includes(n));
    if (leaked.length) bad('不该进包的条目混进来了', JSON.stringify(leaked));
    else ok('边角料都挡住了（带斜杠的名字、坏 JSON、读不出来的群聊）');

    // 预设的正文要能直接被云侧 stParseJson 读回来
    const theme = await readZipEntry(reader, 'themes/暗色主题.json');
    let themeJson = null;
    try { themeJson = JSON.parse(theme.toString('utf8')); } catch { /* 下面统一报 */ }
    if (themeJson && themeJson.name === '暗色主题' && themeJson.main_text_color === '#fff') {
        ok('主题按内容原样落盘（云侧 writeTheme 拿 .name 当名字）');
    } else {
        bad('主题内容不对', theme ? theme.toString('utf8').slice(0, 120) : '（没读到）');
    }

    const openai = await readZipEntry(reader, 'OpenAI Settings/O预设.json');
    let openaiJson = null;
    try { openaiJson = JSON.parse(openai.toString('utf8')); } catch { /* 下面统一报 */ }
    if (openaiJson && openaiJson.name === 'O预设') {
        ok('AI 预设按平行数组配对（内容取 settings[i]，名字取 names[i]）');
    } else {
        bad('AI 预设内容不对', openai ? openai.toString('utf8').slice(0, 120) : '（没读到）');
    }

    // 设置本体：必须是 settings 字符串**解开之后**的那份，不能是套壳
    const settingsEntry = await readZipEntry(reader, 'settings.json');
    let settingsJson = null;
    try { settingsJson = JSON.parse(settingsEntry.toString('utf8')); } catch { /* 下面统一报 */ }
    if (!settingsJson) {
        bad('settings.json 不是合法 JSON', settingsEntry ? settingsEntry.toString('utf8').slice(0, 120) : '（没读到）');
    } else if (settingsJson.settings !== undefined || settingsJson.world_names !== undefined) {
        bad('settings.json 写进去的是整个套壳', '云侧恢复出来 power_user 会不存在，人设名字/描述全丢');
    } else if (settingsJson.username !== 'u'
        || settingsJson.power_user?.personas?.['me.png'] !== '我'
        || settingsJson.power_user?.persona_descriptions?.['me.png']?.description !== '人设正文') {
        bad('settings.json 里没有解开后的 power_user', JSON.stringify(settingsJson).slice(0, 200));
    } else {
        ok('settings.json 是解开后的本体（power_user.personas / persona_descriptions 都在）');
    }

    if (names[names.length - 1] !== 'settings.json') {
        bad('settings.json 不在最后', `最后一条是 ${names[names.length - 1]}`);
    } else {
        ok('settings.json 排在最后（它引用了前面那些东西）');
    }

    // 内容对得上：角色卡必须是原始字节（不能是 JSON 包一层），聊天必须是 JSONL
    const card = await readZipEntry(reader, 'characters/Alice.png');
    if (!card || !card.equals(Buffer.from(PNG))) bad('角色卡字节不对', card ? card.toString('hex') : '（没读到）');
    else ok('角色卡是导出的原始 PNG 字节（没被转成 JSON）');

    const chat = await readZipEntry(reader, 'chats/Alice/chat1.jsonl');
    const chatLines = chat ? chat.toString('utf8').trim().split('\n') : [];
    let parsed = [];
    try {
        parsed = chatLines.map((line) => JSON.parse(line));
    } catch (err) {
        bad('聊天不是合法的 JSONL', String(err.message));
    }
    if (parsed.length === 2 && parsed[0].mes === '你好' && parsed[1].mes === '在') {
        ok('聊天按 JSONL 存（一行一条消息），云侧 stParseJsonl 能直接读');
    } else {
        bad('聊天内容不对', chat ? JSON.stringify(chat.toString('utf8').slice(0, 120)) : '（没读到）');
    }

    const group = await readZipEntry(reader, 'groups/g1.json');
    let groupJson = null;
    try { groupJson = JSON.parse(group.toString('utf8')); } catch { /* 下面统一报 */ }
    if (groupJson && groupJson.id === 'g1') ok('群组存成 groups/<id>.json（写回时 id 直接可用）');
    else bad('群组内容不对', group ? group.toString('utf8').slice(0, 120) : '（没读到）');

    // 请求参数也得对：聊天目录名由 avatar_url 决定，云侧要靠它反推角色
    const chatCalls = seen.filter((c) => c.url.includes('/api/chats/get'));
    if (chatCalls.length !== 1 || chatCalls[0].body.avatar_url !== 'Alice.png'
        || chatCalls[0].body.file_name !== 'chat1.jsonl') {
        bad('读聊天的请求参数不对', JSON.stringify(chatCalls.map((c) => c.body)));
    } else {
        ok('读聊天带的是 {avatar_url, file_name}（avatar 真名，不是显示名）');
    }

    // 外链背景不该去取
    if (seen.some((c) => c.url.includes('cdn.example'))) {
        bad('去取了外链背景图', '那是用户的外链，不属于备份内容');
    } else {
        ok('外链背景图没去取（不属于本机数据）');
    }

    // 手机上唯一的线索就是面板日志：分类计数和"跳过了什么"必须落进去
    const text = lines.join('\n');
    // 角色卡是 1 张不是 2 张：名字里带斜杠的那张在进包前就被挡掉了
    const needed = ['角色卡 1 张', '世界书 1/2 本', '预设/主题 11/13 条', '跳过图片', '跳过聊天附件'];
    for (const need of needed) {
        if (!text.includes(need)) bad(`日志里没有「${need}」`, '手机上看不到这一步的进展/缺口');
    }
    if (needed.every((need) => text.includes(need))) {
        ok('逐类计数和"跳过哪些类"都进了面板日志');
    }
}

/**
 * 上传侧拼出来的目录名，云侧 `classifyRestoreEntry` 必须认得出。
 *
 * 这一条是"端到端契约"的钉子：两边单独看都自洽，但目录名对不上就是静默丢数据 ——
 * 云侧会把整个条目当成"不认识"直接跳过，日志上什么都看不出来。
 */
async function testPresetEntriesClassify(bad_) {
    console.log('\n── 预设类条目：云侧认不认 ──');
    const { api } = loadExtension({ fetchImpl: async () => json({}) });

    // [条目名, 期望的 kind, 期望的 apiId（预设才有，决定往哪个目录写）]
    const expect = [
        ['themes/暗色主题.json', 'theme', null],
        ['movingUI/布局A.json', 'movingUI', null],
        ['QuickReplies/快捷集.json', 'quickReply', null],
        ['context/上下文预设.json', 'preset', 'context'],
        ['instruct/指令预设.json', 'preset', 'instruct'],
        ['sysprompt/系统提示.json', 'preset', 'sysprompt'],
        ['reasoning/推理模板.json', 'preset', 'reasoning'],
        ['KoboldAI Settings/K预设.json', 'preset', 'kobold'],
        ['NovelAI Settings/N预设.json', 'preset', 'novel'],
        ['OpenAI Settings/O预设.json', 'preset', 'openai'],
        ['TextGen Settings/T预设.json', 'preset', 'textgenerationwebui'],
        // 老样子也得还认
        ['backgrounds/bg1.jpg', 'background', null],
        ['User Avatars/me.png', 'userAvatar', null],
        ['settings.json', 'settings', null],
    ];

    const wrong = [];
    for (const [name, kind, apiId] of expect) {
        const info = api.classifyRestoreEntry(name);
        if (!info || info.kind !== kind) {
            wrong.push(`${name} → ${info ? info.kind : 'null'}（期望 ${kind}）`);
            continue;
        }
        if (apiId && info.apiId !== apiId) wrong.push(`${name} → apiId ${info.apiId}（期望 ${apiId}）`);
    }

    if (wrong.length) bad('云侧认不出来的条目', wrong.join('；'));
    else ok(`预设/主题/快捷回复/界面布局 + 老几类，云侧全都认（${expect.length} 条）`);
}

/** TT 上没有读接口的类（图片/附件）跳过就行，但不能连累 Tier1 的数据 */
async function testTtImagesWithoutBytes(bad_) {
    console.log('\n── 上传绕行：图片取不到字节时 ──');
    // TT 后端没有"按路径读图片"的 HTTP 接口，取回来的很可能是前端页面（200 + text/html）
    const { impl } = makeTtReadFetch({ imageType: 'text/html' });
    const { api } = loadExtension({ fetchImpl: impl, tav: true, seed: configSeed('http://relay.test') });

    const { value: blob, lines } = await withLogs(() => api.buildLocalBackup());
    const reader = new api.ZipReader(blob);
    await reader.parse();
    const names = reader.entries.map((e) => e.name);

    if (names.some((n) => n.startsWith('backgrounds/') || n.startsWith('User Avatars/'))) {
        bad('把 HTML 当图片塞进包里了', JSON.stringify(names.filter((n) => n.startsWith('backgrounds/'))));
    } else {
        ok('不是图片就当没有（宁可少这一类，也不往包里塞 HTML）');
    }
    if (!names.includes('characters/Alice.png') || !names.includes('settings.json')) {
        bad('图片取不到却把 Tier1 的数据也弄丢了', JSON.stringify(names));
    } else {
        ok('图片取不到不影响角色卡/设置这些主力数据');
    }
    if (!lines.join('\n').includes('只取到 0 张')) {
        bad('没在日志里说明图片少了', '用户会以为备份是全的');
    } else {
        ok('日志里说明了图片一张都没取到');
    }
}

/** 原版 ST 的备份接口是好的：那边必须继续走老路，别退化成几百个请求 */
async function testClassicStaysOnBackupApi(bad_) {
    console.log('\n── 分叉：原版 ST 仍走 /api/users/backup ──');
    const { api, calls } = loadExtension({
        fetchImpl: async (url) => (url.includes('/api/users/backup')
            ? new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { headers: { 'Content-Type': 'application/zip' } })
            : json({})),
        tav: false,
        seed: configSeed('http://relay.test'),
    });

    const blob = await api.buildLocalBackup();
    if (blob.size !== 4) bad('拿到的不是酒馆给的那份字节', String(blob.size));
    else ok('原版 ST 仍直接拿 /api/users/backup 的字节');

    const strays = calls.filter((c) => /\/api\/(characters|chats|worldinfo|groups)\//.test(c.url));
    if (strays.length) bad('原版 ST 上跑了逐类读', JSON.stringify(strays.map((c) => c.url)));
    else ok('原版 ST 上没走逐类读（那边后端打包又快又全）');
}

/**
 * 拼 zip 这一侧。
 *
 * 圆进圆出只是自证；真正算数的是**换个实现来读**：Python 的 zipfile 是另一套代码，
 * 它肯认这个包（testzip 校验 CRC、名字按 UTF-8 解开），才说明这包是合规的 zip，
 * 而不是"恰好我们的 ZipReader 能读"。
 */
async function testZipWriter(bad_) {
    console.log('\n── buildZip：store-only zip 打包 ──');
    const { api } = loadExtension({ fetchImpl: async () => json({}) });

    // crc32 的标准向量：任何实现算 123456789 都得是 0xCBF43926
    const vector = api.crc32(new TextEncoder().encode('123456789'));
    if (vector !== 0xcbf43926) bad('crc32 不是标准值', `期望 CBF43926，实际 ${vector.toString(16)}`);
    else ok('crc32 对上标准向量（123456789 → 0xCBF43926）');
    if (api.crc32(new Uint8Array(0)) !== 0) bad('空内容的 crc32 不是 0', '');
    else ok('空内容的 crc32 = 0');

    const png = new Uint8Array(257);
    for (let i = 0; i < png.length; i += 1) png[i] = i & 0xff;   // 含 0x00/0xff 的二进制，最容易在拼接处出错
    const entries = [
        { name: 'settings.json', data: '{"theme":"dark"}' },
        { name: 'characters/爱丽丝.png', data: png },
        { name: 'chats/爱丽丝/深夜.jsonl', data: '{"mes":"hi"}\n{"mes":"啊"}\n' },
        { name: 'empty.txt', data: new Uint8Array(0) },
    ];
    const blob = api.buildZip(entries, { date: new Date(2026, 9, 1, 12, 34, 56) });

    const reader = new api.ZipReader(blob);
    await reader.parse();
    if (reader.entries.length !== entries.length) {
        bad('解回来的条目数不对', `${reader.entries.length} ≠ ${entries.length}：${reader.entries.map((e) => e.name)}`);
    } else {
        ok(`圆进圆出：${reader.entries.length} 条全解回来`);
    }

    for (const item of entries) {
        const got = await readZipEntry(reader, item.name);
        const want = Buffer.from(typeof item.data === 'string' ? item.data : item.data);
        if (!got) bad(`条目 ${item.name} 丢了`, reader.entries.map((e) => e.name).join(', '));
        else if (!got.equals(want)) bad(`条目 ${item.name} 字节对不上`, `${got.length} 字节 ≠ ${want.length} 字节`);
    }
    ok('每条名字和字节都逐一比对过（含中文名、含空文件）');

    // 头必须是 store（method 0）+ UTF-8 名字标志，缺了别的解压器会当乱码
    const head = new DataView(await blob.slice(0, 30).arrayBuffer());
    if (head.getUint32(0, true) !== 0x04034b50) bad('开头不是 PK\\x03\\x04', '');
    else if (head.getUint16(8, true) !== 0) bad('压缩方式不是 store', String(head.getUint16(8, true)));
    else if ((head.getUint16(6, true) & 0x0800) === 0) bad('没置 UTF-8 名字标志', '中文名会在别的工具里变乱码');
    else ok('局部头：PK\\x03\\x04 + store(0) + UTF-8 名字标志');

    // 换个实现来读：Python zipfile
    const tmp = path.join(os.tmpdir(), `st-sync-zip-${process.pid}.zip`);
    fs.writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()));
    let py = null;
    try {
        // 输出必须是纯 ASCII：Windows 上 Python 打到管道用的是本地编码（GBK），
        // 非 ASCII 的名字在 Node 这边按 UTF-8 一解就是乱码 —— 那是测试自己的锅，不是包的锅
        py = execFileSync('python', ['-c', `
import sys, json, zipfile, hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
    out = {"bad": z.testzip(), "items": {}}
    for n in z.namelist():
        data = z.read(n)
        out["items"][n] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
print(json.dumps(out))
`, tmp], { encoding: 'utf8' });
    } catch (err) {
        console.log(`  ⚠ 跳过 Python 交叉验证（没跑起来）：${err.message.split('\n')[0]}`);
    } finally {
        fs.unlinkSync(tmp);
    }

    if (py) {
        const result = JSON.parse(py);
        if (result.bad) bad('Python 的 testzip 判包损坏', `CRC 对不上的条目：${result.bad}`);
        else ok('Python zipfile 的 testzip 通过（CRC 全部校验合格）');

        const pyNames = Object.keys(result.items);
        const mineNames = entries.map((e) => e.name);
        if (JSON.stringify(pyNames) !== JSON.stringify(mineNames)) {
            bad('Python 解出来的名字不对', `Python：${JSON.stringify(pyNames)}`);
        } else {
            ok('Python 解出来的名字一致（中文名按 UTF-8 正确还原）');
        }

        let mismatch = 0;
        for (const item of entries) {
            const want = Buffer.from(typeof item.data === 'string' ? item.data : item.data);
            const got = result.items[item.name];
            const sum = crypto.createHash('sha256').update(want).digest('hex');
            if (!got) {
                mismatch += 1;
                bad(`Python 没解出 ${item.name}`, '');
            } else if (got.size !== want.length || got.sha256 !== sum) {
                mismatch += 1;
                bad(`${item.name} 字节对不上（Python 侧）`, `${got.size}/${got.sha256.slice(0, 12)} ≠ ${want.length}/${sum.slice(0, 12)}`);
            }
        }
        if (!mismatch) ok('每个条目的字节都和 Python 解出来的一致（换实现交叉验证）');
    }

    // 超限得报错，不能悄悄打出一个坏包
    let err = null;
    try {
        api.buildZip([{ name: 'big.bin', data: new Uint8Array(1) }]);
    } catch (e) { err = e; }
    if (err) bad('普通条目居然报错了', err.message);
    else ok('正常条目不报错（没把上限判断写反）');
}

/* ------------------------------------------------------------------- main */

async function main() {
    console.log(`\n被测代码：${path.relative(ROOT, INDEX_JS)}（整份源码装进假浏览器跑）`);

    await testNormal(bad);
    await testTimeoutNoHeaders(bad);
    await testTimeoutHangingBody(bad);
    await testRelayTimeoutWording(bad);
    await testDownloadProgress(bad);
    await testDownloadStallKeepsBytes(bad);
    await testChunkedDownload(bad);
    await testChunkedFallback(bad);
    await testChunkedFailureAbortsSiblings(bad);
    await testChunkStallReportsBytes(bad);
    await testTimeoutWiring(bad);
    await testDetect(bad);
    await testTavBranch(bad);
    await testClassicBranch(bad);
    await testJobOutcomes(bad);
    await testImportSubmitFailure(bad);
    await testDiagnostics(bad);
    await testZipWriter(bad);
    await testTtBackupBuild(bad);
    await testPresetEntriesClassify(bad);
    await testTtImagesWithoutBytes(bad);
    await testClassicStaysOnBackupApi(bad);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`通过 ${pass}　失败 ${fail}`);
    if (fail) {
        console.log('\n失败明细：');
        failures.forEach((f) => console.log(`  • ${f}`));
    }
    process.exit(fail ? 1 : 0);
}

main().catch((err) => {
    console.error('测试脚本自身出错：', err);
    process.exit(2);
});
