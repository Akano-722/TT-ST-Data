#!/usr/bin/env node
'use strict';

/**
 * ZipReader / inflateRaw 的实测。
 *
 * 代码不是抄一份来测，是从 extension/st-sync/index.js 里按标记抠出**真实的**那一段
 * （// ==== ZIP-READER-BEGIN/END ====）在 Node 里跑，所以改了源码这里立刻跟着变。
 *
 * 每份夹具都由 Python 侧独立算出 sha256 当标准答案，两边实现完全不同 —— 这才叫交叉验证。
 * 每个用例跑两遍：一遍走浏览器原生 DecompressionStream，一遍强制走纯 JS 的 inflateRawJs。
 *
 * 用法：python tools/zip-reader-test/make_fixtures.py && node tools/zip-reader-test/run.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
// ST_SYNC_INDEX 可以指向别的副本，用来做变异测试：故意改坏一处，看测试抓不抓得住
const INDEX_JS = process.env.ST_SYNC_INDEX
    ? path.resolve(process.env.ST_SYNC_INDEX)
    : path.join(ROOT, 'extension', 'st-sync', 'index.js');
const FIXTURE_DIR = path.join(HERE, 'fixtures');

const BEGIN = '// ==== ZIP-READER-BEGIN ====';
const END = '// ==== ZIP-READER-END ====';

let pass = 0;
let fail = 0;
const failures = [];

function ok(label) {
    pass += 1;
    console.log(`  ✓ ${label}`);
}

function bad(label, detail) {
    fail += 1;
    failures.push(`${label}\n      ${detail}`);
    console.log(`  ✗ ${label}\n      ${detail}`);
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把真实的 ZipReader 抠出来。
 * DecompressionStream 作为形参传进去，等于在函数作用域里把它遮住 ——
 * 传 undefined 就强制走纯 JS 那条路。
 */
function loadReader(DecompressionStreamImpl) {
    const src = fs.readFileSync(INDEX_JS, 'utf8');
    const a = src.indexOf(BEGIN);
    const b = src.indexOf(END);
    if (a < 0 || b < 0 || b < a) {
        throw new Error(`在 ${INDEX_JS} 里找不到 ZIP-READER 标记，测试无法进行`);
    }
    const region = src.slice(a + BEGIN.length, b);
    const factory = new Function(
        'LOG', 'DecompressionStream',
        `${region}\nreturn { ZipReader, inflateRaw, inflateRawJs, decodeZipName };`,
    );
    return factory('[zip-test]', DecompressionStreamImpl);
}

/**
 * 三条路径各跑一遍：
 *   native   —— 浏览器原生 DecompressionStream
 *   pure     —— 传 undefined，typeof 检查不过，**完全不碰**原生，只能用 inflateRawJs
 *   fallback —— 探针是"看起来可用但一用就炸"的类，验证 try/catch 能回退到纯 JS
 */
let nativeAttempted = false;
class ProbeStream {
    constructor() {
        nativeAttempted = true;
        throw new Error('探针：原生解压不可用');
    }
}

const NATIVE = loadReader(globalThis.DecompressionStream);
const PURE = loadReader(undefined);
const FALLBACK = loadReader(ProbeStream);

/**
 * 跑一份夹具，返回 { names, bytes, error }。
 * bytes 是 Map<名字, Buffer>，只放成功读出来的。
 */
async function readFixture(api, filePath) {
    const blob = new Blob([fs.readFileSync(filePath)]);
    const reader = new api.ZipReader(blob);
    await reader.parse();

    const bytes = new Map();
    const errors = [];
    for (const entry of reader.entries) {
        try {
            bytes.set(entry.name, Buffer.from(await reader.readBytes(entry)));
        } catch (err) {
            errors.push({ name: entry.name, message: err.message });
        }
    }
    return { names: reader.entries.map((e) => e.name), bytes, errors };
}

async function checkFixture(api, label, fixture) {
    const filePath = path.join(FIXTURE_DIR, fixture.file);
    let result;
    try {
        result = await readFixture(api, filePath);
    } catch (err) {
        if (fixture.expectError) {
            if (err.message.includes(fixture.expectError)) {
                ok(`${fixture.file} [${label}] 按预期报错：${err.message}`);
            } else {
                bad(`${fixture.file} [${label}] 报错了但不是预期的`,
                    `预期含「${fixture.expectError}」，实际「${err.message}」`);
            }
        } else if (fixture.expectAnyError) {
            ok(`${fixture.file} [${label}] 按预期报错：${err.message}`);
        } else {
            bad(`${fixture.file} [${label}] 不该报错却抛了`, err.stack || err.message);
        }
        return;
    }

    if (fixture.expectError || fixture.expectAnyError) {
        // 有的坏包是在"读某个条目"时才炸，parse 本身不炸 —— 两种都算数
        if (result.errors.length) {
            ok(`${fixture.file} [${label}] 按预期在读条目时报错：${result.errors[0].message}`);
        } else {
            bad(`${fixture.file} [${label}] 预期报错，但整包读成功了（会静默产出垃圾数据）`,
                `解出 ${result.bytes.size} 个条目`);
        }
        return;
    }

    // 名字集合必须一致（19 号是"部分解析"的特例，只要求包含）
    const expectedNames = fixture.entries.map((e) => e.name);
    const missing = expectedNames.filter((n) => !result.names.includes(n));
    if (missing.length && !fixture.partialEntries) {
        bad(`${fixture.file} [${label}] 有条目没解析出来`, `缺：${JSON.stringify(missing.slice(0, 5))}`);
        return;
    }
    if (result.names.length !== fixture.entries.length && !fixture.partialEntries) {
        bad(`${fixture.file} [${label}] 条目数对不上`,
            `期望 ${fixture.entries.length}，实际 ${result.names.length}`);
        return;
    }

    for (const expected of fixture.entries) {
        const got = result.bytes.get(expected.name);
        if (!got) {
            if (fixture.partialEntries) continue;
            bad(`${fixture.file} [${label}] 读不出「${expected.name}」`, '（见上方错误）');
            return;
        }
        const digest = sha256(got);
        if (digest !== expected.sha256) {
            bad(`${fixture.file} [${label}] 「${expected.name}」内容不一致`,
                `期望 ${expected.size} 字节 sha256=${expected.sha256.slice(0, 16)}…，` +
                `实际 ${got.length} 字节 sha256=${digest.slice(0, 16)}…`);
            return;
        }
    }
    ok(`${fixture.file} [${label}] ${fixture.entries.length} 个条目的内容全部一致`);
}

