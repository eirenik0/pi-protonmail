# Publishing

This section documents how the package is released to npm and what CI guards the release flow.

## npm release workflow

Tagged pushes matching `v*` trigger the npm publish workflow, which validates the tag version against `package.json`, runs checks, and publishes with `NPM_TOKEN` when the version is not already on npm.

## Quality workflow

Main-branch pushes and pull requests run formatting and lint checks in GitHub Actions so release metadata and source style stay healthy before a publish tag is created.
