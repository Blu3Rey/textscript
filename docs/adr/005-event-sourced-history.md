# 005: Event-sourced session history

- **Status:** Accepted
- **Date:** 2026-10-06
- **Roadmap segment:** S0 (implemented in S3)

## Context

Users revise as they go: undo, "scratch that", going back to an earlier
version. Sessions should be replayable for review (S11), shareable (S16) and
reproducible in bug reports and evaluations.

## Decision

A session is an **append-only log** of events. Each event is one utterance
together with the edit batch it produced and the resulting IR version. The
current IR is a fold of the log over an empty program, with snapshots cached
every N events for speed. Undo and redo move a pointer through the log or
append inverse batches; nothing is ever deleted from the log.

## Consequences

- Undo, redo, revert-by-utterance and replay all come from one mechanism.
- Any session can be reproduced exactly from its log, which makes bugs
  reportable as data and lets the evaluation runner replay real sessions.
- Live sharing is a broadcast of the same log, with no CRDT needed while
  there is a single writer.
- Every op must have an exact inverse, and replay must be deterministic.
  Both are tested properties from S3.
- Logs grow without limit. Snapshots bound replay time; storage is small
  because events are text and compact ops.

## Alternatives considered

- **Store the latest IR plus an undo stack.** Can't replay or audit how a
  solution developed, which is a core practice feature.
- **Snapshot every version.** Simple, but loses which utterance caused which
  change, and costs more storage.
