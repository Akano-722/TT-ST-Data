'use strict';

const path = require('path');

/** 带 HTTP 状态码的错误，交给统一错误中间件处理 */
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const badRequest = (msg) => new HttpError(400, msg);

/**
 * 校验单个路径片段。传入的片段必须已经按 "/" 拆开。
 * 这里挡的是路径穿越：拒绝空片段、`.`/`..`、空字节、以及任何路径分隔符。
 */
function assertSegment(segment, label) {
    if (typeof segment !== 'string' || segment.length === 0) {
        throw badRequest(`${label} 不能为空`);
    }
    if (segment.includes('\0')) {
        throw badRequest(`${label} 含有空字节`);
    }
    if (segment === '.' || segment === '..') {
        throw badRequest(`${label} 非法: ${segment}`);
    }
    if (segment.includes('/') || segment.includes('\\')) {
        throw badRequest(`${label} 不能包含路径分隔符: ${segment}`);
    }
    return segment;
}

/** 把 "a/b/c" 拆成 ["a","b","c"]，忽略空片段和首尾斜杠 */
function splitKey(key) {
    if (key === undefined || key === null) return [];
    return String(key).split('/').filter((part) => part.length > 0);
}

/**
 * 在 root 之下解析出绝对路径，并再次确认没有越界。
 * assertSegment 已经挡住 `..`，这里是纵深防御：即使上游校验被绕过，也不会写到 root 之外。
 */
function resolveWithin(root, parts) {
    const base = path.resolve(root);
    const full = path.resolve(base, ...parts);
    if (full !== base && !full.startsWith(base + path.sep)) {
        throw badRequest('路径越界');
    }
    return full;
}

/** 命名空间名只允许安全字符，避免它同时被当成文件名使用时的各种麻烦 */
const NAMESPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;

module.exports = { HttpError, badRequest, assertSegment, splitKey, resolveWithin, NAMESPACE_RE };
