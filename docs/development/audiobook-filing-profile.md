# Audiobook filing profile (#1794)

Measured on Windows with Node v24.11.1 on 2026-11-02, with 26.4–26.7 GiB free.
Thirty cuts total per workload, either one chapter reader or three concurrent chapter readers
(ten cuts each), using real generated-artifact filing, measurement persistence and per-cut
audiobook record updates. Added artifacts have valid sidecars and tiny synthetic media; the
largest case adds about 7,500 files. No private manuscript or paid provider is used.

Provider synthesis and transcription are stubbed at 0 ms; media probing returns a fixed result
and rounds to 0 ms. These are storage profiles, not end-to-end narration latency measurements.
Background load was not controlled: some runs overlapped local validation/another profile, so
elapsed differences should not be treated as an isolated speedup estimate. In particular the
500-artifact/three-reader baseline was heavily affected. Scan counts are deterministic.

| Added artifacts | Readers | Elapsed s, before → after | Full scans | Scan time s | Filing time s | Record write time s |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 19.9 → 11.0 | 150 → 90 | 12.1 → 5.9 | 16.5 → 8.6 | 3.4 → 2.4 |
| 0 | 3 | 24.3 → 10.3 | 150 → 90 | 12.9 → 5.4 | 54.9 → 22.4 | 17.7 → 8.3 |
| 500 | 1 | 33.8 → 14.1 | 150 → 90 | 24.3 → 9.1 | 28.5 → 10.7 | 5.3 → 3.4 |
| 500 | 3 | 93.4 → 20.9 | 150 → 90 | 61.4 → 13.5 | 204.1 → 41.9 | 75.8 → 20.5 |
| 3750 | 1 | 60.3 → 38.7 | 150 → 90 | 54.7 → 33.3 | 48.8 → 27.3 | 11.5 → 11.4 |
| 3750 | 3 | 55.6 → 44.5 | 150 → 90 | 50.6 → 38.4 | 117.2 → 90.7 | 47.4 → 41.4 |

Filing and record times sum each reader's elapsed calls, including queue wait; with three readers
they overlap and must not be added to wall time. Scan time is a subset of those operations.

The original path scans five times per cut: sidecar commit + enclosing gate, measurement commit
+ enclosing gate, then the audiobook record. The fix reuses the completed final commit's refresh
for the two explicitly opted-in artifact paths: three scans per cut, 40% fewer. Each commit still
checks ownership, flushes its journal and refreshes bundle/history/index/scan state. Failed or
no-commit paths still rescan. Chapter record updates retain merge-from-current serialization and
per-cut persistence; no chapter-sized memory buffer or weakened spend boundary is introduced.

The original reported 40–60-second saved-block gaps also included provider/transcription, low
free space and contention. This experiment identifies and removes redundant work; it does not
attribute all of that live delay to scanning.

## Rerun for issue 2781 (2026-11-08)

Same script, `optimized` mode, Windows, Node v24.11.1, 22–24 GiB free. The profile files a real
16-bit PCM WAV, which is now measured from its header at filing: the sidecar is written with its
`mediaInfo`, so the probe and the second (measurement) commit are skipped. Each cut is now two
full scans: the filing commit and the audiobook record. Background load was again not controlled
(local tests and a type-check overlapped parts of both runs), so read elapsed as indicative; the
scan counts are deterministic.

| Added artifacts | Readers | Elapsed s, before → after | Full scans | Scan time s | Filing time s | Record write time s |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 29.2 → 5.9 | 90 → 60 | 13.4 → 4.3 | 23.7 → 3.5 | 5.6 → 2.4 |
| 0 | 3 | 25.7 → 5.5 | 90 → 60 | 11.8 → 3.9 | 60.6 → 8.6 | 16.1 → 7.7 |
| 500 | 1 | 15.1 → 8.0 | 90 → 60 | 11.7 → 6.4 | 11.1 → 4.6 | 4.1 → 3.4 |
| 500 | 3 | 15.1 → 8.3 | 90 → 60 | 11.0 → 6.6 | 31.1 → 12.9 | 13.8 → 11.7 |
| 3750 | 1 | 42.9 → 26.4 | 90 → 60 | 38.7 → 24.6 | 29.4 → 13.9 | 13.6 → 12.5 |
| 3750 | 3 | 38.0 → 26.0 | 90 → 60 | 35.0 → 24.2 | 76.3 → 38.2 | 36.7 → 38.5 |

