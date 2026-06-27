# pi-protonmail

Proton Mail Bridge Pi extension for mailbox discovery and profile-based setup.

## What it provides

- `/protonmail` to open the interactive setup hub.
- `protonmail_*` tools for Bridge status, mailbox lookup, message previews, and attachment imports.

## Configuration

Set the Proton Bridge connection variables in your Pi environment:

- `PROTON_BRIDGE_HOST`
- `PROTON_BRIDGE_IMAP_PORT`
- `PROTON_BRIDGE_SMTP_PORT`
- `PROTON_BRIDGE_IMAP_SECURITY`
- `PROTON_BRIDGE_USERNAME`
- `PROTON_BRIDGE_PASSWORD`
- `PROTON_BRIDGE_DEFAULT_MAILBOX` (optional)

Proton Bridge operations are implemented in `src/proton-bridge.ts`.

Profile settings are stored under `.pi/protonmail/` as `config.json` plus per-profile `profiles/<name>/policy.json` files. Attachment imports are staged under `.pi/protonmail/imports/<profile>/...` by default and can be adapted through profile policy.
