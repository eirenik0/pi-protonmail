# pi-protonmail

Proton Mail Bridge Pi extension for mailbox discovery and message previews.

## What it provides

- `/proton-status` to check local Bridge connectivity.
- `/proton-mailboxes` to list IMAP mailboxes.
- `/proton-messages` to preview recent messages.
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

The extension expects the helper script at `.pi/helpers/proton_bridge.py` in the working project.
