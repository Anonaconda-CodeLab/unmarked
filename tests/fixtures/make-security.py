#!/usr/bin/env python3
# Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
# Builds test files with hidden data in the less common places (called by make-fixtures.sh; needs Pillow and pikepdf).
# The signature is not a real one (nothing here checks it): it has the same structure and the same kinds of details.
import io, struct, zlib
import pikepdf
from pikepdf import Name, Dictionary, Array, String
from PIL import Image

def base_pdf():
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.pages[0].Contents = pdf.make_stream(b'BT /F1 12 Tf 20 260 Td (A test form) Tj ET')
    pdf.pages[0].Resources = Dictionary(Font=Dictionary(F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)))
    return pdf

def text_field(pdf, name):
    f = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String(name), V=String('answer'),
                                     Rect=[20, 200, 200, 220], P=pdf.pages[0].obj))
    return f

# 1. a signed form: signer's name, email, place, reason, time and certificate, a visible stamp with the name, and
#    validation data (DSS) and a certification link (Perms) in the catalogue
pdf = base_pdf()
cert = b'0\x82\x01\x00' + b'CN=Jane Signer, E=jane.signer@example.com, O=Example Ltd' + b'\x00' * 64
sig = pdf.make_indirect(Dictionary(Type=Name.Sig, Filter=Name('/Adobe.PPKLite'), SubFilter=Name('/adbe.pkcs7.detached'),
    Name=String('Jane Signer'), M=String('D:20261020101010+07\'00\''), Location=String('Bangkok'), ContactInfo=String('jane.signer@example.com'),
    Reason=String('I approve this document'), ByteRange=[0, 100, 200, 300], Contents=String(cert)))
stamp = pdf.make_stream(b'BT /F1 8 Tf 2 10 Td (Digitally signed by Jane Signer) Tj ET', Type=Name.XObject, Subtype=Name.Form, BBox=[0, 0, 180, 30],
    Resources=Dictionary(Font=Dictionary(F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))))
sigfield = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Sig, T=String('Signature1'), V=sig, F=4,
    Rect=[20, 40, 200, 70], P=pdf.pages[0].obj, AP=Dictionary(N=stamp)))
name = text_field(pdf, 'Name')
pdf.pages[0].Annots = pdf.make_indirect(Array([name, sigfield]))
pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=[name, sigfield], SigFlags=3))
pdf.Root.Perms = Dictionary(DocMDP=sig)
pdf.Root.DSS = pdf.make_indirect(Dictionary(Certs=[pdf.make_stream(cert)]))
pdf.save('signed.pdf')

# 2. XFA forms with a script and a submit button: one that also has ordinary form fields, and one built only from XFA
xfa = b'''<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1"><field name="Name"/><event activity="initialize"><script contentType="application/x-javascript">app.alert("xfa ran");</script></event>
<field name="Send"><event activity="click"><submit format="xml" target="https://forms.example.com/collect"/></event></field></subform></template></xdp:xdp>'''
for dynamic in (False, True):
    pdf = base_pdf()
    stream = pdf.make_stream(zlib.compress(xfa), Filter=Name.FlateDecode)
    if dynamic:
        pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=[], XFA=Array([String('template'), stream])))
        pdf.Root.NeedsRendering = True
    else:
        name = text_field(pdf, 'Name')
        pdf.pages[0].Annots = pdf.make_indirect(Array([name]))
        pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=[name], XFA=Array([String('template'), stream])))
    pdf.save('xfa-dynamic.pdf' if dynamic else 'xfa.pdf')

# 3. form buttons that send the form to a server, or load data from a file (no JavaScript anywhere)
pdf = base_pdf()
send = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Btn, Ff=65536, T=String('Send'), Rect=[20, 100, 100, 120],
    P=pdf.pages[0].obj, A=Dictionary(S=Name.SubmitForm, F=Dictionary(FS=Name.URL, F=String('https://collect.example.net/post?id=42')))))
load = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Btn, Ff=65536, T=String('Load'), Rect=[120, 100, 200, 120],
    P=pdf.pages[0].obj, A=Dictionary(S=Name.ImportData, F=String('answers.fdf'))))
name = text_field(pdf, 'Name')
pdf.pages[0].Annots = pdf.make_indirect(Array([name, send, load]))
pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=[name, send, load]))
pdf.save('submit.pdf')

# 4. an article thread with its own author and title, and web capture data (the source page's address)
pdf = base_pdf()
thread = pdf.make_indirect(Dictionary(Type=Name.Thread, I=Dictionary(Title=String('Draft column'), Author=String('Thread Author'))))
bead = pdf.make_indirect(Dictionary(Type=Name.Bead, T=thread, P=pdf.pages[0].obj, R=[20, 20, 280, 280]))
bead.N = bead; bead.V = bead; thread.F = bead
pdf.pages[0].B = [bead]
pdf.Root.Threads = pdf.make_indirect(Array([thread]))
pdf.Root.SpiderInfo = Dictionary(V=1.0)
pdf.Root.Names = Dictionary(URLS=Dictionary(Names=Array([String('https://intranet.example.org/hr/salaries'), Dictionary(Type=Name.SpiderContentSet)])))
pdf.save('threads.pdf')

# 5. images with text placed where phones never put any
im = Image.new('RGB', (48, 32), (200, 120, 60))
b = io.BytesIO(); im.save(b, 'JPEG', quality=85); j = b.getvalue()
seg = lambda m, data: bytes([0xFF, m]) + struct.pack('>H', len(data) + 2) + data
adobe = b'Adobe' + bytes([0, 100, 0, 0, 0, 0, 1]) + b'SECRET-IN-APP14'
open('hidden.jpg', 'wb').write(j[:2] + seg(0xEE, adobe) + seg(0xF1, b'SECRET-IN-JPG1') + j[2:])
b = io.BytesIO(); im.save(b, 'PNG'); p = b.getvalue()
chunk = lambda t, x: struct.pack('>I', len(x)) + t + x + struct.pack('>I', zlib.crc32(t + x) & 0xffffffff)
splt = b'SECRET-IN-sPLT\x00' + bytes([8]) + bytes([255, 0, 0, 255, 0, 1])
open('hidden.png', 'wb').write(p[:33] + chunk(b'sPLT', splt) + chunk(b'SECr', b'SECRET-IN-CRITICAL') + p[33:])

# 0.1.4 (CodeRabbit #9): a JFIF header carrying its own thumbnail (an 8 × 6 copy of the picture, stored uncompressed
# right after the 14-byte header) and a few more bytes after it. Pillow never writes one, so it is put in by hand.
assert j[2:4] == b'\xff\xe0' and j[6:11] == b'JFIF\x00'
n = struct.unpack('>H', j[4:6])[0]
thumb = im.resize((8, 6)).tobytes()   # 8 × 6 × 3 = 144 bytes of RGB
jfif = j[6:6 + 12] + bytes([8, 6]) + thumb + b'SECRET-AFTER-JFIF'
open('jfif-thumb.jpg', 'wb').write(j[:2] + seg(0xE0, jfif) + j[4 + n:])
