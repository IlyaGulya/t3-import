# Browser review of imports

Use a fresh isolated T3 home, disabled providers, copied stable native histories and the actual T3 server. Import and repeat the same selection, run the full server audit, then open a dedicated browser tab. Never run a new model turn to test historical presentation. Keep the exact importer version, pinned T3 commit, source IDs, audit result and server version with the review.

## Repeatable matrix

For each adapter, exercise an early, middle and final response and a response crossing a compaction boundary. Include a large family and each supported model switch, interruption and attachment kind. Mark unavailable cases explicitly rather than passing them.

| Check             | Required observation                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| History           | Load older turns and use thread find to reach a known early message; text and role agree with native evidence.                                                            |
| Work folds        | Expand and collapse Worked/Continued. Each advertised segment reveals its own work; steers do not create an empty first segment.                                          |
| Tools             | Open a command and generic tool result, including a long hydrated body; copy/select text and confirm content is present.                                                  |
| File changes      | Expand a diff and verify old/new direction. Missing current files are recorded separately from missing historical patches.                                                |
| Children          | Navigate from a launch card to its child and back. Cards belong beside their proven launches, not in an orphan group or after a final reply. Fork snapshots remain forks. |
| Models and timing | Observe native model sections and terminal response duration. Idle model changes, notices and compaction do not add days to work time.                                    |
| Interrupted reply | Partial assistant text keeps assistant styling and interrupted state; abort markers are not new user requests or generic orange notices.                                  |
| Compaction        | Open native compaction cards; earlier available history remains reachable and summaries are not duplicated as fresh user turns.                                           |
| Attachments       | Open an available captured image; distinguish missing source bytes, retained references and unsupported presentation.                                                     |
| Repeat import     | Confirm `already-imported`, then reload the browser and verify no duplicate messages/cards.                                                                               |

Capture screenshots after actual interactions at desktop and a narrower viewport. Check wrapping, overlap, horizontal overflow, labels, empty segments and clickable targets. REST/count assertions support the review but cannot replace these interactions.

## Classify a finding

Record adapter, source and target IDs, exact route, reproducible actions, expected versus actual behavior, severity and screenshot path. Do not include access credentials or full private transcripts in shareable reports.

- Import defect: native evidence exists but is absent, assigned a wrong role, moved to the wrong run, duplicated or linked incorrectly. Add a failing regression at native history → CLI → real T3, fix one case, and rerun the browser reproduction.
- Source limitation: the native reader cannot supply erased records, an anchor, a historical model or an attachment's bytes. Require an explicit diagnostic; do not manufacture history.
- External workspace: a historical path no longer exists or the project moved. Do not silently map it to today's file. Optional recorded workspaces must be labelled partial.
- T3 presentation limitation: data survives in native projections/metadata but the pinned UI cannot expose it. Document the exact unsupported field and retain its payload.
- Review gap: a case was not reached or the environment was unavailable. Mark it unverified, with the reason.

## Independent agent pass

A UI reviewer may use its own browser tab against the same isolated server, with no source/database edits and no model turns. Give it the matrix and known external limitations, then require concrete interactions and repro steps. A Luna pass is useful for discovering presentation problems, but it is not deterministic or exhaustive; retain the audit and behavioral regressions as the repeatable gate. Recheck genuine findings after fixes rather than accepting a report based only on element counts.
