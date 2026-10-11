# Chrona 1.3.15

- Changed download speed reporting from a misleading lifetime average to a live rolling transfer rate.
- Detects large downloads that stop receiving bytes after making progress.
- Automatically pauses and resumes a resumable stalled transfer up to three times to reconnect it.
- Shows an explicit stalled state instead of letting the displayed speed silently decay to zero.
- Persists download byte progress regularly so Downloads reflects the latest known state after a restart.
