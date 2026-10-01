'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { resolveWithin } = require('./paths');

/**
 * 磁盘存储：root/<namespace>/<bucket>/<key>
 * 这一层刻意不认识"文件是什么"——它就是个通用桶，酒馆备份只是里面的一种 key。
 */
class Storage {
    constructor(root) {
        this.root = path.resolve(root);
    }

    async init() {
        await fsp.mkdir(this.root, { recursive: true });
    }

    pathFor(parts) {
        return resolveWithin(this.root, parts);
    }

    /**
     * 流式写盘：先写 .tmp 再 rename，避免半截文件被下游当成完整备份读走。
     * 顺手用 Transform 从流里算 sha256 —— 客户端就不用依赖 crypto.subtle
     * （局域网走 http 时那不是安全上下文，crypto.subtle 会不可用）。
     */
    async put(parts, readable) {
        const dest = this.pathFor(parts);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.tmp-${process.pid}-${Date.now().toString(36)}`;

        const hash = crypto.createHash('sha256');
        const tap = new Transform({
            transform(chunk, encoding, callback) {
                hash.update(chunk);
                callback(null, chunk);
            },
        });

        try {
            await pipeline(readable, tap, fs.createWriteStream(tmp));
            await fsp.rename(tmp, dest);
            const stat = await fsp.stat(dest);
            return { size: stat.size, mtime: stat.mtimeMs, sha256: hash.digest('hex') };
        } catch (err) {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            throw err;
        }
    }

    /** 返回 { abs, size, mtime }；不存在或不是普通文件时返回 null */
    async stat(parts) {
        const abs = this.pathFor(parts);
        try {
            const stat = await fsp.stat(abs);
            if (!stat.isFile()) return null;
            return { abs, size: stat.size, mtime: stat.mtimeMs };
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    /** 递归列出 bucket 下所有文件，key 为相对 bucket 的 POSIX 风格路径 */
    async list(parts) {
        const base = this.pathFor(parts);
        const files = [];

        const walk = async (dir) => {
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch (err) {
                if (err.code === 'ENOENT') return;
                throw err;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.isFile()) {
                    const stat = await fsp.stat(full);
                    files.push({
                        key: path.relative(base, full).split(path.sep).join('/'),
                        size: stat.size,
                        mtime: stat.mtimeMs,
                    });
                }
            }
        };

        await walk(base);
        files.sort((a, b) => a.key.localeCompare(b.key));
        return files;
    }

    async remove(parts) {
        const target = await this.stat(parts);
        if (!target) return false;
        await fsp.rm(target.abs, { force: true });
        return true;
    }

    /** 汇总某命名空间占用的字节数，用于配额显示（暂不做强制限制） */
    async usage(parts) {
        const files = await this.list(parts);
        return files.reduce((sum, file) => sum + file.size, 0);
    }
}

module.exports = { Storage };
