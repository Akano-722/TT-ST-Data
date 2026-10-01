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
    'timedFetch', 'relayFetch', 'buildLocalBackup', 'stFetch', 'stMustOk',
    'pullOne', 'restoreFromZip', 'restoreViaNativeImport', 'waitForImportJob',
    'isTauriTavern', 'restoreModeHint', 'settings', 'STATE', 'TIMEOUT_MS', 'DM_API',
    'JOB_POLL_INTERVAL_MS', 'JOB_TIMEOUT_MS',
    'EXT_VERSION', 'log', 'LOG_LINES', 'LOG_MAX_LINES', 'logText', 'beginBusy', 'endBusy',
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
 *   ok           —— 正常回一段 JSON
 */
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

/* ------------------------------------------------------------------- main */

async function main() {
    console.log(`\n被测代码：${path.relative(ROOT, INDEX_JS)}（整份源码装进假浏览器跑）`);

    await testNormal(bad);
    await testTimeoutNoHeaders(bad);
    await testTimeoutHangingBody(bad);
    await testRelayTimeoutWording(bad);
    await testTimeoutWiring(bad);
    await testDetect(bad);
    await testTavBranch(bad);
    await testClassicBranch(bad);
    await testJobOutcomes(bad);
    await testImportSubmitFailure(bad);
    await testDiagnostics(bad);

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
