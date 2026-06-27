# Proton Mail Bridge Pi extension

This repo packages a Pi extension for Proton Bridge mailbox discovery, message previews, and an interactive TUI.

## Repository overview

`package.json` points Pi at [[src/index.ts#registerProtonMailExtension]], which forwards to [[src/protonmail.ts#registerProtonBridgeExtension]]. The extension resolves optional 1Password secret references through [[src/secret-refs.ts#resolveSecretReference]].

## Docs

These files capture the extension surface and the Bridge data flow.

- [[extension]] — commands, tools, and user-facing mail workflows.
- [[data-workflows]] — environment variables, helper script contract, and mailbox-oriented config.
- [[tests]] — behaviors worth keeping stable as the mail workflow evolves.

## Source layout

The source is split into a thin entrypoint, the main Proton Bridge implementation, and a few shared helpers.

### `src/index.ts`

Thin entrypoint that hands the Pi extension API to the Proton Bridge registrar.

### `src/protonmail.ts`

Main implementation for command/tool registration, helper execution, and message formatting.

### `src/protonmail-tui.ts`

Interactive Proton Mail TUI hub for browsing mailboxes, choosing a month, and previewing messages.

### `src/secret-refs.ts`

Resolves raw tokens and `op://` / `op read` secret references before any Bridge request.

### `src/types.ts` and `src/constants.ts`

Shared wire types and small configuration constants used by the Proton Bridge workflow.
