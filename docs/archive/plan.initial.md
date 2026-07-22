# Initial Project Plan

> Archived source note. The canonical, corrected design is indexed by
> [`docs/README.md`](../README.md). In particular, its description of Box3D as a
> two-dimensional engine predates Box3D 0.1.0 and is no longer valid.

## Vision

A browser-based multiplayer physics world authored in TrenchBroom.

The world is:

* Minimalist
* Physics-driven
* Puzzle-friendly
* Multiplayer
* Persistent
* Authored using Valve 220 `.map` files
* Presented as one continuous shared world

There are no inventories, checkpoints, progression systems, or permanently solved puzzles.

The server continuously persists the current physical state of the world. Administrators can reset the entire world back to its authored initial state.

## Principles

* Keep the architecture small.
* Prefer direct code over abstractions.
* Use one server process until there is a demonstrated need for more.
* Treat the entire game as one authoritative physics simulation.
* Avoid distributed systems infrastructure.
* Avoid speculative engine architecture.
* Make TrenchBroom the primary content-authoring tool.

## Stack

### Runtime

* Bun
* TypeScript
* `ws`
* Bun SQLite
* Box3D.js

### Client

* TypeScript
* Three.js
* Box3D.js where client-side collision queries or prediction are useful
* WebSocket connection to the authoritative Bun server

### Authoring

* TrenchBroom
* Valve 220 `.map`
* TypeScript-generated FGD
* Custom TypeScript `.map` parser and world compiler

## Repository Layout

```text
apps/
├── client/
└── server/

packages/
├── protocol/
├── simulation/
├── map-format/
├── world-runtime/
├── entity-schema/
└── renderer/

tools/
├── generate-fgd/
└── compile-map/

content/
├── maps/
│   └── world.map
├── textures/
├── models/
└── generated/
    ├── game.fgd
    └── world.bundle

docs/
├── architecture.md
├── map-format.md
├── networking.md
└── entities.md
```

## World Model

The game contains one shared persistent world.

The world is authored as one Valve 220 `.map` file, or as multiple source maps compiled into one runtime world.

The server owns:

* Player state
* Dynamic bodies
* Constraints
* Doors
* Buttons
* Platforms
* Puzzle mechanisms
* Entity state
* World reset state

The client owns only presentation and local input.

## Persistence

Use Bun SQLite.

Persist:

* Dynamic-body transforms
* Dynamic-body velocities
* Entity state
* Constraint state where necessary
* Player positions
* Last successful world save timestamp
* Current world revision

Do not persist every physics tick.

Use periodic snapshots and important-event saves.

Example policy:

```ts
export const persistenceConfig = {
  snapshotIntervalMs: 5_000,
  saveOnPlayerDisconnect: true,
  saveOnImportantEntityChange: true,
} as const;
```

On startup:

1. Load the compiled authored world.
2. Read the latest SQLite snapshot.
3. Confirm the snapshot matches the current world revision.
4. Restore persisted state.
5. Fall back to authored initial state when no compatible snapshot exists.

## Administrative Reset

Provide an administrator-only global reset action.

Reset behavior:

1. Pause simulation.
2. Disconnect or freeze players temporarily.
3. Delete the current persisted world state.
4. Recreate the Box3D world from compiled map data.
5. Restore all entities to authored defaults.
6. Place players at configured spawn points.
7. Persist the new initial snapshot.
8. Resume simulation.
9. Broadcast the new world revision to every client.

The reset should be represented as a reliable protocol event:

```ts
type ServerMessage =
  | {
      type: "world-reset";
      revision: number;
      serverTime: number;
    };
```

## Map Pipeline

```text
TrenchBroom
    │
    ▼
Valve 220 world.map
    │
    ▼
TypeScript parser
    │
    ├── brushes
    ├── faces
    ├── entities
    ├── texture projection
    └── key/value properties
    │
    ▼
world compiler
    │
    ├── visual geometry
    ├── Box3D collision geometry
    ├── dynamic bodies
    ├── entity definitions
    ├── spawn points
    └── authored initial state
    │
    ▼
world.bundle
```

## Valve 220 Parser

The parser must support:

* Entity blocks
* Entity key/value properties
* Convex brushes
* Brush planes
* Valve 220 texture axes
* Texture offsets
* Texture rotation
* Texture scaling
* Point entities
* Brush entities
* Stable source identifiers for validation errors

Suggested parsed representation:

```ts
export interface MapFile {
  entities: MapEntity[];
}

export interface MapEntity {
  id: string;
  properties: Record<string, string>;
  brushes: MapBrush[];
}

export interface MapBrush {
  id: string;
  faces: MapFace[];
}

export interface MapFace {
  id: string;
  plane: {
    a: Vec3;
    b: Vec3;
    c: Vec3;
  };
  texture: string;
  uAxis: TextureAxis;
  vAxis: TextureAxis;
  rotation: number;
  scale: {
    x: number;
    y: number;
  };
}

export interface TextureAxis {
  direction: Vec3;
  offset: number;
}
```

## Geometry Compilation

Each brush is a convex solid represented by intersecting planes.

The compiler should:

1. Convert face points into planes.
2. Generate the polygon for each brush face by clipping against all other brush planes.
3. Triangulate the resulting polygons.
4. Generate render vertices and indices.
5. Calculate Valve 220 texture coordinates.
6. Merge static geometry by material where practical.
7. Generate simplified collision geometry.

Keep the source brush and face IDs attached to generated data for useful compiler errors.

## Box3D World Generation

Static world brushes become Box3D static bodies.

Brush entities can become:

* Static bodies
* Kinematic bodies
* Dynamic bodies
* Sensors
* Compound bodies

