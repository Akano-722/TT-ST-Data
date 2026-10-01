'use strict';

/**
 * 冒烟测试：本地起一个真实服务实例，把接口、鉴权、隔离、路径穿越全打一遍。
 * 用法：npm test
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.TEST_PORT || 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'test-admin-token';
const BOOTSTRAP_TOKEN = 'test-token-for-namespace-a';
const DATA_DIR = path.join(os.tmpdir(), `st-sync-relay-test-${process.pid}`);
const SERVER = path.join(__dirname, '..', 'server.js');

const results = [];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
}

async function check(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ok   ${name}`);
    } catch (err) {
        results.push({ name, ok: false, error: err.message });
        console.log(`  FAIL ${name}\n       ${err.message}`);
    }
}

function startServer(extraEnv = {}) {
    const child = spawn(process.execPath, [SERVER], {
        env: {
            ...process.env,
            PORT: String(PORT),
            DATA_DIR,
            ADMIN_TOKEN,
            BOOTSTRAP_NAMESPACE: 'A',
            BOOTSTRAP_TOKEN,
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    return child;
}

async function waitForHealth(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) return;
        } catch {
            // 还没起来，继续等
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('服务在超时时间内没有就绪');
}

function stopServer(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    });
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * 用原始 socket 发请求，path 原样送出去不做归一化。
 * fetch() 会按 URL 规范把 %2E%2E 提前解成 ..，请求根本到不了服务端，
 * 那样测的就不是服务端的防御了，所以路径穿越必须用这个发。
 */
function rawRequest(method, rawPath, { token, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(body);
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (payload) headers['Content-Length'] = payload.length;

        const req = http.request(
            { host: '127.0.0.1', port: PORT, method, path: rawPath, headers },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            },
        );
        req.on('error', reject);
        req.end(payload || undefined);
    });
}

