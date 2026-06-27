# Extension

This section describes the Proton Bridge Pi extension surface and the user-facing mail workflows it exposes.

## Proton Bridge Mail Intake

The extension exposes `/proton-status`, `/proton-mailboxes`, and `/proton-messages`, plus matching `protonmail_*` tools for Pi. They check the Bridge, list mailboxes, and preview recent messages.

Command and tool summaries are formatted by [[src/protonmail.ts#formatStatusSummary]], [[src/protonmail.ts#formatMailboxSummary]], and [[src/protonmail.ts#formatMessageSummary]].
