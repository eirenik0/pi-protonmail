# Changelog

## Unreleased

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
