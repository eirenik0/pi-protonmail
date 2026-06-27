# pi-protonmail

Proton Mail Bridge Pi extension for mailbox discovery, message previews, attachment imports, and profile-based setup.

## Use cases

- `/protonmail` — open the interactive setup hub for profile defaults.
- `protonmail_*` tools — check Bridge status, list mailboxes, preview messages, and import attachments.

## Install

```bash
pi install npm:pi-protonmail
```

For local development:

```bash
pi install /absolute/path/to/this/repo
```

## Environment

Set the Proton Bridge connection variables in your Pi environment:

- `PROTON_BRIDGE_HOST`
- `PROTON_BRIDGE_IMAP_PORT`
- `PROTON_BRIDGE_SMTP_PORT`
- `PROTON_BRIDGE_IMAP_SECURITY`
- `PROTON_BRIDGE_USERNAME`
- `PROTON_BRIDGE_PASSWORD`
- `PROTON_BRIDGE_DEFAULT_MAILBOX` (optional)

These values may be raw strings or 1Password references resolved by the extension.

## Profiles and workspace

Profile settings are stored under `.pi/protonmail/`:

- `config.json` — workspace-level config
- `profiles/<name>/policy.json` — per-profile defaults

Profile defaults control the mailbox selection, mailbox filter, period, and optional import workspace override used by LLM-driven mail workflows. Attachment imports default to `.pi/protonmail/imports/<profile>/...`.

## Workflow

1. Configure Proton Bridge credentials.
2. Open `/protonmail` to choose or edit a profile.
3. Use `protonmail_*` tools for Bridge status, mailbox lookup, message previews, or staged attachment imports.

## Publishing

Tagged pushes like `v0.1.0` publish to npm through GitHub Actions. The release workflow validates the tag version, runs checks, and publishes with `NPM_TOKEN` when the version is not already on npm.

## Repository notes

- Entry point: `src/index.ts`
- Main extension logic: `src/protonmail.ts`
- Native Bridge implementation: `src/proton-bridge.ts`
- Setup hub: `src/hub.ts`
- Secret resolution: `src/secret-refs.ts`

## Troubleshooting

- If Bridge status fails, confirm the host, ports, and credentials are correct.
- If list or import commands return nothing, verify the default mailbox and active profile policy.
- If imports fail, check that the target period is set and matches `YYYY-MM`.
