# Unmarked

**Remove the hidden data in your photos and PDFs, on your own device.**
Unmarked shows you what a file gives away (where a photo was taken, which phone took it, who wrote a document and what
was deleted from it) and makes a clean copy without it. No account, no server, no upload.

**Use it now: [unmarked.anonacondacodelab.com](https://unmarked.anonacondacodelab.com)** · Android app:
[unmarked.anonacondacodelab.com/android.html](https://unmarked.anonacondacodelab.com/android.html)

## Features
- **Photos (JPEG, PNG, WebP):** removes location, names, phone and camera details, serial numbers, dates and time zone,
  embedded thumbnails (which can show what you cropped out), motion-photo video clips, edit history, document IDs,
  comments and keywords. **Lossless:** the picture data is copied byte for byte; only the rotation and colour profile
  are kept, so the photo still looks right.
- **PDFs:** removes document information (author, app, dates), XMP metadata, **earlier saved versions** that can hold
  deleted text, page thumbnails, private app data, and camera data inside placed photos. Attached files, scripts and
  comments (with their authors' names) are removed by choice.
- **See before you clean:** every finding is listed in plain language, most revealing first, marked *Remove* or *Keep*.
- **Checked twice:** each clean copy is inspected again before it's offered, and anything left is reported.
- **Options:** keep the date taken, keep copyright notices, give files plain names (`IMG_20261024_143512.jpg` reveals the
  date too).
- **Many files at once**, saved one by one or as a `.zip` with neutral timestamps.
- **Android app:** *Share → Unmarked* from the gallery or any app; no internet permission and no other permissions.

## How it works
The whole web app is one file, `dist/index.html`, built by `node build.mjs` from `src/`. A Content Security Policy
blocks every network request, so the page can't send your files anywhere.

The cleaning code is `src/clean.js`: self-contained, no DOM, usable in any browser or Node 18+ (other studio apps reuse
it). Images are parsed and cut down directly; PDFs use [pdf-lib](https://github.com/Hopding/pdf-lib) to rewrite the
document from its current version only.

## Development
```
node build.mjs          # builds dist/
npm test                # builds, then runs the tests (Node's built-in runner, no dependencies)
```
Tests use real files in `tests/fixtures/`, made with ExifTool, Pillow, reportlab and pikepdf
(`tests/fixtures/make-fixtures.sh` rebuilds them). The Android app is in `mobile/` (see `mobile/README.md`).

### Hosting your own copy
Host the `dist/` folder anywhere that serves https. Netlify deploys only when `dist/` changes (`netlify.toml`).

## Licence
Free software under the [GNU General Public License v3 or later](LICENSE), with no warranty. © 2026 Anonaconda Code Lab.
Third-party components: see [NOTICE.md](NOTICE.md). Security and privacy: see [SECURITY.md](SECURITY.md).
Questions or problems: hello@anonacondacodelab.com.
