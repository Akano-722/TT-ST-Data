'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');


const { HttpError } = require('./paths');

const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;
/** 会话闲置多久后回收（临时文件也一起删） */
const DEFAULT_IDLE_MS = 6 * 60 * 60 * 1000;
/** 每小时扫一次 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 分片追加上传。
 *
 * 为什么需要它：手机端要把几百 MB 的备份拼成 zip，老做法是整包留在 JS 内存里再
 * 一次 PUT，iOS WebView 会被内存压力杀掉（表现就是页面突然重载）。改成客户端
 * 边收集边拼、每 4 MB 发一片，中转按顺序追加到一个临时文件，内存占用就只和
 * 单片大小有关。
 *
 * 关键约束：
 *  - **必须顺序追加**。客户端按 seq 串行发；这里再用每会话的 Promise 锁保一道。
 *  - **必须幂等**。客户端某片超时后会用同一个 seq 重试；如果上一片其实已经写进去了，
 *    不能重复追加，直接回上一次成功的结果。
 *  - 进程重启后内存里的会话就没了，启动时把临时目录清空即可（旧客户端会收到 404
 *    然后从头再来，不会产生半截快照）。
 *
 * 临时文件放在 `<DATA_DIR>/.uploads/`，和最终目标在同一个卷上，finish 时 rename
 * 是原子的——下游永远看不到写了一半的 zip。
 */
class UploadSessions {
    constructor(storage, { idleMs = DEFAULT_IDLE_MS } = {}) {
        this.storage = storage;
        this.dir = path.join(storage.root, '.uploads');
        this.idleMs = idleMs;
        this.sessions = new Map();
        this.timer = null;
    }

    async init() {
        await fsp.mkdir(this.dir, { recursive: true });

        // 内存会话不会跨进程存活，启动时残留的临时文件不会再有人认领。
        // 直接清掉，避免重启次数一多把磁盘塞满。
        const leftovers = await fsp.readdir(this.dir).catch(() => []);
        await Promise.all(leftovers.map((name) => (
            fsp.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => {})
        )));

