import type {
  PlayerSpawn,
  ResetMarker,
  Rgb,
  SpriteAssetId,
  Vec3,
  WorldSettings,
} from "@gurgur/engine";
import type { CompiledGameEntity } from "./world";

export type PropertySource = {
  sourceName: string;
  classname: string;
  property: string;
  line: number;
};

export type EntityProperty<T> = {
  editor: {
    type: "string" | "number" | "boolean" | "vector" | "target" | "targetname";
    description: string;
    default?: string | number | boolean;
  };
  parse(raw: string | undefined, source: PropertySource): T;
};

export type InferProperties<S extends Record<string, EntityProperty<unknown>>> = {
  [K in keyof S]: S[K] extends EntityProperty<infer T> ? T : never;
};

export type EntityCompileContext = {
  sourceName: string;
  line: number;
  classname: string;
  authoredId?: string;
  origin?: Vec3;
  brushIndices: number[];
};

export type CompiledAuthoredEntity =
  | { kind: "world-settings"; settings: WorldSettings }
  | { kind: "player-spawn"; spawn: PlayerSpawn }
  | { kind: "reset-marker"; marker: ResetMarker }
  | { kind: "game-entity"; entity: CompiledGameEntity };

export type EntityDefinition<
  S extends Record<string, EntityProperty<unknown>>,
  O extends CompiledAuthoredEntity,
> = {
  editor: {
    kind: "point" | "solid";
    description: string;
    color: readonly [number, number, number];
    size?: readonly [number, number, number, number, number, number];
    persistent: boolean;
  };
  properties: S;
  compile(context: EntityCompileContext, properties: InferProperties<S>): O;
};

type PropertyOptions<T> = { default?: T; optional?: boolean };

function sourceLabel(source: PropertySource): string {
  return `${source.sourceName}:${source.line}: ${source.classname}.${source.property}`;
}

function requiredRaw(
  raw: string | undefined,
  source: PropertySource,
  fallback: string | number | boolean | undefined,
  optional: boolean,
): string | undefined {
  if (raw !== undefined && raw !== "") return raw;
  if (fallback !== undefined) return String(fallback);
  if (optional) return undefined;
  throw new Error(`${sourceLabel(source)} is required`);
}

export function stringProperty(
  description: string,
  options?: PropertyOptions<string> & { optional?: false },
): EntityProperty<string>;
export function stringProperty(
  description: string,
  options: PropertyOptions<string> & { optional: true },
): EntityProperty<string | undefined>;
export function stringProperty(
  description: string,
  options: PropertyOptions<string> = {},
): EntityProperty<string | undefined> {
  return {
    editor: {
      type: "string",
      description,
      ...(options.default === undefined ? {} : { default: options.default }),
    },
    parse(raw, source) {
      return requiredRaw(raw, source, options.default, options.optional ?? false);
    },
  };
}

export function boundedNumberProperty(
  description: string,
  options: PropertyOptions<number> & { min?: number; max?: number } = {},
): EntityProperty<number> {
  return {
    editor: {
      type: "number",
      description,
      ...(options.default === undefined ? {} : { default: options.default }),
    },
    parse(raw, source) {
      const sourceValue = requiredRaw(raw, source, options.default, options.optional ?? false);
      if (sourceValue === undefined) return undefined as never;
      const value = Number(sourceValue);
      if (!Number.isFinite(value)) throw new Error(`${sourceLabel(source)} must be numeric`);
      if (options.min !== undefined && value < options.min)
        throw new Error(`${sourceLabel(source)} must be at least ${options.min}`);
      if (options.max !== undefined && value > options.max)
        throw new Error(`${sourceLabel(source)} must be at most ${options.max}`);
      return value;
    },
  };
}

export function booleanProperty(
  description: string,
  options: PropertyOptions<boolean> = {},
): EntityProperty<boolean> {
  return {
    editor: {
      type: "boolean",
      description,
      ...(options.default === undefined ? {} : { default: options.default }),
    },
    parse(raw, source) {
      const value = requiredRaw(raw, source, options.default, options.optional ?? false);
      if (value === "1" || value === "true") return true;
      if (value === "0" || value === "false") return false;
      throw new Error(`${sourceLabel(source)} must be 0 or 1`);
    },
  };
}

