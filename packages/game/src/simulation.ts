import type { PhysicsStepEvents, RuntimeId, Vec3 } from "@gurgur/engine";
import type { GameEngine } from "./engine-api";
import { createGamePlayers, type GamePlayers, type GamePlayersOptions } from "./players";
import type { PersistedGameState } from "./state";
import {
  entityInputDomain,
  type EntityInput,
  type OutputConnection,
  type TriggerOutputs,
  type WorldBundle,
} from "./world";

type Trigger = {
  entityIndex: number;
  handle: RuntimeId;
  authoredId: string;
  mode: "once" | "multiple";
  outputs: TriggerOutputs;
  waitTicks: number;
  readyAtTick: number;
  consumed: boolean;
  activeVisitors: Set<string>;
};

export type Mechanism = {
  entityIndex: number;
  handle: RuntimeId;
  authoredId: string;
  mode: "door" | "platform";
  targetname: string;
  start: Vec3;
  end: Vec3;
  speed: number;
  waitTicks: number;
  progress: number;
  direction: -1 | 0 | 1;
  resumeAtTick: number;
};

type Relay = {
  entityIndex: number;
  authoredId: string;
  targetname: string;
  target: string;
  delayTicks: number;
  once: boolean;
  fired: boolean;
};

export type Button = {
  handle: RuntimeId;
  authoredId: string;
  target: string;
  waitTicks: number;
  readyAtTick: number;
};

export type GameSimulation = {
  readonly players: GamePlayers;
  step(): void;
  processSensorEvents(
    begins: PhysicsStepEvents["sensorBegin"],
    ends: PhysicsStepEvents["sensorEnd"],
  ): void;
  use(target: RuntimeId, origin: Vec3, displacement: Vec3): boolean;
  persistedState(): PersistedGameState;
  reset(): void;
};

type GameSimulationOptions = {
  engine: GameEngine;
  bundle: WorldBundle;
  restored: PersistedGameState | null;
  players: Omit<GamePlayersOptions, "engine" | "bundle" | "use">;
};

