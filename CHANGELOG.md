# Changelog

## 0.1.0
- First version. Finds and removes hidden data in JPEG, PNG and WebP photos and PDF documents, entirely on the device:
  location, names, device details and serial numbers, dates and time zones, embedded thumbnails, motion-photo clips,
  edit history and document IDs. PDFs also lose document information, earlier saved versions, page thumbnails and
  camera data in placed photos, with a choice for attached files, scripts and comments.
- Lossless for photos: the picture data is copied unchanged. Rotation and colour profile are kept.
- Options: keep the date taken, keep copyright notices, give files plain names.
- Every clean copy is checked again before it is offered for saving.
- Android app: saving opens the folder the original came from, suggesting a name like `photo-unmarked.jpg` so the
  original can't be replaced by accident (otherwise the folder used last time). Files are opened with Android's own
  file picker, which grants access to the chosen files only.
- Android app: Share → Unmarked from any app, saving and sharing through Android's own screens, no internet permission.
