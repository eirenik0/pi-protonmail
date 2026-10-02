# Publishing

This section documents how the package is released to npm and what CI guards the release flow.

## npm release workflow

Tagged pushes matching `v*` trigger the npm publish workflow, which validates the tag version against `package.json`, runs checks, and publishes when the version is not already on npm.

Publishing uses npm trusted publishing: the job requests a GitHub OIDC token (`id-token: write`), upgrades to npm ≥ 11.5.1, and runs `npm publish` without any `NPM_TOKEN` secret; npm attaches provenance automatically. The package's trusted publisher on npmjs.com must name `eirenik0/pi-protonmail` and the `publish-npm.yml` workflow file. A failed tag can be republished with a manual `workflow_dispatch` run that passes the tag, which uses the workflow from `main`.

## Quality workflow

Main-branch pushes and pull requests run formatting, lint, and `npm run typecheck` checks on Node 24 in GitHub Actions so release metadata and source style stay healthy before a publish tag is created.