function parseVector(raw: string | undefined, source: PropertySource, fallback?: string): Vec3 {
  const value = requiredRaw(raw, source, fallback, false)!;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite))
    throw new Error(`${sourceLabel(source)} must be a three-number vector`);
  return { x: parts[0]!, y: parts[1]!, z: parts[2]! };
}

export function vectorProperty(
  description: string,
  options: PropertyOptions<string> = {},
): EntityProperty<Vec3> {
  return {
    editor: {
      type: "vector",
      description,
      ...(options.default === undefined ? {} : { default: options.default }),
    },
    parse: (raw, source) => parseVector(raw, source, options.default),
  };
}

export function colorProperty(
  description: string,
  options: PropertyOptions<string> = {},
): EntityProperty<Rgb> {
  const vector = vectorProperty(description, options);
  return {
    editor: vector.editor,
    parse(raw, source) {
      const { x: r, y: g, z: b } = vector.parse(raw, source);
      if ([r, g, b].some((component) => component < 0 || component > 1))
        throw new Error(`${sourceLabel(source)} components must be between 0 and 1`);
      return { r, g, b };
    },
  };
}

export function targetProperty(
  description = "Entity targetname to signal",
): EntityProperty<string> {
  const property = stringProperty(description);
  return { ...property, editor: { ...property.editor, type: "target" } };
}

export function targetNameProperty(
  description = "Name other entities can target",
): EntityProperty<string> {
  const property = stringProperty(description);
  return { ...property, editor: { ...property.editor, type: "targetname" } };
}

export const METRES_PER_MAP_UNIT = 0.0254;

export function mapDistanceProperty(
  description: string,
  options: PropertyOptions<number> & { min?: number; max?: number } = {},
): EntityProperty<number> {
  const property = boundedNumberProperty(description, options);
  return {
    editor: property.editor,
    parse: (raw, source) => property.parse(raw, source) * METRES_PER_MAP_UNIT,
  };
}

export const mapSpeedProperty = mapDistanceProperty;

export function yawAngleProperty(
  description: string,
  options: PropertyOptions<number> = {},
): EntityProperty<number> {
  const property = boundedNumberProperty(description, options);
  return {
    editor: property.editor,
    parse(raw, source) {
      const radians = (-property.parse(raw, source) * Math.PI) / 180;
      return radians === 0 ? 0 : radians;
    },
  };
}

export function logicalSpriteAssetProperty(
  description: string,
  options: PropertyOptions<string> = {},
): EntityProperty<SpriteAssetId> {
  const property = stringProperty(
    description,
    options.default === undefined ? {} : { default: options.default },
  );
  return {
    editor: property.editor,
    parse(raw, source) {
      const value = property.parse(raw, source);
      if (!/^[a-z0-9][a-z0-9/_-]*$/.test(value))
        throw new Error(`${sourceLabel(source)} must be an extensionless logical asset ID`);
      return value;
    },
  };
}

function mapDirectionProperty(description: string, fallback: string): EntityProperty<Vec3> {
  const property = vectorProperty(description, { default: fallback });
  return {
    editor: property.editor,
    parse(raw, source) {
      const map = property.parse(raw, source);
      const world = {
        x: map.x * METRES_PER_MAP_UNIT,
        y: map.z * METRES_PER_MAP_UNIT,
        z: -map.y * METRES_PER_MAP_UNIT,
      };
      const length = Math.hypot(world.x, world.y, world.z);
      if (length === 0) throw new Error(`${sourceLabel(source)} must not be zero`);
      const canonical = (value: number): number => (value === 0 ? 0 : value);
      return {
        x: canonical(world.x / length),
        y: canonical(world.y / length),
        z: canonical(world.z / length),
      };
    },
  };
}

function defineEntity<
  S extends Record<string, EntityProperty<unknown>>,
  O extends CompiledAuthoredEntity,
>(
  definition: EntityDefinition<S, O>,
): EntityDefinition<S, O> & {
  compileRaw(context: EntityCompileContext, raw: Record<string, string>): O;
} {
  return {
    ...definition,
    compileRaw(context, raw) {
      const properties = Object.fromEntries(
        Object.entries(definition.properties).map(([name, property]) => [
          name,
          property.parse(raw[name], {
            sourceName: context.sourceName,
            line: context.line,
            classname: context.classname,
            property: name,
          }),
        ]),
      ) as InferProperties<S>;
      return definition.compile(context, properties);
    },
  };
}

