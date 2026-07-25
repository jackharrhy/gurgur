import {
  FULL_RATE_BODY_RADIUS_METRES,
  PHYSICS_HZ,
  SNAPSHOT_BODY_BYTES,
  SNAPSHOT_FLAG_CREATED,
  SNAPSHOT_FLAG_GRABBED,
  SNAPSHOT_FLAG_LOCAL_GRAB,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  SNAPSHOT_FLAG_WAKE,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_INTERVAL_TICKS,
  SNAPSHOT_PLAYER_BYTES,
  STATE_ALWAYS_NEAR_BODY_SLOTS,
  STATE_DATAGRAM_TARGET_BYTES,
  STATE_FAR_BODY_RESERVE,
  STATE_FAR_PLAYER_RESERVE,
  STATE_MAX_PLAYER_RECORDS,
  stateWasAcknowledged,
  type BodySnapshot,
  type RuntimeId,
  type Snapshot,
  type StateAcknowledgement,
  type Vec3,
} from "@gurgur/engine";

const FAST_LANE_SLOTS = 8;
const TRANSITION_LANE_SLOTS = 4;
const RECENT_INTERACTION_TICKS = Math.ceil(0.5 * PHYSICS_HZ);
const NEAR_AWAKE_DEADLINE_TICKS = SNAPSHOT_INTERVAL_TICKS * 2;
const SENT_PACKET_HISTORY = 64;
const TRANSITION_FLAGS = SNAPSHOT_FLAG_CREATED | SNAPSHOT_FLAG_TELEPORT | SNAPSHOT_FLAG_WAKE;

type DeliveryState = {
  latest: BodySnapshot;
  fingerprint: string;
  revision: number;
  acknowledgedRevision: number;
  lastSentTick: number;
  debt: number;
  grabbed: boolean;
  interactiveUntilTick: number;
};

type Candidate = {
  key: string;
  state: DeliveryState;
  body: BodySnapshot;
  distance: number;
  awake: boolean;
  terminalPending: boolean;
};

export class ClientSnapshotScheduler {
  readonly #states = new Map<string, DeliveryState>();
  readonly #sentPackets = new Map<number, Array<{ key: string; revision: number }>>();
  #worldEpoch: number | null = null;

  select(
    snapshot: Snapshot,
    localPosition: Vec3 | null,
    localPlayerId: RuntimeId,
    localGrabbedTarget: RuntimeId | null = null,
  ): Snapshot {
    if (!localPosition) return snapshot;
    if (this.#worldEpoch !== snapshot.worldEpoch) {
      this.#states.clear();
      this.#sentPackets.clear();
      this.#worldEpoch = snapshot.worldEpoch;
    }

    const playerIds = new Set(snapshot.players.map(({ id }) => key(id)));
    this.#observe(snapshot, playerIds, localGrabbedTarget);
    const selectedPlayers = selectPlayers(
      snapshot,
      localPosition,
      localPlayerId,
      Math.floor(snapshot.serverTick / SNAPSHOT_INTERVAL_TICKS),
    );
    const selectedPlayerIds = new Set(selectedPlayers.map(({ id }) => key(id)));
    const selectedPlayerBodies = snapshot.bodies.filter((body) =>
      selectedPlayerIds.has(key(body.id)),
    );
    const bodyCapacity = Math.max(
      0,
      Math.floor(
        (STATE_DATAGRAM_TARGET_BYTES -
          SNAPSHOT_HEADER_BYTES -
          selectedPlayers.length * SNAPSHOT_PLAYER_BYTES) /
          SNAPSHOT_BODY_BYTES,
      ),
    );
    const candidates = [...this.#states.entries()].flatMap(([identity, state]) => {
      const body = withLocalGrabFlag(state.latest, localGrabbedTarget);
      const distanceToPlayer = distance(body.position, localPosition);
      const awake = ((body.flags ?? 0) & SNAPSHOT_FLAG_SLEEP) === 0;
      const terminalPending = !awake && state.acknowledgedRevision < state.revision;
      if (!awake && !terminalPending && snapshot.serverTick > state.interactiveUntilTick) return [];
      state.debt += importance(body, distanceToPlayer, awake);
      return [
        {
          key: identity,
          state,
          body,
          distance: distanceToPlayer,
          awake,
          terminalPending,
        },
      ];
    });