Because Box3D is fundamentally two-dimensional, define one clear world-plane convention.

For example:

```text
TrenchBroom X → Box2D X
TrenchBroom Y → visual height
TrenchBroom Z → Box2D Y
```

Under this model:

* Physics runs on the horizontal X/Z plane.
* Render geometry remains fully 3D.
* Height is either decorative or managed through explicit gameplay layers.
* Stairs, ramps, falling, stacking, and arbitrary 3D rigid-body interaction are not physically simulated.

This constraint must be treated as a core game-design decision rather than hidden inside the engine.

If full 3D rigid-body interaction is required, Box3D.js is not sufficient and the project should use a 3D physics engine instead.

## Entity Schema

Define entities once in TypeScript.

The same schema should generate:

* TrenchBroom FGD
* Runtime validation
* Parser types
* Compiler behavior
* Editor documentation

Example:

```ts
export const entityDefinitions = {
  worldspawn: {
    kind: "solid",
    description: "Static world geometry",
    properties: {},
  },

  info_player_spawn: {
    kind: "point",
    description: "Player spawn location",
    color: [80, 180, 255],
    size: [-16, -16, -16, 16, 16, 16],
    properties: {
      name: {
        type: "string",
        description: "Spawn identifier",
        default: "default",
      },
    },
  },

  phys_dynamic: {
    kind: "solid",
    description: "Dynamic physics object",
    properties: {
      density: {
        type: "number",
        default: 1,
      },
      friction: {
        type: "number",
        default: 0.5,
      },
      restitution: {
        type: "number",
        default: 0,
      },
    },
  },

  trigger_volume: {
    kind: "solid",
    description: "Sensor volume",
    properties: {
      channel: {
        type: "string",
      },
    },
  },

  logic_button: {
    kind: "point",
    description: "Activatable button",
    properties: {
      channel: {
        type: "string",
      },
      admin_only: {
        type: "boolean",
        default: false,
      },
    },
  },

  admin_world_reset: {
    kind: "point",
    description: "Administrator-only complete world reset",
    properties: {},
  },
} as const;
```

## FGD Generation

Generate `game.fgd` directly from the TypeScript entity schema.

Example generated output:

```text
@PointClass
size(-16 -16 -16, 16 16 16)
color(80 180 255)
= info_player_spawn : "Player spawn location"
[
    name(string) : "Spawn identifier" : "default"
]

@SolidClass
= phys_dynamic : "Dynamic physics object"
[
    density(float) : "Density" : 1
    friction(float) : "Friction" : 0.5
    restitution(float) : "Restitution" : 0
]

@PointClass
= admin_world_reset : "Administrator-only complete world reset"
[
]
```

The generator should run as part of development:

```fish
bun run generate:fgd
```

## Networking

Use raw WebSockets through `ws`.

The server is authoritative.

Client sends:

```ts
type ClientMessage =
  | {
      type: "input";
      sequence: number;
      movement: {
        x: number;
        y: number;
      };
      actions: number;
      clientTime: number;
    }
  | {
      type: "interact";
      entityId: string;
    }
  | {
      type: "admin-reset-world";
      token: string;
    };
```

Server sends:

```ts
type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      worldRevision: number;
      serverTime: number;
    }
  | {
      type: "snapshot";
      tick: number;
      serverTime: number;
      bodies: BodySnapshot[];
      players: PlayerSnapshot[];
      entities: EntitySnapshot[];
    }
  | {
      type: "entity-event";
      event: EntityEvent;
    }
  | {
      type: "world-reset";
      revision: number;
      serverTime: number;
    };
```

Use:

* Fixed-rate server simulation
* Snapshot interpolation
* Local-player prediction only when necessary
* Reliable events for interactions and reset operations
* Binary encoding only after JSON becomes measurably inadequate

Initial configuration:

```ts
export const simulationConfig = {
  physicsHz: 60,
  snapshotHz: 20,
  maxPlayers: 64,
} as const;
```

## Initial Milestones

### Milestone 1: Map Parser

* Parse a Valve 220 `.map`
* Print entities and brushes
* Produce useful line-numbered validation errors
* Unit-test representative brush and entity cases

### Milestone 2: Visual World

* Compile brush faces into renderable meshes
* Generate Valve 220 UV coordinates
* Render the world in Three.js
* Support basic materials

### Milestone 3: Physics World

* Generate Box3D static collision
* Add one dynamic brush entity
* Add sensors and buttons
* Keep rendered bodies synchronized with physics bodies

### Milestone 4: Multiplayer

* Bun server
* `ws`
* Multiple players
* Authoritative movement
* Snapshot interpolation
* Shared dynamic objects

### Milestone 5: Persistence

* Save world state to SQLite
* Restore after restart
* Version snapshots against compiled map revisions
* Ignore incompatible persisted state safely

### Milestone 6: Administrative Reset

* Add an admin reset entity
* Add authenticated reset protocol
* Rebuild the complete world
* Resynchronize connected clients

## Non-Goals

Do not implement:

* Redis
* Distributed zone servers
* Matchmaking
* Player inventory
* Checkpoints
* Puzzle completion persistence
* Accounts beyond minimal player identity
* Procedural world generation
* Arbitrary mapper scripting
* Public user-generated content hosting
* Microservices
* ECS architecture unless a concrete problem demands it

## Coding-Agent Instructions

Read this document before making architectural decisions.

Prefer small commits.

Before each milestone:

1. Add a concrete checklist to `TODO.md`.
2. Implement the smallest complete slice.
3. Add tests.
4. Update documentation.
5. Commit the completed milestone.

Do not introduce a framework or abstraction unless it removes existing duplication or solves an observed problem.

Gameplay and iteration speed take priority over general-purpose engine design.