export function createGameSimulation(options: GameSimulationOptions): GameSimulation {
  const { engine, bundle, restored } = options;
  const triggers: Trigger[] = [];
  const mechanisms: Mechanism[] = [];
  const relays: Relay[] = [];
  const buttons: Button[] = [];
  const delayedSignals = restored?.delayedSignals.map((signal) => ({ ...signal })) ?? [];
  delayedSignals.sort((a, b) => a.dueTick - b.dueTick);

  const setTransform = (mechanism: Mechanism): void => {
    const position = mix(mechanism.start, mechanism.end, mechanism.progress);
    engine.setKinematicTarget(mechanism.handle, position);
  };

  const activateRelay = (relay: Relay): void => {
    if (relay.once && relay.fired) return;
    relay.fired = true;
    delayedSignals.push({
      target: relay.target,
      dueTick: engine.tick + relay.delayTicks,
    });
    delayedSignals.sort((a, b) => a.dueTick - b.dueTick);
    engine.requestSave();
  };

  const activateMechanism = (mechanism: Mechanism, input: EntityInput): void => {
    if (input === "open") {
      if (mechanism.progress < 1) mechanism.direction = 1;
    } else if (input === "close") {
      if (mechanism.progress > 0) mechanism.direction = -1;
    } else {
      mechanism.direction = mechanism.progress >= 1 ? -1 : 1;
    }
    mechanism.resumeAtTick = 0;
    engine.requestSave();
  };

  const emitTarget = (targetname: string): void => {
    for (const relay of relays) {
      if (relay.targetname === targetname) activateRelay(relay);
    }
    for (const mechanism of mechanisms) {
      if (mechanism.targetname !== targetname) continue;
      activateMechanism(mechanism, "trigger");
    }
  };

  const dispatchConnection = (connection: OutputConnection): void => {
    for (const entityIndex of connection.targetEntityIndices) {
      const relay = relays.find((candidate) => candidate.entityIndex === entityIndex);
      if (relay && connection.input === "trigger") {
        activateRelay(relay);
        continue;
      }
      const mechanism = mechanisms.find((candidate) => candidate.entityIndex === entityIndex);
      if (
        mechanism &&
        (connection.input === "trigger" ||
          connection.input === "open" ||
          connection.input === "close")
      ) {
        activateMechanism(mechanism, connection.input);
      }
    }
  };

  const stepMechanisms = (): void => {
    const tick = engine.tick;
    while (delayedSignals[0] && delayedSignals[0].dueTick <= tick) {
      const signal = delayedSignals.shift()!;
      engine.requestSave();
      emitTarget(signal.target);
    }
    for (const mechanism of mechanisms) {
      if (
        mechanism.direction === 0 &&
        mechanism.resumeAtTick > 0 &&
        mechanism.resumeAtTick <= tick
      ) {
        mechanism.direction = mechanism.progress >= 1 ? -1 : 1;
        mechanism.resumeAtTick = 0;
      }
      if (mechanism.direction === 0) {
        engine.setKinematicTarget(mechanism.handle, engine.bodies.state(mechanism.handle).position);
        continue;
      }
      const distance = vectorLength(mechanism.start, mechanism.end);
      if (distance <= Number.EPSILON || mechanism.speed <= 0) {
        mechanism.direction = 0;
        continue;
      }
      mechanism.progress = clamp(
        mechanism.progress + (mechanism.direction * mechanism.speed * engine.dt) / distance,
        0,
        1,
      );
      setTransform(mechanism);
      if (mechanism.progress !== 0 && mechanism.progress !== 1) continue;
      const reachedOpen = mechanism.progress === 1;
      mechanism.direction = 0;
      if (mechanism.mode === "platform" || reachedOpen) {
        mechanism.resumeAtTick = tick + mechanism.waitTicks;
      }
      engine.requestSave();
    }
  };

  const processSensorEvents = (
    begins: PhysicsStepEvents["sensorBegin"],
    ends: PhysicsStepEvents["sensorEnd"],
  ): void => {
    const proxyKeys = new Set(players.proxies().map(key));
    const tick = engine.tick;
    for (const event of begins) {
      if (!proxyKeys.has(key(event.visitor))) continue;
      const trigger = triggers.find((candidate) => key(candidate.handle) === key(event.sensor));
      if (!trigger || trigger.consumed || trigger.readyAtTick > tick) continue;
      const visitor = key(event.visitor);
      if (trigger.activeVisitors.has(visitor)) continue;
      if (connectionIsGame(trigger.outputs.enter, bundle))
        dispatchConnection(trigger.outputs.enter);
      if (trigger.outputs.exit && connectionIsGame(trigger.outputs.exit, bundle))
        trigger.activeVisitors.add(visitor);
      if (trigger.mode === "once") trigger.consumed = true;
      else trigger.readyAtTick = tick + trigger.waitTicks;
      engine.requestSave();
    }
    for (const event of ends) {
      if (!proxyKeys.has(key(event.visitor))) continue;
      const trigger = triggers.find((candidate) => key(candidate.handle) === key(event.sensor));
      const visitor = key(event.visitor);
      if (!trigger?.activeVisitors.delete(visitor) || !trigger.outputs.exit) continue;
      dispatchConnection(trigger.outputs.exit);
    }
  };

  const use = (target: RuntimeId, rayOrigin: Vec3, displacement: Vec3): boolean => {
    const button = buttons.find((candidate) => key(candidate.handle) === key(target));
    if (!button || button.readyAtTick > engine.tick) return false;
    const hit = engine.raycast(rayOrigin, displacement);
    if (!hit || key(hit.body) !== key(button.handle)) return false;
    button.readyAtTick = engine.tick + button.waitTicks;
    emitTarget(button.target);
    engine.requestSave();
    return true;
  };

  const persistedState = (): PersistedGameState => ({
    entities: [
      ...mechanisms.map((mechanism) => ({
        kind: "linear-mover" as const,
        authoredId: mechanism.authoredId,
        progress: mechanism.progress,
        direction: mechanism.direction,
        resumeAtTick: mechanism.resumeAtTick,
      })),
      ...triggers.map((trigger) => ({
        kind: "trigger" as const,
        authoredId: trigger.authoredId,
        readyAtTick: trigger.readyAtTick,
        consumed: trigger.consumed,
      })),
      ...relays.map((relay) => ({
        kind: "relay" as const,
        authoredId: relay.authoredId,
        fired: relay.fired,
      })),
      ...buttons.map((button) => ({
        kind: "button" as const,
        authoredId: button.authoredId,
        readyAtTick: button.readyAtTick,
      })),
    ],
    delayedSignals: delayedSignals.map((signal) => ({ ...signal })),
  });

  populate({
    engine,
    bundle,
    restored,
    triggers,
    mechanisms,
    relays,
    buttons,
  });
  const players = createGamePlayers({
    ...options.players,
    engine,
    bundle,
    use,
  });
  const step = (): void => {
    stepMechanisms();
    players.step();
  };
  const reset = (): void => {
    triggers.length = 0;
    mechanisms.length = 0;
    relays.length = 0;
    buttons.length = 0;
    delayedSignals.length = 0;
    populate({
      engine,
      bundle,
      restored: null,
      triggers,
      mechanisms,
      relays,
      buttons,
    });
    players.reset();
  };
  return {
    players,
    step,
    processSensorEvents,
    use,
    persistedState,
    reset,
  };
}