    const selected: Candidate[] = [];
    const selectedKeys = new Set<string>();
    const add = (items: Candidate[], count: number): void => {
      for (const candidate of items) {
        if (selected.length >= bodyCapacity || count <= 0) break;
        if (selectedKeys.has(candidate.key)) continue;
        selected.push(candidate);
        selectedKeys.add(candidate.key);
        count -= 1;
      }
    };
    const byUrgency = (left: Candidate, right: Candidate): number =>
      right.state.debt - left.state.debt ||
      left.state.lastSentTick - right.state.lastSentTick ||
      left.distance - right.distance ||
      left.key.localeCompare(right.key);

    const fast = candidates
      .filter(({ state }) => snapshot.serverTick <= state.interactiveUntilTick)
      .toSorted((left, right) => {
        const leftLocal = sameId(left.body.id, localGrabbedTarget);
        const rightLocal = sameId(right.body.id, localGrabbedTarget);
        return Number(rightLocal) - Number(leftLocal) || byUrgency(left, right);
      });
    add(fast, FAST_LANE_SLOTS);

    const overdueAwake = candidates
      .filter(
        ({ awake, distance: candidateDistance, state }) =>
          awake &&
          !isTransitionState(state.latest) &&
          candidateDistance <= FULL_RATE_BODY_RADIUS_METRES &&
          snapshot.serverTick - state.lastSentTick >= NEAR_AWAKE_DEADLINE_TICKS,
      )
      .toSorted(byUrgency);
    add(overdueAwake, bodyCapacity);

    const transitions = candidates
      .filter(
        ({ body, terminalPending }) =>
          terminalPending || ((body.flags ?? 0) & TRANSITION_FLAGS) !== 0,
      )
      .toSorted(byUrgency);
    add(transitions, TRANSITION_LANE_SLOTS);

    const closestAwake = candidates
      .filter(
        ({ awake, distance: candidateDistance, body }) =>
          awake && !isTransitionState(body) && candidateDistance <= FULL_RATE_BODY_RADIUS_METRES,
      )
      .toSorted((left, right) => left.distance - right.distance || byUrgency(left, right));
    add(closestAwake, STATE_ALWAYS_NEAR_BODY_SLOTS);

    const remaining = bodyCapacity - selected.length;
    const far = candidates
      .filter(
        ({ body, distance: candidateDistance, terminalPending }) =>
          candidateDistance > FULL_RATE_BODY_RADIUS_METRES &&
          !terminalPending &&
          !isTransitionState(body),
      )
      .toSorted(byUrgency);
    const farReserve = Math.min(STATE_FAR_BODY_RESERVE, far.length, remaining);
    add(far, farReserve);
    add(
      candidates
        .filter(
          ({ body, state, terminalPending }) =>
            (!terminalPending || snapshot.serverTick <= state.interactiveUntilTick) &&
            !isTransitionState(body),
        )
        .toSorted(byUrgency),
      bodyCapacity,
    );

    return {
      ...snapshot,
      players: selectedPlayers,
      bodies: [...selectedPlayerBodies, ...selected.map(({ body }) => body)],
    };
  }

  sent(snapshot: Snapshot): void {
    const records = snapshot.bodies.flatMap((body) => {
      const identity = key(body.id);
      const state = this.#states.get(identity);
      if (!state) return [];
      state.lastSentTick = snapshot.serverTick;
      state.debt = 0;
      return [{ key: identity, revision: state.revision }];
    });
    this.#sentPackets.set(snapshot.serverTick, records);
    while (this.#sentPackets.size > SENT_PACKET_HISTORY)
      this.#sentPackets.delete(this.#sentPackets.keys().next().value!);
  }

  acknowledge(acknowledgement: StateAcknowledgement): void {
    for (const [serverTick, records] of this.#sentPackets) {
      if (!stateWasAcknowledged(acknowledgement, serverTick)) continue;
      for (const record of records) {
        const state = this.#states.get(record.key);
        if (state)
          state.acknowledgedRevision = Math.max(state.acknowledgedRevision, record.revision);
      }
      this.#sentPackets.delete(serverTick);
    }
  }

  #observe(snapshot: Snapshot, playerIds: Set<string>, localGrabbedTarget: RuntimeId | null): void {
    for (const source of snapshot.bodies) {
      const identity = key(source.id);
      if (playerIds.has(identity)) continue;
      const body = withLocalGrabFlag(source, localGrabbedTarget);
      const fingerprint = bodyFingerprint(body);
      const existing = this.#states.get(identity);
      const grabbed =
        ((body.flags ?? 0) & (SNAPSHOT_FLAG_GRABBED | SNAPSHOT_FLAG_LOCAL_GRAB)) !== 0;
      if (!existing) {
        this.#states.set(identity, {
          latest: body,
          fingerprint,
          revision: 1,
          acknowledgedRevision: 0,
          lastSentTick: Number.NEGATIVE_INFINITY,
          debt: 0,
          grabbed,
          interactiveUntilTick: grabbed
            ? snapshot.serverTick + RECENT_INTERACTION_TICKS
            : Number.NEGATIVE_INFINITY,
        });
        continue;
      }
      if (existing.fingerprint !== fingerprint) {
        existing.latest = body;
        existing.fingerprint = fingerprint;
        existing.revision += 1;
      }
      if (grabbed || existing.grabbed)
        existing.interactiveUntilTick = snapshot.serverTick + RECENT_INTERACTION_TICKS;
      existing.grabbed = grabbed;
    }
  }
}

