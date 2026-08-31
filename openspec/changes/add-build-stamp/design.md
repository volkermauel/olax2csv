## Context

The app is a single static HTML file; the repo is the source of truth but
the Pages copy is what users run. A deploy-time substitution keeps the repo
clean (no churn from re-stamping on every commit) and makes local/`file://`
use honest: placeholders fail the SHA check, badge stays hidden.

## Goals / Non-Goals

Goal: every deployed copy carries its exact source commit + build time.
Non-goal: build info in downloaded CSV/XLSX outputs.

## Real-World Constraints

- The app must stay a single offline file — no runtime fetch of version info.
- `sed`-substitution in CI happens after tests ran on the clean file, so the
  tested artifact and the published one differ only in those two tokens.

## Proposal

Ship placeholders; stamp at deploy. The deploy job needs
`permissions: pages: write, id-token: write` and the `github-pages`
environment; artifact = the whole repo (single-file app). After the first
successful run, switch the Pages build_type to `workflow`.

## Migration Plan

1. Land this change (tests green on the placeholder artifact).
2. Push to main; confirm the deploy job succeeds.
3. `gh api -X PUT repos/volkermauel/olax2csv/pages -f build_type=workflow`.
4. Hard-refresh the Pages URL; commit hash + build time appear.

## Risks / Trade-offs

- Stamped artifact is not the tested one byte-for-byte (accepted: the two
  tokens are inert data, exercised by the hidden-badge guard).
- Legacy Pages deployment must be switched manually once (documented above).

## Prompt Entries

OpenSpec planning used per project instructions; no AI prompt text embedded
in the artifact beyond the repo's existing conventions.
