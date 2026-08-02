# 0025: Predict a bounded nearby loose-body contact island

Status: accepted, 2026-08-02. Refines the one-held-body prediction subset in
[0024](0024-source-style-networked-physics.md).

## Decision

Bun remains authoritative for every player and rigid body. Each 30 Hz owner
checkpoint additionally carries exact states for a stable set of at most four
eligible loose bodies within six metres of the player. The current player support
and the held body's live loose-body contact graph take priority, retained members
fill the next slots, and distance breaks remaining ties. The confirmed held body
is carried separately with its grab seed and does not consume one of those four
slots.

The browser restores that bounded set as real dynamic Box3D bodies before
replaying unacknowledged commands. The local player, held prop, and selected
loose bodies therefore exchange impulses in the same replay world. Bodies not
selected by the checkpoint remain source-timed kinematic proxies. Jointed,
explicitly manipulated, claimed-by-another-player, and non-loose bodies never
enter the local dynamic set.

Every locally simulated body publishes a new local presentation sequence on
every worker tick and renders from that simulated body. Authoritative samples
continue to update the correction target without replacing an active local
track. Leaving the bounded set returns the body to host presentation through a
rate-limited visual correction.

Late input is a sampled intent stream, not elapsed work. Bun drains a delivered
burst, advances the controller once from the newest valid intent, acknowledges
that sequence, and recovers bounded action-counter edges from the discarded
samples. It never spends subsequent ticks replaying movement time that it
already simulated by repeating the prior intent.

As in Source, a held object is forcibly released if it becomes the player's
support. A grab controller and support velocity cannot form a feedback loop
through the same body.

## Evidence

The paired 15-second traces in the August 2 investigation exposed three failures
that the previous tests did not model:

- a main-thread capture stall produced a permanent 15–16-command server queue
  and 16–18-command replay tail because Bun treated samples as a FIFO;
- a server-dynamic held prop hit two other server-dynamic bodies at roughly
  8.5 m/s while those same surrounding bodies were kinematic in browser replay;
- predicted held transforms reused an authoritative state sequence, so the
  presentation buffer discarded otherwise valid 60 Hz local samples.

The capture artifact is now assembled and compressed in a dedicated worker.
The command-burst regression proves immediate newest-intent recovery. Independent
Box3D adapters reproduce a held-plus-two-loose-body collision chain within
`1e-4` metres and velocity units. The production Chrome pickup gate pairs host
and browser held poses by source tick and requires at most 1 cm separation; the
current fixture matches exactly at recorded precision. Release frames remain
below the 25 cm discontinuity gate.

The chosen four-body set, one shared state index per publish, and contact-priority
selection retain the 8/12 ms p95/p99 host budgets and stay below the 2 Mbit/s
recipient traffic budget in the 16-player/128-body release matrix. A focused
fixture proves a live held-body contact wins a slot even when four other loose
bodies are nearer to the player.

Checkpoint state and prediction seeds are captured atomically with the 30 Hz
world sample. Delta encoding and channel writes are deferred until after the
fixed simulation tick; delaying those I/O operations does not retime the captured
state.

## Rejected alternatives

- **Keep every surrounding body kinematic.** This repeats the captured split
  contact solve: Bun moves the struck body while browser replay treats it as an
  immovable obstacle.
- **Predict every loose body.** It duplicates too much checkpoint state and
  failed the existing multiplayer host budget. It also broadens rollback far
  beyond the local interaction.
- **Make nearby bodies client authority.** Prediction is a disposable cache;
  accepting it as truth would restore split authority and conflicting contacts.
- **Hide the correction only in interpolation.** Smoothing cannot repair a
  permanent input backlog or two different dynamic contact graphs.
- **Replace Box3D.** Identical adapters and selected contact islands agree; the
  recorded defect was boundary and scheduling policy, not a solver mismatch.

## Consequences

The prediction boundary is explicit and measurable, not deterministic
full-world lockstep. A contact chain larger than the selected set can still
receive authoritative correction, so source-tick error and body-set membership
remain trace data and browser behavior gates. Increasing the radius or capacity
requires rerunning both the real-browser interaction gate and the full network
matrix.