export function snapshotForPlayer(
  snapshot: Snapshot,
  localPosition: Vec3 | null,
  localPlayerId: RuntimeId,
  localGrabbedTarget: RuntimeId | null = null,
  scheduler = new ClientSnapshotScheduler(),
): Snapshot {
  return scheduler.select(snapshot, localPosition, localPlayerId, localGrabbedTarget);
}

function selectPlayers(
  snapshot: Snapshot,
  localPosition: Vec3,
  localPlayerId: RuntimeId,
  rotation: number,
): Snapshot["players"] {
  const ordered = snapshot.players.toSorted((left, right) => {
    const leftIsLocal = sameId(left.id, localPlayerId);
    const rightIsLocal = sameId(right.id, localPlayerId);
    if (leftIsLocal !== rightIsLocal) return leftIsLocal ? -1 : 1;
    return distance(left.position, localPosition) - distance(right.position, localPosition);
  });
  return ordered.length <= STATE_MAX_PLAYER_RECORDS
    ? ordered
    : [
        ...ordered.slice(0, STATE_MAX_PLAYER_RECORDS - STATE_FAR_PLAYER_RESERVE),
        ...takeRotating(
          ordered.slice(STATE_MAX_PLAYER_RECORDS - STATE_FAR_PLAYER_RESERVE),
          STATE_FAR_PLAYER_RESERVE,
          rotation,
        ),
      ];
}

function withLocalGrabFlag(body: BodySnapshot, localGrabbedTarget: RuntimeId | null): BodySnapshot {
  const flags = sameId(body.id, localGrabbedTarget)
    ? (body.flags ?? 0) | SNAPSHOT_FLAG_LOCAL_GRAB
    : (body.flags ?? 0) & ~SNAPSHOT_FLAG_LOCAL_GRAB;
  return { ...body, flags };
}

function bodyFingerprint(body: BodySnapshot): string {
  const linear = body.linearVelocity ?? ZERO;
  const angular = body.angularVelocity ?? ZERO;
  return [
    body.position.x,
    body.position.y,
    body.position.z,
    body.rotation.x,
    body.rotation.y,
    body.rotation.z,
    body.rotation.w,
    linear.x,
    linear.y,
    linear.z,
    angular.x,
    angular.y,
    angular.z,
    body.flags ?? 0,
  ].join(",");
}

function importance(body: BodySnapshot, distanceToPlayer: number, awake: boolean): number {
  const linear = body.linearVelocity ?? ZERO;
  const angular = body.angularVelocity ?? ZERO;
  const speed = Math.hypot(linear.x, linear.y, linear.z);
  const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
  const proximity = Math.max(0, FULL_RATE_BODY_RADIUS_METRES - distanceToPlayer);
  return 1 + proximity * 2 + Number(awake) * 8 + Math.min(20, speed * 4 + angularSpeed);
}

function isTransitionState(body: BodySnapshot): boolean {
  return ((body.flags ?? 0) & TRANSITION_FLAGS) !== 0;
}

function takeRotating<T>(items: T[], count: number, rotation: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count >= items.length) return [...items];
  const start = (rotation * count) % items.length;
  return Array.from({ length: count }, (_, index) => items[(start + index) % items.length]!);
}

function sameId(left: RuntimeId | null, right: RuntimeId | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.index === right.index &&
    left.generation === right.generation
  );
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

const ZERO = { x: 0, y: 0, z: 0 };