type Population = Pick<GameSimulationOptions, "engine" | "bundle" | "restored"> & {
  triggers: Trigger[];
  mechanisms: Mechanism[];
  relays: Relay[];
  buttons: Button[];
};

function populate(options: Population): void {
  const { engine, bundle, restored, triggers, mechanisms, relays, buttons } = options;
  const restoredMechanisms = new Map(
    restored?.entities
      .filter((state) => state.kind === "linear-mover")
      .map((state) => [state.authoredId, state]),
  );
  const restoredSignals = new Map(
    restored?.entities
      .filter((state) => state.kind !== "linear-mover")
      .map((state) => [state.authoredId, state]),
  );
  for (const [entityIndex, entity] of bundle.entities.entries()) {
    if (entity.kind === "trigger") {
      if (
        !connectionIsGame(entity.outputs.enter, bundle) &&
        (!entity.outputs.exit || !connectionIsGame(entity.outputs.exit, bundle))
      )
        continue;
      const saved = restoredSignals.get(entity.authoredId);
      const body = engine.bodies.forEntity(entityIndex);
      if (!body) throw new Error(`trigger body ${entity.authoredId} is missing`);
      triggers.push({
        entityIndex,
        handle: body.id,
        authoredId: entity.authoredId,
        mode: entity.mode,
        outputs: entity.outputs,
        waitTicks: Math.max(1, Math.ceil(entity.waitSeconds / engine.dt)),
        readyAtTick: saved?.kind === "trigger" ? saved.readyAtTick : 0,
        consumed: saved?.kind === "trigger" ? saved.consumed : false,
        activeVisitors: new Set(),
      });
      continue;
    }
    if (entity.kind === "relay") {
      const saved = restoredSignals.get(entity.authoredId);
      relays.push({
        entityIndex,
        authoredId: entity.authoredId,
        targetname: entity.targetName,
        target: entity.target,
        delayTicks: Math.max(0, Math.ceil(entity.delaySeconds / engine.dt)),
        once: entity.once,
        fired: saved?.kind === "relay" ? saved.fired : false,
      });
      continue;
    }
    if (entity.kind === "button") {
      const body = engine.bodies.forEntity(entityIndex);
      if (!body) throw new Error(`button body ${entity.authoredId} is missing`);
      const saved = restoredSignals.get(entity.authoredId);
      buttons.push({
        handle: body.id,
        authoredId: entity.authoredId,
        target: entity.target,
        waitTicks: Math.max(1, Math.ceil(entity.waitSeconds / engine.dt)),
        readyAtTick: saved?.kind === "button" ? saved.readyAtTick : 0,
      });
      continue;
    }
    if (entity.kind !== "linear-mover") continue;
    const body = engine.bodies.forEntity(entityIndex);
    if (!body) throw new Error(`mechanism body ${entity.authoredId} is missing`);
    const start = { ...bundle.brushes[entity.body.brushIndices[0]!]!.center };
    const direction = entity.moveDirection;
    const distance = entity.distance;
    const saved = restoredMechanisms.get(entity.authoredId);
    const mechanism: Mechanism = {
      entityIndex,
      handle: body.id,
      authoredId: entity.authoredId,
      mode: entity.mode,
      targetname: entity.targetName,
      start,
      end: {
        x: start.x + direction.x * distance,
        y: start.y + direction.y * distance,
        z: start.z + direction.z * distance,
      },
      speed: entity.speed,
      waitTicks: Math.max(0, Math.ceil(entity.waitSeconds / engine.dt)),
      progress: saved?.progress ?? (entity.startOpen ? 1 : 0),
      direction: saved?.direction ?? 0,
      resumeAtTick: saved?.resumeAtTick ?? 0,
    };
    mechanisms.push(mechanism);
  }
}

function connectionIsGame(connection: OutputConnection, bundle: WorldBundle): boolean {
  const target = bundle.entities[connection.targetEntityIndices[0]!]!;
  return entityInputDomain(target, connection.input) === "game";
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}
function vectorLength(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}
function mix(a: Vec3, b: Vec3, amount: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  };
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
