# Notices

## Third-party components
The built app embeds:

| Component | Version | Licence |
|---|---|---|
| [pdf-lib](https://github.com/Hopding/pdf-lib) (`src/vendor/pdf-lib.min.js`, unmodified) | 1.17.1 | MIT ([src/vendor/LICENSE-pdf-lib.md](src/vendor/LICENSE-pdf-lib.md)) |
| Instrument Sans typeface | | SIL Open Font License 1.1 ([src/fonts/OFL-InstrumentSans.txt](src/fonts/OFL-InstrumentSans.txt)) |
| IBM Plex Mono typeface | | SIL Open Font License 1.1 ([src/fonts/OFL-IBMPlexMono.txt](src/fonts/OFL-IBMPlexMono.txt)) |

pdf-lib itself bundles pako (MIT) and parts of the TypeScript runtime library (0BSD/Apache-2.0); their notices are kept in
the file.

The **Android app** (built from `mobile/`) also includes:

| Component | Version | Licence |
|---|---|---|
| [Capacitor](https://capacitorjs.com) (`@capacitor/android`, `@capacitor/core`) | 8.5.3 | MIT |
| AndroidX libraries (AppCompat, Core, CoordinatorLayout, Core SplashScreen, Activity, WebKit) | see `mobile/android/variables.gradle` | Apache-2.0 |

Test files in `tests/fixtures/` were made with Pillow, reportlab, pikepdf and ExifTool (see `make-fixtures.sh`); the
tools themselves are not part of the app.
