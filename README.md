# pi-protonmail

Proton Mail Bridge Pi extension for mailbox discovery and profile-based setup.

## What it provides

- `/proton-status` to check local Bridge connectivity.
- `/proton-mailboxes` to list IMAP mailboxes.
- `/proton-messages` to preview recent messages.
- `/protonmail` to open the interactive setup hub.
- `protonmail_*` tools for the same workflows inside Pi.

## Configuration

Set the Proton Bridge connection variables in your Pi environment:

- `PROTON_BRIDGE_HOST`
- `PROTON_BRIDGE_IMAP_PORT`
- `PROTON_BRIDGE_SMTP_PORT`
- `PROTON_BRIDGE_IMAP_SECURITY`
- `PROTON_BRIDGE_USERNAME`
- `PROTON_BRIDGE_PASSWORD`
- `PROTON_BRIDGE_DEFAULT_MAILBOX` (optional)

The extension bundles its Proton Bridge helper script in `helpers/proton_bridge.py`.

Profile settings are stored under `.pi/protonmail/` as `config.json` plus per-profile `profiles/<name>/policy.json` files.
