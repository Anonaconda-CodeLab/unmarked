#!/usr/bin/env python3
# Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
# Builds the colour-profile test files (called by make-fixtures.sh; needs Pillow only).
# The Display P3 profile is written here by hand, with made-up maker, model, copyright and device text in it,
# so the tests can check that those are blanked and that the colours still convert the same.
import hashlib, io, struct, zlib
from PIL import Image, ImageCms

def s15(x): return struct.pack('>i', round(x * 65536))
def xyz(*v): return b'XYZ \0\0\0\0' + b''.join(s15(x) for x in v)
def text_tag(s): return b'text\0\0\0\0' + s.encode('latin-1') + b'\0'
def desc_tag(s):   # v2 textDescriptionType
    a = s.encode('latin-1') + b'\0'
    return b'desc\0\0\0\0' + struct.pack('>I', len(a)) + a + b'\0' * 8 + b'\0' * 3 + b'\0' * 67
def mluc_tag(s):
    u = s.encode('utf-16-be')
    return b'mluc\0\0\0\0' + struct.pack('>II', 1, 12) + b'enUS' + struct.pack('>II', len(u), 28) + u
def para_srgb(): return b'para\0\0\0\0' + struct.pack('>H', 3) + b'\0\0' + b''.join(s15(x) for x in (2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045))

def profile(version):
    v4 = version == 4
    t = mluc_tag if v4 else desc_tag
    txt = mluc_tag if v4 else text_tag
    tags = [
        (b'desc', t('Display P3')),
        (b'cprt', txt('Copyright Example Display Co., 2026')),
        (b'dmdd', t('Studio Monitor SN-998877')),
        (b'wtpt', xyz(0.9642, 1.0, 0.8249)),
        (b'rXYZ', xyz(0.5151, 0.2412, -0.0011)),
        (b'gXYZ', xyz(0.2920, 0.6922, 0.0419)),
        (b'bXYZ', xyz(0.1571, 0.0666, 0.7841)),
        (b'rTRC', para_srgb()), (b'gTRC', para_srgb()), (b'bTRC', para_srgb()),
        (b'chad', b'sf32\0\0\0\0' + b''.join(s15(x) for x in (1.0479, 0.0229, -0.0502, 0.0296, 0.9904, -0.0171, -0.0092, 0.0151, 0.7519))),
        (b'calt', b'dtim\0\0\0\0' + struct.pack('>6H', 2026, 10, 1, 9, 30, 0)),
    ]
    off = 128 + 4 + 12 * len(tags); table = b''; data = b''
    for sig, body in tags:
        while (off + len(data)) % 4: data += b'\0'
        table += sig + struct.pack('>II', off + len(data), len(body)); data += body
    while len(data) % 4: data += b'\0'
    size = 128 + 4 + len(table) + len(data)
    head = bytearray(128)
    head[0:4] = struct.pack('>I', size); head[4:8] = b'exmp'
    head[8:12] = bytes([4, 0x30, 0, 0]) if v4 else bytes([2, 0x10, 0, 0])
    head[12:16] = b'mntr'; head[16:20] = b'RGB '; head[20:24] = b'XYZ '
    head[24:36] = struct.pack('>6H', 2026, 10, 24, 7, 59, 16); head[36:40] = b'acsp'; head[40:44] = b'APPL'
    head[48:52] = b'EXDC'; head[52:56] = b'P3X1'; head[68:80] = s15(0.9642) + s15(1.0) + s15(0.8249); head[80:84] = b'exmp'
    p = bytearray(bytes(head) + struct.pack('>I', len(tags)) + table + data)
    if v4:   # profile ID: MD5 with flags, intent and ID zeroed
        q = bytearray(p); q[44:48] = b'\0' * 4; q[64:68] = b'\0' * 4; q[84:100] = b'\0' * 16
        p[84:100] = hashlib.md5(q).digest()
    return bytes(p)

p3v4, p3v2 = profile(4), profile(2)
srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()

# a picture with saturated colours, so a wrong profile would show
im = Image.new('RGB', (64, 48))
im.putdata([((x * 4) % 256, (y * 5) % 256, ((x + y) * 3) % 256) for y in range(48) for x in range(64)])

def split_jpeg_icc(jpeg, parts):   # rewrite the APP2 ICC_PROFILE segment as several numbered parts
    i = 2
    while True:
        m, n = jpeg[i + 1], struct.unpack('>H', jpeg[i + 2:i + 4])[0]
        if m == 0xE2 and jpeg[i + 4:i + 16] == b'ICC_PROFILE\0': break
        i += 2 + n
    prof = jpeg[i + 18:i + 2 + n]
    cuts = [len(prof) * k // parts for k in range(parts + 1)]
    segs = b''.join(b'\xff\xe2' + struct.pack('>H', 16 + cuts[k + 1] - cuts[k]) + b'ICC_PROFILE\0' + bytes([k + 1, parts]) + prof[cuts[k]:cuts[k + 1]] for k in range(parts))
    return jpeg[:i] + segs + jpeg[i + 2 + n:]

b = io.BytesIO(); im.save(b, 'JPEG', quality=90, icc_profile=p3v4)
open('p3.jpg', 'wb').write(split_jpeg_icc(b.getvalue(), 3))
im.save('p3.png', icc_profile=p3v2)
im.save('srgb.png', icc_profile=srgb)
im.save('p3.webp', quality=90, icc_profile=p3v4)
im.save('srgb.webp', quality=90, icc_profile=srgb)
# a PNG with only an sRGB chunk (one byte, the rendering intent) and gAMA: nothing in it to list
b = io.BytesIO(); im.save(b, 'PNG'); d = b.getvalue()
def chunk(t, x): return struct.pack('>I', len(x)) + t + x + struct.pack('>I', zlib.crc32(t + x) & 0xffffffff)
open('srgb-chunk.png', 'wb').write(d[:33] + chunk(b'sRGB', b'\0') + chunk(b'gAMA', struct.pack('>I', 45455)) + d[33:])
