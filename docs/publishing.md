# Publishing to Obsidian Community Plugins

## Repository prerequisites

Obsidian requires the plugin repository or an approved public release repository to expose the files needed for review.

The simplest Sparkore setup is:

1. make `Sparkore/sparkore-kb-reader` public;
2. keep the current license unless Sparkore explicitly chooses another license;
3. keep `README.md`, `LICENSE`, and `manifest.json` at repository root.

## Initial release

Before submission:

1. Embed the production GitHub App Client ID and install URL.
2. Confirm CI is green.
3. Ensure `manifest.json`, `package.json`, and `versions.json` agree on version `0.1.0`.
4. Open **GitHub Actions → Release → Run workflow**, enter `0.1.0`, and run it.

The release workflow automatically:

- validates that the requested version matches `manifest.json`;
- typechecks;
- builds `main.js`;
- creates Git tag `0.1.0` when needed;
- creates `sparkore-kb-reader.zip`;
- creates the GitHub Release with `main.js`, `manifest.json`, and the install ZIP.

A normal pushed semver tag also triggers the same release workflow.

## Community directory submission

This is a one-time account-level action:

1. Sign in to https://community.obsidian.md.
2. Connect the GitHub account that owns or publicly belongs to the Sparkore organization.
3. Open **Plugins** -> **New plugin**.
4. Submit:
   `https://github.com/Sparkore/sparkore-kb-reader`
5. Address automated/reviewer feedback until the listing is published.

After the first approval, future versions only require a new GitHub release/tag; users can update through Obsidian.

## Private-source alternative

Obsidian supports a private source repository plus a public release repository, but this adds another repository and GitHub App configuration. Sparkore currently prefers the single public repository path for operational simplicity.