async function main() {
    await fsp.rm(DATA_DIR, { recursive: true, force: true });

    console.log(`\n数据目录: ${DATA_DIR}\n`);
    let server = startServer();
    await waitForHealth();

    console.log('基础连通性:');
    await check('GET /health 返回 ok', async () => {
        const res = await fetch(`${BASE}/health`);
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assertEqual(body.ok, true, 'ok 字段');
    });

    console.log('\n鉴权:');
    await check('无令牌访问受保护接口返回 401', async () => {
        const res = await fetch(`${BASE}/v1/meta`);
        assertEqual(res.status, 401, '状态码');
    });

    await check('错误令牌返回 403', async () => {
        const res = await fetch(`${BASE}/v1/meta`, { headers: authHeaders('wrong-token') });
        assertEqual(res.status, 403, '状态码');
    });

    await check('正确令牌返回自己的命名空间', async () => {
        const res = await fetch(`${BASE}/v1/meta`, { headers: authHeaders(BOOTSTRAP_TOKEN) });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assertEqual(body.namespace, 'A', 'namespace');
    });

    console.log('\n文件读写:');
    const payload = Buffer.from('hello relay 你好\n');
    await check('PUT 上传文件并返回正确的 sha256', async () => {
        const expected = require('crypto').createHash('sha256').update(payload).digest('hex');
        const res = await fetch(`${BASE}/v1/ns/A/tavern/notes/hello.txt`, {
            method: 'PUT',
            headers: authHeaders(BOOTSTRAP_TOKEN),
            body: payload,
        });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assertEqual(body.size, payload.length, '字节数');
        assertEqual(body.sha256, expected, 'sha256');
    });

    await check('GET 下载内容一致', async () => {
        const res = await fetch(`${BASE}/v1/ns/A/tavern/notes/hello.txt`, {
            headers: authHeaders(BOOTSTRAP_TOKEN),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        assertEqual(res.status, 200, '状态码');
        assert(buf.equals(payload), '下载内容与上传不一致');
    });

    await check('GET 不存在的文件返回 404', async () => {
        const res = await fetch(`${BASE}/v1/ns/A/tavern/nope.txt`, {
            headers: authHeaders(BOOTSTRAP_TOKEN),
        });
        assertEqual(res.status, 404, '状态码');
    });

    await check('GET bucket 列出文件与用量', async () => {
        const res = await fetch(`${BASE}/v1/ns/A/tavern`, { headers: authHeaders(BOOTSTRAP_TOKEN) });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assertEqual(body.count, 1, '文件数');
        assertEqual(body.files[0].key, 'notes/hello.txt', 'key');
        assertEqual(body.usage, payload.length, 'usage');
    });

    await check('DELETE 删除文件', async () => {
        const res = await fetch(`${BASE}/v1/ns/A/tavern/notes/hello.txt`, {
            method: 'DELETE',
            headers: authHeaders(BOOTSTRAP_TOKEN),
        });
        assertEqual(res.status, 200, '状态码');
        const list = await (await fetch(`${BASE}/v1/ns/A/tavern`, { headers: authHeaders(BOOTSTRAP_TOKEN) })).json();
        assertEqual(list.count, 0, '删除后文件数');
    });

    console.log('\n隔离与安全:');
    await check('管理员创建命名空间 B 并拿到令牌', async () => {
        const res = await fetch(`${BASE}/admin/namespace`, {
            method: 'POST',
            headers: { ...authHeaders(ADMIN_TOKEN), 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: 'B' }),
        });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assert(typeof body.token === 'string' && body.token.length > 20, '令牌未返回');
        globalThis.tokenB = body.token;
    });

    await check('A 的令牌访问 B 的命名空间返回 403', async () => {
        const res = await fetch(`${BASE}/v1/ns/B/tavern/evil.txt`, {
            method: 'PUT',
            headers: authHeaders(BOOTSTRAP_TOKEN),
            body: Buffer.from('should not land'),
        });
        assertEqual(res.status, 403, '状态码');
    });

    await check('B 的令牌能正常访问 B', async () => {
        const res = await fetch(`${BASE}/v1/ns/B/tavern/x.txt`, {
            method: 'PUT',
            headers: authHeaders(globalThis.tokenB),
            body: Buffer.from('ok'),
        });
        assertEqual(res.status, 200, '状态码');
    });

    await check('字面量 .. 的路径穿越被服务端拒绝', async () => {
        const res = await rawRequest('PUT', '/v1/ns/A/tavern/../../../evil.txt', {
            token: BOOTSTRAP_TOKEN,
            body: 'should not land',
        });
        assertEqual(res.status, 400, '状态码');
        assert(/非法/.test(res.body), `响应应说明原因，实际: ${res.body}`);
    });

    await check('字面量 .. 的读取穿越被拒绝', async () => {
        const res = await rawRequest('GET', '/v1/ns/A/tavern/../../auth.json', {
            token: BOOTSTRAP_TOKEN,
        });
        assertEqual(res.status, 400, '状态码');
    });

    await check('%2F 编码的斜杠绕过被拒绝', async () => {
        const res = await rawRequest('PUT', '/v1/ns/A/tavern/..%2F..%2Fevil.txt', {
            token: BOOTSTRAP_TOKEN,
            body: 'should not land',
        });
        assertEqual(res.status, 400, '状态码');
    });

    await check('越界文件确实没有落到数据目录外', async () => {
        const outside = path.join(DATA_DIR, '..', 'evil.txt');
        const exists = await fsp.access(outside).then(() => true, () => false);
        assert(!exists, `数据目录外出现了文件: ${outside}`);
    });

    await check('auth.json 没有被穿越读取泄露', async () => {
        const res = await rawRequest('GET', '/v1/ns/A/tavern/../../auth.json', {
            token: BOOTSTRAP_TOKEN,
        });
        assert(!/tokenHash/.test(res.body), 'auth.json 内容疑似泄露');
    });

    await check('非管理员令牌调管理接口被拒', async () => {
        const res = await fetch(`${BASE}/admin/namespace`, {
            method: 'POST',
            headers: { ...authHeaders(BOOTSTRAP_TOKEN), 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: 'C' }),
        });
        assertEqual(res.status, 403, '状态码');
    });

    console.log('\n邀请码（关闭态）:');
    await check('未启用时 /admin/invite 返回 501', async () => {
        const res = await fetch(`${BASE}/admin/invite`, {
            method: 'POST',
            headers: { ...authHeaders(ADMIN_TOKEN), 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: 'F' }),
        });
        assertEqual(res.status, 501, '状态码');
    });

    await check('未启用时 /v1/invite/redeem 返回 501', async () => {
        const res = await fetch(`${BASE}/v1/invite/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'whatever' }),
        });
        assertEqual(res.status, 501, '状态码');
    });

    console.log('\n持久化（模拟重启）:');
    await check('重启后数据仍在', async () => {
        await fetch(`${BASE}/v1/ns/A/tavern/persist.txt`, {
            method: 'PUT',
            headers: authHeaders(BOOTSTRAP_TOKEN),
            body: Buffer.from('survive me'),
        });
        await stopServer(server);
        server = startServer();
        await waitForHealth();
        const res = await fetch(`${BASE}/v1/ns/A/tavern/persist.txt`, {
            headers: authHeaders(BOOTSTRAP_TOKEN),
        });
        const text = await res.text();
        assertEqual(res.status, 200, '重启后状态码');
        assertEqual(text, 'survive me', '重启后内容');
    });

    await check('重启后令牌依然有效（auth.json 已持久化）', async () => {
        const res = await fetch(`${BASE}/v1/meta`, { headers: authHeaders(BOOTSTRAP_TOKEN) });
        assertEqual(res.status, 200, '状态码');
    });

    console.log('\n管理浏览接口（后台用的）:');
    await check('管理员列出命名空间，包含 A 与 B', async () => {
        const res = await fetch(`${BASE}/admin/namespaces`, { headers: authHeaders(ADMIN_TOKEN) });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        const names = body.namespaces.map((item) => item.namespace);
        assert(names.includes('A') && names.includes('B'), `实际: ${JSON.stringify(names)}`);
    });

    await check('管理员列出 A 的桶，含文件数与新增时间', async () => {
        const res = await fetch(`${BASE}/admin/namespaces/A/buckets`, {
            headers: authHeaders(ADMIN_TOKEN),
        });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        const tavern = body.buckets.find((item) => item.bucket === 'tavern');
        assert(tavern, `没找到 tavern 桶：${JSON.stringify(body.buckets)}`);
        assertEqual(tavern.count, 1, '文件数');   // 只剩重启前写的 persist.txt
        assertEqual(tavern.usage, 10, '字节数');  // 'survive me'
        assert(Number.isFinite(tavern.createdAt), `新增时间应是时间戳，实际 ${tavern.createdAt}`);
        assert(Number.isFinite(tavern.lastModified), `最近修改应是时间戳，实际 ${tavern.lastModified}`);
    });

    await check('管理员列出桶内文件', async () => {
        const res = await fetch(`${BASE}/admin/namespaces/A/buckets/tavern`, {
            headers: authHeaders(ADMIN_TOKEN),
        });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assertEqual(body.count, 1, '文件数');
        assertEqual(body.files[0].key, 'persist.txt', 'key');
    });

    await check('管理员下载文件内容一致', async () => {
        const res = await fetch(`${BASE}/admin/namespaces/A/buckets/tavern/files/persist.txt`, {
            headers: authHeaders(ADMIN_TOKEN),
        });
        assertEqual(res.status, 200, '状态码');
        assertEqual(await res.text(), 'survive me', '内容');
    });

    await check('管理员下载不存在的文件返回 404', async () => {
        const res = await fetch(`${BASE}/admin/namespaces/A/buckets/tavern/files/nope.txt`, {
            headers: authHeaders(ADMIN_TOKEN),
        });
        assertEqual(res.status, 404, '状态码');
    });

    await check('普通命名空间令牌访问管理浏览接口被拒', async () => {
        const res = await fetch(`${BASE}/admin/namespaces/A/buckets`, {
            headers: authHeaders(BOOTSTRAP_TOKEN),
        });
        assertEqual(res.status, 403, '状态码');
    });

    await check('管理浏览接口的路径穿越被拒绝', async () => {
        const res = await rawRequest(
            'GET',
            '/admin/namespaces/A/buckets/tavern/files/../../../../auth.json',
            { token: ADMIN_TOKEN },
        );
        assertEqual(res.status, 400, '状态码');
        assert(!/tokenHash/.test(res.body), 'auth.json 内容疑似泄露');
    });

    await check('管理后台页面可访问，且不需要令牌', async () => {
        const res = await fetch(`${BASE}/admin`);
        assertEqual(res.status, 200, '状态码');
        assert(/ST Sync/.test(await res.text()), '拿到的不是后台页面');
    });

    await stopServer(server);

    console.log('\n邀请码（启用态）:');
    server = startServer({ ENABLE_INVITES: 'true' });
    await waitForHealth();

    let inviteCode = null;
    await check('启用后管理员可创建邀请码', async () => {
        const res = await fetch(`${BASE}/admin/invite`, {
            method: 'POST',
            headers: { ...authHeaders(ADMIN_TOKEN), 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: 'FRIEND', ttlHours: 24 }),
        });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assert(typeof body.code === 'string', '邀请码未返回');
        inviteCode = body.code;
    });

    await check('朋友用邀请码换取令牌', async () => {
        const res = await fetch(`${BASE}/v1/invite/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: inviteCode }),
        });
        const body = await res.json();
        assertEqual(res.status, 200, '状态码');
        assertEqual(body.namespace, 'FRIEND', 'namespace');
        globalThis.friendToken = body.token;
    });

    await check('朋友的令牌只能碰自己的命名空间', async () => {
        const ok = await fetch(`${BASE}/v1/ns/FRIEND/tavern/f.txt`, {
            method: 'PUT',
            headers: authHeaders(globalThis.friendToken),
            body: Buffer.from('hi'),
        });
        assertEqual(ok.status, 200, '自己命名空间状态码');
        const denied = await fetch(`${BASE}/v1/ns/A/tavern/f.txt`, {
            method: 'PUT',
            headers: authHeaders(globalThis.friendToken),
            body: Buffer.from('hi'),
        });
        assertEqual(denied.status, 403, '越权状态码');
    });

    await check('邀请码不能重复使用', async () => {
        const res = await fetch(`${BASE}/v1/invite/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: inviteCode }),
        });
        assertEqual(res.status, 403, '状态码');
    });

    await stopServer(server);
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});

    const failed = results.filter((item) => !item.ok);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    if (failed.length) {
        console.log('失败项:');
        for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch((err) => {
    console.error('测试运行失败:', err);
    process.exit(1);
});
