# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Workspace activity ledger** - Mortise now coordinates concurrent Agent file writes across sessions and processes, records exact before/after content provenance, and surfaces active work, conflicts, and recent changes from the top bar.
- **Optional Developer Kit** - Extension authors can install a separately packaged, version-matched Dev Host and `mortise-ui` validation CLI without adding privileged test controls to the normal Mortise package.
- **Versioned extension manifests** - Extensions can declare author and publisher identity, SemVer host compatibility, required and optional dependencies, conflicts, capabilities, permissions, and deterministic load-order hints.

## Improvements

- **Actionable extension diagnostics** - Settings now shows extension versions, authors, compatibility warnings, and blocking dependency or conflict errors before extension code runs.


## Bug Fixes

- **Clean packaged resources** - Rebuilds clear staged resources first, so deleted release notes and other obsolete files no longer survive into a new package.


## Breaking Changes
