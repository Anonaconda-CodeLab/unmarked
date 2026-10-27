#!/bin/sh
# Rebuilds the test files in this folder. Needs Python 3 with Pillow, reportlab and pikepdf, and ExifTool.
# The files are committed, so the tests themselves need none of this.
#   EXIFTOOL=/path/to/exiftool sh tests/fixtures/make-fixtures.sh
set -e
cd "$(dirname "$0")"
ET=${EXIFTOOL:-exiftool}

python3 - <<'EOF'
from PIL import Image, ImageDraw, ImageCms
im = Image.new('RGB', (96, 64), (40, 120, 200)); d = ImageDraw.Draw(im)
d.rectangle([10, 10, 50, 40], fill=(240, 200, 40)); d.ellipse([55, 20, 85, 55], fill=(200, 40, 60))
im.save('photo-full.jpg', quality=85); im.save('rotated.jpg', quality=85)
im.save('image.png'); im.save('image.webp', quality=80)
small = Image.new('RGB', (64, 48), (90, 160, 90))
small.save('icc.jpg', quality=85, icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
small.save('plain.jpg', quality=85)
EOF
# colour profiles: Display P3 (with made-up maker and device details) and sRGB, in JPEG, PNG and WebP
python3 make-icc.py
# hidden data in the less common places: signatures, XFA, form buttons, threads, reserved image markers
python3 make-security.py

# a phone photo with everything: location, names, serial numbers, XMP, IPTC, comment, thumbnail
$ET -q -overwrite_original -GPSLatitude=51.50072 -GPSLatitudeRef=N -GPSLongitude=0.12462 -GPSLongitudeRef=W -GPSAltitude=21 \
  -Make=Google -Model="Pixel 9" -Software="HDR+ 1.0" -Artist="Jane Example" -Copyright="© Jane Example" \
  -DateTimeOriginal="2026:10:24 14:35:12" -OffsetTimeOriginal="+07:00" -SerialNumber="SN12345678" -OwnerName="Jane Example" \
  -ImageUniqueID="ABC123DEF" -ExposureTime=1/120 -ISO=100 -XMP:Creator="Jane Example" -XMP:City="London" -XMP:CreatorTool="Snapseed" \
  -IPTC:By-line="Jane Example" -IPTC:City="London" -Comment="holiday flat 3B" -Orientation#=6 photo-full.jpg
$ET -q -overwrite_original "-ThumbnailImage<=photo-full.jpg" photo-full.jpg
# a motion photo: a video clip appended after the picture
python3 -c "d=open('photo-full.jpg','rb').read(); open('motion.jpg','wb').write(d+b'\x00\x00\x00\x18ftypmp42'+b'\x00'*200)"
$ET -q -overwrite_original -Orientation#=6 rotated.jpg
$ET -q -overwrite_original -GPSLatitude=1 -GPSLatitudeRef=N -GPSLongitude=1 -GPSLongitudeRef=E -Artist=X icc.jpg
$ET -q -overwrite_original -GPSLatitude=13.7563 -GPSLatitudeRef=N -GPSLongitude=100.5018 -GPSLongitudeRef=E -Artist="Somchai" \
  -Copyright="CC-BY" -DateTimeOriginal="2026:01:02 03:04:05" -XMP:Creator="Somchai" -PNG:Author="Somchai" -PNG:Software="GIMP 2.10" \
  -PNG:Comment="private" image.png
$ET -q -overwrite_original -GPSLatitude=18.7883 -GPSLatitudeRef=N -GPSLongitude=98.9853 -GPSLongitudeRef=E -Model="Galaxy S25" \
  -Artist="Anon" -XMP:Creator="Anon" -DateTimeOriginal="2025:12:31 23:59:00" image.webp

# PDFs: document info, XMP, an attachment, a script, a comment with an author, a link, private app data,
# a placed photo (ASCII85 + DCT, as reportlab writes it) and a second photo stored as plain DCT
python3 - <<'EOF'
from reportlab.pdfgen import canvas
import pikepdf
c = canvas.Canvas('doc-src.pdf', pagesize=(300, 300))
c.setAuthor('Jane Example'); c.setTitle('Tenancy agreement'); c.setCreator('Microsoft Word')
c.drawString(20, 260, 'Hello, this is a test document.'); c.drawImage('photo-full.jpg', 20, 100, 96, 64)
c.showPage(); c.drawString(20, 260, 'Page two'); c.save()
pdf = pikepdf.open('doc-src.pdf')
pdf.attachments['bank-details.txt'] = pikepdf.AttachedFileSpec(pdf, b'account 12345678', mime_type='text/plain')
pdf.Root.OpenAction = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Action, S=pikepdf.Name.JavaScript, JS=pikepdf.String('app.alert("hi")')))
p1 = pdf.pages[0]
note = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text, Rect=[200, 200, 220, 220],
  Contents=pikepdf.String('remove clause 4'), T=pikepdf.String('Bob Reviewer'), M=pikepdf.String('D:20261020101010')))
link = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[20, 250, 120, 270],
  A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI=pikepdf.String('https://example.com'))))
p1.Annots = pdf.make_indirect(pikepdf.Array([note, link]))
p1.obj.PieceInfo = pikepdf.Dictionary(Word=pikepdf.Dictionary(Private=pikepdf.String('secret')))
img = pikepdf.Stream(pdf, open('photo-full.jpg', 'rb').read())
img.Type = pikepdf.Name.XObject; img.Subtype = pikepdf.Name.Image; img.Width = 96; img.Height = 64
img.ColorSpace = pikepdf.Name.DeviceRGB; img.BitsPerComponent = 8; img.Filter = pikepdf.Name.DCTDecode
p2 = pdf.pages[1]
p2.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im9=pdf.make_indirect(img)))
p2.Contents = pdf.make_stream(b'q 96 0 0 64 20 100 cm /Im9 Do Q')
with pdf.open_metadata() as m:
    m['dc:creator'] = ['Jane Example']; m['xmp:CreatorTool'] = 'Microsoft Word'
pdf.save('doc.pdf')
EOF
rm -f doc-src.pdf
# an incremental update: the earlier version stays inside the file
cp doc.pdf doc-rev.pdf
$ET -q -overwrite_original -PDF:Author="Second Author" -PDF:Title="Edited title" doc-rev.pdf
echo "Fixtures rebuilt."
