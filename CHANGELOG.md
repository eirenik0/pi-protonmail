# Changelog

## Unreleased

- Adapted the extension to pi 1.0: import `Theme` from `@earendil-works/pi-coding-agent`, accept block content in the report message renderer, and keep tool call renderers safe on partial streaming arguments.
- Disabled ImapFlow's stdout logger, which corrupted pi's fullscreen TUI and printed AUTH payloads.
- Rebuilt the setup hub profile list without touching private `SelectList` fields, so filters match mailbox and period values again, and moved the cursor to the end of prefilled inputs.
- Fixed `protonmail_import_attachments` ignoring its `query` filter and skipping matches older than the newest `limit × 10` messages; workspace roots outside the project are now rejected.
- Validated periods (month 01–12), UIDs, and `searchIn` fields, named unopenable mailboxes in errors, and ran these checks before 1Password secret resolution.

## 0.3.1 - 2026-07-20

- Fixed Proton Bridge searches to return and fetch message UIDs correctly, and stopped applying mailbox filters as implicit message-content queries.

## 0.3.0 - 2026-07-03

- Added `protonmail_get_message` for reading a single message's metadata, body, headers, and attachments by mailbox UID.
- Changed `protonmail_list_messages` to list all messages by default with an `attachmentsOnly` filter for attachment-only views.
- Added `protonmail_copy_message` for copying messages between IMAP mailboxes without moving the source.
- Improved label application errors when a requested Proton label mailbox cannot be resolved.
- Added optional `labels` to `protonmail_send` for labeling saved sent copies.
- Fixed copied UID reporting for `protonmail_copy_message` responses.
- Added `searchIn` to `protonmail_list_messages` for searching recipients, bodies, headers, and message metadata.

## 0.2.0 - 2026-07-02

- Added outgoing Proton Bridge tools for draft creation, SMTP sending, message moving, and label application.
- Added MIME composition with local attachments through `nodemailer`.
- Added profile `default_from` support for outgoing mail sender resolution.
- Added Conventional Commits guidance for future repository commits.

## 0.1.0

- Kept `/protonmail` as the single config command and moved Bridge/status/message handling into `protonmail_*` tools.
- Replaced the Python Bridge helper with a native TypeScript module and kept attachment import staging under profile-specific workspaces.
- Aligned the package metadata and docs with the Proton Mail workflow.
