# Changelog

## Unreleased

- Added `protonmail_get_message` for reading a single message's metadata, body, headers, and attachments by mailbox UID.
- Added `includeWithoutAttachments` to `protonmail_list_messages` for listing non-attachment mail when requested.

## 0.2.0 - 2026-07-02

- Added outgoing Proton Bridge tools for draft creation, SMTP sending, message moving, and label application.
- Added MIME composition with local attachments through `nodemailer`.
- Added profile `default_from` support for outgoing mail sender resolution.
- Added Conventional Commits guidance for future repository commits.

## 0.1.0

- Kept `/protonmail` as the single config command and moved Bridge/status/message handling into `protonmail_*` tools.
- Replaced the Python Bridge helper with a native TypeScript module and kept attachment import staging under profile-specific workspaces.
- Aligned the package metadata and docs with the Proton Mail workflow.
