# Chrona 1.3.9

- Fixed provider downloads remaining active indefinitely after every advertised byte had arrived.
- Added guarded recovery when Chromium saves a completed provider file under its original filename instead of Chrona's managed filename.
- Added startup recovery for exact-size completed archives, allowing affected downloads to be installed without downloading them again.
