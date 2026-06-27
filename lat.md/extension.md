# Extension

This section describes the Proton Bridge Pi extension surface and the user-facing mail workflows it exposes.

## Proton Bridge Mail Intake

The extension exposes `/proton-status`, `/proton-mailboxes`, `/proton-messages`, and `/protonmail`, plus matching `protonmail_*` tools for Pi. They check the Bridge, list mailboxes, preview recent messages, and open the interactive mailbox hub.

Command and tool summaries are formatted by [[src/protonmail.ts#formatStatusSummary]], [[src/protonmail.ts#formatMailboxSummary]], and [[src/protonmail.ts#formatMessageSummary]]. The hub itself lives in [[src/protonmail-tui.ts#openProtonMailHub]] and uses a framed, ZenMoney-style theme for its overlay.
