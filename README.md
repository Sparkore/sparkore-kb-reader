# Sparkore KB Reader

Read selected Knowledge Base folders from GitHub directly inside Obsidian on desktop, Android, and iOS.

## What it does

Sparkore KB Reader turns a GitHub folder into a local Obsidian reading cache:

```text
GitHub repository
└── selected branch
    └── selected KB path
            ↓
      Sparkore KB Reader
            ↓
      local Obsidian cache
```

It does **not** clone the full repository and does **not** push local changes back to GitHub.

Typical use case for a game project:

```text
Repository: SparkonStudio/BackpackAdventures
Branch:     develop
KB root:    Knowledge Base
Local:      Sparkore KB/Backpack Legends
```

Repository, branch, KB root, and local folder are configured per project in Obsidian. You can temporarily point a project at a feature branch or a narrower subfolder without changing the source repository.

## Features

- Works with public and private GitHub repositories.
- Fetches only the configured KB path.
- Supports multiple projects in one Obsidian vault.
- Branch is configurable per project; an empty branch uses the repository default.
- Local destination folder is configurable per project.
- Uses upstream GitHub SHA plus local file metadata to avoid unnecessary downloads and restore reader-managed files after local edits.
- Optionally removes local cache files that were deleted upstream.
- Manual refresh per project or for all projects.
- Optional refresh on Obsidian startup.
- Keeps the GitHub token in Obsidian SecretStorage instead of plugin `data.json`.

## Mobile support

The plugin is designed for Obsidian Mobile. It uses Obsidian APIs and Web APIs only:

- `requestUrl()` for GitHub HTTP requests;
- `Vault` and `FileManager` for cache files;
- `SecretStorage` for GitHub credentials.

It does not use Node.js, Electron, a Git executable, or direct filesystem APIs.

## Setup

### 1. Create a GitHub token

For private repositories, create a fine-grained GitHub personal access token with access only to the repositories you want to read.

Required repository permission:

```text
Contents: Read-only
```

No write permission is needed.

### 2. Store the token in Obsidian

Open Obsidian settings and create/select the token through the **GitHub token** SecretStorage field in Sparkore KB Reader settings.

The plugin stores only the secret name in its settings. The token value stays in Obsidian SecretStorage.

### 3. Add a project

Configure:

- **Repository** — `owner/repo`;
- **Branch** — optional; empty uses the repository default branch;
- **KB root** — repository path such as `Knowledge Base`;
- **Local folder** — optional; defaults under `Sparkore KB/`.

Then use **Refresh** or the command **Refresh all knowledge bases**.

## Read-only model

GitHub is the source for Reader-managed folders. The local Obsidian copy is a disposable reading cache.

Local edits are not pushed. A refresh may restore a Reader-managed file from GitHub.

Use the project's normal Git branch and review workflow for durable KB changes.

## Network and privacy

Sparkore KB Reader connects only to GitHub APIs required to read configured repositories.

- No analytics or client-side telemetry.
- No Sparkore backend.
- No ads.
- No account other than GitHub is required.
- GitHub OAuth access and refresh tokens are stored through Obsidian SecretStorage.
- Project configuration is stored locally in the Obsidian plugin settings.

## Development

Requirements:

- Node.js 22+
- npm

```sh
npm install
npm run dev
```

Production build:

```sh
npm run build
```

The build produces `main.js` at the repository root.

## Local installation

Build the plugin, then copy these files into:

```text
<vault>/.obsidian/plugins/sparkore-kb-reader/
```

Files:

```text
manifest.json
main.js
```

Restart/reload Obsidian and enable **Sparkore KB Reader** under Community plugins.

## Releases

A Git tag must exactly match the version in `manifest.json`, for example:

```text
0.1.0
```

The release workflow builds and publishes:

- `main.js`
- `manifest.json`

## Status

Early internal release. Validate with a test vault before using it with an important vault.

## License

Copyright © 2026 Sparkore. All rights reserved.
