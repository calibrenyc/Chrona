## Fixed

- Recover automatically when `library.json` is unreadable or contains null bytes: Chrona restores the newest valid library backup, removes the broken primary file, and saves a fresh recovery backup.
- Make Find Links reliable on the first click by restoring the required dialog markup, preventing stale requests, and limiting each source lookup to three seconds.
- Show only verified title matches in Find Links. When nothing matches, a red caution panel says **No links found** and provides **Check again**.

## Improved

- Restored configured-source searching, including Online-Fix search results when an exact title match is available.

### Installing

Download **Chrona 1.2.3.exe**. This release is unsigned, so Windows may display an unknown-publisher or SmartScreen warning.
