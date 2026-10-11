# Chrona 1.3.11

- Added an optional, source-independent Online Fix workflow to the central download manager.
- Main-game and Online Fix downloads now share one installation job with independent progress and retry handling.
- Enforced extraction order: main game first, followed by the Online Fix overlay with conflicting files overwritten safely.
- Added post-install launcher selection with detected launch files, manual browsing, and persisted Play-button configuration.
- Removed the outdated Zeigames MultiLink prompt while preserving multipart support for other providers.
- Improved AnkerGames and Zeigames discovery with verified Google results, site-search fallbacks, and clear not-found states.
