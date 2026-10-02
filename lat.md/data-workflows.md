# Data Workflows

This section covers Bridge configuration, helper execution, and the profile-oriented data flow used by the extension.

## Proton Bridge helper contract

This extension reads the Bridge env vars, resolves secret references, and then uses the native TypeScript bridge module in `src/proton-bridge.ts`.

Profile defaults live under `.pi/protonmail/config.json` and `.pi/protonmail/profiles/<name>/policy.json`; those files capture the active setup used later by LLM-oriented workflows. Attachment imports are staged under `.pi/protonmail/imports/<profile>/...` by default, and `import_workspace_root` can override that path for adapted workflows.

Attachment imports apply the optional `query` to each parsed message's subject, sender, message ID, and attachment names, the same default scope as message listing. They scan the whole period, so `limit` caps imported messages rather than the number of messages inspected. The workspace root must be a relative path that stays inside the project directory.

## Argument validation

Cheap argument checks run before Bridge secrets are resolved, because `op read` can block for a minute when 1Password is locked.

Periods must be `YYYY-MM` with a month of 01–12, UIDs must be positive integers, `searchIn` accepts only known fields, outgoing mail needs a `from` (explicit or profile `default_from`), and labels on sent mail require `saveToMailbox`. Mailboxes that cannot be opened are named in the error instead of ImapFlow's bare "Command failed".

IMAP connections are created with ImapFlow's logger disabled, so protocol traces and AUTH payloads never reach stdout or the pi TUI.

Secret values may be literal text or 1Password references handled by [[src/secret-refs.ts#resolveSecretReference]].
