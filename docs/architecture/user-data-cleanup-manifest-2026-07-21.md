# User Data Cleanup Manifest - 2026-07-21

**Confirmation status: NOT APPROVED. This document performs and authorizes no deletion.**

Snapshot captured at `2026-07-21 07:58:18 +08:00` using filesystem metadata only. No file contents or secret values were read. Sizes are binary MiB (1 MiB = 1,048,576 bytes). `MORTISE_CONFIG_DIR` and `PI_CODING_AGENT_DIR` were not set during the scan.

This is a point-in-time inventory. Every candidate must be re-scanned immediately before deletion, the resulting dated exact-path manifest must be reviewed, and the user must explicitly confirm that current manifest before any destructive command is run.

## Summary

| Set | Directories | Size | Status |
|---|---:|---:|---|
| Fixed persistent legacy paths | 6 | 776.07 MiB | Confirmation required |
| Persistent `.craft` session sidecars | 129 | 7.70 MiB | Confirmation required |
| Persistent legacy total | 135 | 783.78 MiB | Confirmation required |
| Temporary `craft*` directories | 162 | 910.38 MiB | Separate temporary set; confirmation required |
| Active Mortise/Pi paths | 8 | Not included in cleanup total | **DO NOT DELETE** |

The persistent total is the recorded scan total supplied for this decision snapshot; the fixed and sidecar rows are rounded independently.

## Persistent Legacy Paths

| Exact absolute path | Exists | Size (MiB) | Last write | Category | Decision |
|---|:---:|---:|---|---|---|
| `C:\Users\32858\.craft-agent` | Yes | 64.39 | 2026-07-19 18:33:30 +08:00 | Former Craft agent data | Confirmation required before cleanup |
| `C:\Users\32858\.mortise-migration-backups` | Yes | 197.13 | 2026-07-19 18:47:54 +08:00 | Former migration backups | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Roaming\@craft-agent` | Yes | 41.45 | 2026-07-18 15:32:39 +08:00 | Former scoped roaming configuration | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Roaming\craft-agent` | Yes | 0.03 | 2026-07-09 11:00:19 +08:00 | Former roaming configuration | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Roaming\Craft Agents` | Yes | 43.92 | 2026-07-18 21:10:08 +08:00 | Former Craft Agents application data | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\@craft-agentelectron-updater` | Yes | 429.15 | 2026-07-02 16:17:09 +08:00 | Former Craft updater cache | Confirmation required before cleanup |

## Active Paths - DO NOT DELETE

These are current Mortise/Pi or repository-local paths. Their presence in the scan is protective context only; they are outside cleanup scope.

| Exact absolute path | Exists | Size (MiB) | Last write | Category | Decision |
|---|:---:|---:|---|---|---|
| `C:\Users\32858\.mortise` | Yes | 3.83 | 2026-07-21 06:25:22 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `C:\Users\32858\.pi` | Yes | 660.62 | 2026-05-22 19:00:18 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `C:\Users\32858\AppData\Roaming\@mortise` | Yes | 60.06 | 2026-07-18 21:22:01 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `C:\Users\32858\AppData\Roaming\mortise` | Yes | 130.79 | 2026-07-20 01:27:58 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `C:\Users\32858\AppData\Local\@mortiseelectron-updater` | Yes | 416.03 | 2026-07-18 21:26:37 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `C:\Users\32858\AppData\Local\Mortise\Developer Kit` | Yes | 949.11 | 2026-07-19 20:35:59 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `E:\_workSpace\_Agents\craft-agent\.mortise` | Yes | 0.00 | 2026-07-19 01:21:06 +08:00 | Active Mortise/Pi data | DO NOT DELETE |
| `E:\_workSpace\_Agents\craft-agent\.pi` | Yes | 0.00 | 2026-07-12 11:58:11 +08:00 | Active Mortise/Pi data | DO NOT DELETE |

## Temporary Set

Temporary `craft*` directories are not part of the 783.78 MiB persistent legacy total. They require separate review and confirmation because a currently running process may still own a temporary directory.

