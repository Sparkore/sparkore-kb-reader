# Security

## GitHub credentials

Sparkore KB Reader requires only read access.

For private repositories, use a fine-grained GitHub personal access token limited
to the required repositories with:

- Contents: Read-only

Do not grant repository write, administration, workflow, secrets, or organization
permissions.

The plugin stores the selected secret name in its settings and reads the token
value through Obsidian SecretStorage.

## Reporting

Do not open a public issue containing tokens, private repository URLs, confidential
KB content, or other secrets. Report security issues privately to the Sparkore
maintainers.
