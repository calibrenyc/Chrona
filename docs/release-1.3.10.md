# Chrona 1.3.10

- Fixed Retry installation failing when Chromium removed Chrona's managed copy after a completed provider transfer.
- Retry installation now resolves the exact-size original provider archive before reporting that a saved download is missing.
- Verified recovery and installation against the existing 254,831,320-byte IGTAP archive without downloading it again.