## Appendix A - Persistent `.craft` Sidecars

Enumerated directories: 129. Total: 7.70 MiB.

| Exact absolute path | Exists | Size (MiB) | Last write | Category | Decision |
|---|:---:|---:|---|---|---|
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-.craft-agent-workspaces-my-workspace--\.craft` | Yes | 0.00 | 2026-07-08 02:45:39 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-craft-store-attachment-jljnzz-workspace--\.craft` | Yes | 0.00 | 2026-07-06 13:50:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-pending-plan-test-1783073755305-1d5vriqdc7v--\.craft` | Yes | 0.00 | 2026-07-03 18:15:55 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659222966-2by7v1wzph2--\.craft` | Yes | 0.00 | 2026-07-10 12:53:42 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659444471-t7i31ztpwlf--\.craft` | Yes | 0.00 | 2026-07-10 12:57:24 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659444701-8l0m3ld6qio--\.craft` | Yes | 0.00 | 2026-07-10 12:57:24 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659444820-p0b5b90yfg--\.craft` | Yes | 0.00 | 2026-07-10 12:57:24 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783661868684-zkxf8m834np--\.craft` | Yes | 0.00 | 2026-07-10 13:37:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783661869105-8qomjkaavid--\.craft` | Yes | 0.00 | 2026-07-10 13:37:49 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783661869318-ebmg661g3p6--\.craft` | Yes | 0.00 | 2026-07-10 13:37:49 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663438702-yxpn8o3dc5--\.craft` | Yes | 0.00 | 2026-07-10 14:03:58 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663439034-5txmm6rn32u--\.craft` | Yes | 0.00 | 2026-07-10 14:03:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663439193-7xpjx1x9pdw--\.craft` | Yes | 0.00 | 2026-07-10 14:03:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663460650-e2dr0tumj65--\.craft` | Yes | 0.00 | 2026-07-10 14:04:20 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663460979-wl0hxtdfyb9--\.craft` | Yes | 0.00 | 2026-07-10 14:04:20 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663461185-f96ltbmd978--\.craft` | Yes | 0.00 | 2026-07-10 14:04:21 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783759146893-a8zhxs0pcv--\.craft` | Yes | 0.00 | 2026-07-11 16:39:06 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783759147096-l6u0tj9kx3o--\.craft` | Yes | 0.00 | 2026-07-11 16:39:07 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783759147203-3f5nz8j431w--\.craft` | Yes | 0.00 | 2026-07-11 16:39:07 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783828893477-ttokia3jt3l--\.craft` | Yes | 0.00 | 2026-07-12 12:01:33 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783828893727-ki4kfon99la--\.craft` | Yes | 0.00 | 2026-07-12 12:01:33 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783828893899-4m7sbjw6j02--\.craft` | Yes | 0.00 | 2026-07-12 12:01:33 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837356844-7h0xnveytf3--\.craft` | Yes | 0.00 | 2026-07-12 14:22:36 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837357066-8gpdmf9j5rs--\.craft` | Yes | 0.00 | 2026-07-12 14:22:37 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837357181-ea637brr0tu--\.craft` | Yes | 0.00 | 2026-07-12 14:22:37 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837979426-ubhh7ul7t6--\.craft` | Yes | 0.00 | 2026-07-12 14:32:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837979636-vqls5n1udsq--\.craft` | Yes | 0.00 | 2026-07-12 14:32:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837979767-x9fwcxcdavg--\.craft` | Yes | 0.00 | 2026-07-12 14:32:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783846401631-g3z3k4i1dy9--\.craft` | Yes | 0.00 | 2026-07-12 16:53:21 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783846401866-2uvv9iris4i--\.craft` | Yes | 0.00 | 2026-07-12 16:53:21 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783846401983-ttsbiowfpjt--\.craft` | Yes | 0.00 | 2026-07-12 16:53:21 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-persistence-queue-test-1783085536079--\.craft` | Yes | 0.00 | 2026-07-03 21:32:31 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-persistence-queue-test-1783085552239--\.craft` | Yes | 0.00 | 2026-07-03 21:32:32 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-persistence-queue-test-1783758896903--\.craft` | Yes | 0.00 | 2026-07-11 16:35:27 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-persistence-queue-test-1783828618649--\.craft` | Yes | 0.00 | 2026-07-12 11:57:29 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-persistence-queue-test-1783829036181--\.craft` | Yes | 0.00 | 2026-07-12 12:04:26 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-4mwyhc--\.craft` | Yes | 0.00 | 2026-07-11 20:44:54 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-62dstk--\.craft` | Yes | 0.00 | 2026-07-12 14:13:31 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-7wt2wa--\.craft` | Yes | 0.00 | 2026-07-11 20:12:07 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-bvjhkl--\.craft` | Yes | 0.00 | 2026-07-12 11:58:34 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-crdrgy--\.craft` | Yes | 0.00 | 2026-07-12 14:13:31 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-fjjwfr--\.craft` | Yes | 0.00 | 2026-07-12 13:43:58 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-fre0sw--\.craft` | Yes | 0.00 | 2026-07-11 18:01:34 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-qhe7pp--\.craft` | Yes | 0.00 | 2026-07-11 20:12:07 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-r2r8tk--\.craft` | Yes | 0.00 | 2026-07-12 11:58:34 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-rl9ppl--\.craft` | Yes | 0.00 | 2026-07-11 21:48:49 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-rugrvy--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-sdr7cj--\.craft` | Yes | 0.00 | 2026-07-11 18:01:34 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-so29cf--\.craft` | Yes | 0.00 | 2026-07-11 16:47:12 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-uj22wk--\.craft` | Yes | 0.00 | 2026-07-11 16:48:54 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-vl72b7--\.craft` | Yes | 0.00 | 2026-07-12 13:43:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-vomcmz--\.craft` | Yes | 0.00 | 2026-07-11 20:44:54 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-vtignk--\.craft` | Yes | 0.00 | 2026-07-12 11:58:33 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-w73q32--\.craft` | Yes | 0.00 | 2026-07-12 11:58:33 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-43bCWi--\.craft` | Yes | 0.00 | 2026-07-03 21:32:56 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-6DeIg8--\.craft` | Yes | 0.00 | 2026-07-03 21:32:55 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-bemlha--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-e0l0p4--\.craft` | Yes | 0.00 | 2026-07-11 16:36:12 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-fauifq--\.craft` | Yes | 0.00 | 2026-07-11 16:36:12 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-GqgAfE--\.craft` | Yes | 0.00 | 2026-07-03 21:32:55 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-Gys41L--\.craft` | Yes | 0.00 | 2026-07-03 21:32:55 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-jeaxu7--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-jtwuvk--\.craft` | Yes | 0.00 | 2026-07-11 16:36:13 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-jxnyfn--\.craft` | Yes | 0.00 | 2026-07-11 16:36:13 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-nftm4w--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-okto0r--\.craft` | Yes | 0.00 | 2026-07-11 16:36:13 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-ptYCpy--\.craft` | Yes | 0.00 | 2026-07-03 21:32:55 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-qjqcjk--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-sJHuwn--\.craft` | Yes | 0.00 | 2026-07-03 21:32:55 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-smsfc8--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-x1khkh--\.craft` | Yes | 0.00 | 2026-07-11 16:36:13 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-xbsr7s--\.craft` | Yes | 0.00 | 2026-07-11 21:48:48 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-debug-410ugj--\.craft` | Yes | 0.00 | 2026-07-08 23:30:54 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-6lyfbz--\.craft` | Yes | 0.00 | 2026-07-12 12:03:28 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-6xooh9--\.craft` | Yes | 0.00 | 2026-07-11 21:48:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-7ell1u--\.craft` | Yes | 0.00 | 2026-07-11 19:45:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-8m7x0w--\.craft` | Yes | 0.00 | 2026-07-11 16:36:14 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-8sgit4--\.craft` | Yes | 0.00 | 2026-07-08 11:25:10 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-9jlhoh--\.craft` | Yes | 0.00 | 2026-07-08 23:27:47 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-a4b8ky--\.craft` | Yes | 0.00 | 2026-07-08 23:27:47 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-as0akb--\.craft` | Yes | 0.00 | 2026-07-11 19:45:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-bmakgo--\.craft` | Yes | 0.00 | 2026-07-12 11:58:36 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-c2i9yu--\.craft` | Yes | 0.00 | 2026-07-11 19:50:31 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-cuq2ta--\.craft` | Yes | 0.00 | 2026-07-08 23:27:47 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-dqyfcy--\.craft` | Yes | 0.00 | 2026-07-08 23:33:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-eligh8--\.craft` | Yes | 0.00 | 2026-07-08 23:21:08 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-eln3ew--\.craft` | Yes | 0.00 | 2026-07-08 23:21:08 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-fh5sln--\.craft` | Yes | 0.00 | 2026-07-12 12:03:31 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-ghpclu--\.craft` | Yes | 0.00 | 2026-07-08 23:27:47 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-durability-idNHLz--\.craft` | Yes | 0.00 | 2026-07-03 21:32:56 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-ijahpx--\.craft` | Yes | 0.00 | 2026-07-08 23:21:08 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-inisyv--\.craft` | Yes | 0.00 | 2026-07-12 11:58:36 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-iz125w--\.craft` | Yes | 0.00 | 2026-07-11 21:48:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-lepcgm--\.craft` | Yes | 0.00 | 2026-07-12 14:20:11 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-lvsned--\.craft` | Yes | 0.00 | 2026-07-08 23:21:08 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-lyhjkj--\.craft` | Yes | 0.00 | 2026-07-11 21:48:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-mmsxiz--\.craft` | Yes | 0.00 | 2026-07-08 11:25:12 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-n1ouxs--\.craft` | Yes | 0.00 | 2026-07-08 11:57:08 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-n8mbop--\.craft` | Yes | 0.00 | 2026-07-11 19:45:59 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-durability-NMBZFn--\.craft` | Yes | 0.00 | 2026-07-03 21:32:57 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-q4lo0p--\.craft` | Yes | 0.00 | 2026-07-08 11:25:11 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-r3mits--\.craft` | Yes | 0.00 | 2026-07-12 12:03:28 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-skvite--\.craft` | Yes | 0.00 | 2026-07-11 19:50:32 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-tbg5np--\.craft` | Yes | 0.00 | 2026-07-11 16:36:14 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-utrrze--\.craft` | Yes | 0.00 | 2026-07-11 19:50:31 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-wickik--\.craft` | Yes | 0.00 | 2026-07-12 11:58:35 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-yqafwz--\.craft` | Yes | 0.00 | 2026-07-11 16:36:14 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-9u3oyd--\.craft` | Yes | 0.00 | 2026-07-13 19:49:04 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-edshsi--\.craft` | Yes | 0.00 | 2026-07-11 16:36:14 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-fn0rob--\.craft` | Yes | 0.00 | 2026-07-11 21:48:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-jn3myz--\.craft` | Yes | 0.00 | 2026-07-12 11:58:35 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-jpjio7--\.craft` | Yes | 0.00 | 2026-07-12 14:30:09 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-o3xmrc--\.craft` | Yes | 0.00 | 2026-07-12 16:50:49 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-p3mx7q--\.craft` | Yes | 0.00 | 2026-07-11 16:36:14 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-oauth-refresh-P8BEIy--\.craft` | Yes | 0.00 | 2026-07-03 21:32:57 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-picmrd--\.craft` | Yes | 0.00 | 2026-07-12 16:50:49 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-pph8de--\.craft` | Yes | 0.00 | 2026-07-11 21:48:50 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-qnamzv--\.craft` | Yes | 0.00 | 2026-07-12 14:30:09 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-oauth-refresh-tY5eha--\.craft` | Yes | 0.00 | 2026-07-03 21:32:58 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-vlwfsl--\.craft` | Yes | 0.00 | 2026-07-13 19:49:04 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-ylszct--\.craft` | Yes | 0.00 | 2026-07-12 11:58:36 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workSpace-_Agents-craft-agent--\.craft` | Yes | 4.41 | 2026-07-18 21:02:26 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-.craft-agent-electron-dev-26323-workspaces-my-workspace--\.craft` | Yes | 0.45 | 2026-07-12 02:55:05 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-.craft-agent-webui-26321-workspaces-test--\.craft` | Yes | 0.00 | 2026-07-12 02:50:47 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-.craft-agent-webui-26323-workspaces-picker-smoke--\.craft` | Yes | 0.00 | 2026-07-12 19:11:02 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-packages-server-core--\.craft` | Yes | 0.00 | 2026-07-12 11:58:33 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workSpace-_Agents-pi--\.craft` | Yes | 1.76 | 2026-07-14 00:59:46 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--_workSpace-_chat--\.craft` | Yes | 1.03 | 2026-07-18 03:27:39 +08:00 | Legacy session sidecar | Confirmation required before cleanup |
| `C:\Users\32858\.pi\agent\sessions\--E--tmp-pi-native-transcript-test--\.craft` | Yes | 0.00 | 2026-07-12 15:52:56 +08:00 | Legacy session sidecar | Confirmation required before cleanup |

