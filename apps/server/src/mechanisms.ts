import type { PhysicsStepEvents, PhysicsWorld } from "@gurgur/physics";
import { PHYSICS_DT, type RuntimeId, type Vec3, type WorldBundle } from "@gurgur/shared";
import type { RuntimeBody } from "./runtime-bodies";
import type { PersistedWorld } from "./store";

type Trigger = {
  handle: RuntimeId;
  authoredId: string;
  classname: "trigger_once" | "trigger_multiple";
  target: string;
  waitTicks: number;
  readyAtTick: number;
  consumed: boolean;
};

export type Mechanism = {
  handle: RuntimeId;
  authoredId: string;
  classname: "func_door" | "func_platform";
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

export type MechanismRuntime = {
  readonly triggers: Trigger[];
  readonly mechanisms: Mechanism[];
  readonly relays: Relay[];
  readonly buttons: Button[];
  readonly delayedSignals: Array<{ target: string; dueTick: number }>;
  step(): void;
  processSensorBegins(events: PhysicsStepEvents["sensorBegin"]): void;
  emitTarget(targetname: string): void;
};

type MechanismRuntimeOptions = {
  physics: PhysicsWorld;
  bundle: WorldBundle;
  bodies: RuntimeBody[];
  restored: PersistedWorld | null;
  currentTick(): number;
  playerProxies(): RuntimeId[];
  requestSave(): void;
};

export function createMechanismRuntime(options: MechanismRuntimeOptions): MechanismRuntime {
  const { physics, bundle, bodies, restored, currentTick, playerProxies, requestSave } = options;
  const triggers: Trigger[] = [];
  const mechanisms: Mechanism[] = [];
  const relays: Relay[] = [];
  const buttons: Button[] = [];
  const delayedSignals = restored?.delayedSignals.map((signal) => ({ ...signal })) ?? [];
  delayedSignals.sort((a, b) => a.dueTick - b.dueTick);

  const setTransform = (mechanism: Mechanism, teleport = false): void => {
    const position = mix(mechanism.start, mechanism.end, mechanism.progress);
    if (teleport) {
      physics.setBodyTransform(mechanism.handle, position, { x: 0, y: 0, z: 0, w: 1 });
      physics.setBodyVelocity(mechanism.handle, zero(), zero());
      return;
    }
    const current = physics.state(mechanism.handle).position;
    physics.setBodyVelocity(mechanism.handle, {
      x: (position.x - current.x) / PHYSICS_DT,
      y: (position.y - current.y) / PHYSICS_DT,
      z: (position.z - current.z) / PHYSICS_DT,
    }, zero());
  };

  const emitTarget = (targetname: string): void => {
    const tick = currentTick();
    for (const relay of relays) {
      if (relay.targetname !== targetname || (relay.once && relay.fired)) continue;
      relay.fired = true;
      delayedSignals.push({ target: relay.target, dueTick: tick + relay.delayTicks });
      delayedSignals.sort((a, b) => a.dueTick - b.dueTick);
      requestSave();
    }
    for (const mechanism of mechanisms) {
      if (mechanism.targetname !== targetname) continue;
      mechanism.direction = mechanism.progress >= 1 ? -1 : 1;
      mechanism.resumeAtTick = 0;
      requestSave();
    }
  };

  const step = (): void => {
    const tick = currentTick();
    while (delayedSignals[0] && delayedSignals[0].dueTick <= tick) {
      const signal = delayedSignals.shift()!;
      requestSave();
      emitTarget(signal.target);
    }
    for (const mechanism of mechanisms) {
      if (mechanism.direction === 0 && mechanism.resumeAtTick > 0 && mechanism.resumeAtTick <= tick) {
        mechanism.direction = mechanism.progress >= 1 ? -1 : 1;
        mechanism.resumeAtTick = 0;
      }
      if (mechanism.direction === 0) {
        physics.setBodyVelocity(mechanism.handle, zero(), zero());
        continue;
      }
      const distance = vectorLength(mechanism.start, mechanism.end);
      if (distance <= Number.EPSILON || mechanism.speed <= 0) {
        mechanism.direction = 0;
        continue;
      }
      mechanism.progress = clamp(
        mechanism.progress + mechanism.direction * mechanism.speed * PHYSICS_DT / distance,
        0,
        1,
      );
      setTransform(mechanism);
      if (mechanism.progress !== 0 && mechanism.progress !== 1) continue;
      const reachedOpen = mechanism.progress === 1;
      mechanism.direction = 0;
      if (mechanism.classname === "func_platform" || reachedOpen) {
        mechanism.resumeAtTick = tick + mechanism.waitTicks;
      }
      requestSave();
    }
  };

  const processSensorBegins = (events: PhysicsStepEvents["sensorBegin"]): void => {
    const proxyKeys = new Set(playerProxies().map(key));
    const tick = currentTick();
    for (const event of events) {
      if (!proxyKeys.has(key(event.visitor))) continue;
      const trigger = triggers.find((candidate) => key(candidate.handle) === key(event.sensor));
      if (!trigger || trigger.consumed || trigger.readyAtTick > tick) continue;
      emitTarget(trigger.target);
      if (trigger.classname === "trigger_once") trigger.consumed = true;
      else trigger.readyAtTick = tick + trigger.waitTicks;
      requestSave();
    }
  };

  populate({ physics, bundle, bodies, restored, triggers, mechanisms, relays, buttons, setTransform });
  return { triggers, mechanisms, relays, buttons, delayedSignals, step, processSensorBegins, emitTarget };
}

type Population = Pick<MechanismRuntimeOptions, "physics" | "bundle" | "bodies" | "restored"> & {
  triggers: Trigger[];
  mechanisms: Mechanism[];
  relays: Relay[];
  buttons: Button[];
  setTransform(mechanism: Mechanism, teleport?: boolean): void;
};

function populate(options: Population): void {
  const { physics, bundle, bodies, restored, triggers, mechanisms, relays, buttons, setTransform } = options;
  const bodyByAuthoredId = new Map(bodies.map((body) => [body.authoredId, body]));
  const restoredMechanisms = new Map(restored?.mechanisms.map((state) => [state.authoredId, state]));
  const restoredSignals = new Map(restored?.signals.map((state) => [state.authoredId, state]));
  for (const entity of bundle.entities) {
    if (entity.classname === "trigger_once" || entity.classname === "trigger_multiple") {
      if (!entity.authoredId) throw new Error(`${entity.classname} requires an authoredId`);
      const brush = bundle.brushes[entity.brushIndices[0]!]!;
      const saved = restoredSignals.get(entity.authoredId);
      triggers.push({
        handle: physics.createSensorHull({ position: zero(), vertices: brush.worldVertices }),
        authoredId: entity.authoredId,
        classname: entity.classname,
        target: String(entity.runtimeProperties.target),
        waitTicks: Math.max(1, Math.ceil(Number(entity.runtimeProperties.wait ?? 0) / PHYSICS_DT)),
        readyAtTick: saved?.kind === "trigger" ? saved.readyAtTick : 0,
        consumed: saved?.kind === "trigger" ? saved.latched : false,
      });
      continue;
    }
    if (entity.classname === "logic_relay") {
      if (!entity.authoredId) throw new Error("logic_relay requires an authoredId");
      const saved = restoredSignals.get(entity.authoredId);
      relays.push({
        authoredId: entity.authoredId,
        targetname: String(entity.runtimeProperties.targetname),
        target: String(entity.runtimeProperties.target),
        delayTicks: Math.max(0, Math.ceil(Number(entity.runtimeProperties.delay) / PHYSICS_DT)),
        once: Boolean(entity.runtimeProperties.once),
        fired: saved?.kind === "relay" ? saved.latched : false,
      });
      continue;
    }
    if (entity.classname === "func_button") {
      const body = bodyByAuthoredId.get(entity.authoredId!);
      if (!body) throw new Error(`button body ${entity.authoredId} is missing`);
      const saved = restoredSignals.get(entity.authoredId!);
      buttons.push({
        handle: body.handle,
        authoredId: entity.authoredId!,
        target: String(entity.runtimeProperties.target),
        waitTicks: Math.max(1, Math.ceil(Number(entity.runtimeProperties.wait) / PHYSICS_DT)),
        readyAtTick: saved?.kind === "button" ? saved.readyAtTick : 0,
      });
      continue;
    }
    if (entity.classname !== "func_door" && entity.classname !== "func_platform") continue;
    const body = bodyByAuthoredId.get(entity.authoredId!);
    if (!body) throw new Error(`mechanism body ${entity.authoredId} is missing`);
    const start = { ...bundle.brushes[entity.brushIndices[0]!]!.center };
    const direction = entity.runtimeProperties.moveDirection as Vec3;
    const distance = Number(entity.runtimeProperties.distance);
    const saved = restoredMechanisms.get(entity.authoredId!);
    const mechanism: Mechanism = {
      handle: body.handle,
      authoredId: entity.authoredId!,
      classname: entity.classname,
      targetname: String(entity.runtimeProperties.targetname),
      start,
      end: {
        x: start.x + direction.x * distance,
        y: start.y + direction.y * distance,
        z: start.z + direction.z * distance,
      },
      speed: Number(entity.runtimeProperties.speed),
      waitTicks: Math.max(0, Math.ceil(Number(entity.runtimeProperties.wait) / PHYSICS_DT)),
      progress: saved?.progress ?? (Boolean(entity.runtimeProperties.startOpen) ? 1 : 0),
      direction: saved?.direction ?? 0,
      resumeAtTick: saved?.resumeAtTick ?? 0,
    };
    mechanisms.push(mechanism);
    setTransform(mechanism, true);
  }
}

function key(id: RuntimeId): string { return `${id.index}:${id.generation}`; }
function zero(): Vec3 { return { x: 0, y: 0, z: 0 }; }
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
