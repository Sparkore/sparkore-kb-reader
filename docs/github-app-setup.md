# GitHub App setup

Sparkore KB Reader uses a GitHub App with OAuth Device Flow instead of personal access tokens.

## Why a GitHub App

A classic GitHub OAuth App cannot request read-only access to private repository source code. Its `repo` scope is broad. A GitHub App can request exactly the repository permissions the Reader needs.

## Registration

Create the GitHub App under the Sparkore organization.

Recommended values:

- **GitHub App name:** Sparkore KB Reader
- **Homepage URL:** https://github.com/Sparkore/sparkore-kb-reader
- **Webhook:** disabled
- **Device Flow:** enabled
- **User-to-server token expiration:** enabled
- **Repository permissions**
  - Contents: Read-only
  - Metadata: Read-only (GitHub default/required)
- **Organization permissions:** none
- **Account permissions:** none
- **Install scope:** allow installation on any account if the Reader must access repositories in both Sparkore and SparkonStudio.

The app does not need a client secret for Device Flow.

## After registration

Configured production values:

- Client ID: `Iv23lirlrKVZLobrsmYi`
- App URL: `https://github.com/apps/sparkore-kb-reader`
- Install URL: `https://github.com/apps/sparkore-kb-reader/installations/new`

These values are embedded in `src/main.ts`. No client secret is shipped in the plugin.

## Repository installation

Install the GitHub App only on repositories that should be readable from Sparkore KB Reader.

For example:

```text
SparkonStudio/BackpackAdventures
```

The user authorizing the Reader must also have access to the repository. GitHub App user tokens are limited to the intersection of:

- the repositories/permissions granted to the GitHub App; and
- the repositories/permissions of the signed-in GitHub user.

## Token lifecycle

GitHub App user access tokens expire after eight hours by default. The Reader stores the refresh token in Obsidian SecretStorage and refreshes the access token automatically. Refresh tokens expire after six months without refresh/use; after that the user reconnects GitHub through Device Flow.
