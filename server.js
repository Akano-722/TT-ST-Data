'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const express = require('express');

const { Auth, timingSafeEqualStr } = require('./lib/auth');
const { Storage } = require('./lib/storage');
const { HttpError, badRequest, assertSegment, splitKey, NAMESPACE_RE } = require('./lib/paths');

const VERSION = require('./package.json').version;

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ENABLE_INVITES = String(process.env.ENABLE_INVITES || '').toLowerCase() === 'true';
const BOOTSTRAP_NAMESPACE = (process.env.BOOTSTRAP_NAMESPACE || '').trim();
const BOOTSTRAP_TOKEN = (process.env.BOOTSTRAP_TOKEN || '').trim();

const auth = new Auth(path.join(DATA_DIR, 'auth.json'));
const storage = new Storage(DATA_DIR);

// ---------------------------------------------------------------- 中间件

function cors(req, res, next) {
    // 扩展跑在酒馆页面的源上，访问中转是跨域的，必须放行。
    // 用 Bearer 令牌而不是 Cookie，所以 Allow-Origin: * 是安全的。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
}

function logger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)}ms)`);
    });
    next();
}

function bearerToken(req) {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
}

/** 普通用户鉴权：令牌 -> 命名空间，挂到 req.namespace */
function authenticate(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: '缺少 Bearer 令牌' });
    const namespace = auth.resolveToken(token);
    if (!namespace) return res.status(403).json({ error: '令牌无效' });
    req.namespace = namespace;
    return next();
}

/** 管理鉴权：只认 ADMIN_TOKEN */
function requireAdmin(req, res, next) {
    const token = bearerToken(req);
    if (!ADMIN_TOKEN) return res.status(500).json({ error: '服务端未配置 ADMIN_TOKEN' });
    if (!token || !timingSafeEqualStr(token, ADMIN_TOKEN)) {
        return res.status(403).json({ error: '需要管理员令牌' });
    }
    return next();
}

/**
 * 命名空间隔离的核心：URL 里的 :ns 必须等于令牌绑定的命名空间。
 * 这样 A 的令牌在服务端根本走不到 B 的目录，不依赖上层逻辑写对。
 */
function requireOwnNamespace(req, res, next) {
    try {
        assertSegment(req.params.ns, 'namespace');
        if (req.params.ns !== req.namespace) {
            return res.status(403).json({ error: '令牌无权访问该命名空间' });
        }
        assertSegment(req.params.bucket, 'bucket');
        return next();
    } catch (err) {
        return next(err);
    }
}

/** 从通配符里取出 key，并逐个片段校验 */
function keyPartsOf(req) {
    const parts = splitKey(req.params[0]);
    if (parts.length === 0) throw badRequest('缺少文件路径');
    parts.forEach((part) => assertSegment(part, 'key'));
    return parts;
}

// ---------------------------------------------------------------- 应用

const app = express();
app.set('trust proxy', 1);
app.use(cors);
app.use(logger);

// 刻意不全局挂 express.json()：它会按 Content-Type 吃掉请求体，
// 而文件上传接口要拿到原始的 req 流。只在真正需要解析 JSON 的路由上挂。
const jsonBody = express.json({ limit: '1mb' });

app.get('/', (req, res) => {
    res.json({
        service: 'st-sync-relay',
        version: VERSION,
        invites: ENABLE_INVITES,
        endpoints: {
            health: 'GET    /health',
            meta: 'GET    /v1/meta',
            put: 'PUT    /v1/ns/:ns/:bucket/*key',
            get: 'GET    /v1/ns/:ns/:bucket/*key',
            list: 'GET    /v1/ns/:ns/:bucket              (列出文件与用量)',
            remove: 'DELETE /v1/ns/:ns/:bucket/*key',
            adminUI: 'GET    /admin                       (管理后台页面，页面本身不需要令牌)',
            adminNamespaces: 'GET    /admin/namespaces            (需管理员令牌)',
            adminNamespace: 'POST   /admin/namespace             (需管理员令牌)',
            adminBuckets: 'GET    /admin/namespaces/:ns/buckets             (需管理员令牌)',
            adminBucket: 'GET    /admin/namespaces/:ns/buckets/:bucket      (需管理员令牌)',
            adminFile: 'GET    /admin/namespaces/:ns/buckets/:bucket/files/*key (需管理员令牌)',
            adminInvite: 'POST   /admin/invite                (需管理员令牌，且 ENABLE_INVITES=true)',
            redeem: 'POST   /v1/invite/redeem',
        },
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, version: VERSION });
});

app.get('/v1/meta', authenticate, (req, res) => {
    res.json({ ok: true, namespace: req.namespace });
});

// ---- 文件读写 ----

app.put('/v1/ns/:ns/:bucket/*', authenticate, requireOwnNamespace, async (req, res, next) => {
    try {
        const keyParts = keyPartsOf(req);
        const result = await storage.put([req.namespace, req.params.bucket, ...keyParts], req);
        res.json({
            ok: true,
            key: keyParts.join('/'),
            size: result.size,
            mtime: result.mtime,
            sha256: result.sha256,
        });
    } catch (err) {
        next(err);
    }
});

app.get('/v1/ns/:ns/:bucket/*', authenticate, requireOwnNamespace, async (req, res, next) => {
    try {
        const keyParts = keyPartsOf(req);
        const target = await storage.stat([req.namespace, req.params.bucket, ...keyParts]);
        if (!target) return res.status(404).json({ error: '文件不存在' });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(target.size));
        res.setHeader('X-Mtime', String(target.mtime));
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length,X-Mtime');
        await pipeline(fs.createReadStream(target.abs), res);
        return undefined;
    } catch (err) {
        // 下载中途出错时响应头已经发出去了，没法再回 JSON
        if (res.headersSent) return res.destroy();
        return next(err);
    }
});

app.delete('/v1/ns/:ns/:bucket/*', authenticate, requireOwnNamespace, async (req, res, next) => {
    try {
        const keyParts = keyPartsOf(req);
        const removed = await storage.remove([req.namespace, req.params.bucket, ...keyParts]);
        if (!removed) return res.status(404).json({ error: '文件不存在' });
        res.json({ ok: true, key: keyParts.join('/') });
    } catch (err) {
        next(err);
    }
});

// 注意：这条必须放在带通配符的路由之后也没关系——Express 匹配的是完整路径，
// /v1/ns/A/tavern 不会命中 /v1/ns/:ns/:bucket/*（通配符要求末尾有斜杠）。
app.get('/v1/ns/:ns/:bucket', authenticate, requireOwnNamespace, async (req, res, next) => {
    try {
        const files = await storage.list([req.namespace, req.params.bucket]);
        const usage = files.reduce((sum, file) => sum + file.size, 0);
        res.json({ ok: true, bucket: req.params.bucket, count: files.length, usage, files });
    } catch (err) {
        next(err);
    }
});

// ---- 管理 ----

app.get('/admin/namespaces', requireAdmin, (req, res) => {
    const namespaces = Object.entries(auth.data.namespaces).map(([name, record]) => ({
        namespace: name,
        createdAt: record.createdAt,
    }));
    res.json({ ok: true, namespaces, invites: auth.data.invites.length });
});

app.post('/admin/namespace', requireAdmin, jsonBody, async (req, res, next) => {
    try {
        const namespace = String((req.body && req.body.namespace) || '').trim();
        if (!NAMESPACE_RE.test(namespace)) {
            throw badRequest('namespace 只允许字母、数字、下划线、中划线，长度 1-64');
        }
        if (auth.hasNamespace(namespace)) {
            return res.status(409).json({ error: `命名空间 ${namespace} 已存在` });
        }
        const token = auth.createNamespace(namespace);
        await auth.save();
        console.log(`[admin] 已创建命名空间 ${namespace}，令牌仅在本次响应中可见`);
        res.json({ ok: true, namespace, token, note: '请立即保存令牌，服务端只存哈希，无法找回' });
    } catch (err) {
        next(err);
    }
});

app.post('/admin/invite', requireAdmin, jsonBody, async (req, res, next) => {
    try {
        if (!ENABLE_INVITES) {
            return res.status(501).json({
                error: '邀请码功能未启用',
                hint: '设置环境变量 ENABLE_INVITES=true 后重启服务即可启用',
            });
        }
        const namespace = String((req.body && req.body.namespace) || '').trim();
        const ttlHours = Number((req.body && req.body.ttlHours) || 0);
        if (!NAMESPACE_RE.test(namespace)) {
            throw badRequest('namespace 只允许字母、数字、下划线、中划线，长度 1-64');
        }
        if (auth.hasNamespace(namespace)) {
            return res.status(409).json({ error: `命名空间 ${namespace} 已存在` });
        }
        const invite = auth.createInvite(namespace, ttlHours);
        await auth.save();
        res.json({ ok: true, ...invite, note: '把 code 给对方，对方调 POST /v1/invite/redeem 换取令牌' });
    } catch (err) {
        next(err);
    }
});

// ---- 管理：浏览各命名空间的数据（只读）----
// /admin 那个页面用的。注意这三条**刻意绕过了命名空间隔离**：一个 ADMIN_TOKEN
// 能看所有人的数据。这是管理员该有的权限，也正因如此它们只能挂在 requireAdmin 下，
// 绝不能挪到 authenticate 那一套里去。
//
// 路径嵌在 /admin/namespaces 下面，是为了不和 POST /admin/namespace 撞车——
// 那条是"建命名空间"，少一个 s，两条路互不影响。

app.get('/admin/namespaces/:ns/buckets', requireAdmin, async (req, res, next) => {
    try {
        assertSegment(req.params.ns, 'namespace');
        const buckets = await storage.listBuckets([req.params.ns]);
        res.json({ ok: true, namespace: req.params.ns, buckets });
    } catch (err) {
        next(err);
    }
});

app.get('/admin/namespaces/:ns/buckets/:bucket', requireAdmin, async (req, res, next) => {
    try {
        assertSegment(req.params.ns, 'namespace');
        assertSegment(req.params.bucket, 'bucket');
        const files = await storage.list([req.params.ns, req.params.bucket]);
        const usage = files.reduce((sum, file) => sum + file.size, 0);
        res.json({
            ok: true,
            namespace: req.params.ns,
            bucket: req.params.bucket,
            count: files.length,
            usage,
            files,
        });
    } catch (err) {
        next(err);
    }
});

// 下载。写法和 /v1/ns/:ns/:bucket/* 那条完全一致，只是鉴权换成了管理员令牌——
// 后台要能直接看 latest.json，光有列表不够。
app.get('/admin/namespaces/:ns/buckets/:bucket/files/*', requireAdmin, async (req, res, next) => {
    try {
        assertSegment(req.params.ns, 'namespace');
        assertSegment(req.params.bucket, 'bucket');
        const target = await storage.stat([req.params.ns, req.params.bucket, ...keyPartsOf(req)]);
        if (!target) return res.status(404).json({ error: '文件不存在' });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(target.size));
        res.setHeader('X-Mtime', String(target.mtime));
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length,X-Mtime');
        await pipeline(fs.createReadStream(target.abs), res);
        return undefined;
    } catch (err) {
        if (res.headersSent) return res.destroy();
        return next(err);
    }
});

// ---- 邀请码兑换（给朋友用，默认关闭）----

app.post('/v1/invite/redeem', jsonBody, async (req, res, next) => {
    try {
        if (!ENABLE_INVITES) {
            return res.status(501).json({ error: '邀请码功能未启用' });
        }
        const code = String((req.body && req.body.code) || '').trim();
        if (!code) throw badRequest('缺少邀请码');

        const { invite, error } = auth.findUsableInvite(code);
        if (error) return res.status(403).json({ error });

        const token = auth.createNamespace(invite.namespace);
        invite.redeemedAt = new Date().toISOString();
        await auth.save();
        res.json({ ok: true, namespace: invite.namespace, token, note: '请立即保存令牌，服务端只存哈希' });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------- 管理后台页面

// 页面本身**不需要令牌**——它只是一张静态 HTML，数据全靠上面的接口现拿，
// 而接口是要 ADMIN_TOKEN 的。所以这里托管静态文件不构成泄露面。
// 必须注册在所有 /admin API 之后：先来的先匹配，/admin/namespaces 仍然走 JSON 接口，
// 只有没被 API 接住的路径（也就是 GET /admin 本身）才落到这里。
//
// 单独给 /admin 一条：光靠 express.static 的话，访问 /admin 会先吃一个 301 跳到 /admin/。
// 浏览器会跟，但 curl 和脚本里就多一次跳转，不如直接给。
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use('/admin', express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- 兜底

app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', err);
    if (res.headersSent) return res.destroy();
    return res.status(status).json({ error: err.message || '服务器内部错误' });
});

// ---------------------------------------------------------------- 启动

async function bootstrap() {
    await storage.init();
    await auth.load();

    if (!ADMIN_TOKEN) {
        console.warn('[warn] 未设置 ADMIN_TOKEN，管理接口不可用。请设置后重启。');
    }

    // Zeabur 这类平台不方便开 shell，所以支持用环境变量在首次启动时自建命名空间。
    if (BOOTSTRAP_NAMESPACE) {
        if (auth.hasNamespace(BOOTSTRAP_NAMESPACE)) {
            console.log(`[bootstrap] 命名空间 ${BOOTSTRAP_NAMESPACE} 已存在，跳过`);
        } else {
            const token = auth.createNamespace(BOOTSTRAP_NAMESPACE, BOOTSTRAP_TOKEN || undefined);
            await auth.save();
            console.log('=========================================================');
            console.log(`[bootstrap] 已创建命名空间 ${BOOTSTRAP_NAMESPACE}`);
            console.log(`[bootstrap] 访问令牌: ${token}`);
            console.log('[bootstrap] 这行日志之后不会再出现，请立刻复制保存');
            console.log('=========================================================');
        }
    }

    app.listen(PORT, () => {
        console.log(`st-sync-relay v${VERSION} 监听 :${PORT}`);
        console.log(`数据目录: ${DATA_DIR}`);
        console.log(`邀请码功能: ${ENABLE_INVITES ? '已启用' : '关闭'}`);
    });
}

if (require.main === module) {
    bootstrap().catch((err) => {
        console.error('启动失败:', err);
        process.exit(1);
    });
}

module.exports = { app, auth, storage, bootstrap };
