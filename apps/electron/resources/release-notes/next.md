# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Data sources start disabled** - New and unset installations now keep the optional data-source UI and session tools off until explicitly enabled in Settings.
- **Workspace activity at a glance** - Workspace rows in the sidebar now show a running indicator whenever one of their visible sessions is processing, even when another workspace is selected.

## Bug Fixes

- **Stop now truly interrupts a response** - Craft waits for Pi to acknowledge cancellation, suppresses late output from the stopped turn, and no longer copies submitted or queued prompts back into the composer.

## Breaking Changes