## Appendix B - Temporary `craft*` Directories

Enumerated directories: 162. Total: 910.38 MiB.

| Exact absolute path | Exists | Size (MiB) | Last write | Category | Decision |
|---|:---:|---:|---|---|---|
| `C:\Users\32858\AppData\Local\Temp\craft-agent-backend-research-20260718` | Yes | 899.32 | 2026-07-18 13:26:51 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-1KiW9j` | Yes | 0.00 | 2026-07-18 14:58:47 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-1OPVUD` | Yes | 0.00 | 2026-07-18 14:19:34 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-2mnfle` | Yes | 0.00 | 2026-07-18 14:58:56 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-7xklyb` | Yes | 0.00 | 2026-07-18 14:19:41 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-8LfFxT` | Yes | 0.00 | 2026-07-18 10:34:34 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-b0fdtI` | Yes | 0.00 | 2026-07-18 14:58:55 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-bGSbKI` | Yes | 0.00 | 2026-07-18 14:19:35 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-BKfkh4` | Yes | 0.00 | 2026-07-18 14:58:54 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-c8mpEd` | Yes | 0.00 | 2026-07-18 14:19:37 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-cSDK76` | Yes | 0.00 | 2026-07-18 14:31:45 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-E9mjXl` | Yes | 0.00 | 2026-07-18 10:34:33 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-FjiIDa` | Yes | 0.00 | 2026-07-18 10:34:32 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-fJPSNb` | Yes | 0.00 | 2026-07-18 10:34:29 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-HRZfWd` | Yes | 0.00 | 2026-07-18 14:31:43 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-IasjRZ` | Yes | 0.00 | 2026-07-18 14:31:47 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-jCeq1n` | Yes | 0.00 | 2026-07-18 10:34:27 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-JCQqo1` | Yes | 0.00 | 2026-07-18 10:34:35 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-KLmdrp` | Yes | 0.00 | 2026-07-18 14:19:39 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-ksZAb1` | Yes | 0.00 | 2026-07-18 10:34:28 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-lYtxRo` | Yes | 0.00 | 2026-07-18 14:31:48 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-p3XJKW` | Yes | 0.00 | 2026-07-18 14:31:49 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-S6tDmi` | Yes | 0.00 | 2026-07-18 14:19:43 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-t3JUuA` | Yes | 0.00 | 2026-07-18 14:31:40 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-TS2uTA` | Yes | 0.00 | 2026-07-18 14:19:40 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-vOZT4O` | Yes | 0.00 | 2026-07-18 14:58:48 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-vyaeI3` | Yes | 0.00 | 2026-07-18 14:31:41 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-wAgNpu` | Yes | 0.00 | 2026-07-18 14:58:50 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-config-thinking-Ww12gt` | Yes | 0.00 | 2026-07-18 14:58:52 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-4scEgL` | Yes | 0.06 | 2026-07-18 14:58:43 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-5H2uAv` | Yes | 0.06 | 2026-07-18 14:58:44 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-8h9kvQ` | Yes | 0.00 | 2026-07-18 10:34:25 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-CQHY5T` | Yes | 0.06 | 2026-07-18 14:19:30 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-DkEMjj` | Yes | 0.06 | 2026-07-18 14:19:34 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-HBIupj` | Yes | 0.06 | 2026-07-18 14:19:32 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-jZAcCI` | Yes | 0.00 | 2026-07-18 10:34:24 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-mF15bF` | Yes | 0.06 | 2026-07-18 14:31:37 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-o383RF` | Yes | 0.00 | 2026-07-18 10:34:19 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-sB9FBf` | Yes | 0.06 | 2026-07-18 14:31:40 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-V8odG6` | Yes | 0.06 | 2026-07-18 14:31:38 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-data-sources-xVT8pH` | Yes | 0.06 | 2026-07-18 14:58:47 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-01PjIl` | Yes | 0.06 | 2026-07-18 14:59:57 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-0MmNPE` | Yes | 0.00 | 2026-07-18 14:18:58 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-169G54` | Yes | 0.00 | 2026-07-18 10:35:19 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-2XxEIl` | Yes | 0.06 | 2026-07-18 14:24:27 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-2YTuhL` | Yes | 0.00 | 2026-07-18 10:35:12 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-3CKEnx` | Yes | 0.00 | 2026-07-18 14:18:55 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-3esLQD` | Yes | 0.00 | 2026-07-18 14:20:26 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-3sNqB7` | Yes | 0.00 | 2026-07-18 10:35:23 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-40mGiW` | Yes | 0.00 | 2026-07-18 14:19:09 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-4ekel5` | Yes | 0.00 | 2026-07-18 14:20:31 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-55yQNm` | Yes | 0.00 | 2026-07-18 14:20:16 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-5sW7Bl` | Yes | 0.06 | 2026-07-18 14:59:48 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-9JpjCG` | Yes | 0.06 | 2026-07-18 14:24:43 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-9pscGx` | Yes | 0.00 | 2026-07-18 14:18:51 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-aGM4uM` | Yes | 0.00 | 2026-07-18 10:35:04 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Aim18W` | Yes | 0.00 | 2026-07-18 14:20:22 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Ato9JG` | Yes | 0.00 | 2026-07-18 10:35:09 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-b3OZBI` | Yes | 0.00 | 2026-07-18 14:20:29 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-bBTidA` | Yes | 0.06 | 2026-07-18 14:24:45 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-bOFziN` | Yes | 0.06 | 2026-07-18 14:24:32 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-CmFTlo` | Yes | 0.06 | 2026-07-18 14:24:37 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-dfR9CK` | Yes | 0.00 | 2026-07-18 14:19:15 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-dKX5zH` | Yes | 0.06 | 2026-07-18 14:32:29 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Dp2G36` | Yes | 0.06 | 2026-07-18 14:59:42 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-e4xSfF` | Yes | 0.06 | 2026-07-18 14:24:42 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ED1YYP` | Yes | 0.00 | 2026-07-18 14:20:30 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-eGA3TD` | Yes | 0.00 | 2026-07-18 14:20:24 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-eLhP5K` | Yes | 0.00 | 2026-07-18 14:19:04 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ExYfSO` | Yes | 0.06 | 2026-07-18 14:24:44 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-f0kJua` | Yes | 0.06 | 2026-07-18 14:59:36 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Ftc1gf` | Yes | 0.00 | 2026-07-18 14:20:33 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-g3WWju` | Yes | 0.06 | 2026-07-18 14:32:48 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Gd6pOg` | Yes | 0.06 | 2026-07-18 14:59:44 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-GDa3Ba` | Yes | 0.00 | 2026-07-18 10:35:26 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-GM09vx` | Yes | 0.00 | 2026-07-18 14:20:09 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-hfUu38` | Yes | 0.00 | 2026-07-18 14:19:13 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ih8sH6` | Yes | 0.00 | 2026-07-18 14:19:01 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-iNtIx7` | Yes | 0.06 | 2026-07-18 14:32:44 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-IoEDPA` | Yes | 0.00 | 2026-07-18 10:35:17 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Kax23T` | Yes | 0.00 | 2026-07-18 14:20:11 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-kEDCqy` | Yes | 0.00 | 2026-07-18 14:20:19 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-kjjIXQ` | Yes | 0.06 | 2026-07-18 14:32:33 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-kTRSHE` | Yes | 0.00 | 2026-07-18 10:35:16 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-kTto9r` | Yes | 0.06 | 2026-07-18 14:32:34 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-lJFfw1` | Yes | 0.06 | 2026-07-18 14:59:29 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-MGIhU7` | Yes | 0.06 | 2026-07-18 14:59:32 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ngPUmd` | Yes | 0.06 | 2026-07-18 14:59:47 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-NSMpyY` | Yes | 0.00 | 2026-07-18 10:35:22 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-nyDKeo` | Yes | 0.00 | 2026-07-18 14:19:12 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-O2XvMY` | Yes | 0.06 | 2026-07-18 14:32:40 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-odLHrw` | Yes | 0.06 | 2026-07-18 14:24:47 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-OQutes` | Yes | 0.00 | 2026-07-18 10:35:24 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-OUsPBq` | Yes | 0.00 | 2026-07-18 10:35:02 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-p5fGHA` | Yes | 0.06 | 2026-07-18 14:24:51 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-PuB3gp` | Yes | 0.06 | 2026-07-18 14:32:41 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-q039ik` | Yes | 0.00 | 2026-07-18 14:20:28 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-q6FwGh` | Yes | 0.06 | 2026-07-18 14:32:21 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-QQQC1m` | Yes | 0.06 | 2026-07-18 14:32:39 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-SCgYgA` | Yes | 0.00 | 2026-07-18 14:19:10 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-sl7vj2` | Yes | 0.06 | 2026-07-18 14:32:26 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-sw4wLt` | Yes | 0.00 | 2026-07-18 14:19:06 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-TAoXpE` | Yes | 0.06 | 2026-07-18 14:24:29 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-Tcy2ww` | Yes | 0.00 | 2026-07-18 10:35:07 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-TroqgT` | Yes | 0.06 | 2026-07-18 14:32:24 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-UbSPLy` | Yes | 0.06 | 2026-07-18 14:32:36 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-udwTsl` | Yes | 0.00 | 2026-07-18 14:18:48 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-utLjnh` | Yes | 0.06 | 2026-07-18 14:32:42 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-v0cxqX` | Yes | 0.00 | 2026-07-18 10:35:20 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-VlW9Xg` | Yes | 0.06 | 2026-07-18 14:59:50 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-vq2UKS` | Yes | 0.00 | 2026-07-18 14:20:14 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-w0qv5X` | Yes | 0.06 | 2026-07-18 14:24:35 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-wOj7fc` | Yes | 0.06 | 2026-07-18 14:59:41 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-xeFa8b` | Yes | 0.06 | 2026-07-18 14:24:24 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-XSQhkh` | Yes | 0.06 | 2026-07-18 14:59:34 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ZEFoZN` | Yes | 0.06 | 2026-07-18 14:24:39 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ZJZqsl` | Yes | 0.06 | 2026-07-18 14:59:52 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ZvSVU8` | Yes | 0.00 | 2026-07-18 14:19:08 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-drafts-ZWu7Kk` | Yes | 0.06 | 2026-07-18 14:59:51 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-agent-webui` | Yes | 0.04 | 2026-07-16 03:29:51 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-packaged-smoke-6024253979184e92b91f0949c48cbccb` | Yes | 0.99 | 2026-07-18 15:20:18 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-packaged-smoke-ac490c63d16f4511a077de48ec074107` | Yes | 5.35 | 2026-07-18 15:21:42 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-packaging-audit-unpacked` | Yes | 0.74 | 2026-07-18 15:52:52 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-050LS2` | Yes | 0.00 | 2026-07-18 10:34:38 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-07KpWa` | Yes | 0.00 | 2026-07-18 14:31:55 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-2cPyJC` | Yes | 0.00 | 2026-07-18 10:34:39 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-2WRirH` | Yes | 0.00 | 2026-07-18 17:03:35 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-43nx5S` | Yes | 0.00 | 2026-07-18 17:03:30 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-47RryU` | Yes | 0.00 | 2026-07-18 17:45:34 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-5DIXPd` | Yes | 0.00 | 2026-07-18 14:19:46 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-BmNefM` | Yes | 0.00 | 2026-07-18 14:19:45 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-C2onzV` | Yes | 0.00 | 2026-07-18 17:59:54 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-dEY7S9` | Yes | 0.00 | 2026-07-18 18:00:02 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-dH6kVE` | Yes | 0.00 | 2026-07-18 14:19:47 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-EEAy1q` | Yes | 0.00 | 2026-07-18 17:03:37 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-HU4YWL` | Yes | 0.00 | 2026-07-18 14:31:57 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-IBQmOF` | Yes | 0.00 | 2026-07-18 18:00:04 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-ilRi1p` | Yes | 0.00 | 2026-07-18 14:59:04 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-nX9H2R` | Yes | 0.00 | 2026-07-18 14:31:56 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-oUBMrB` | Yes | 0.00 | 2026-07-18 17:45:41 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-pG881X` | Yes | 0.00 | 2026-07-18 14:59:03 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-Puq7Fe` | Yes | 0.00 | 2026-07-18 10:34:40 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-RxX9ij` | Yes | 0.00 | 2026-07-18 17:03:33 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-SWgxsQ` | Yes | 0.00 | 2026-07-18 14:59:02 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-tTTkHA` | Yes | 0.00 | 2026-07-18 18:00:01 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-UFqm8F` | Yes | 0.00 | 2026-07-18 17:59:59 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-vtFMk2` | Yes | 0.00 | 2026-07-18 17:45:37 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-pi-agent-wCvqoW` | Yes | 0.00 | 2026-07-18 17:45:39 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provenance-ledger-e5e29f39e805426eacdfa97f0a715061.git` | Yes | 0.21 | 2026-07-17 11:03:55 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-0byBNE` | Yes | 0.06 | 2026-07-18 14:59:24 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-1u9dT6` | Yes | 0.06 | 2026-07-18 14:32:17 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-duNH0Z` | Yes | 0.06 | 2026-07-18 14:59:28 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-Ec3Krz` | Yes | 0.07 | 2026-07-18 14:20:08 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-f0NnEI` | Yes | 0.00 | 2026-07-18 10:35:00 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-hCbiMW` | Yes | 0.07 | 2026-07-18 14:59:26 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-hTs4AD` | Yes | 0.00 | 2026-07-18 10:34:59 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-LkoUtQ` | Yes | 0.06 | 2026-07-18 14:32:20 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-qs6PhD` | Yes | 0.07 | 2026-07-18 14:32:18 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-r6PBaR` | Yes | 0.00 | 2026-07-18 10:35:02 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-rQKTYK` | Yes | 0.06 | 2026-07-18 14:20:09 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-provider-migration-YAZSuU` | Yes | 0.06 | 2026-07-18 14:20:06 +08:00 | Temporary Craft directory | Confirmation required before cleanup |
| `C:\Users\32858\AppData\Local\Temp\craft-server-registry-dc0Zm0` | Yes | 0.00 | 2026-07-18 14:53:22 +08:00 | Temporary Craft directory | Confirmation required before cleanup |

## Confirmation Record

- Confirmation: **not provided**
- Approved exact paths: **none**
- Deletion performed: **no**
- Required next step: re-scan all candidates, produce a new dated manifest if metadata changed, and request explicit confirmation.
