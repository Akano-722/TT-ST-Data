'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

/** 令牌只以 sha256 形式落盘，明文仅在签发的那一刻返回一次 */
function sha256Hex(input) {
    return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function newInviteCode() {
    return crypto.randomBytes(9).toString('base64url');
}

/** 定长比较，避免按字符逐位比较泄漏时序信息 */
function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * auth.json 的读写。
 * 结构：
 * {
 *   "namespaces": { "A": { "tokenHash": "...", "createdAt": "..." } },
 *   "invites":    [ { "code": "...", "namespace": "B", "createdAt": "...", "expiresAt": "...", "redeemedAt": null } ]
 * }
 */
class Auth {
    constructor(file) {
        this.file = path.resolve(file);
        this.data = { namespaces: {}, invites: [] };
    }

    async load() {
        try {
            const raw = await fsp.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = {
                namespaces: parsed && typeof parsed.namespaces === 'object' && parsed.namespaces ? parsed.namespaces : {},
                invites: parsed && Array.isArray(parsed.invites) ? parsed.invites : [],
            };
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            // 首次启动：建一个空档
            await this.save();
        }
        return this;
    }

    /** 先写临时文件再 rename，避免写一半崩溃导致 auth.json 损坏 */
    async save() {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp-${process.pid}`;
        await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        await fsp.rename(tmp, this.file);
    }

    hasNamespace(namespace) {
        return Object.prototype.hasOwnProperty.call(this.data.namespaces, namespace);
    }

    /** 创建命名空间，返回明文令牌（调用方负责只展示一次） */
    createNamespace(namespace, token) {
        const issued = token || newToken();
        this.data.namespaces[namespace] = {
            tokenHash: sha256Hex(issued),
            createdAt: new Date().toISOString(),
        };
        return issued;
    }

    /** 用明文令牌反查命名空间；查不到返回 null */
    resolveToken(token) {
        if (!token) return null;
        const hash = sha256Hex(token);
        for (const [namespace, record] of Object.entries(this.data.namespaces)) {
            if (record && record.tokenHash && timingSafeEqualStr(record.tokenHash, hash)) {
                return namespace;
            }
        }
        return null;
    }

    // ---- 邀请码：默认关闭，靠 ENABLE_INVITES 打开 ----

    createInvite(namespace, ttlHours) {
        const now = Date.now();
        const invite = {
            code: newInviteCode(),
            namespace,
            createdAt: new Date(now).toISOString(),
            expiresAt: ttlHours > 0 ? new Date(now + ttlHours * 3600 * 1000).toISOString() : null,
            redeemedAt: null,
        };
        this.data.invites.push(invite);
        return invite;
    }

    findUsableInvite(code) {
        const invite = this.data.invites.find((item) => item.code === code);
        if (!invite) return { error: '邀请码不存在' };
        if (invite.redeemedAt) return { error: '邀请码已被使用' };
        if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) return { error: '邀请码已过期' };
        if (this.hasNamespace(invite.namespace)) return { error: `命名空间 ${invite.namespace} 已被占用` };
        return { invite };
    }
}

module.exports = { Auth, sha256Hex, newToken, newInviteCode, timingSafeEqualStr };