function authoredId(context: EntityCompileContext): string {
  if (!context.authoredId)
    throw new Error(
      `${context.sourceName}:${context.line}: ${context.classname} requires authoredId`,
    );
  return context.authoredId;
}

function origin(context: EntityCompileContext): Vec3 {
  if (!context.origin)
    throw new Error(`${context.sourceName}:${context.line}: ${context.classname} requires origin`);
  return context.origin;
}

const persistent = { persistent: true } as const;
const transient = { persistent: false } as const;

export const entityDefinitions = {
  worldspawn: defineEntity({
    editor: {
      kind: "solid",
      description: "Static world geometry and environment settings",
      color: [92, 112, 101],
      ...transient,
    },
    properties: {
      mapversion: boundedNumberProperty("Valve map format version", { default: 220 }),
      message: stringProperty("World display name", { default: "Gurgur World" }),
      gravity: boundedNumberProperty("Downward gravity in metres per second squared", {
        default: 10,
        min: 0,
      }),
      skyColor: colorProperty("Linear RGB sky color", { default: "0.08 0.11 0.09" }),
    },
    compile(_context, properties) {
      return {
        kind: "world-settings",
        settings: {
          title: properties.message,
          gravity: { x: 0, y: -properties.gravity, z: 0 },
          skyColor: properties.skyColor,
        },
      };
    },
  }),
  info_player_start: defineEntity({
    editor: {
      kind: "point",
      description: "Player spawn transform",
      color: [80, 180, 255],
      size: [-16, -16, 0, 16, 16, 72],
      ...transient,
    },
    properties: {
      name: stringProperty("Spawn identifier", { default: "default" }),
      angle: yawAngleProperty("Yaw in map-space degrees", { default: 0 }),
    },
    compile(context, properties) {
      return {
        kind: "player-spawn",
        spawn: { name: properties.name, position: origin(context), yaw: properties.angle },
      };
    },
  }),
  func_physics: defineEntity({
    editor: {
      kind: "solid",
      description: "Dynamic convex physics body",
      color: [235, 174, 73],
      ...persistent,
    },
    properties: {
      density: boundedNumberProperty("Mass density", { default: 1, min: 0.001 }),
      friction: boundedNumberProperty("Surface friction", { default: 0.6, min: 0 }),
      restitution: boundedNumberProperty("Bounciness", { default: 0, min: 0, max: 1 }),
    },
    compile(context, properties) {
      return {
        kind: "game-entity",
        entity: {
          kind: "physics-prop",
          authoredId: authoredId(context),
          body: { kind: "dynamic-brush", brushIndices: context.brushIndices, ...properties },
          presentation: { kind: "brush", transform: "body" },
          interaction: "grab",
        },
      };
    },
  }),
  func_door: linearMover("door", 96, 2, [105, 190, 155]),
  func_platform: linearMover("platform", 64, 1, [88, 166, 196]),
  trigger_once: trigger("once", 0, [196, 105, 184]),
  trigger_multiple: trigger("multiple", 0.5, [179, 112, 211]),
  logic_relay: defineEntity({
    editor: {
      kind: "point",
      description: "Typed mechanism signal relay",
      color: [234, 116, 116],
      size: [-16, -16, -16, 16, 16, 16],
      ...persistent,
    },
    properties: {
      targetname: targetNameProperty(),
      target: targetProperty(),
      delay: boundedNumberProperty("Seconds before forwarding", { default: 0, min: 0 }),
      once: booleanProperty("Forward only once per epoch", { default: false }),
    },
    compile(context, properties) {
      return {
        kind: "game-entity",
        entity: {
          kind: "relay",
          authoredId: authoredId(context),
          targetName: properties.targetname,
          target: properties.target,
          delaySeconds: properties.delay,
          once: properties.once,
          body: null,
          presentation: { kind: "none" },
          interaction: "none",
        },
      };
    },
  }),
  func_button: defineEntity({
    editor: {
      kind: "solid",
      description: "Use-activated physical signal source",
      color: [232, 112, 79],
      ...persistent,
    },
    properties: {
      target: targetProperty(),
      wait: boundedNumberProperty("Minimum seconds between uses", { default: 1, min: 0 }),
    },
    compile(context, properties) {
      return {
        kind: "game-entity",
        entity: {
          kind: "button",
          authoredId: authoredId(context),
          target: properties.target,
          waitSeconds: properties.wait,
          body: { kind: "kinematic-brush", brushIndices: context.brushIndices },
          presentation: { kind: "brush", transform: "body" },
          interaction: "use",
        },
      };
    },
  }),
  info_world_reset: defineEntity({
    editor: {
      kind: "point",
      description: "Administrative reset marker and safe observer spawn",
      color: [255, 72, 72],
      size: [-24, -24, -24, 24, 24, 24],
      ...transient,
    },
    properties: {
      label: stringProperty("Administrative display label", { default: "Reset world" }),
    },
    compile(context, properties) {
      return {
        kind: "reset-marker",
        marker: { label: properties.label, position: origin(context) },
      };
    },
  }),
  env_sprite: defineEntity({
    editor: {
      kind: "point",
      description: "Camera-facing decorative sprite",
      color: [119, 218, 172],
      size: [-16, -16, 0, 16, 16, 64],
      ...transient,
    },
    properties: {
      sprite: logicalSpriteAssetProperty("Logical sprite asset ID", { default: "fern" }),
      scale: mapDistanceProperty("Sprite height in map units", { default: 64, min: 1 }),
      glow: booleanProperty("Render without scene lighting", { default: false }),
    },
    compile(context, properties) {
      return {
        kind: "game-entity",
        entity: {
          kind: "sprite",
          origin: origin(context),
          body: null,
          presentation: {
            kind: "sprite",
            asset: properties.sprite,
            height: properties.scale,
            glow: properties.glow,
          },
          interaction: "none",
        },
      };
    },
  }),
} as const;

