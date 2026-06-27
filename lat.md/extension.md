# Extension

This section describes the Proton Bridge Pi extension surface and the user-facing setup workflows it exposes.

## Proton Bridge Mail Intake

The extension exposes `/protonmail` plus `protonmail_*` tools for setup and mail workflows.

The command keeps config edits separate from LLM-facing workflows, and profile filtering should not change the active profile until the user explicitly selects one. Bridge work now lives in the native TypeScript module instead of a Python helper.

Command and tool summaries are formatted by [[src/protonmail.ts#formatStatusSummary]], [[src/protonmail.ts#formatMailboxSummary]], [[src/protonmail.ts#formatMessageSummary]], and [[src/protonmail.ts#formatImportSummary]]. The hub itself lives in [[src/hub.ts#openProtonMailHub]] and stores profile defaults for later LLM workflows.