A take in any other format, or a WAV this cannot read as 16-bit PCM, is still probed and measured
in its own commit: three scans, as before.

### Re-landed for issue 2794 (2026-11-09)

#2840 reverted the header measurement because tests filed tiny WAVs and told a stub probe the
duration they meant; #2838 then made those fixtures as long as they claim, and this is the same
change again. Same mode, 7.5 GiB free, with the scan cache (#2793) on main:

| Added artifacts | Readers | Elapsed s | Full scans | Scan time s | Filing time s | Record write time s |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 6.9 | 60 | 4.8 | 4.2 | 2.7 |
| 0 | 3 | 6.9 | 60 | 4.8 | 10.7 | 9.7 |
| 500 | 1 | 8.9 | 60 | 6.5 | 5.3 | 3.6 |
| 500 | 3 | 7.9 | 60 | 5.8 | 12.5 | 11.0 |
| 3750 | 1 | 19.6 | 60 | 15.7 | 11.7 | 8.0 |
| 3750 | 3 | 37.5 | 60 | 27.7 | 54.3 | 57.3 |

A cached scan still lists and stats the whole world, about 260 ms at 3,750 artifacts, so the
record write's own scan remains half of each cut's.

### One gate a block (issue 2794, 2026-11-09)

The run now files a take and writes the record that names it in one gate operation: the sidecar's
commit leaves its refresh to the gate's closing scan, and a take its header cannot measure is
probed before the gate. `one-gate` mode profiles that path; 6.7 GiB free:

| Added artifacts | Readers | Elapsed s, two scans → one | Full scans | Scan time s | Filing and record time s |
|---:|---:|---:|---:|---:|---:|
| 0 | 1 | 6.9 → 3.5 | 60 → 30 | 4.8 → 1.8 | 6.9 → 3.5 |
| 0 | 3 | 6.9 → 3.5 | 60 → 30 | 4.8 → 1.8 | 20.4 → 10.0 |
| 500 | 1 | 8.9 → 4.2 | 60 → 30 | 6.5 → 2.4 | 8.9 → 4.2 |
| 500 | 3 | 7.9 → 3.7 | 60 → 30 | 5.8 → 2.1 | 23.5 → 10.7 |
| 3750 | 1 | 19.6 → 8.7 | 60 → 30 | 15.7 → 6.7 | 19.7 → 8.7 |
| 3750 | 3 | 37.5 → 9.2 | 60 → 30 | 27.7 → 7.3 | 111.6 → 26.7 |

The order is unchanged: the take is on the shelf before the record names it, so a failure between
the two leaves a filed take for the next run to adopt.

## Reproduce

Run from the repository root:

```powershell
node --import tsx packages/coordinator/scripts/profile-audiobook-filing.ts baseline
node --import tsx packages/coordinator/scripts/profile-audiobook-filing.ts optimized
node --import tsx packages/coordinator/scripts/profile-audiobook-filing.ts one-gate
```

Optional second argument overrides added artifact counts (for example `0,500,3750`). Baseline
mode disables only the two final-commit refresh opt-ins. Each row is JSON on stdout. The script
uses disposable worlds and closes them before removing its own verified temporary root.

Regression coverage checks three scans for filing/measurement/checkpoint (two for a 16-bit PCM WAV), saved identity after
reopen, no duplicate landed artifact, normal/failure/no-commit/precondition scan behavior, close
drain and ownership. Existing audiobook tests cover interrupted work, restoring missing media,
landed-result adoption, second-press reuse and direction edits concurrent with a read.
