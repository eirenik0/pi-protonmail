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

### Fetches search results by UID

Message listing and attachment import should fetch UIDs returned by IMAP search in UID mode, so sparse UID values are not mistaken for sequence numbers.

### Does not apply mailbox filters to messages

A profile's mailbox filter should narrow mailbox discovery only; message listing and attachment import should not use it as an implicit message-content query.

### Filters by attachments

Message listing should include messages without attachments by default, but it should return only attachment-bearing messages when callers set the attachments-only filter.

### Searches selected fields

Message listing should keep the default query scope stable while allowing callers to search recipients, body text, headers, attachments, and message IDs explicitly.

### Searches message ID and recipients

A message-ID query should use the Message-ID header, and a recipient query should use the recipient search key, without falling back to a body search.

### Searches searchable fields on the server

A subject, sender, recipient, or message-ID query should be sent to IMAP and only the matching UIDs should have their envelope and body structure fetched.

### Keeps period and unseen restrictions

A field search should stay inside the requested month and unseen set instead of searching the rest of the mailbox.

### Omits an invalid envelope date

Listing should keep a message whose envelope date cannot be parsed and should leave that date unset instead of failing the preview.

### Walks sparse UIDs newest first

Listing should order numeric UIDs newest first and fetch those UIDs, not the sequence numbers in between.

### Prefers a newer attachment match

The default query ORs attachment filenames with subject and sender, so a newer filename match comes before an older subject match.

### Fetches only the requested preview count

Listing without a query should fetch metadata for enough newest messages to fill the limit, not the rest of the mailbox.

### Rejects a fractional limit

A fractional or non-positive list limit is rejected before any mailbox scan, so a partial batch size cannot stall the preview loop.

### Searches headers without the body

A header query should fetch header text, match decoded header lines including Subject, and should not download the message body.

### Searches decoded message text

A body query should match decoded message text, including quoted-printable or base64 parts, and should not issue an IMAP BODY search.

### Reads decoded attachment filenames

Attachment search should decode MIME filenames, including inline parts and files nested in another multipart, without downloading the message body.

### Matches parsed attachment parts

Listing should report the same attachment names and types as parsed mail for the same MIME message, including unnamed binaries, named text attachments, inline text left out, and an attached message kept as one file.

### Cancels during a preview batch

Esc during a metadata batch should cancel the listing instead of waiting for the remaining mailbox to download.

## Message reading

Reading a single message should return parsed address fields, subject, date, bodies, headers, attachment metadata, and raw size for the requested mailbox UID.

## TUI navigation

The Proton Mail setup hub should preserve the active profile while users edit defaults.

It should let users choose a profile, save or delete it without losing the active selection, and keep profile filtering from silently switching the active profile. The hub should stay framed and readable like the ZenMoney hub.

## Import staging

Attachment imports should report the profile workspace, period folder, and staging locations so the LLM can adapt the workflow without depending on business-specific folder names or a fixed workspace layout.

### Imports older matches

An import with a small `limit` should still find a matching message older than the newest `limit × 10` messages of the period, and should reject workspace roots that are absolute or escape the project with `..`.

### Applies the import query

An import with a `query` that matches no subject, sender, message ID, or attachment name should import nothing, instead of ignoring the query and staging every attachment-bearing message.

## Pi 1.0 rendering

Tool call renderers should not throw on partial streaming arguments, and the hub should list profiles whose mailbox or period matches the filter, not only names starting with it.

### Quiet IMAP client

Running any Bridge tool should print nothing to stdout from ImapFlow, since stray protocol logs corrupt pi's fullscreen TUI and can expose AUTH payloads.

## Draft creation

Draft creation should compose a MIME message with sender, recipients, body, and local attachments before APPENDing it to the configured Drafts mailbox.

## Message sending

Message sending should use Proton Bridge SMTP for delivery and optionally append a copy to a chosen IMAP mailbox for workflow filing.

### Labels saved copies

Message sending should apply requested labels only to a saved sent copy, and it should require `saveToMailbox` before accepting labels.

## Message moving

Message moving should open the source mailbox by UID and move the selected message to the requested Proton destination folder.

### Reports failed moves

Moving or copying to a nonexistent destination, or a UID missing from the source mailbox, should fail with a clear error instead of reporting success.

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

## Operation timeouts

Bridge network waits should fail when Proton Bridge accepts a socket and then goes silent, and Esc should cancel the tool instead of leaving it running.

### Stalled greeting

A server that accepts IMAP and never sends a greeting should fail the call within the greeting timeout and drop the socket.

### Stalled command

A server that stops answering after login should fail the in-flight command on socket inactivity and drop the socket, without an uncaught ImapFlow error.

### Post-login socket timeout

A stall after login succeeds should still hit socket inactivity, so the post-connect error event is handled instead of crashing the process.

### Abort during logout

Esc during a stalled LOGOUT should close the socket immediately instead of waiting out the logout bound, after the IMAP work has already finished.

### Failed connect

A refused IMAP connection should surface the connection error, not a cancellation, and should not leave the client socket open.

### Bounded logout

A server that ignores LOGOUT should still finish within the logout bound, and a server that accepts LOGOUT should not leave the logout timer running.

### Abort cancels IMAP

Aborting the tool signal during a stalled mailbox list should reject with a cancellation and close the socket without waiting for socket inactivity.

### SMTP greeting timeout

A server that accepts SMTP and never sends a greeting should reject the send from Nodemailer's greeting timeout.

### Abort cancels SMTP

Aborting during an SMTP greeting wait should cancel the send immediately, close the socket, and leave no greeting timer behind.

### SMTP delivery accepted

A completed plain SMTP send should be accepted by the server, so cancellation tests are compared with a path that really queues mail.

### Abort during SMTP data

Aborting after the message body has been written should close the socket before a deferred acceptance response is sent.

### Abort cancels implicit TLS

Aborting an implicit TLS send should destroy that TLS socket and should not leave the greeting timer running.

### Abort cancels STARTTLS

Aborting a STARTTLS send after the message body is written should close the socket before the server accepts the message.

### Tool signal reaches Bridge

The abort signal passed to a registered Proton Mail tool should reach the Bridge call and cancel it.

### Abort cancels secret reads

An already aborted signal should reject an `op://` secret read before the 1Password CLI can block the tool.
