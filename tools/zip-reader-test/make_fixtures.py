#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 extension/st-sync/index.js 里的 ZipReader 造测试用的 zip。

每份 zip 的"标准答案"（文件名 -> 原始内容的 sha256）写进 fixtures/manifest.json，
run.js 拿 ZipReader 解出来的结果逐条比对。标准答案由 Python 侧独立算出，
两边实现完全不同，才算交叉验证。

夹具分两类：
  A 组 用 zipfile 正常打包，模拟真实世界的包（酒馆备份就是这种）
  B 组 手工拼字节，专打边界：GBK 文件名、Zip64、本地头与中央目录长度不一致、
       三种 deflate 块类型、损坏包
"""

import hashlib
import json
import os
import random
import struct
import sys
import zipfile
import zlib

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')

FIXTURES = []


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def record(file_name, note, entries, expect_error=None, extra=None):
    """
    记一份夹具。entries 是 [(zip 里的名字, 原始内容 bytes), ...]。

    目录项（名字以 / 结尾）也要记进来：ZipReader 是忠实返回归档里所有条目的，
    过滤目录项是恢复阶段的 classifyRestoreEntry 干的事。这里漏记会让"条目数对不上"
    变成一个假警报（测过，确实报过）。
    """
    item = {
        'file': file_name,
        'note': note,
        'expectError': expect_error,
        'entries': [
            {'name': name, 'sha256': sha256(data), 'size': len(data)}
            for name, data in entries
        ],
    }
    if extra:
        item.update(extra)
    FIXTURES.append(item)


# ------------------------------------------------------------------ 造数据

def text_repeat(n, unit='酒馆云同步 ST-Sync 🎭 测试 '):
    return (unit * n).encode('utf-8')


def tavern_layout():
    """一份贴近真实备份的目录结构，用来测路径解析和 jsonl/中文内容。"""
    rnd = random.Random(20261001)
    entries = []
    entries.append(('characters/', b''))
    entries.append(('characters/Seraphina.png', bytes(rnd.randrange(256) for _ in range(4096))))
    entries.append(('characters/小明.json', json.dumps(
        {'name': '小明', 'description': '一个测试角色，含中文与 emoji 🎭'}, ensure_ascii=False).encode('utf-8')))
    entries.append(('chats/', b''))
    entries.append(('chats/Seraphina/', b''))
    chat = []
    for i in range(40):
        chat.append(json.dumps(
            {'name': 'Seraphina' if i % 2 else 'User',
             'is_user': i % 2 == 0,
             'mes': f'第 {i} 条消息，中文内容 + emoji 🎭 + 换行\n第二行',
             'send_date': '2026-09-01T10:00:00.000Z'},
            ensure_ascii=False))
    entries.append(('chats/Seraphina/2026-09-01@10h00m00s.jsonl',
                    ('\n'.join(chat) + '\n').encode('utf-8')))
    entries.append(('chats/小明/默认.jsonl', '\n'.join(chat[:5]).encode('utf-8')))
    entries.append(('group chats/', b''))
    entries.append(('group chats/群聊-2026.jsonl', '\n'.join(chat[:3]).encode('utf-8')))
    entries.append(('groups/我的群组.json', json.dumps(
        {'id': '我的群组', 'name': '我的群组', 'members': ['Seraphina.png']}, ensure_ascii=False).encode('utf-8')))
    entries.append(('worlds/世界观.json', json.dumps(
        {'entries': {'0': {'key': ['魔法'], 'content': '设定内容'}}}, ensure_ascii=False).encode('utf-8')))
    entries.append(('themes/暗色.json', json.dumps({'name': '暗色'}, ensure_ascii=False).encode('utf-8')))
    entries.append(('OpenAI Settings/我的预设.json', json.dumps(
        {'temp': 0.9, 'name': '我的预设'}, ensure_ascii=False).encode('utf-8')))
    entries.append(('QuickReplies/常用.json', json.dumps({'name': '常用'}, ensure_ascii=False).encode('utf-8')))
    entries.append(('movingUI/布局.json', json.dumps({'name': '布局'}, ensure_ascii=False).encode('utf-8')))
    entries.append(('backgrounds/房间.png', bytes(rnd.randrange(256) for _ in range(2048))))
    entries.append(('User Avatars/me.png', bytes(rnd.randrange(256) for _ in range(1024))))
    entries.append(('user/images/char1.png', bytes(rnd.randrange(256) for _ in range(512))))
    entries.append(('user/files/note.txt', '附件内容 📎'.encode('utf-8')))
    entries.append(('settings.json', json.dumps(
        {'theme': '暗色', 'username': '小明'}, ensure_ascii=False).encode('utf-8')))
    # 这几类是恢复时要跳过的目录，留着确认解析器不会把它们当普通文件
    entries.append(('thumbnails/x.png', b'thumb'))
    entries.append(('vectors/v.json', b'{"a":1}'))
    entries.append(('assets/sticker.png', b'sticker'))
    entries.append(('extensions/x.js', b'console.log(1)'))
    entries.append(('__MACOSX/._x', b'junk'))
    return entries


# ------------------------------------------------------------------ A 组：zipfile 正规打包

def build_with_zipfile(file_name, note, entries, compression, compresslevel=None):
    """
    注意：writestr(ZipInfo, data) 用的是 **ZipInfo 自己的 compress_type**（默认 ZIP_STORED），
    不是归档的 compression —— 不显式设一遍，写出来的就是没压缩的包，
    夹具会"看起来正常"但其实根本没测到 deflate。
    """
    path = os.path.join(OUT, file_name)
    with zipfile.ZipFile(path, 'w', compression) as zf:
        for name, data in entries:
            zi = zipfile.ZipInfo(name, date_time=(2026, 10, 1, 12, 0, 0))
            zi.compress_type = compression
            if compresslevel is not None:
                zi.compress_level = compresslevel
            zf.writestr(zi, data)

    with zipfile.ZipFile(path) as zf:
        methods = {zi.compress_type for zi in zf.infolist()}
    expected = {zipfile.ZIP_STORED} if compression == zipfile.ZIP_STORED else {compression}
    if not methods <= expected:
        raise AssertionError(f'{file_name} 里出现了没预料到的压缩方式 {methods}，夹具不合格')

    record(file_name, note, entries)


# ------------------------------------------------------------------ B 组：手工拼字节

def deflate_raw(data, level=9, strategy=zlib.Z_DEFAULT_STRATEGY):
    co = zlib.compressobj(level, zlib.DEFLATED, -15, 9, strategy)
    return co.compress(data) + co.flush()


def raw_entry(name, data, method=8, flags=0, local_extra=b'', central_extra=b'',
              comp_override=None, zip64_sizes=False, descriptor=False):
    """descriptor=True 时按 archiver 那种流式写法产出：本地头里尺寸和 crc 全写 0、
    置 bit3，真值放在数据后面的数据描述符里 —— 酒馆备份很可能就是这个形态。"""
    crc = zlib.crc32(data) & 0xFFFFFFFF
    if method == 0:
        comp = data
    elif method == 8:
        comp = deflate_raw(data) if comp_override is None else comp_override
    else:
        raise ValueError('只支持 0 / 8')
    return {
        'name': name, 'data': data, 'comp': comp, 'crc': crc, 'method': method,
        'flags': flags, 'local_extra': local_extra, 'central_extra': central_extra,
        'zip64_sizes': zip64_sizes, 'descriptor': descriptor,
    }


def build_zip(entries, comment=b'', zip64=False, corrupt_cd_at=None):
    """
    entries: raw_entry 列表。
    zip64: 传 True 时，EOCD 里的条目数/偏移/长度全写 0xFFFFFFFF，并补上
           Zip64 EOCD record + locator；同时每个条目的中央目录字段也写 0xFFFFFFFF，
           真值放进 0x0001 扩展区（这正是 Zip64 的规定做法）。
    """
    out = bytearray()
    offsets = []
    for e in entries:
        offsets.append(len(out))
        if e['descriptor']:
            # 流式写法：写头的时候还不知道 crc 和大小，全填 0 并置 bit3
            flags = e['flags'] | 0x0008
            crc_field, comp_field, uncomp_field = 0, 0, 0
        else:
            flags = e['flags']
            crc_field, comp_field, uncomp_field = e['crc'], len(e['comp']), len(e['data'])
        out += struct.pack(
            '<IHHHHHIIIHH', 0x04034b50, 45 if zip64 else 20, flags, e['method'],
            0, 0x21, crc_field, comp_field, uncomp_field,
            len(e['name']), len(e['local_extra']))
        out += e['name'] + e['local_extra'] + e['comp']
        if e['descriptor']:
            out += struct.pack('<IIII', 0x08074b50, e['crc'], len(e['comp']), len(e['data']))

    cd_start = len(out)
    for i, e in enumerate(entries):
        if e['zip64_sizes']:
            comp_size = 0xFFFFFFFF
            uncomp_size = 0xFFFFFFFF
            offset = 0xFFFFFFFF
            extra = struct.pack('<HHQQQ', 0x0001, 24, len(e['data']), len(e['comp']), offsets[i])
        else:
            comp_size = len(e['comp'])
            uncomp_size = len(e['data'])
            offset = offsets[i]
            extra = e['central_extra']
        out += struct.pack(
            '<IHHHHHHIIIHHHHHII', 0x02014b50, 0x031E, 45 if zip64 else 20,
            e['flags'], e['method'], 0, 0x21, e['crc'],
            comp_size, uncomp_size,
            len(e['name']), len(extra), 0, 0, 0, 0, offset)
        out += e['name'] + extra

    cd_size = len(out) - cd_start
    if corrupt_cd_at is not None:
        # 把中央目录中间某条记录的签名打坏，看解析器是整体失败还是保留已解析的部分
        out[cd_start + corrupt_cd_at] = 0x00

    if zip64:
        z64_at = len(out)
        out += struct.pack('<IQHHIIQQQQ', 0x06064b50, 44, 0x031E, 45, 0, 0,
                           len(entries), len(entries), cd_size, cd_start)
        out += struct.pack('<IIQI', 0x07064b50, 0, z64_at, 1)
        total = 0xFFFF
        cd_size_field = 0xFFFFFFFF
        cd_start_field = 0xFFFFFFFF
    else:
        total = len(entries)
        cd_size_field = cd_size
        cd_start_field = cd_start

    out += struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, total, total,
                       cd_size_field, cd_start_field, len(comment))
    out += comment
    return bytes(out)


def write(file_name, blob):
    with open(os.path.join(OUT, file_name), 'wb') as fh:
        fh.write(blob)


# ==================================================================== 开始

def main():
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))

    rnd = random.Random(4242)

    # ---- A1/A2 最基本的两种压缩方式，同内容 ----
    basic = [
        ('hello.txt', b'hello world\n'),
        ('中文/说明.txt', '这是中文内容 🎭\n'.encode('utf-8')),
        ('data.json', json.dumps({'k': 'v', 'n': 1}, ensure_ascii=False).encode('utf-8')),
    ]
    build_with_zipfile('01-stored.zip', 'zipfile 打包，全部 STORED（不压缩）', basic, zipfile.ZIP_STORED)
    build_with_zipfile('02-deflate.zip', 'zipfile 打包，全部 DEFLATED', basic, zipfile.ZIP_DEFLATED)

    # ---- A3 一个包里混用两种方式 ----
    mixed = [
        ('a-stored.txt', b'stored content ' * 20),
        ('b-deflated.txt', b'deflated content ' * 200),
        ('c-stored.bin', bytes(rnd.randrange(256) for _ in range(300))),
        ('d-deflated.bin', bytes(rnd.randrange(256) for _ in range(3000))),
    ]
    path = os.path.join(OUT, '03-mixed-methods.zip')
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr(zipfile.ZipInfo('a-stored.txt'), mixed[0][1], zipfile.ZIP_STORED)
        zf.writestr(zipfile.ZipInfo('b-deflated.txt'), mixed[1][1], zipfile.ZIP_DEFLATED)
        zf.writestr(zipfile.ZipInfo('c-stored.bin'), mixed[2][1], zipfile.ZIP_STORED)
        zf.writestr(zipfile.ZipInfo('d-deflated.bin'), mixed[3][1], zipfile.ZIP_DEFLATED)
    record('03-mixed-methods.zip', '一个包里 STORED 和 DEFLATED 混用', mixed)

    # ---- A4 空文件与极小文件 ----
    tiny = [
        ('empty.txt', b''),
        ('one.txt', b'A'),
        ('two.txt', b'AB'),
        ('three.txt', b'ABC'),
        ('empty2.txt', b''),
        ('bigger.txt', b'ABCDEFGHIJ'),
    ]
    build_with_zipfile('04-empty-and-tiny.zip', '空文件、1/2/3 字节（deflate 边界）', tiny, zipfile.ZIP_DEFLATED)

    # ---- A5 大而可压，逼出长距离回溯 ----
    big = [('big.txt', text_repeat(40000))]
    build_with_zipfile('05-big-compressible.zip', '约 1.5MB 高度可压，测长回溯距离', big, zipfile.ZIP_DEFLATED)

    # ---- A6 不可压，走字面量路径 ----
    noise = [('noise.bin', bytes(rnd.randrange(256) for _ in range(512 * 1024)))]
    build_with_zipfile('06-random-incompressible.zip', '512KB 随机字节，基本走字面量', noise, zipfile.ZIP_DEFLATED)

    # ---- A7 条目数量多，压中央目录解析 ----
    many = [(f'dir{i % 20}/file{i}.txt', f'内容 {i} 编号\n'.encode('utf-8')) for i in range(1200)]
    build_with_zipfile('07-many-entries.zip', '1200 个条目，测中央目录的规模', many, zipfile.ZIP_DEFLATED)

    # ---- A8 真实酒馆备份结构 ----
    layout = tavern_layout()
    build_with_zipfile('08-tavern-layout.zip', '贴近真实酒馆备份的完整目录结构', layout, zipfile.ZIP_DEFLATED)

    # ---- B9 GBK 文件名，且没置 UTF-8 标志位 ----
    gbk_name = '角色卡/测试世界.txt'.encode('gbk')
    assert '�' in gbk_name.decode('utf-8', 'replace'), '这串 GBK 字节要能被 UTF-8 解出替换字符，否则测不到 GBK 分支'
    utf8_name = 'utf8/中文名.txt'.encode('utf-8')
    e_gbk = raw_entry(gbk_name, 'GBK 名字的内容\n'.encode('utf-8'), method=8, flags=0)
    e_utf8_flag = raw_entry(utf8_name, 'UTF-8 名字的内容\n'.encode('utf-8'), method=8, flags=0x800)
    write('09b-mixed-names.zip', build_zip([e_gbk, e_utf8_flag]))
    record('09b-mixed-names.zip', 'GBK 名（未置 bit11）与 UTF-8 名（置了 bit11）同包',
           [('角色卡/测试世界.txt', e_gbk['data']), ('utf8/中文名.txt', e_utf8_flag['data'])])

    # ---- B10 UTF-8 字节但不置标志位（不能误判成 GBK）----
    e = raw_entry(utf8_name, '内容 utf8 无标志位\n'.encode('utf-8'), method=8, flags=0)
    write('10-utf8-noflag.zip', build_zip([e]))
    record('10-utf8-noflag.zip', 'UTF-8 字节但没置 bit11（不能被当成 GBK 解错）',
           [('utf8/中文名.txt', e['data'])])

    # ---- B11 本地头与中央目录的 extra 长度故意不一致 ----
    # readBytes 必须按"本地头"的长度算数据起点；按中央目录算就会整体错位
    e = raw_entry('mismatch.txt'.encode('utf-8'), 'extra 长度不一致时的内容\n'.encode('utf-8') * 30,
                  method=8, local_extra=struct.pack('<HH', 0x5455, 16) + bytes(16), central_extra=b'')
    write('11-local-extra-mismatch.zip', build_zip([e]))
    record('11-local-extra-mismatch.zip', '本地头 extra 比中央目录多一段（数据起点必须按本地头算）',
           [('mismatch.txt', e['data'])])

    # ---- B12 Zip64 ----
    e1 = raw_entry('zip64-a.txt'.encode('utf-8'), text_repeat(300), method=8, zip64_sizes=True)
    e2 = raw_entry('zip64-b.txt'.encode('utf-8'), b'second entry stored', method=0, zip64_sizes=True)
    write('12-zip64.zip', build_zip([e1, e2], zip64=True))
    record('12-zip64.zip', 'Zip64：EOCD 与中央目录字段全为 0xFFFFFFFF，真值在 0x0001 扩展区',
           [('zip64-a.txt', e1['data']), ('zip64-b.txt', e2['data'])])

    # ---- B13 EOCD 注释，且注释里埋一个假的 EOCD 签名 ----
    e = raw_entry('comment.txt'.encode('utf-8'), b'with comment\n', method=8)
    # 倒扫的区间是 [文件尾-22, 0]，从后往前。假签名必须落在这个区间里才会被先撞上 ——
    # 放在注释开头就一定在区间内（放末尾反而会落在起点之外，扫不到，等于没埋）。
    comment = struct.pack('<I', 0x06054b50) + b'x' * 100
    blob = build_zip([e], comment=comment)
    fake_at = blob.rfind(comment)          # 假签名在文件里的偏移
    if fake_at < 0 or fake_at > len(blob) - 22:
        raise AssertionError('陷阱没埋进倒扫区间，这份夹具测不到东西')
    write('13-eocd-comment-trap.zip', blob)
    record('13-eocd-comment-trap.zip',
           '⚠️ EOCD 注释里埋了假签名，且落在倒扫区间内 —— 不校验注释长度的实现会撞上假的',
           [('comment.txt', e['data'])],
           extra={'knownRisk': '注释里的假 EOCD 签名'})

    # ---- B13b 普通 EOCD 注释（无陷阱），作为对照 ----
    e = raw_entry('comment2.txt'.encode('utf-8'), b'plain comment\n', method=8)
    write('13b-eocd-comment.zip', build_zip([e], comment=b'just a normal zip comment, no trap'))
    record('13b-eocd-comment.zip', '普通 EOCD 注释，倒扫必须能越过它找到真的 EOCD',
           [('comment2.txt', e['data'])])

    # ---- B14 三种 deflate 块类型 ----
    payload = text_repeat(2000)
    strategies = [
        ('14-fixed-huffman.zip', zlib.Z_FIXED, 'deflate 固定 Huffman 块（type 1）'),
        ('15-store-blocks.zip', None, 'deflate 未压缩块（type 0）'),
        ('16-huffman-only.zip', zlib.Z_HUFFMAN_ONLY, 'deflate 只有 Huffman 无回溯（type 2 无匹配）'),
    ]
    for file_name, strategy, note in strategies:
        if strategy is None:
            co = zlib.compressobj(0, zlib.DEFLATED, -15)
        else:
            co = zlib.compressobj(9, zlib.DEFLATED, -15, 9, strategy)
        comp = co.compress(payload) + co.flush()
        e = raw_entry('blocks.txt'.encode('utf-8'), payload, method=8, comp_override=comp)
        write(file_name, build_zip([e]))
        record(file_name, note, [('blocks.txt', payload)])

    # ---- B17 不支持的压缩方式 ----
    path = os.path.join(OUT, '17-bzip2.zip')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_BZIP2) as zf:
        zf.writestr('bz.txt', b'bzip2 content')
    record('17-bzip2.zip', 'BZIP2 压缩，必须明确报错而不是解出垃圾',
           [('bz.txt', b'bzip2 content')], expect_error='不支持的压缩方式')

    # ---- B18 截断的 deflate 流 ----
    # 压缩数据只写一半，但中央目录里仍声明完整长度 —— 解压时必然提前断流
    e = raw_entry('trunc.txt'.encode('utf-8'), text_repeat(500), method=8)
    write('18-truncated-deflate.zip', build_zip([raw_entry(
        'trunc.txt'.encode('utf-8'), e['data'], method=8,
        comp_override=e['comp'][:len(e['comp']) // 2])]))
    record('18-truncated-deflate.zip', 'deflate 流被砍掉一半，必须报错',
           [('trunc.txt', e['data'])], expect_error=None, extra={'expectAnyError': True})

    # ---- B19 中央目录中间被写坏 ----
    e1 = raw_entry('good1.txt'.encode('utf-8'), b'first\n', method=8)
    e2 = raw_entry('bad.txt'.encode('utf-8'), b'second\n', method=8)
    e3 = raw_entry('good3.txt'.encode('utf-8'), b'third\n', method=8)
    write('19-corrupt-central.zip', build_zip([e1, e2, e3], corrupt_cd_at=46 + len(e1['name'])))
    record('19-corrupt-central.zip', '第二条中央目录记录签名被写坏，应保留已解析的第一条而不整体失败',
           [('good1.txt', e1['data'])],
           extra={'partialEntries': True})

    # ---- B22 数据描述符式（archiver 流式写包就是这种）----
    d1 = raw_entry('stream/deflated.txt'.encode('utf-8'), text_repeat(200), method=8, descriptor=True)
    d2 = raw_entry('stream/stored.bin'.encode('utf-8'),
                   bytes(rnd.randrange(256) for _ in range(500)), method=0, descriptor=True)
    d3 = raw_entry('stream/中文名.json'.encode('utf-8'),
                   json.dumps({'名': '值', 'emoji': '🎭'}, ensure_ascii=False).encode('utf-8'),
                   method=8, descriptor=True)
    write('22-data-descriptor.zip', build_zip([d1, d2, d3]))
    record('22-data-descriptor.zip',
           '本地头尺寸/crc 全为 0 且置 bit3，真值在数据描述符里（archiver 流式写法的形态）',
           [('stream/deflated.txt', d1['data']), ('stream/stored.bin', d2['data']),
            ('stream/中文名.json', d3['data'])])
    # 用 Python 的 zipfile 独立复核一遍这份包确实是合法的
    with zipfile.ZipFile(os.path.join(OUT, '22-data-descriptor.zip')) as zf:
        assert zf.testzip() is None, '22 号夹具本身不合法'
        assert zf.read('stream/stored.bin') == d2['data']

    # ---- B20 根本不是 zip ----
    write('20-not-a-zip.zip', bytes(rnd.randrange(256) for _ in range(4096)))
    record('20-not-a-zip.zip', '随机字节，必须报"不是 zip"',
           [], expect_error='不是一个 zip')

    # ---- B21 空 zip（只有 EOCD）----
    write('21-empty.zip', build_zip([]))
    record('21-empty.zip', '零条目的空 zip，应该正常解析出 0 个文件', [])

    manifest = {
        'generatedBy': 'tools/zip-reader-test/make_fixtures.py',
        'python': sys.version.split()[0],
        'fixtures': FIXTURES,
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    total_entries = sum(len(f['entries']) for f in FIXTURES)
    print(f'生成 {len(FIXTURES)} 份夹具，共 {total_entries} 个条目 -> {OUT}')


if __name__ == '__main__':
    main()