        if (!this.timer) {
            this.timer = setInterval(() => {
                this.cleanup().catch((err) => console.error('[uploads] 清理失败', err));
            }, CLEANUP_INTERVAL_MS);
            // 测试/脚本里别让这个定时器把进程吊住
            if (typeof this.timer.unref === 'function') this.timer.unref();
        }
    }

    async begin({ namespace, bucket, key }) {
        const id = crypto.randomBytes(16).toString('hex');
        const tmp = path.join(this.dir, `${id}.part`);
        // 'wx'：万一 id 撞了（不可能），宁可报错也不要覆盖别人的上传
        await fsp.writeFile(tmp, Buffer.alloc(0), { flag: 'wx' });

        const session = {
            id,
            namespace,
            bucket,
            key,
            tmp,
            size: 0,
            nextSeq: 0,
            createdAt: Date.now(),
            touchedAt: Date.now(),
            gone: false,
            // 每个会话一条串行链：同一片的超时重试可能和前一次请求并发到达，
            // 先排队再判 seq，才能稳定地识别"已经写过了"。
            lock: Promise.resolve(),
        };
        this.sessions.set(id, session);
        return { uploadId: id, key };
    }

    get(uploadId, namespace) {
        if (!UPLOAD_ID_RE.test(String(uploadId || ''))) return null;
        const session = this.sessions.get(uploadId);
        if (!session || session.gone || session.namespace !== namespace) return null;
        return session;
    }

    enqueue(session, fn) {
        const run = session.lock.then(fn, fn);
        // 链本身要吞掉错误，否则一次失败会把后面所有请求都带进 rejected 分支
        session.lock = run.then(() => {}, () => {});
        return run;
    }

    /**
     * 追加一片。
     * @param {number} seq 从 0 开始的分片序号
     * @param {import('stream').Readable} readable 请求体
     */
    append(session, seq, readable) {
        return this.enqueue(session, async () => {
            if (session.gone) {
                // 会话已经没了，但仍要把请求体读掉，否则连接会一直挂着
                readable.resume();
                throw new HttpError(404, '上传会话不存在或已结束');
            }
            session.touchedAt = Date.now();

            // 客户端超时重试：上一片已经落盘了，把请求体冲掉，回同一个结果。
            // 不重复追加是这份实现的核心，否则整包会多出一段、zip 直接坏掉。
            if (seq === session.nextSeq - 1) {
                readable.resume();
                return { ok: true, seq, size: session.size, duplicate: true };
            }
            if (seq !== session.nextSeq) {
                readable.resume();
                throw new HttpError(409, `分片序号不对：期望 ${session.nextSeq}，收到 ${seq}`);
            }

            // 这一片开始前的大小。失败时截回去，重试同一 seq 就能接着写。
            const before = session.size;
            try {
                await pipeline(readable, fs.createWriteStream(session.tmp, { flags: 'a' }));
            } catch (err) {
                // 手机网络抖一下很常见，不能因此把整个会话作废（客户端要重新读一遍酒馆的
                // 几百 MB 数据）。追加失败只会留下半片垃圾，截回 before 就恢复原状。
                // 代价是 sha256 没法增量算了：半片的字节已经喂进 hash，退不回去。
                // 所以改成 finish 时把临时文件流式读一遍算 hash（本地磁盘，几秒钟）。
                try {
                    await fsp.truncate(session.tmp, before);
                    session.size = before;
                } catch (truncErr) {
                    // 截不回去就真的没法接着用了
                    await this.discardNow(session);
                }
                throw err;
            }

            const stat = await fsp.stat(session.tmp);
            session.size = stat.size;
            session.nextSeq = seq + 1;
            return { ok: true, seq, size: session.size };
        });
    }

    /** finish：校验大小 → 拿 sha256 → rename 到最终 key。 */
    finish(session, expectedSize) {
        return this.enqueue(session, async () => {
            if (session.gone) throw new HttpError(404, '上传会话不存在或已结束');
            session.touchedAt = Date.now();

            const stat = await fsp.stat(session.tmp);
            if (Number.isFinite(expectedSize) && expectedSize !== stat.size) {
                throw new HttpError(400, `上传大小对不上：期望 ${expectedSize}，实际 ${stat.size}`);
            }
            session.size = stat.size;

            const target = this.storage.pathFor([session.namespace, session.bucket, ...session.key.split('/')]);
            await fsp.mkdir(path.dirname(target), { recursive: true });

            // 分片可能失败重试过，增量 hash 无法回滚，所以这里把临时文件流式读一遍。
            // 本地磁盘顺序读，240 MB 也就一两秒；换来的是一片失败不用从头重传。
            const hash = crypto.createHash('sha256');
            await pipeline(
                fs.createReadStream(session.tmp),
                new Transform({
                    transform(chunk, encoding, callback) {
                        hash.update(chunk);
                        callback();
                    },
                }),
            );
            const sha256 = hash.digest('hex');

            try {
                await fsp.rename(session.tmp, target);
            } catch (err) {
                // Windows 上 rename 不覆盖已存在的文件；Linux 部署用不到，但本地测试要过
                if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES') {
                    await fsp.rm(target, { force: true });
                    await fsp.rename(session.tmp, target);
                } else {
                    throw err;
                }
            }

            session.gone = true;
            this.sessions.delete(session.id);

            const finalStat = await fsp.stat(target);
            return {
                ok: true,
                key: session.key,
                size: finalStat.size,
                mtime: finalStat.mtimeMs,
                sha256,
            };
        });
    }

    /** 客户端主动放弃，或清理过期会话 */
    abort(session) {
        return this.enqueue(session, () => this.discardNow(session));
    }

    /** 调用方必须已经持有该会话的锁（append 的 catch 里直接调） */
    async discardNow(session) {
        if (session.gone) return;
        session.gone = true;
        this.sessions.delete(session.id);
        await fsp.rm(session.tmp, { force: true }).catch(() => {});
    }

    async cleanup(now = Date.now()) {
        const stale = [...this.sessions.values()].filter((s) => now - s.touchedAt >= this.idleMs);
        await Promise.all(stale.map((session) => this.abort(session).catch(() => {})));
        return stale.length;
    }
}

module.exports = { UploadSessions, UPLOAD_ID_RE };
