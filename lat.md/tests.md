# Tests

This section records the Proton Bridge behaviors that should stay stable as the extension evolves.

## Bridge status output

The status report should list the configured host, ports, security mode, credential presence, and any local IMAP/SMTP probe failures so connection problems are visible before mail browsing starts.

## Mailbox filtering

Mailbox search should return only folders that match the query, with the count and names preserved in the summary so users can choose the exact source.

## Message previewing

Message summaries should include UID, sender, subject, date, and attachment names so users can confirm a mailbox contains the intended mail before opening it.

### Handles empty searches

Message listing should return an empty result for a mailbox or period with no matches instead of crashing when IMAP search returns no UIDs.

### Includes messages without attachments

Message listing should remain attachment-only by default, but it should include non-attachment messages when callers opt in for sent-mail or archive searches.

## Message reading

Reading a single message should return parsed address fields, subject, date, bodies, headers, attachment metadata, and raw size for the requested mailbox UID.

## TUI navigation

The Proton Mail setup hub should preserve the active profile while users edit defaults.

It should let users choose a profile, save or delete it without losing the active selection, and keep profile filtering from silently switching the active profile. The hub should stay framed and readable like the ZenMoney hub.

## Import staging

Attachment imports should report the profile workspace, period folder, and staging locations so the LLM can adapt the workflow without depending on business-specific folder names or a fixed workspace layout.

## Draft creation

Draft creation should compose a MIME message with sender, recipients, body, and local attachments before APPENDing it to the configured Drafts mailbox.

## Message sending

Message sending should use Proton Bridge SMTP for delivery and optionally append a copy to a chosen IMAP mailbox for workflow filing.

## Message moving

Message moving should open the source mailbox by UID and move the selected message to the requested Proton destination folder.

## Message copying

Message copying should open the source mailbox by UID and copy the selected message to the requested Proton destination without removing the source message.

## Label application

Label application should copy the selected UID into each resolved label mailbox while leaving the message in its source mailbox.

### Missing label mailbox

Label application should fail with a clear available-label hint when a requested bare label or label mailbox path cannot be resolved.

## Profile default_from

Outgoing tools should use an explicit `from` value first and otherwise require the active profile policy to provide `default_from`.

## Secret resolution

`op://` and `op read` references should resolve before any Bridge request, and clear errors should surface when the 1Password CLI is unavailable or returns an empty secret.
