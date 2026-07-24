import {
  decodeCompiledEntityCapabilities,
  decodeWorldBundle as decodeEngineWorldBundle,
  encodeWorldBundle as encodeEngineWorldBundle,
  type DynamicBrushBody,
  type KinematicBrushBody,
  type SensorBrushBody,
  type SpriteAssetId,
  type Vec3,
  type WorldBundle as EngineWorldBundle,
  type WorldMessage as EngineWorldMessage,
} from "@gurgur/engine";

type EntityBase = {
  authoredId?: string;
  origin?: Vec3;
};

export type PhysicsPropEntity = EntityBase & {
  kind: "physics-prop";
  authoredId: string;
  body: DynamicBrushBody;
  presentation: { kind: "brush"; transform: "body" };
  interaction: "grab";
};

export type LinearMoverEntity = EntityBase & {
  kind: "linear-mover";
  authoredId: string;
  mode: "door" | "platform";
  targetName: string;
  moveDirection: Vec3;
  distance: number;
  speed: number;
  waitSeconds: number;
  startOpen: boolean;
  body: KinematicBrushBody;
  presentation: { kind: "brush"; transform: "body" };
  interaction: "none";
};

export type TriggerEntity = EntityBase & {
  kind: "trigger";
  authoredId: string;
  mode: "once" | "multiple";
  target: string;
  waitSeconds: number;
  body: SensorBrushBody;
  presentation: { kind: "none" };
  interaction: "none";
};

export type RelayEntity = EntityBase & {
  kind: "relay";
  authoredId: string;
  targetName: string;
  target: string;
  delaySeconds: number;
  once: boolean;
  body: null;
  presentation: { kind: "none" };
  interaction: "none";
};

export type ButtonEntity = EntityBase & {
  kind: "button";
  authoredId: string;
  target: string;
  waitSeconds: number;
  body: KinematicBrushBody;
  presentation: { kind: "brush"; transform: "body" };
  interaction: "use";
};

export type SpriteEntity = EntityBase & {
  kind: "sprite";
  origin: Vec3;
  body: null;
  presentation: { kind: "sprite"; asset: SpriteAssetId; height: number; glow: boolean };
  interaction: "none";
};

export type CompiledGameEntity =
  | PhysicsPropEntity
  | LinearMoverEntity
  | TriggerEntity
  | RelayEntity
  | ButtonEntity
  | SpriteEntity;

export type WorldBundle = EngineWorldBundle<CompiledGameEntity>;
export type WorldMessage = EngineWorldMessage<CompiledGameEntity>;

export function encodeWorldBundle(bundle: WorldBundle): Uint8Array {
  decodeCompiledGameEntities(bundle.entities);
  return encodeEngineWorldBundle(bundle);
}

export function decodeWorldBundle(input: ArrayBuffer | ArrayBufferView): WorldBundle {
  return decodeEngineWorldBundle(input, decodeCompiledGameEntities);
}

export function decodeCompiledGameEntities(value: unknown): CompiledGameEntity[] {
  const entities = decodeCompiledEntityCapabilities(value);
  for (const entity of entities) {
    const record = entity as Record<string, unknown>;
    switch (entity.kind) {
      case "physics-prop":
        assertAuthoredId(record);
        requireBody(record.body, "dynamic-brush");
        requireBrushPresentation(record, "body");
        requireInteraction(record, "grab");
        break;
      case "linear-mover":
        assertAuthoredId(record);
        requireBody(record.body, "kinematic-brush");
        requireBrushPresentation(record, "body");
        requireInteraction(record, "none");
        if (record.mode !== "door" && record.mode !== "platform")
          throw new Error("world bundle linear mover mode is invalid");
        assertString(record.targetName, "world bundle linear mover targetName");
        assertVec3(record.moveDirection, "world bundle linear mover direction");
        assertFiniteFields(record, ["distance", "speed", "waitSeconds"]);
        if (typeof record.startOpen !== "boolean")
          throw new Error("world bundle linear mover startOpen must be boolean");
        break;
      case "trigger":
        assertAuthoredId(record);
        requireBody(record.body, "sensor-brush");
        requireNoPresentation(record);
        requireInteraction(record, "none");
        if (record.mode !== "once" && record.mode !== "multiple")
          throw new Error("world bundle trigger mode is invalid");
        assertString(record.target, "world bundle trigger target");
        assertFiniteFields(record, ["waitSeconds"]);
        break;
      case "relay":
        assertAuthoredId(record);
        if (record.body !== null) throw new Error("world bundle relay cannot have a body");
        requireNoPresentation(record);
        requireInteraction(record, "none");
        assertString(record.targetName, "world bundle relay targetName");
        assertString(record.target, "world bundle relay target");
        assertFiniteFields(record, ["delaySeconds"]);
        if (typeof record.once !== "boolean")
          throw new Error("world bundle relay once must be boolean");
        break;
      case "button":
        assertAuthoredId(record);
        requireBody(record.body, "kinematic-brush");
        requireBrushPresentation(record, "body");
        requireInteraction(record, "use");
        assertString(record.target, "world bundle button target");
        assertFiniteFields(record, ["waitSeconds"]);
        break;
      case "sprite":
        if (record.body !== null) throw new Error("world bundle sprite cannot have a body");
        requireInteraction(record, "none");
        assertVec3(record.origin, "world bundle sprite origin");
        if (!isRecord(record.presentation) || record.presentation.kind !== "sprite")
          throw new Error("world bundle sprite presentation must be sprite");
        break;
      default:
        throw new Error(`world bundle entity kind ${entity.kind} is invalid`);
    }
  }
  return entities as CompiledGameEntity[];
}

function requireBody(value: unknown, kind: string): void {
  if (!isRecord(value) || value.kind !== kind) throw new Error(`world bundle body must be ${kind}`);
}

function requireBrushPresentation(entity: Record<string, unknown>, transform: string): void {
  if (
    !isRecord(entity.presentation) ||
    entity.presentation.kind !== "brush" ||
    entity.presentation.transform !== transform
  )
    throw new Error(`world bundle brush presentation must use ${transform} transforms`);
}

function requireNoPresentation(entity: Record<string, unknown>): void {
  if (!isRecord(entity.presentation) || entity.presentation.kind !== "none")
    throw new Error("world bundle entity presentation must be none");
}

function requireInteraction(entity: Record<string, unknown>, interaction: string): void {
  if (entity.interaction !== interaction)
    throw new Error(`world bundle ${String(entity.kind)} interaction must be ${interaction}`);
}

function assertAuthoredId(entity: Record<string, unknown>): void {
  assertString(entity.authoredId, "world bundle entity authoredId");
}

function assertFiniteFields(value: Record<string, unknown>, fields: string[]): void {
  for (const field of fields)
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]))
      throw new Error(`world bundle ${field} must be finite`);
}

function assertVec3(value: unknown, label: string): asserts value is Vec3 {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.z !== "number" ||
    !Number.isFinite(value.z)
  )
    throw new Error(`${label} must contain finite x, y, and z`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
