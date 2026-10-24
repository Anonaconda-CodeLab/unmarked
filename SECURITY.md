# Security and privacy

## Design
- **No network access.** The built page carries a Content Security Policy (`default-src 'none'; connect-src 'none'`) so the
  app cannot send or fetch anything, even if malicious code were injected. Fonts and pdf-lib are embedded; there are no
  external scripts, analytics or trackers. The only outbound links are optional *Source code* / *Support on Ko-fi* buttons,
  which open in a new, isolated tab (`rel="noopener noreferrer"`).
- **Nothing stored.** Files are held in memory while the page is open and are gone when it closes. The only thing kept on
  the device is the three option settings (browser localStorage).
- **Originals untouched.** Unmarked always makes a new copy; it has no way to change the file you picked.
- **Untrusted input.** Every file is treated as hostile: parsers check bounds and sizes, PDFs are parsed by pdf-lib
  without running any of their scripts, and all text taken from files is HTML-escaped before display.
- **Verified output.** Each clean copy is inspected again with the same code before it is offered; anything still found
  is shown as a warning.

## Android app
- **No internet permission.** It is removed in the manifest, and every build fails if it reappears.
- **No other permissions.** Files come from Android's file picker or from another app's Share action, which grants
  access to those files only. Clean copies are saved through Android's "save as" screen or shared through the share sheet
  (from a private folder inside the app, emptied before each share).
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
