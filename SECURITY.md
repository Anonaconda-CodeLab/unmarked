# Security and privacy

## Design
- **No network access.** The built page carries a Content Security Policy (`default-src 'none'; connect-src 'none'`,
  checked by the tests) that blocks every connection the page could make: fetching, loading outside scripts, images,
  frames or fonts, and submitting forms. Fonts and pdf-lib are embedded; there are no external scripts, analytics or
  trackers. A Content Security Policy does not cover the page navigating itself to another address, so it is not the
  main protection against injected code: that is that no file content can ever become code (see *Untrusted input*).
  The Android app has no internet permission at all, so nothing in it can reach the network. The only outbound links are optional *Source code* / *Support on Ko-fi* buttons
  and links in the manual, which open in the same tab (`rel="noopener noreferrer"`); the page asks first if clean copies
  would be lost. The site's HTTP headers (`dist/_headers`) add a second block on connections and stop other sites
  from framing the app.
- **Nothing stored.** Files are held in memory while the page is open and are gone when it closes. The only thing kept on
  the device is the three option settings and a count of cleaning runs, used only for an occasional donation
  request (browser localStorage).
- **Originals untouched.** Unmarked always makes a new copy; it has no way to change the file you picked.
- **Untrusted input.** Every file is treated as hostile: parsers check bounds and sizes, compressed data is unpacked
  only up to 64 MB, text is scanned in a single pass (so no file can make the page hang), PDFs are parsed by pdf-lib
  without running any of their scripts, and all text taken from files is HTML-escaped before display.
- **Verified output.** Each clean copy is inspected again with the same code before it is offered; anything still found
  is shown as a warning.

## Android app
- **No internet permission.** It is removed in the manifest, and every build fails if it reappears.
- **No other permissions.** Files come from Android's file picker or from another app's Share action, which grants
  access to those files only. Clean copies are saved through Android's "save as" screen or shared through the share sheet
  (from a private folder inside the app, emptied before each share and when the app starts). The app writes only to the
  place chosen in Android's save screen, and accepts shared files only from other apps.
- **Signed releases.** Official APKs are signed with the studio's key. Its SHA-256 certificate fingerprint is published on
  the [Android page](https://unmarked.anonacondacodelab.com/android.html) and in every release, and the release build fails
  if an APK is signed with any other key. Each release also lists the APK's SHA-256 checksum.

## Known limitations
- Unmarked removes hidden data, not visible content (faces, text, signs). See the user manual.
- HEIC/AVIF photos, encrypted PDFs, GIF, TIFF/RAW and video are not supported yet and are left alone.

## Reporting a vulnerability
Please report security issues privately using GitHub's **Security → Report a vulnerability** (private vulnerability
reporting) on this repository rather than opening a public issue, or email hello@anonacondacodelab.com. Include steps
to reproduce and the affected version. Please don't attach private files; a test file that shows the problem is best.
