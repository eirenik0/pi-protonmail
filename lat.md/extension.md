# Extension

This section describes the Proton Bridge Pi extension surface and the user-facing setup workflows it exposes.

## Proton Bridge Mail Intake

The extension exposes `/protonmail` plus `protonmail_*` tools for setup and mail workflows.

The command keeps config edits separate from LLM-facing workflows, and profile filtering should not change the active profile until the user explicitly selects one. Message listing stays attachment-only by default but can include non-attachment messages and search selected fields for sent-mail and archive searches. Bridge work now lives in the native TypeScript module instead of a Python helper.

Command and tool summaries are formatted by [[src/protonmail.ts#formatStatusSummary]], [[src/protonmail.ts#formatMailboxSummary]], [[src/protonmail.ts#formatMessageSummary]], [[src/protonmail.ts#formatGetMessageSummary]], and [[src/protonmail.ts#formatImportSummary]]. The hub itself lives in [[src/hub.ts#openProtonMailHub]] and stores profile defaults for later LLM workflows.

## Proton Bridge Outgoing

The extension can read, compose, send, and move mail through Proton Bridge so workflows do not stop at incoming attachment import.

Message reads use [[src/proton-bridge.ts#protonBridgeGetMessage]] to fetch one mailbox UID with parsed headers, bodies, and attachment metadata. Draft creation uses [[src/proton-bridge.ts#protonBridgeCreateDraft]] to build MIME messages with local attachments and APPEND them to a Drafts mailbox. Direct sending uses [[src/proton-bridge.ts#protonBridgeSendMessage]] over Bridge SMTP, can append a sent copy to a workflow mailbox, and can label that saved copy when `saveToMailbox` returns a UID. Filing uses [[src/proton-bridge.ts#protonBridgeMoveMessage]] to move a UID between Proton folders, [[src/proton-bridge.ts#protonBridgeCopyMessage]] copies a UID to another mailbox, and [[src/proton-bridge.ts#protonBridgeApplyLabels]] copies a UID into resolved label mailboxes without removing it from the source.

Mail tools are registered by [[src/protonmail.ts#registerProtonBridgeExtension]] as `protonmail_get_message`, `protonmail_create_draft`, `protonmail_send`, `protonmail_move_message`, `protonmail_copy_message`, and `protonmail_apply_labels`. The active profile policy may define `default_from`, which is used when a tool call does not provide an explicit sender address.
