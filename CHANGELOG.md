# Changelog

All notable changes to Sparkore KB Reader are documented here.

## 0.1.3 - Unreleased

### Added

- Repository picker populated from repositories available to the connected GitHub account/app.
- Branch picker populated from the selected repository.
- GitHub folder browser for selecting the KB root.
- Local Obsidian folder picker for selecting the cache destination.
- Manual text entry remains available as a fallback for advanced/custom paths.

## 0.1.2 - 2026-09-30

### Fixed

- Remove the redundant plugin-name heading from the settings page.
- Raise the minimum supported Obsidian version to 1.13.0 to match the current APIs.
- Migrate the settings UI to Obsidian's declarative settings API so settings are searchable and no deprecated `display()` override remains.
- Adopt the MIT license so the repository license is recognized by GitHub and Obsidian review.

## 0.1.1 - 2026-09-30

### Fixed

- Use Obsidian `Setting.setHeading()` instead of raw heading elements in plugin settings.
- Replace deprecated destructive-button styling API.
- Add a reproducible npm lockfile and use `npm ci` in CI/release builds.
- Remove the deprecated `builtin-modules` dependency.
- Publish only the release assets Obsidian consumes.
- Generate GitHub artifact provenance for `main.js`.

## 0.1.0 - 2026-09-30

### Added

- GitHub App OAuth Device Flow with automatic access-token refresh for mobile sign-in.
- Mobile-compatible Obsidian plugin foundation.
- Read-only GitHub Knowledge Base fetching.
- Multiple project configurations per vault.
- Per-project repository, branch, KB root, and local folder settings.
- Optional use of a repository's default branch.
- Fine-grained GitHub token integration through Obsidian SecretStorage.
- Incremental refresh using upstream SHA and local modification time.
- Optional pruning of files deleted upstream.
- Manual refresh per project and refresh-all command.
- Optional refresh on startup.
- CI typecheck, production build, manifest validation, and install artifacts.
- Automated GitHub release workflow for version tags.
