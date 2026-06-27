# Data Workflows

This section covers Bridge configuration, helper execution, and the mailbox-oriented data flow used by the extension.

## Proton Bridge helper contract

This extension reads the Bridge env vars, resolves secret references, and then calls `.pi/helpers/proton_bridge.py`.

Secret values may be literal text or 1Password references handled by [[src/secret-refs.ts#resolveSecretReference]].
