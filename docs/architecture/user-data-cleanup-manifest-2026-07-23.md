# User Data Cleanup Manifest - 2026-07-23

This is the exact pre-deletion inventory captured at 2026-07-23 10:53:44 +08:00 and the resulting deletion record. It authorized no deletion until the user explicitly confirmed the sets below. File contents were not inspected during inventory.

## Summary

| Set | Count | Bytes | MiB | Status |
|---|---:|---:|---:|---|
| Fixed former Craft directories | 6 | 813771426 | 776.07 | Confirmation required |
| Legacy .craft sidecars | 129 | 8078665 | 7.70 | Confirmation required |
| Current craft* temporary directories | 0 | 0 | 0.00 | Nothing to delete |
| **Total eligible** | **135** | **821850091** | **783.78** | **Confirmation required** |

All 129 sidecars are contained beneath C:\Users\32858\.pi\agent\sessions, and none is a reparse point. No Craft, Mortise, or Electron runtime process was active during the occupancy check; the only textual process match was the inspection command itself.

Frozen path-list SHA-256 (six fixed paths in table order followed by 129 sidecars sorted by absolute path, UTF-8, LF-separated): `be1518e6dbf2a766a426546cb4f49026742586aa8e3b4a72bc4990ccc595f8f6`.

Environment overrides at capture time: `MORTISE_CONFIG_DIR` unset; `PI_CODING_AGENT_DIR` unset.

## Fixed Former Craft Directories

| Absolute path | Bytes | MiB | Last write |
|---|---:|---:|---|
| C:\Users\32858\.craft-agent | 67519389 | 64.39 | 2026-07-19 18:33:30 +08:00 |
| C:\Users\32858\.mortise-migration-backups | 206708303 | 197.13 | 2026-07-19 18:47:54 +08:00 |
| C:\Users\32858\AppData\Roaming\@craft-agent | 43467952 | 41.45 | 2026-07-18 15:32:39 +08:00 |
| C:\Users\32858\AppData\Roaming\craft-agent | 29167 | 0.03 | 2026-07-09 11:00:19 +08:00 |
| C:\Users\32858\AppData\Roaming\Craft Agents | 46049942 | 43.92 | 2026-07-18 21:10:08 +08:00 |
| C:\Users\32858\AppData\Local\@craft-agentelectron-updater | 449996673 | 429.15 | 2026-07-02 16:17:09 +08:00 |

## Active Paths - Do Not Delete

- C:\Users\32858\.mortise
- C:\Users\32858\.pi
- C:\Users\32858\AppData\Roaming\@mortise
- C:\Users\32858\AppData\Roaming\mortise
- C:\Users\32858\AppData\Local\@mortiseelectron-updater
- C:\Users\32858\AppData\Local\Mortise\Developer Kit
- E:\_workSpace\_Agents\craft-agent\.mortise
- E:\_workSpace\_Agents\craft-agent\.pi

Only the exact .craft directories in the appendix are eligible within C:\Users\32858\.pi; the .pi directory and all sibling session data are protected.

## Appendix A - Exact Legacy Sidecars

