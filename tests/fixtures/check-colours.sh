#!/bin/sh
# Checks with Pillow (littleCMS) that cleaning never changes how colours look: each test picture with a colour
# profile is cleaned, then the original and the clean copy are both converted to sRGB through their own profile
# (or none) and compared pixel by pixel. Needs Node and Python 3 with Pillow.
#   sh tests/fixtures/check-colours.sh
set -e
cd "$(dirname "$0")"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
FILES="icc.jpg p3.jpg p3.png p3.webp srgb.png srgb.webp"
node -e '
  require("../../src/clean.js"); const C = globalThis.UnmarkedClean, fs = require("fs"), [out, ...files] = process.argv.slice(1);
  (async () => { for (const f of files) fs.writeFileSync(out + "/" + f, (await C.clean(new Uint8Array(fs.readFileSync(f)))).bytes); })();
' "$OUT" $FILES
python3 - "$OUT" $FILES <<'EOF'
import io, sys
from PIL import Image, ImageCms, ImageChops
SRGB = ImageCms.createProfile('sRGB')
def load(path):
    im = Image.open(path); icc = im.info.get('icc_profile'); im = im.convert('RGB')
    shown = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), SRGB, outputMode='RGB') if icc else im
    return im, shown, icc
bad = 0
for f in sys.argv[2:]:
    a_raw, a, a_icc = load(f); b_raw, b, b_icc = load(sys.argv[1] + '/' + f)
    pix = ImageChops.difference(a_raw, b_raw).getbbox() is None
    diff = max(x[1] for x in ImageChops.difference(a, b).getextrema())
    print(f'{f:11} pixels identical: {pix}  colour difference: {diff}  profile: {"kept" if b_icc else "removed"}')
    bad += (not pix) or diff > 0
sys.exit(1 if bad else 0)
EOF
echo "Colours unchanged."