/** 直接对拍 inflateRawJs 和浏览器原生解压，覆盖 Python 没造到的随机输入 */
async function fuzzInflate(rounds) {
    const random = require('crypto').randomBytes;
    const cases = [];
    for (let i = 0; i < rounds; i += 1) {
        const kind = i % 4;
        let size;
        if (kind === 0) size = i % 7;                        // 极小
        else if (kind === 1) size = 1 + (i * 37) % 2000;     // 小
        else if (kind === 2) size = 20000 + (i * 977) % 60000; // 中
        else size = 200000;                                   // 大

        let data;
        if (kind === 0) data = random(size);
        else if (kind === 1) data = Buffer.from('酒馆 '.repeat(Math.ceil(size / 6))).subarray(0, size);
        else if (kind === 2) data = random(size);
        else data = Buffer.from('A'.repeat(size));            // 极端可压，狂涨回溯距离
        cases.push(data);
    }

    let checked = 0;
    for (const data of cases) {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        writer.write(data);
        writer.close();
        const compressed = Buffer.from(await new Response(cs.readable).arrayBuffer());

        const native = Buffer.from(await new Response(
            new Response(compressed).body.pipeThrough(new DecompressionStream('deflate-raw')),
        ).arrayBuffer());
        const pure = Buffer.from(PURE.inflateRawJs(new Uint8Array(compressed), data.length));

        if (!native.equals(data)) {
            bad(`fuzz ${data.length}B 原生解压结果就不对`, '（环境问题，不是被测代码）');
            return;
        }
        if (!pure.equals(data)) {
            bad(`fuzz ${data.length}B 纯 JS 解压结果不一致`,
                `期望 ${data.length} 字节，实际 ${pure.length} 字节；` +
                `首个不同位置 ${[...data].findIndex((b, i) => pure[i] !== b)}`);
            return;
        }
        checked += 1;
    }
    ok(`纯 JS 解压与原生解压对拍 ${checked} 组（0B ~ 200KB，含高压缩比与随机数据），逐字节一致`);
}

async function main() {
    if (!fs.existsSync(path.join(FIXTURE_DIR, 'manifest.json'))) {
        console.error('没有夹具。先跑：python tools/zip-reader-test/make_fixtures.py');
        process.exit(2);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

    console.log(`\n被测代码：${path.relative(ROOT, INDEX_JS)}（按标记抠出真实实现）`);
    console.log(`夹具：${manifest.fixtures.length} 份，Python ${manifest.python} 生成\n`);

    console.log('── 原生解压路径 ──');
    for (const fixture of manifest.fixtures) {
        await checkFixture(NATIVE, '原生', fixture);
    }

    console.log('\n── 纯 JS 解压路径（DecompressionStream 传 undefined，彻底不碰原生）──');
    for (const fixture of manifest.fixtures) {
        nativeAttempted = false;
        await checkFixture(PURE, '纯JS', fixture);
        if (nativeAttempted) {
            bad(`${fixture.file} [纯JS] 居然走到了原生解压`, '纯 JS 实现根本没被测到');
        }
    }

    console.log('\n── 回退路径（原生"能用但会炸"，必须回退到纯 JS）──');
    // 这条路径每一步都会打印"原生解压失败，改用内置解压"，那是被测行为本身，测试期间静音
    const realWarn = console.warn;
    console.warn = () => {};
    for (const fixture of manifest.fixtures) {
        nativeAttempted = false;
        await checkFixture(FALLBACK, '回退', fixture);
        // 带压缩的包必须触发探针，否则说明它压根没试过原生，这条路径等于没测
        const compressed = fixture.entries.length > 0
            && !fixture.expectError && !fixture.expectAnyError;
        if (compressed && !nativeAttempted && fixture.file !== '01-stored.zip') {
            bad(`${fixture.file} [回退] 探针没被触发`,
                '说明没走"先试原生再回退"这条路，回退逻辑没被测到');
        }
    }
    console.warn = realWarn;

    console.log('\n── 纯 JS 解压对拍（随机输入）──');
    await fuzzInflate(240);

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
