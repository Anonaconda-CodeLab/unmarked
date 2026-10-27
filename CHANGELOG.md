# Changelog

## 0.1.1
- Links open in the same tab, and leaving the page after cleaning asks first, so clean copies aren't lost.
- File names and the hidden data found are marked so a browser's Translate button leaves them out (translation
  sends the page's text to an online service). The manual explains this, and that opening the web app is an
  ordinary website visit.
- **New home:** the website moved to Cloudflare Pages, with stricter security headers: no other site can show
  the app inside its own page, and browsers always use HTTPS.
- Shorter thank-you line at the bottom of the start screen.

## 0.1.0
- First version. Finds and removes hidden data in JPEG, PNG and WebP photos and PDF documents, entirely on the device:
  location, names, device details and serial numbers, dates and time zones, embedded thumbnails, motion-photo clips,
  edit history and document IDs. PDFs also lose document information, earlier saved versions, page thumbnails and
  camera data in placed photos, with a choice for attached files, scripts and comments.
- Lossless for photos: the picture data is copied unchanged. Rotation and colour profile are kept.
- Options: keep the date taken, keep copyright notices, give files plain names.
- Every clean copy is checked again before it is offered for saving.
- Start screen: everyday reasons to use it, and what it can't remove, with a plain no-warranty notice.
- Free, with no ads or tracking: a Ko-fi link in About, and a gentle request after 20, 50 and 100 uses.
- Android app: saving opens the folder the original came from, suggesting a name like `photo-unmarked.jpg` so the
  original can't be replaced by accident (otherwise the folder used last time). Files are opened with Android's own
  file picker, which grants access to the chosen files only.
- Android app: Share → Unmarked from any app, saving and sharing through Android's own screens, no internet permission.