function linearMover(
  mode: "door" | "platform",
  defaultSpeed: number,
  defaultWait: number,
  color: readonly [number, number, number],
) {
  return defineEntity({
    editor: {
      kind: "solid",
      description: `Signal-driven kinematic ${mode === "door" ? "sliding door" : "moving platform"}`,
      color,
      ...persistent,
    },
    properties: {
      targetname: targetNameProperty(),
      moveDirection: mapDirectionProperty("Map-space movement direction", "0 0 1"),
      distance: mapDistanceProperty("Travel distance in map units", {
        default: 128,
        min: 0,
      }),
      speed: mapSpeedProperty("Travel speed in map units per second", {
        default: defaultSpeed,
        min: 0.001,
      }),
      wait: boundedNumberProperty("Seconds before returning; -1 stays open", {
        default: defaultWait,
        min: -1,
      }),
      startOpen: booleanProperty("Begin at the travelled endpoint", { default: false }),
    },
    compile(context, properties) {
      return {
        kind: "game-entity",
        entity: {
          kind: "linear-mover",
          authoredId: authoredId(context),
          mode,
          targetName: properties.targetname,
          moveDirection: properties.moveDirection,
          distance: properties.distance,
          speed: properties.speed,
          waitSeconds: properties.wait,
          startOpen: properties.startOpen,
          body: { kind: "kinematic-brush", brushIndices: context.brushIndices },
          presentation: { kind: "brush", transform: "body" },
          interaction: "none",
        },
      };
    },
  });
}

function trigger(
  mode: "once" | "multiple",
  defaultWait: number,
  color: readonly [number, number, number],
) {
  return defineEntity({
    editor: {
      kind: "solid",
      description:
        mode === "once"
          ? "Sensor that emits its target once per world epoch"
          : "Repeatable sensor signal source",
      color,
      ...persistent,
    },
    properties: {
      target: targetProperty(),
      wait: boundedNumberProperty("Minimum seconds between signals", {
        default: defaultWait,
        min: 0,
      }),
    },
    compile(context, properties) {
      return {
        kind: "game-entity",
        entity: {
          kind: "trigger",
          authoredId: authoredId(context),
          mode,
          target: properties.target,
          waitSeconds: properties.wait,
          body: { kind: "sensor-brush", brushIndices: context.brushIndices },
          presentation: { kind: "none" },
          interaction: "none",
        },
      };
    },
  });
}

export type EntityClassname = keyof typeof entityDefinitions;
export type PropertyDefinition = EntityProperty<unknown>;
