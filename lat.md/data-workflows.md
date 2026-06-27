# Data Workflows

This section covers Bridge configuration, helper execution, and the profile-oriented data flow used by the extension.

## Proton Bridge helper contract

This extension reads the Bridge env vars, resolves secret references, and then calls `helpers/proton_bridge.py`.

Profile defaults live under `.pi/protonmail/config.json` and `.pi/protonmail/profiles/<name>/policy.json`; those files capture the active setup used later by LLM-oriented workflows. Attachment imports are staged under `.pi/protonmail/imports/<profile>/...` by default, and `import_workspace_root` can override that path for adapted workflows.

Secret values may be literal text or 1Password references handled by [[src/secret-refs.ts#resolveSecretReference]].
