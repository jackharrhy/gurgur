export type PropertyDefinition = {
  type: "string" | "number" | "boolean" | "vector" | "target" | "targetname";
  description: string;
  default?: string | number | boolean;
  conversion?: "map-direction" | "map-distance" | "map-speed" | "yaw-degrees";
};

export type EntityDefinition = {
  kind: "point" | "solid";
  description: string;
  color: readonly [number, number, number];
  size?: readonly [number, number, number, number, number, number];
  persistent: boolean;
  properties: Readonly<Record<string, PropertyDefinition>>;
};

export const ENTITY_SCHEMA_VERSION = 3;

const authoredId: PropertyDefinition = {
  type: "string",
  description: "Stable unique persistence identity",
};
const target: PropertyDefinition = { type: "target", description: "Entity targetname to signal" };
const targetname: PropertyDefinition = {
  type: "targetname",
  description: "Name other entities can target",
};

export const entityDefinitions = {
  worldspawn: {
    kind: "solid",
    description: "Static world geometry and environment settings",
    color: [92, 112, 101],
    persistent: false,
    properties: {
      mapversion: { type: "number", description: "Valve map format version", default: 220 },
      message: { type: "string", description: "World display name", default: "Gurgur World" },
      gravity: {
        type: "number",
        description: "Gravity magnitude in metres per second squared",
        default: 10,
      },
      skyColor: { type: "vector", description: "Linear RGB sky color", default: "0.08 0.11 0.09" },
    },
  },
  info_player_start: {
    kind: "point",
    description: "Player spawn transform",
    color: [80, 180, 255],
    size: [-16, -16, 0, 16, 16, 72],
    persistent: false,
    properties: {
      name: { type: "string", description: "Spawn identifier", default: "default" },
      angle: {
        type: "number",
        description: "Yaw in map-space degrees",
        default: 0,
        conversion: "yaw-degrees",
      },
    },
  },
  func_physics: {
    kind: "solid",
    description: "Dynamic convex physics body",
    color: [235, 174, 73],
    persistent: true,
    properties: {
      authoredId,
      density: { type: "number", description: "Mass density", default: 1 },
      friction: { type: "number", description: "Surface friction", default: 0.6 },
      restitution: { type: "number", description: "Bounciness", default: 0 },
    },
  },
  func_door: {
    kind: "solid",
    description: "Signal-driven kinematic sliding door",
    color: [105, 190, 155],
    persistent: true,
    properties: {
      authoredId,
      targetname,
      moveDirection: {
        type: "vector",
        description: "Map-space movement direction",
        default: "0 0 1",
        conversion: "map-direction",
      },
      distance: {
        type: "number",
        description: "Travel distance in map units",
        default: 128,
        conversion: "map-distance",
      },
      speed: {
        type: "number",
        description: "Travel speed in map units per second",
        default: 96,
        conversion: "map-speed",
      },
      wait: { type: "number", description: "Seconds before returning; -1 stays open", default: 2 },
      startOpen: {
        type: "boolean",
        description: "Begin at the travelled endpoint",
        default: false,
      },
    },
  },
  func_platform: {
    kind: "solid",
    description: "Signal-driven kinematic moving platform",
    color: [88, 166, 196],
    persistent: true,
    properties: {
      authoredId,
      targetname,
      moveDirection: {
        type: "vector",
        description: "Map-space movement direction",
        default: "0 0 1",
        conversion: "map-direction",
      },
      distance: {
        type: "number",
        description: "Travel distance in map units",
        default: 128,
        conversion: "map-distance",
      },
      speed: {
        type: "number",
        description: "Travel speed in map units per second",
        default: 64,
        conversion: "map-speed",
      },
      wait: { type: "number", description: "Seconds at each endpoint", default: 1 },
      startOpen: {
        type: "boolean",
        description: "Begin at the travelled endpoint",
        default: false,
      },
    },
  },
  trigger_once: {
    kind: "solid",
    description: "Sensor that emits its target once per world epoch",
    color: [196, 105, 184],
    persistent: true,
    properties: { authoredId, target },
  },
  trigger_multiple: {
    kind: "solid",
    description: "Repeatable sensor signal source",
    color: [179, 112, 211],
    persistent: true,
    properties: {
      authoredId,
      target,
      wait: { type: "number", description: "Minimum seconds between signals", default: 0.5 },
    },
  },
  logic_relay: {
    kind: "point",
    description: "Typed mechanism signal relay",
    color: [234, 116, 116],
    size: [-16, -16, -16, 16, 16, 16],
    persistent: true,
    properties: {
      authoredId,
      targetname,
      target,
      delay: { type: "number", description: "Seconds before forwarding", default: 0 },
      once: { type: "boolean", description: "Forward only once per epoch", default: false },
    },
  },
  func_button: {
    kind: "solid",
    description: "Use-activated physical signal source",
    color: [232, 112, 79],
    persistent: true,
    properties: {
      authoredId,
      target,
      wait: { type: "number", description: "Minimum seconds between uses", default: 1 },
    },
  },
  info_world_reset: {
    kind: "point",
    description: "Administrative reset marker and safe observer spawn",
    color: [255, 72, 72],
    size: [-24, -24, -24, 24, 24, 24],
    persistent: false,
    properties: {
      label: {
        type: "string",
        description: "Administrative display label",
        default: "Reset world",
      },
    },
  },
  env_sprite: {
    kind: "point",
    description: "Camera-facing decorative sprite",
    color: [119, 218, 172],
    size: [-16, -16, 0, 16, 16, 64],
    persistent: false,
    properties: {
      sprite: { type: "string", description: "Built-in pixel sprite name", default: "fern" },
      scale: {
        type: "number",
        description: "Sprite height in map units",
        default: 64,
        conversion: "map-distance",
      },
      glow: { type: "boolean", description: "Render without scene lighting", default: false },
    },
  },
} as const satisfies Readonly<Record<string, EntityDefinition>>;

export type EntityClassname = keyof typeof entityDefinitions;