| # | Absolute path | Bytes | MiB | Last write |
|---:|---|---:|---:|---|
| 1 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-.craft-agent-workspaces-my-workspace--\.craft | 0 | 0.00 | 2026-07-08 02:45:39 +08:00 |
| 2 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-craft-store-attachment-jljnzz-workspace--\.craft | 0 | 0.00 | 2026-07-06 13:50:50 +08:00 |
| 3 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-pending-plan-test-1783073755305-1d5vriqdc7v--\.craft | 0 | 0.00 | 2026-07-03 18:15:55 +08:00 |
| 4 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659222966-2by7v1wzph2--\.craft | 0 | 0.00 | 2026-07-10 12:53:42 +08:00 |
| 5 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659444471-t7i31ztpwlf--\.craft | 0 | 0.00 | 2026-07-10 12:57:24 +08:00 |
| 6 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659444701-8l0m3ld6qio--\.craft | 0 | 0.00 | 2026-07-10 12:57:24 +08:00 |
| 7 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783659444820-p0b5b90yfg--\.craft | 0 | 0.00 | 2026-07-10 12:57:24 +08:00 |
| 8 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783661868684-zkxf8m834np--\.craft | 0 | 0.00 | 2026-07-10 13:37:48 +08:00 |
| 9 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783661869105-8qomjkaavid--\.craft | 0 | 0.00 | 2026-07-10 13:37:49 +08:00 |
| 10 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783661869318-ebmg661g3p6--\.craft | 0 | 0.00 | 2026-07-10 13:37:49 +08:00 |
| 11 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663438702-yxpn8o3dc5--\.craft | 0 | 0.00 | 2026-07-10 14:03:58 +08:00 |
| 12 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663439034-5txmm6rn32u--\.craft | 0 | 0.00 | 2026-07-10 14:03:59 +08:00 |
| 13 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663439193-7xpjx1x9pdw--\.craft | 0 | 0.00 | 2026-07-10 14:03:59 +08:00 |
| 14 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663460650-e2dr0tumj65--\.craft | 0 | 0.00 | 2026-07-10 14:04:20 +08:00 |
| 15 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663460979-wl0hxtdfyb9--\.craft | 0 | 0.00 | 2026-07-10 14:04:20 +08:00 |
| 16 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783663461185-f96ltbmd978--\.craft | 0 | 0.00 | 2026-07-10 14:04:21 +08:00 |
| 17 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783759146893-a8zhxs0pcv--\.craft | 0 | 0.00 | 2026-07-11 16:39:06 +08:00 |
| 18 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783759147096-l6u0tj9kx3o--\.craft | 0 | 0.00 | 2026-07-11 16:39:07 +08:00 |
| 19 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783759147203-3f5nz8j431w--\.craft | 0 | 0.00 | 2026-07-11 16:39:07 +08:00 |
| 20 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783828893477-ttokia3jt3l--\.craft | 0 | 0.00 | 2026-07-12 12:01:33 +08:00 |
| 21 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783828893727-ki4kfon99la--\.craft | 0 | 0.00 | 2026-07-12 12:01:33 +08:00 |
| 22 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783828893899-4m7sbjw6j02--\.craft | 0 | 0.00 | 2026-07-12 12:01:33 +08:00 |
| 23 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837356844-7h0xnveytf3--\.craft | 0 | 0.00 | 2026-07-12 14:22:36 +08:00 |
| 24 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837357066-8gpdmf9j5rs--\.craft | 0 | 0.00 | 2026-07-12 14:22:37 +08:00 |
| 25 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837357181-ea637brr0tu--\.craft | 0 | 0.00 | 2026-07-12 14:22:37 +08:00 |
| 26 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837979426-ubhh7ul7t6--\.craft | 0 | 0.00 | 2026-07-12 14:32:59 +08:00 |
| 27 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837979636-vqls5n1udsq--\.craft | 0 | 0.00 | 2026-07-12 14:32:59 +08:00 |
| 28 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783837979767-x9fwcxcdavg--\.craft | 0 | 0.00 | 2026-07-12 14:32:59 +08:00 |
| 29 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783846401631-g3z3k4i1dy9--\.craft | 0 | 0.00 | 2026-07-12 16:53:21 +08:00 |
| 30 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783846401866-2uvv9iris4i--\.craft | 0 | 0.00 | 2026-07-12 16:53:21 +08:00 |
| 31 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pending-plan-test-1783846401983-ttsbiowfpjt--\.craft | 0 | 0.00 | 2026-07-12 16:53:21 +08:00 |
| 32 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-persistence-queue-test-1783085536079--\.craft | 0 | 0.00 | 2026-07-03 21:32:31 +08:00 |
| 33 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-persistence-queue-test-1783085552239--\.craft | 0 | 0.00 | 2026-07-03 21:32:32 +08:00 |
| 34 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-persistence-queue-test-1783758896903--\.craft | 0 | 0.00 | 2026-07-11 16:35:27 +08:00 |
| 35 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-persistence-queue-test-1783828618649--\.craft | 0 | 0.00 | 2026-07-12 11:57:29 +08:00 |
| 36 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-persistence-queue-test-1783829036181--\.craft | 0 | 0.00 | 2026-07-12 12:04:26 +08:00 |
| 37 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-4mwyhc--\.craft | 665 | 0.00 | 2026-07-11 20:44:54 +08:00 |
| 38 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-62dstk--\.craft | 4948 | 0.00 | 2026-07-12 14:13:31 +08:00 |
| 39 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-7wt2wa--\.craft | 665 | 0.00 | 2026-07-11 20:12:07 +08:00 |
| 40 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-bvjhkl--\.craft | 4948 | 0.00 | 2026-07-12 11:58:34 +08:00 |
| 41 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-crdrgy--\.craft | 665 | 0.00 | 2026-07-12 14:13:31 +08:00 |
| 42 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-fjjwfr--\.craft | 665 | 0.00 | 2026-07-12 13:43:58 +08:00 |
| 43 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-fre0sw--\.craft | 4557 | 0.00 | 2026-07-11 18:01:34 +08:00 |
| 44 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-qhe7pp--\.craft | 4948 | 0.00 | 2026-07-11 20:12:07 +08:00 |
| 45 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-r2r8tk--\.craft | 665 | 0.00 | 2026-07-12 11:58:34 +08:00 |
| 46 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-rl9ppl--\.craft | 4948 | 0.00 | 2026-07-11 21:48:49 +08:00 |
| 47 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-rugrvy--\.craft | 665 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 48 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-sdr7cj--\.craft | 620 | 0.00 | 2026-07-11 18:01:34 +08:00 |
| 49 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-so29cf--\.craft | 444 | 0.00 | 2026-07-11 16:47:12 +08:00 |
| 50 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-uj22wk--\.craft | 620 | 0.00 | 2026-07-11 16:48:54 +08:00 |
| 51 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-vl72b7--\.craft | 4948 | 0.00 | 2026-07-12 13:43:59 +08:00 |
| 52 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-vomcmz--\.craft | 4948 | 0.00 | 2026-07-11 20:44:54 +08:00 |
| 53 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-vtignk--\.craft | 665 | 0.00 | 2026-07-12 11:58:33 +08:00 |
| 54 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-pi-projection-persistence-w73q32--\.craft | 4948 | 0.00 | 2026-07-12 11:58:33 +08:00 |
| 55 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-43bCWi--\.craft | 0 | 0.00 | 2026-07-03 21:32:56 +08:00 |
| 56 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-6DeIg8--\.craft | 0 | 0.00 | 2026-07-03 21:32:55 +08:00 |
| 57 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-bemlha--\.craft | 0 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 58 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-e0l0p4--\.craft | 0 | 0.00 | 2026-07-11 16:36:12 +08:00 |
| 59 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-fauifq--\.craft | 0 | 0.00 | 2026-07-11 16:36:12 +08:00 |
| 60 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-GqgAfE--\.craft | 0 | 0.00 | 2026-07-03 21:32:55 +08:00 |
| 61 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-Gys41L--\.craft | 0 | 0.00 | 2026-07-03 21:32:55 +08:00 |
| 62 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-jeaxu7--\.craft | 0 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 63 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-jtwuvk--\.craft | 0 | 0.00 | 2026-07-11 16:36:13 +08:00 |
| 64 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-jxnyfn--\.craft | 0 | 0.00 | 2026-07-11 16:36:13 +08:00 |
| 65 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-nftm4w--\.craft | 0 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 66 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-okto0r--\.craft | 0 | 0.00 | 2026-07-11 16:36:13 +08:00 |
| 67 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-ptYCpy--\.craft | 0 | 0.00 | 2026-07-03 21:32:55 +08:00 |
| 68 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-qjqcjk--\.craft | 0 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 69 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-cold-meta-sJHuwn--\.craft | 0 | 0.00 | 2026-07-03 21:32:55 +08:00 |
| 70 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-smsfc8--\.craft | 0 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 71 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-x1khkh--\.craft | 207 | 0.00 | 2026-07-11 16:36:13 +08:00 |
| 72 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-cold-meta-xbsr7s--\.craft | 207 | 0.00 | 2026-07-11 21:48:48 +08:00 |
| 73 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-debug-410ugj--\.craft | 91 | 0.00 | 2026-07-08 23:30:54 +08:00 |
| 74 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-6lyfbz--\.craft | 0 | 0.00 | 2026-07-12 12:03:28 +08:00 |
| 75 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-6xooh9--\.craft | 135 | 0.00 | 2026-07-11 21:48:50 +08:00 |
| 76 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-7ell1u--\.craft | 117 | 0.00 | 2026-07-11 19:45:59 +08:00 |
| 77 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-8m7x0w--\.craft | 135 | 0.00 | 2026-07-11 16:36:14 +08:00 |
| 78 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-8sgit4--\.craft | 91 | 0.00 | 2026-07-08 11:25:10 +08:00 |
| 79 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-9jlhoh--\.craft | 91 | 0.00 | 2026-07-08 23:27:47 +08:00 |
| 80 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-a4b8ky--\.craft | 91 | 0.00 | 2026-07-08 23:27:47 +08:00 |
| 81 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-as0akb--\.craft | 135 | 0.00 | 2026-07-11 19:45:59 +08:00 |
| 82 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-bmakgo--\.craft | 0 | 0.00 | 2026-07-12 11:58:36 +08:00 |
| 83 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-c2i9yu--\.craft | 135 | 0.00 | 2026-07-11 19:50:31 +08:00 |
| 84 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-cuq2ta--\.craft | 152 | 0.00 | 2026-07-08 23:27:47 +08:00 |
| 85 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-dqyfcy--\.craft | 91 | 0.00 | 2026-07-08 23:33:50 +08:00 |
| 86 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-eligh8--\.craft | 152 | 0.00 | 2026-07-08 23:21:08 +08:00 |
| 87 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-eln3ew--\.craft | 91 | 0.00 | 2026-07-08 23:21:08 +08:00 |
| 88 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-fh5sln--\.craft | 0 | 0.00 | 2026-07-12 12:03:31 +08:00 |
| 89 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-ghpclu--\.craft | 91 | 0.00 | 2026-07-08 23:27:47 +08:00 |
| 90 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-durability-idNHLz--\.craft | 0 | 0.00 | 2026-07-03 21:32:56 +08:00 |
| 91 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-ijahpx--\.craft | 91 | 0.00 | 2026-07-08 23:21:08 +08:00 |
| 92 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-inisyv--\.craft | 0 | 0.00 | 2026-07-12 11:58:36 +08:00 |
| 93 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-iz125w--\.craft | 117 | 0.00 | 2026-07-11 21:48:50 +08:00 |
| 94 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-lepcgm--\.craft | 293 | 0.00 | 2026-07-12 14:20:11 +08:00 |
| 95 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-lvsned--\.craft | 91 | 0.00 | 2026-07-08 23:21:08 +08:00 |
| 96 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-lyhjkj--\.craft | 135 | 0.00 | 2026-07-11 21:48:50 +08:00 |
| 97 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-mmsxiz--\.craft | 152 | 0.00 | 2026-07-08 11:25:12 +08:00 |
| 98 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-n1ouxs--\.craft | 152 | 0.00 | 2026-07-08 11:57:08 +08:00 |
| 99 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-n8mbop--\.craft | 135 | 0.00 | 2026-07-11 19:45:59 +08:00 |
| 100 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-durability-NMBZFn--\.craft | 0 | 0.00 | 2026-07-03 21:32:57 +08:00 |
| 101 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-q4lo0p--\.craft | 91 | 0.00 | 2026-07-08 11:25:11 +08:00 |
| 102 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-r3mits--\.craft | 0 | 0.00 | 2026-07-12 12:03:28 +08:00 |
| 103 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-skvite--\.craft | 135 | 0.00 | 2026-07-11 19:50:32 +08:00 |
| 104 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-tbg5np--\.craft | 117 | 0.00 | 2026-07-11 16:36:14 +08:00 |
| 105 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-utrrze--\.craft | 117 | 0.00 | 2026-07-11 19:50:31 +08:00 |
| 106 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-wickik--\.craft | 0 | 0.00 | 2026-07-12 11:58:35 +08:00 |
| 107 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-durability-yqafwz--\.craft | 135 | 0.00 | 2026-07-11 16:36:14 +08:00 |
| 108 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-9u3oyd--\.craft | 442 | 0.00 | 2026-07-13 19:49:04 +08:00 |
| 109 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-edshsi--\.craft | 117 | 0.00 | 2026-07-11 16:36:14 +08:00 |
| 110 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-fn0rob--\.craft | 117 | 0.00 | 2026-07-11 21:48:50 +08:00 |
| 111 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-jn3myz--\.craft | 0 | 0.00 | 2026-07-12 11:58:35 +08:00 |
| 112 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-jpjio7--\.craft | 103 | 0.00 | 2026-07-12 14:30:09 +08:00 |
| 113 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-o3xmrc--\.craft | 390 | 0.00 | 2026-07-12 16:50:49 +08:00 |
| 114 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-p3mx7q--\.craft | 117 | 0.00 | 2026-07-11 16:36:14 +08:00 |
| 115 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-oauth-refresh-P8BEIy--\.craft | 0 | 0.00 | 2026-07-03 21:32:57 +08:00 |
| 116 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-picmrd--\.craft | 396 | 0.00 | 2026-07-12 16:50:49 +08:00 |
| 117 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-pph8de--\.craft | 117 | 0.00 | 2026-07-11 21:48:50 +08:00 |
| 118 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-qnamzv--\.craft | 107 | 0.00 | 2026-07-12 14:30:09 +08:00 |
| 119 | C:\Users\32858\.pi\agent\sessions\--C--Users-32858-AppData-Local-Temp-sm-oauth-refresh-tY5eha--\.craft | 0 | 0.00 | 2026-07-03 21:32:58 +08:00 |
| 120 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-vlwfsl--\.craft | 448 | 0.00 | 2026-07-13 19:49:04 +08:00 |
| 121 | C:\Users\32858\.pi\agent\sessions\--C--users-32858-appdata-local-temp-sm-oauth-refresh-ylszct--\.craft | 0 | 0.00 | 2026-07-12 11:58:36 +08:00 |
| 122 | C:\Users\32858\.pi\agent\sessions\--E--_workSpace-_Agents-craft-agent--\.craft | 4627885 | 4.41 | 2026-07-18 21:02:26 +08:00 |
| 123 | C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-.craft-agent-electron-dev-26323-workspaces-my-workspace--\.craft | 469339 | 0.45 | 2026-07-12 02:55:05 +08:00 |
| 124 | C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-.craft-agent-webui-26321-workspaces-test--\.craft | 1702 | 0.00 | 2026-07-12 02:50:47 +08:00 |
| 125 | C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-.craft-agent-webui-26323-workspaces-picker-smoke--\.craft | 1892 | 0.00 | 2026-07-12 19:11:02 +08:00 |
| 126 | C:\Users\32858\.pi\agent\sessions\--E--_workspace-_agents-craft-agent-packages-server-core--\.craft | 504 | 0.00 | 2026-07-12 11:58:33 +08:00 |
| 127 | C:\Users\32858\.pi\agent\sessions\--E--_workSpace-_Agents-pi--\.craft | 1846834 | 1.76 | 2026-07-14 00:59:46 +08:00 |
| 128 | C:\Users\32858\.pi\agent\sessions\--E--_workSpace-_chat--\.craft | 1076180 | 1.03 | 2026-07-18 03:27:39 +08:00 |
| 129 | C:\Users\32858\.pi\agent\sessions\--E--tmp-pi-native-transcript-test--\.craft | 2670 | 0.00 | 2026-07-12 15:52:56 +08:00 |

## Confirmation Record

- Confirmation: **provided**
- User confirmation text: `清理。另外pi的那些目录我觉得是不是可以统一成mortise`
- Confirmation scope: all 135 exact paths in this manifest
- Frozen path-list SHA-256: `be1518e6dbf2a766a426546cb4f49026742586aa8e3b4a72bc4990ccc595f8f6`
- Deletion completed: 2026-07-23 11:09:42 +08:00
- Deletion result: **135 succeeded, 0 failed**
- Bytes removed: **821850091 bytes (783.78 MiB)**
- Post-delete legacy sidecars: **0**
- Newly discovered unconfirmed sidecars: **0**
- Protected paths: **8 of 8 still exist**

The deletion consumed only the frozen manifest entries. It did not dynamically delete newly discovered paths, remove any session parent directory, or modify a protected Mortise/Pi root.
