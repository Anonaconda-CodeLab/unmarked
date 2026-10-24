# Unmarked user manual

## What Unmarked does

Photos and documents carry information you can't see on screen. A photo from a phone usually records **where it was
taken** (often to within a few metres), **when**, **which phone** took it, and sometimes the **owner's name** and the
camera's **serial number**. A PDF can carry the **author's name**, the app and computer that made it, **comments and
who wrote them**, **attached files**, and even **earlier versions of the document** with text you thought you deleted.

Unmarked shows you what's inside each file and makes a clean copy without it. It runs entirely on your device: your
files are never uploaded anywhere.

> Unmarked makes a **clean copy**. Your original file is not changed, and neither is your gallery or cloud backup.
> Share the clean copy, not the original.

## How to use it

1. Tap **Choose photos or PDFs** (or drop files onto the page on a computer). You can pick many at once.
2. Each file is checked. Tap **What's inside** to see exactly what was found, from the most revealing to the most
   technical, and whether each item will be removed or kept.
3. Choose any **options** (below), then tap **Remove hidden data**.
4. Each clean copy is **checked again** to confirm nothing was left behind.
5. **Save** or **Share** the clean copies. Several files can be saved together as one `.zip` file.
   In the Android app the save screen opens in the **same folder as the original**, and suggests a name like
   `photo-unmarked.jpg` so you can't replace your original by accident. Browsers save to their usual download folder.

On Android you can also start from another app: in your gallery or file manager, pick photos or PDFs, tap **Share**
and choose **Unmarked**.

## Options

- **Keep the date taken**: leaves the date and time a photo was taken. The time zone, which hints at where you were,
  is still removed.
- **Keep copyright notices**: for photographers and artists who want their copyright line to stay with the picture.
- **Give files plain names**: file names often give things away too. `IMG_20261024_143512.jpg` says the photo was
  taken on 24 October 2026 at 14:35. With this option the copies are called `image-01.jpg`, `document-01.pdf` and
  so on.

Your choices are remembered on this device.

## Photos (JPEG, PNG, WebP)

Removed:

- **Location** (GPS position, altitude, the direction the camera faced) and place names
- **Names**: author, camera owner, creator, contact details
- **Device details**: phone or camera maker and model, serial numbers, lens, software and editing apps
- **Dates and time zone**
- **Embedded thumbnails**: a small copy of the original picture, which can still show parts you cropped out
- **Motion photos**: the short video clip some phones attach to a photo
- **Edit history**, document IDs and other data added by editing apps
- **Comments, titles, descriptions and keywords**
- Camera settings (exposure, ISO and similar) and other technical data

Kept, because they are harmless and needed to show the picture correctly:

- **Rotation**: so the photo appears the right way up
- **Colour profile**: so colours look right

Cleaning is **lossless**. Unmarked cuts the hidden data out of the file without touching the picture itself, so
there is no recompression and no loss of quality.

## PDF documents

Removed:

- **Document information**: author, title, subject, keywords, the app that made it, creation and modification dates
- **XMP metadata**, document IDs and edit history
- **Earlier saved versions**: many apps add edits to the end of a PDF and leave the old version inside the file.
  Unmarked writes a fresh copy containing only the current version.
- **Camera data inside photos** placed in the document
- **Page thumbnails** and private editing data left by apps such as Word or Illustrator

You choose, for each PDF that has them (all are ticked to start with):

- **Attached files**: files stored inside the PDF. They can carry their own hidden data.
- **Scripts**: code that runs when the PDF is opened. Rarely needed.
- **Comments and markup**: notes, highlights and drawings, and the names of the people who made them.

Kept: the text, pictures and layout, links, form fields and their answers, and layers.

## What Unmarked can't remove

> Unmarked removes hidden data. It can't change what anyone can **see** in the file.

- **The picture or page itself**: faces, street signs, house numbers, car number plates, reflections, screens, and
  text on a page. Crop or cover them before cleaning.
- **Text that is in the document**, including tracked changes that were already accepted.
- **Your device's own records**: the original file, your gallery, and cloud backups keep their data.
- **Hidden layers in PDFs** are kept. If a PDF has layers, Unmarked says so; check them in a PDF reader.

## Files Unmarked can't clean (yet)

- **HEIC photos** (the default on iPhones and some Android phones). Most phones can save or share as JPEG instead.
- **Password-protected or encrypted PDFs.**
- GIF, TIFF, camera RAW files and videos.

## Privacy

Unmarked has no server, no account and no tracking. The web app blocks every network connection, and the Android app
has no internet permission, so it couldn't send your files anywhere even if it tried. The only things remembered on
your device are your three option settings.

## The Android app

The Android app is the same app with two extras: **Share → Unmarked** from any app, and saving and sharing through
Android's own screens. Download it from https://unmarked.anonacondacodelab.com/android.html (not from Google Play;
that page explains why). **About → Check for updates** tells you when a new version is out.

## Help

Unmarked is free and open source (GNU GPL v3), made by Anonaconda Code Lab. Questions or problems:
hello@anonacondacodelab.com. Please don't send the files you were cleaning; a description is usually enough.
