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

    /**
     * 列出某命名空间下的一级目录，也就是"桶"。
     *
     * 桶是隐式的：磁盘上没有"创建桶"这个动作，第一次写入时目录才被 mkdir 出来，
     * 所以没有任何地方记着创建时间。目录自身的 mtime 也不能用——往里加一层子目录
     * 就会把它刷新。唯一稳的时间锚点是**桶内最早那个文件的 mtime**，拿它当"新增时间"；
     * 桶被清空时没有文件可依据，老老实实返回 null，别编一个。
     */
    async listBuckets(parts) {
        const base = this.pathFor(parts);
        let entries;
        try {
            entries = await fsp.readdir(base, { withFileTypes: true });
        } catch (err) {
            if (err.code === 'ENOENT') return [];   // 命名空间还没有任何数据，不是错误
            throw err;
        }

        const buckets = [];
        for (const entry of entries) {
            // 命名空间目录下只该有桶。真有 stray 文件掉进来（比如误放的 auth.json），
            // 跳过而不是把它当成一个桶列出来。
            if (!entry.isDirectory()) continue;
            const files = await this.list([...parts, entry.name]);
            const times = files.map((file) => file.mtime).filter((t) => Number.isFinite(t));
            buckets.push({
                bucket: entry.name,
                count: files.length,
                usage: files.reduce((sum, file) => sum + file.size, 0),
                createdAt: times.length ? Math.min(...times) : null,
                lastModified: times.length ? Math.max(...times) : null,
            });
        }
        buckets.sort((a, b) => a.bucket.localeCompare(b.bucket));
        return buckets;
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
