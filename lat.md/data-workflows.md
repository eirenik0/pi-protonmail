# Data Workflows

This section covers Bridge configuration, helper execution, and the profile-oriented data flow used by the extension.

## Proton Bridge helper contract

This extension reads the Bridge env vars, resolves secret references, and then uses the native TypeScript bridge module in `src/proton-bridge.ts`.

Profile defaults live under `.pi/protonmail/config.json` and `.pi/protonmail/profiles/<name>/policy.json`; those files capture the active setup used later by LLM-oriented workflows. Attachment imports are staged under `.pi/protonmail/imports/<profile>/...` by default, and `import_workspace_root` can override that path for adapted workflows.

Attachment imports apply the optional `query` to each parsed message's subject, sender, message ID, and attachment names, the same default scope as message listing. They scan the whole period, so `limit` caps imported messages rather than the number of messages inspected. The workspace root must be a relative path that stays inside the project directory.

## Message listing

Message listing searches subject, sender, recipients, and message ID on the IMAP server, then fetches `ENVELOPE`, `BODYSTRUCTURE`, and size for the newest matches.

The default query also ORs attachment filenames, so a filename match still walks the mailbox newest first. Header queries parse header text in metadata batches. A body query fetches and parses one message source, then decides, before downloading the next, and stops once `limit` matches are found. A short result means fewer matches, not an early cutoff. Previews omit attachment sizes on every branch, including a parsed body match. `get` still returns the decoded size. Imports still download full source for messages they save.

## Argument validation

Cheap argument checks run before Bridge secrets are resolved, because `op read` can block for a minute when 1Password is locked.

Periods must be `YYYY-MM` with a month of 01–12, UIDs and message list limits must be positive integers, `searchIn` accepts only known fields, outgoing mail needs a `from` (explicit or profile `default_from`), and labels on sent mail require `saveToMailbox`. Mailboxes that cannot be opened are named in the error instead of ImapFlow's bare "Command failed".

## Write-result checks

ImapFlow's `messageMove` and `messageCopy` return `false` instead of throwing, so move, copy, and label operations verify the source UID exists and fail on a `false` result.

Without these checks a missing destination folder or UID was reported to the LLM as a successful move.

IMAP connections are created with ImapFlow's logger disabled, so protocol traces and AUTH payloads never reach stdout or the pi TUI.

Secret values may be literal text or 1Password references handled by [[src/secret-refs.ts#resolveSecretReference]].

## Operation timeouts

Bridge IMAP and SMTP calls use [[src/proton-bridge.ts#defaultBridgeTimeouts]]: 10s to connect, 10s for the greeting, and 60s of socket inactivity.

Inactivity is not a deadline for the whole call. A long import or an active transfer may run longer than 60s while bytes are still moving. The port probe stays at 1.5s.

Logout waits at most 5s, and Esc during that logout closes the socket immediately. A failed connect is closed without LOGOUT because the caller never receives that client. Esc aborts the tool signal, which destroys the IMAP socket or the owned SMTP socket for plain, STARTTLS, and implicit TLS, and stops an in-flight `op read`. Cancelled send, append, move, or copy calls are not retried: the server may already have applied the write.
