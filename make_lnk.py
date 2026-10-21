# -*- coding: utf-8 -*-
"""纯 Python 生成 Windows .lnk 快捷方式（无 COM 依赖）v3（LinkInfo 补齐 VolumeIDOffset）"""
import struct, os

def utf16_str(x):
    b = x.encode('utf-16-le') + b'\x00\x00'
    return struct.pack('<H', len(b) // 2) + b

def make_lnk(target, args, workdir, icon, out):
    rel = os.path.basename(target)
    strings = utf16_str(rel) + utf16_str(workdir) + utf16_str(args) + utf16_str(icon)

    # ---- VolumeID：Size, DriveType(FIXED=3), Serial, VolumeLabelOffset(=16, ANSI) ----
    label = b'OS\x00'
    vol = struct.pack('<IIII', 16 + len(label), 3, 0, 16) + label

    # ---- LocalBasePath（ANSI）与 CommonPathSuffix ----
    local_base = target.encode('mbcs') + b'\x00'
    suffix = b'\x00'

    # ---- LinkInfo 头：6 个 DWORD ----
    # LinkInfoHeaderSize(0x1C), LinkInfoFlags, VolumeIDOffset, LocalBasePathOffset,
    # CommonNetworkRelativeLinkOffset, CommonPathSuffixOffset
    li_header_size = 0x1C
    li_flags = 0x1  # VolumeIDAndLocalBasePath
    vol_off = li_header_size                      # 28
    lbpo = vol_off + len(vol)                     # base path 紧跟 VolumeID
    cnr_off = 0
    cps_off = lbpo + len(local_base)
    link_info = struct.pack('<IIIIII', li_header_size, li_flags, vol_off, lbpo, cnr_off, cps_off)
    link_info += b'\x00' * 4   # 0x1C(28) - 6*4(24)：补齐声明头长度的填充字节
    link_info += vol + local_base + suffix

    # ---- ShellLinkHeader（0x4C = 76 字节）----
    link_flags = 0x02 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80
    header = struct.pack('<I', 0x4C)
    header += bytes.fromhex('0121440200000000C000000000000046')
    header += struct.pack('<I', link_flags)
    header += struct.pack('<I', 0x20)      # FILE_ATTRIBUTE_NORMAL
    header += b'\x00' * 24                 # 三个 FILETIME
    header += struct.pack('<I', 0)         # FileSize
    header += struct.pack('<I', 0)         # IconIndex
    header += struct.pack('<I', 1)         # ShowCommand
    header += struct.pack('<H', 0)         # HotKey
    header += b'\x00' * 10                 # Reserved
    assert len(header) == 0x4C, len(header)

    data = header + link_info + strings
    with open(out, 'wb') as f:
        f.write(data)
    return len(data)

def verify(path):
    d = open(path, 'rb').read()
    hs = struct.unpack_from('<I', d, 0)[0]
    hsz, flags, vol_off, lbpo, cnr, cps = struct.unpack_from('<IIIIII', d, hs)
    assert hsz == 0x1C
    base = d[hs + lbpo: hs + cps].split(b'\x00')[0].decode('mbcs')
    li_end = hs + cps + 1
    off = li_end
    out = {'LocalBasePath': base}
    for n in ['RelativePath', 'WorkingDir', 'Arguments', 'IconLocation']:
        cnt = struct.unpack_from('<H', d, off)[0]
        out[n] = d[off + 2: off + 2 + cnt * 2].decode('utf-16-le').rstrip('\x00')
        off += 2 + cnt * 2
    assert len(d) == off, (len(d), off)
    return out

if __name__ == '__main__':
    chrome = os.path.join(os.environ['LOCALAPPDATA'], r'Google\Chrome\Application\chrome.exe')
    if not os.path.exists(chrome):
        chrome = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
    assert os.path.exists(chrome), chrome
    url = 'file:///C:/Users/feng/hwdesk/%E4%BD%9C%E4%B8%9A%E6%8F%90%E4%BA%A4%E5%B7%A5%E4%BD%9C%E5%8F%B0.html'
    out = os.path.join(os.environ['USERPROFILE'], 'Desktop', '作业提交工作台.lnk')
    if os.path.exists(out):
        os.remove(out)
    n = make_lnk(
        target=chrome,
        args='--app="%s"' % url,
        workdir=os.path.dirname(chrome),
        icon=r'C:\Users\feng\hwdesk\hwdesk.ico',
        out=out,
    )
    info = verify(out)
    for k, v in info.items():
        print(k, '=', v[:100])
    print('written', out, n, 'bytes; verify OK')
