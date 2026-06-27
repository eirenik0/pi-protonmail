# Tests

This section records the Proton Bridge behaviors that should stay stable as the extension evolves.

## Bridge status output

The status report should list the configured host, ports, security mode, credential presence, and any local IMAP/SMTP probe failures so connection problems are visible before mail browsing starts.

## Mailbox filtering

Mailbox search should return only folders that match the query, with the count and names preserved in the summary so users can choose the exact source.

## Message previewing

Message summaries should include UID, sender, subject, date, and attachment names so users can confirm a mailbox contains the intended mail before opening it.

## TUI navigation

The Proton Mail setup hub should preserve the active profile while users edit defaults.

It should let users choose a profile, save or delete it without losing the active selection, and keep profile filtering from silently switching the active profile. The hub should stay framed and readable like the ZenMoney hub.

## Import staging

Attachment imports should report the profile workspace, period folder, and staging locations so the LLM can adapt the workflow without depending on business-specific folder names or a fixed workspace layout.

## Secret resolution

`op://` and `op read` references should resolve before any Bridge request, and clear errors should surface when the 1Password CLI is unavailable or returns an empty secret.
