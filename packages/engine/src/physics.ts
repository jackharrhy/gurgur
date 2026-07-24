import createBox3D, {
  type b3BodyId,
  type b3CompoundData,
  type b3HeightFieldData,
  type b3JointId,
  type b3MeshData,
  type Box3DModule,
  type BodyMoveEvent,
  type ContactHitEvent,
  type ContactTouchEvent,
  type EventsBuffer,
  type PlaneResultBuffer,
  type SensorTouchEvent,
} from "box3d.js";
import type {
  BodyKind,
  BodySnapshot,
  BodyState,
  ConstraintId,
  PhysicsDebugDraw,
  PhysicsStepEvents,
  Quat,
  RuntimeId,
  Vec3,
} from "./types";
import { drawPhysicsDebug } from "./physics-debug";

type BodySlot = {
  generation: number;
  body: b3BodyId | null;
  meshes: b3MeshData[];
  compounds: b3CompoundData[];
  heightFields: b3HeightFieldData[];
};
type ConstraintSlot = {
  generation: number;
  joint: b3JointId | null;
  bodyA: RuntimeId;
  bodyB: RuntimeId;
};
const PLAYER_PROXY_CATEGORY = 1n << 1n;
const TRIGGER_CATEGORY = 1n << 2n;

export class PhysicsWorld {
  readonly #box3d: Box3DModule;
  readonly #gravity: Vec3;
  #world: ReturnType<Box3DModule["b3CreateWorld"]>;
  readonly #slots: BodySlot[] = [];
  readonly #freeSlots: number[] = [];
  readonly #pendingDestroy = new Set<number>();
  readonly #constraintSlots: ConstraintSlot[] = [];
  readonly #freeConstraintSlots: number[] = [];
  readonly #events: EventsBuffer;
  readonly #sensorEvent: SensorTouchEvent;
  readonly #contactTouchEvent: ContactTouchEvent;
  readonly #contactHitEvent: ContactHitEvent;
  readonly #bodyMoveEvent: BodyMoveEvent;
  readonly #stepEvents: PhysicsStepEvents = {
    sensorBegin: [],
    sensorEnd: [],
    contactBegin: [],
    contactEnd: [],
    contactHit: [],
    moved: [],
  };
  #stepping = false;
  #disposed = false;

  private constructor(box3d: Box3DModule, gravity: Vec3) {
    this.#box3d = box3d;
    this.#gravity = { ...gravity };
    const definition = box3d.b3DefaultWorldDef();
    definition.gravity = this.#gravity;
    this.#world = box3d.b3CreateWorld(definition);
    this.#events = box3d.createEventsBuffer();
    this.#sensorEvent = box3d.createSensorTouchEvent();
    this.#contactTouchEvent = box3d.createContactTouchEvent();
    this.#contactHitEvent = box3d.createContactHitEvent();
    this.#bodyMoveEvent = box3d.createBodyMoveEvent();
  }

  static async create(
    options: {
      locateFile?(path: string): string;
      gravity?: Vec3;
    } = {},
  ): Promise<PhysicsWorld> {
    return new PhysicsWorld(
      await createBox3D(options.locateFile ? { locateFile: options.locateFile } : undefined),
      options.gravity ?? { x: 0, y: -10, z: 0 },
    );
  }

  createBox(options: {
    type: BodyKind;
    position: Vec3;
    halfExtents: Vec3;
    rotation?: Quat;
    density?: number;
  }): RuntimeId {
    this.#assertLive();
    const definition = this.#box3d.b3DefaultBodyDef();
    definition.type = this.#bodyType(options.type);
    definition.position = options.position;
    if (options.rotation) {
      definition.rotation = {
        v: { x: options.rotation.x, y: options.rotation.y, z: options.rotation.z },
        s: options.rotation.w,
      };
    }

    const body = this.#box3d.b3CreateBody(this.#world, definition);
    const shape = this.#box3d.b3DefaultShapeDef();
    shape.density = options.density ?? shape.density;
    shape.enableContactEvents = options.type === "dynamic";
    shape.enableHitEvents = options.type === "dynamic";
    this.#box3d.b3CreateBoxShape(
      body,
      shape,
      options.halfExtents.x,
      options.halfExtents.y,
      options.halfExtents.z,
    );

    return this.#track(body);
  }

  createHull(options: {
    type: BodyKind;
    position: Vec3;
    vertices: Vec3[];
    rotation?: Quat;
    density?: number;
    friction?: number;
    restitution?: number;
  }): RuntimeId {
    this.#assertLive();
    if (options.vertices.length < 4)
      throw new Error("a convex hull requires at least four vertices");
    const definition = this.#box3d.b3DefaultBodyDef();
    definition.type = this.#bodyType(options.type);
    definition.position = options.position;
    if (options.rotation) {
      definition.rotation = {
        v: { x: options.rotation.x, y: options.rotation.y, z: options.rotation.z },
        s: options.rotation.w,
      };
    }
    const body = this.#box3d.b3CreateBody(this.#world, definition);
    const hull = this.#box3d.b3CreateHull(
      options.vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]),
    );
    if (!hull) {
      this.#box3d.b3DestroyBody(body);
      throw new Error("Box3D rejected the convex hull");
    }
    try {
      const shape = this.#box3d.b3DefaultShapeDef();
      shape.density = options.density ?? shape.density;
      shape.baseMaterial.friction = options.friction ?? shape.baseMaterial.friction;
      shape.baseMaterial.restitution = options.restitution ?? shape.baseMaterial.restitution;
      shape.enableContactEvents = options.type === "dynamic";
      shape.enableHitEvents = options.type === "dynamic";
      this.#box3d.b3CreateHullShape(body, shape, hull);
    } finally {
      this.#box3d.b3DestroyHull(hull);
    }
    return this.#track(body);
  }

  createCompoundHulls(options: {
    type: BodyKind;
    position: Vec3;
    rotation?: Quat;
    hulls: Array<{ vertices: Vec3[] }>;
    density?: number;
    friction?: number;
    restitution?: number;
  }): RuntimeId {
    this.#assertLive();
    if (options.hulls.length === 0 || options.hulls.some((hull) => hull.vertices.length < 4)) {
      throw new Error("compound hull bodies require one or more convex hulls");
    }
    const definition = this.#box3d.b3DefaultBodyDef();
    definition.type = this.#bodyType(options.type);
    definition.position = options.position;
    if (options.rotation)
      definition.rotation = {
        v: { x: options.rotation.x, y: options.rotation.y, z: options.rotation.z },
        s: options.rotation.w,
      };
    const body = this.#box3d.b3CreateBody(this.#world, definition);
    try {
      for (const source of options.hulls) {
        const hull = this.#box3d.b3CreateHull(
          source.vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]),
        );
        if (!hull) throw new Error("Box3D rejected a compound convex hull");
        try {
          const shape = this.#box3d.b3DefaultShapeDef();
          shape.density = options.density ?? shape.density;
          shape.baseMaterial.friction = options.friction ?? shape.baseMaterial.friction;
          shape.baseMaterial.restitution = options.restitution ?? shape.baseMaterial.restitution;
          shape.enableContactEvents = options.type === "dynamic";
          shape.enableHitEvents = options.type === "dynamic";
          this.#box3d.b3CreateHullShape(body, shape, hull);
        } finally {
          this.#box3d.b3DestroyHull(hull);
        }
      }
    } catch (error) {
      this.#box3d.b3DestroyBody(body);
      throw error;
    }
    return this.#track(body);
  }

  createPlayerProxy(position: Vec3, capsule: { radius: number; halfSegment: number }): RuntimeId {
    this.#assertLive();
    const definition = this.#box3d.b3DefaultBodyDef();
    definition.type = this.#bodyType("kinematic");
    definition.position = position;
    const body = this.#box3d.b3CreateBody(this.#world, definition);
    const shape = this.#box3d.b3DefaultShapeDef();
    shape.isSensor = false;
    shape.enableSensorEvents = true;
    shape.filter.categoryBits = PLAYER_PROXY_CATEGORY;
    shape.filter.maskBits = TRIGGER_CATEGORY;
    this.#box3d.b3CreateCapsuleShape(body, shape, {
      center1: { x: 0, y: -capsule.halfSegment, z: 0 },
      center2: { x: 0, y: capsule.halfSegment, z: 0 },
      radius: capsule.radius,
    });
    return this.#track(body);
  }

  createSensorHull(options: { position: Vec3; vertices: Vec3[]; rotation?: Quat }): RuntimeId {
    this.#assertLive();
    if (options.vertices.length < 4)
      throw new Error("a sensor hull requires at least four vertices");
    const definition = this.#box3d.b3DefaultBodyDef();
    definition.type = this.#bodyType("static");
    definition.position = options.position;
    if (options.rotation)
      definition.rotation = {
        v: { x: options.rotation.x, y: options.rotation.y, z: options.rotation.z },
        s: options.rotation.w,
      };
    const body = this.#box3d.b3CreateBody(this.#world, definition);
    const hull = this.#box3d.b3CreateHull(
      options.vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]),
    );
    if (!hull) {
      this.#box3d.b3DestroyBody(body);
      throw new Error("Box3D rejected the sensor hull");
    }
    try {
      const shape = this.#box3d.b3DefaultShapeDef();
      shape.isSensor = true;
      shape.enableSensorEvents = true;
      shape.filter.categoryBits = TRIGGER_CATEGORY;
      shape.filter.maskBits = PLAYER_PROXY_CATEGORY;
      this.#box3d.b3CreateHullShape(body, shape, hull);
    } finally {
      this.#box3d.b3DestroyHull(hull);
    }
    return this.#track(body);
  }

  createStaticMesh(options: {
    vertices: Vec3[];
    triangles: Array<[number, number, number]>;
  }): RuntimeId {
    this.#assertLive();
    if (options.vertices.length < 3 || options.triangles.length < 1)
      throw new Error("a static mesh requires vertices and triangles");
    for (const triangle of options.triangles) {
      if (
        triangle.some(
          (index) => !Number.isInteger(index) || index < 0 || index >= options.vertices.length,
        )
      ) {
        throw new Error("static mesh triangle index is out of bounds");
      }
    }
    const definition = this.#box3d.b3DefaultBodyDef();
    definition.type = this.#bodyType("static");
    const body = this.#box3d.b3CreateBody(this.#world, definition);
    const mesh = this.#box3d.b3CreateMesh(
      options.vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]),
      options.triangles.flat(),
    );
    if (!mesh) {
      this.#box3d.b3DestroyBody(body);
      throw new Error("Box3D rejected the static indexed mesh");
    }
    try {
      this.#box3d.b3CreateMeshShape(body, this.#box3d.b3DefaultShapeDef(), mesh, {
        x: 1,
        y: 1,
        z: 1,
      });
    } catch (error) {
      this.#box3d.b3DestroyBody(body);
      this.#box3d.b3DestroyMesh(mesh);
      throw error;
    }
    return this.#track(body, [mesh]);
  }

  createStaticCompound(options: {
    boxes: Array<{ position: Vec3; halfExtents: Vec3; rotation?: Quat }>;
  }): RuntimeId {
    this.#assertLive();
    if (options.boxes.length === 0)
      throw new Error("a static compound requires at least one child");
    for (const box of options.boxes) {
      if (
        ![box.halfExtents.x, box.halfExtents.y, box.halfExtents.z].every(
          (value) => Number.isFinite(value) && value > 0,
        )
      ) {
        throw new Error("static compound half extents must be finite and positive");
      }
    }
    const body = this.#box3d.b3CreateBody(this.#world, this.#box3d.b3DefaultBodyDef());
    const childHulls = options.boxes.map((box) =>
      this.#box3d.b3CreateHull(
        [-1, 1].flatMap((x) =>
          [-1, 1].flatMap((y) =>
            [-1, 1].flatMap((z) => [
              x * box.halfExtents.x,
              y * box.halfExtents.y,
              z * box.halfExtents.z,
            ]),
          ),
        ),
      ),
    );
    if (childHulls.some((hull) => !hull)) {
      for (const hull of childHulls) if (hull) this.#box3d.b3DestroyHull(hull);
      this.#box3d.b3DestroyBody(body);
      throw new Error("Box3D rejected a static compound child hull");
    }
    const compound = this.#box3d.b3CreateCompound({
      hulls: options.boxes.map((box, index) => ({
        hull: childHulls[index],
        transform: {
          p: box.position,
          q: box.rotation
            ? { v: { x: box.rotation.x, y: box.rotation.y, z: box.rotation.z }, s: box.rotation.w }
            : { v: { x: 0, y: 0, z: 0 }, s: 1 },
        },
      })),
    });
    for (const hull of childHulls) if (hull) this.#box3d.b3DestroyHull(hull);
    if (!compound) {
      this.#box3d.b3DestroyBody(body);
      throw new Error("Box3D rejected the static compound");
    }
    try {
      this.#box3d.b3CreateCompoundShape(body, this.#box3d.b3DefaultShapeDef(), compound);
    } catch (error) {
      this.#box3d.b3DestroyBody(body);
      this.#box3d.b3DestroyCompound(compound);
      throw error;
    }
    return this.#track(body, [], [compound]);
  }

  createStaticHeightField(options: {
    heights: number[];
    countX: number;
    countZ: number;
    scale: Vec3;
  }): RuntimeId {
    this.#assertLive();
    if (
      !Number.isInteger(options.countX) ||
      !Number.isInteger(options.countZ) ||
      options.countX < 2 ||
      options.countZ < 2
    ) {
      throw new Error("height field dimensions must be integers of at least two");
    }
    if (
      options.heights.length !== options.countX * options.countZ ||
      options.heights.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("height field requires one finite sample per grid point");
    }
    const body = this.#box3d.b3CreateBody(this.#world, this.#box3d.b3DefaultBodyDef());
    const heightField = this.#box3d.b3CreateHeightField(
      new Float32Array(options.heights),
      options.countX,
      options.countZ,
      options.scale,
    );
    if (!heightField) {
      this.#box3d.b3DestroyBody(body);
      throw new Error("Box3D rejected the static height field");
    }
    try {
      this.#box3d.b3CreateHeightFieldShape(body, this.#box3d.b3DefaultShapeDef(), heightField);
    } catch (error) {
      this.#box3d.b3DestroyBody(body);
      this.#box3d.b3DestroyHeightField(heightField);
      throw error;
    }
    return this.#track(body, [], [], [heightField]);
  }

  restoreBox(options: {
    position: Vec3;
    rotation: Quat;
    linearVelocity: Vec3;
    angularVelocity: Vec3;
    halfExtents: Vec3;
  }): RuntimeId {
    const id = this.createBox({
      type: "dynamic",
      position: options.position,
      rotation: options.rotation,
      halfExtents: options.halfExtents,
    });
    const body = this.#resolve(id);
    this.#box3d.b3Body_SetLinearVelocity(body, options.linearVelocity);
    this.#box3d.b3Body_SetAngularVelocity(body, options.angularVelocity);
    return id;
  }

  restoreHull(options: {
    type: BodyKind;
    position: Vec3;
    rotation: Quat;
    linearVelocity: Vec3;
    angularVelocity: Vec3;
    vertices: Vec3[];
    density?: number;
    friction?: number;
    restitution?: number;
    awake?: boolean;
  }): RuntimeId {
    const id = this.createHull(options);
    const body = this.#resolve(id);
    this.#box3d.b3Body_SetLinearVelocity(body, options.linearVelocity);
    this.#box3d.b3Body_SetAngularVelocity(body, options.angularVelocity);
    if (options.awake !== undefined) this.#box3d.b3Body_SetAwake(body, options.awake);
    return id;
  }

  recreate(): void {
    this.#assertLive();
    if (this.#stepping) throw new Error("cannot recreate physics world during a step");
    this.#box3d.b3DestroyWorld(this.#world);
    for (const slot of this.#slots) {
      this.#destroyBackingResources(slot);
      if (!slot) continue;
      slot.body = null;
      slot.meshes = [];
      slot.compounds = [];
      slot.heightFields = [];
      slot.generation += 1;
    }
    for (const slot of this.#constraintSlots) {
      if (!slot) continue;
      slot.joint = null;
      slot.generation += 1;
    }
    this.#freeConstraintSlots.length = 0;
    for (let index = this.#constraintSlots.length - 1; index >= 0; index -= 1)
      this.#freeConstraintSlots.push(index);
    this.#freeSlots.length = 0;
    for (let index = this.#slots.length - 1; index >= 0; index -= 1) this.#freeSlots.push(index);
    this.#pendingDestroy.clear();
    const definition = this.#box3d.b3DefaultWorldDef();
    definition.gravity = this.#gravity;
    this.#world = this.#box3d.b3CreateWorld(definition);
  }

  destroy(id: RuntimeId): boolean {
    const slot = this.#slots[id.index];
    if (!slot || slot.generation !== id.generation || slot.body === null) return false;
    if (this.#stepping) {
      this.#pendingDestroy.add(id.index);
      return true;
    }
    this.#destroySlot(id.index);
    return true;
  }

  setBodyTransform(id: RuntimeId, position: Vec3, rotation: Quat): void {
    const body = this.#resolve(id);
    this.#box3d.b3Body_SetTransform(body, position, {
      v: { x: rotation.x, y: rotation.y, z: rotation.z },
      s: rotation.w,
    });
  }

  setKinematicTarget(id: RuntimeId, position: Vec3, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error("kinematic target duration must be positive");
    this.#box3d.b3Body_SetTargetTransform(
      this.#resolve(id),
      { p: position, q: { v: { x: 0, y: 0, z: 0 }, s: 1 } },
      seconds,
      true,
    );
  }

  setBodyVelocity(id: RuntimeId, linearVelocity: Vec3, angularVelocity: Vec3): void {
    const body = this.#resolve(id);
    this.#box3d.b3Body_SetLinearVelocity(body, linearVelocity);
    this.#box3d.b3Body_SetAngularVelocity(body, angularVelocity);
  }

  setBodyType(id: RuntimeId, type: BodyKind): void {
    this.#box3d.b3Body_SetType(this.#resolve(id), this.#bodyType(type));
  }

  setBodyAwake(id: RuntimeId, awake: boolean): void {
    this.#box3d.b3Body_SetAwake(this.#resolve(id), awake);
  }

  setBodyEnabled(id: RuntimeId, enabled: boolean): void {
    const body = this.#resolve(id);
    if (enabled) this.#box3d.b3Body_Enable(body);
    else this.#box3d.b3Body_Disable(body);
  }

  pointVelocity(id: RuntimeId, point: Vec3): Vec3 {
    const body = this.#resolve(id);
    const linear = this.#box3d.b3Body_GetLinearVelocity(body);
    const angular = this.#box3d.b3Body_GetAngularVelocity(body);
    const center = this.#box3d.b3Body_GetPosition(body);
    const offset = subtract(point, center);
    return {
      x: linear.x + angular.y * offset.z - angular.z * offset.y,
      y: linear.y + angular.z * offset.x - angular.x * offset.z,
      z: linear.z + angular.x * offset.y - angular.y * offset.x,
    };
  }

  applyLinearImpulse(id: RuntimeId, impulse: Vec3): boolean {
    const body = this.#resolve(id);
    if (this.#box3d.b3Body_GetType(body) !== this.#box3d.b3BodyType.b3_dynamicBody) return false;
    this.#box3d.b3Body_ApplyLinearImpulseToCenter(body, impulse, true);
    return true;
  }

  createDistanceConstraint(options: {
    bodyA: RuntimeId;
    bodyB: RuntimeId;
    worldAnchorA: Vec3;
    worldAnchorB: Vec3;
    length: number;
    hertz?: number;
    dampingRatio?: number;
    maxForce?: number;
  }): ConstraintId {
    const bodyA = this.#resolve(options.bodyA);
    const bodyB = this.#resolve(options.bodyB);
    const definition = this.#box3d.b3DefaultDistanceJointDef();
    definition.base.bodyIdA = bodyA;
    definition.base.bodyIdB = bodyB;
    definition.base.localFrameA.p = this.#box3d.b3Body_GetLocalPoint(bodyA, options.worldAnchorA);
    definition.base.localFrameB.p = this.#box3d.b3Body_GetLocalPoint(bodyB, options.worldAnchorB);
    definition.length = Math.max(0.05, options.length);
    definition.enableSpring = true;
    definition.hertz = options.hertz ?? 8;
    definition.dampingRatio = options.dampingRatio ?? 0.9;
    definition.lowerSpringForce = -(options.maxForce ?? 500);
    definition.upperSpringForce = options.maxForce ?? 500;
    const joint = this.#box3d.b3CreateDistanceJoint(this.#world, definition);
    const index = this.#freeConstraintSlots.pop() ?? this.#constraintSlots.length;
    const generation = this.#constraintSlots[index]?.generation ?? 1;
    this.#constraintSlots[index] = {
      generation,
      joint,
      bodyA: { ...options.bodyA },
      bodyB: { ...options.bodyB },
    };
    return { index, generation };
  }

  destroyConstraint(id: ConstraintId): boolean {
    const slot = this.#constraintSlots[id.index];
    if (!slot || slot.generation !== id.generation || !slot.joint) return false;
    this.#box3d.b3DestroyJoint(slot.joint, true);
    slot.joint = null;
    slot.generation += 1;
    this.#freeConstraintSlots.push(id.index);
    return true;
  }

  step(seconds: number, substeps: number): PhysicsStepEvents {
    this.#assertLive();
    if (this.#stepping) throw new Error("physics step is not reentrant");
    this.#stepping = true;
    try {
      this.#box3d.b3World_Step(this.#world, seconds, substeps);
      this.#box3d.getEvents(this.#events, this.#world);
      for (const events of Object.values(this.#stepEvents)) events.length = 0;
      this.#readSensorEvents(true, this.#stepEvents.sensorBegin);
      this.#readSensorEvents(false, this.#stepEvents.sensorEnd);
      this.#readContactEvents(true, this.#stepEvents.contactBegin);
      this.#readContactEvents(false, this.#stepEvents.contactEnd);
      this.#readContactHits();
      this.#readBodyMoves();
      return this.#stepEvents;
    } finally {
      this.#stepping = false;
      for (const index of this.#pendingDestroy) this.#destroySlot(index);
      this.#pendingDestroy.clear();
    }
  }

  debugDraw(maxPrimitives = 4_096): PhysicsDebugDraw {
    this.#assertLive();
    if (this.#stepping) throw new Error("cannot debug draw during a physics step");
    return drawPhysicsDebug(this.#box3d, this.#world, maxPrimitives);
  }

  moveCapsule(
    start: Vec3,
    desired: Vec3,
    capsuleShape: { radius: number; halfSegment: number },
  ): Vec3 {
    this.#assertLive();
    const capsule = {
      center1: { x: 0, y: -capsuleShape.halfSegment, z: 0 },
      center2: { x: 0, y: capsuleShape.halfSegment, z: 0 },
      radius: capsuleShape.radius,
    };
    const filter = this.#box3d.b3DefaultQueryFilter();
    filter.maskBits &= ~PLAYER_PROXY_CATEGORY;
    const planeResult = this.#box3d.createPlaneResult();
    const target = add(start, desired);
    let origin = { ...start };

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const planes: Array<{
        plane: { normal: Vec3; offset: number };
        pushLimit: number;
        push: number;
        clipVelocity: boolean;
      }> = [];
      this.#box3d.b3World_CollideMover(
        this.#world,
        origin,
        capsule,
        filter,
        (_shape: unknown, buffer: PlaneResultBuffer) => {
          for (let index = 0; index < this.#box3d.getNumPlaneResults(buffer); index += 1) {
            this.#box3d.getPlaneResultAt(planeResult, buffer, index);
            planes.push({
              plane: {
                normal: { ...planeResult.plane.normal },
                offset: planeResult.plane.offset,
              },
              pushLimit: 10,
              push: 0,
              clipVelocity: true,
            });
          }
          return true;
        },
      );

      const solved = this.#box3d.b3SolvePlanes(subtract(target, origin), planes);
      const fraction = this.#box3d.b3World_CastMover(
        this.#world,
        origin,
        capsule,
        solved.delta,
        filter,
        () => true,
      );
      const delta = multiply(solved.delta, fraction);
      origin = add(origin, delta);
      if (Math.hypot(delta.x, delta.y, delta.z) < 0.01) break;
    }

    return origin;
  }

  castCapsule(start: Vec3, desired: Vec3, capsule: { radius: number; halfSegment: number }): Vec3 {
    this.#assertLive();
    const filter = this.#box3d.b3DefaultQueryFilter();
    filter.maskBits &= ~PLAYER_PROXY_CATEGORY;
    const fraction = this.#box3d.b3World_CastMover(
      this.#world,
      start,
      {
        center1: { x: 0, y: -capsule.halfSegment, z: 0 },
        center2: { x: 0, y: capsule.halfSegment, z: 0 },
        radius: capsule.radius,
      },
      desired,
      filter,
      () => true,
    );
    return add(start, multiply(desired, fraction));
  }

  capsuleFits(center: Vec3, capsule: { radius: number; halfSegment: number }): boolean {
    this.#assertLive();
    const filter = this.#box3d.b3DefaultQueryFilter();
    filter.maskBits &= ~PLAYER_PROXY_CATEGORY;
    let overlaps = false;
    const plane = this.#box3d.createPlaneResult();
    this.#box3d.b3World_CollideMover(
      this.#world,
      center,
      {
        center1: { x: 0, y: -capsule.halfSegment, z: 0 },
        center2: { x: 0, y: capsule.halfSegment, z: 0 },
        radius: capsule.radius,
      },
      filter,
      (_shape: unknown, buffer: PlaneResultBuffer) => {
        for (let index = 0; index < this.#box3d.getNumPlaneResults(buffer); index += 1) {
          this.#box3d.getPlaneResultAt(plane, buffer, index);
          if (plane.plane.normal.y < 0.5) {
            overlaps = true;
            break;
          }
        }
        return !overlaps;
      },
    );
    return !overlaps;
  }

  raycastClosest(
    origin: Vec3,
    translation: Vec3,
    options: { includePlayerProxies?: boolean } = {},
  ): { point: Vec3; normal: Vec3; fraction: number; body: RuntimeId } | null {
    this.#assertLive();
    const filter = this.#box3d.b3DefaultQueryFilter();
    if (!options.includePlayerProxies) filter.maskBits &= ~PLAYER_PROXY_CATEGORY;
    const result = this.#box3d.b3World_CastRayClosest(this.#world, origin, translation, filter);
    return result.hit
      ? {
          point: { ...result.point },
          normal: { ...result.normal },
          fraction: result.fraction,
          body: this.#runtimeIdForBody(this.#box3d.b3Shape_GetBody(result.shapeId)),
        }
      : null;
  }

  snapshot(): BodySnapshot[] {
    this.#assertLive();
    const bodies: BodySnapshot[] = [];
    for (let index = 0; index < this.#slots.length; index += 1) {
      const slot = this.#slots[index];
      if (!slot?.body) continue;
      bodies.push({
        id: { index, generation: slot.generation },
        position: { ...this.#box3d.b3Body_GetPosition(slot.body) },
        rotation: this.#rotation(slot.body),
        linearVelocity: { ...this.#box3d.b3Body_GetLinearVelocity(slot.body) },
        angularVelocity: { ...this.#box3d.b3Body_GetAngularVelocity(slot.body) },
      });
    }
    return bodies;
  }

  state(id: RuntimeId): BodyState {
    const body = this.#resolve(id);
    return {
      id: { ...id },
      position: { ...this.#box3d.b3Body_GetPosition(body) },
      rotation: this.#rotation(body),
      linearVelocity: { ...this.#box3d.b3Body_GetLinearVelocity(body) },
      angularVelocity: { ...this.#box3d.b3Body_GetAngularVelocity(body) },
      awake: this.#box3d.b3Body_IsAwake(body),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#box3d.destroyEventsBuffer(this.#events);
    this.#box3d.b3DestroyWorld(this.#world);
    for (const slot of this.#slots) this.#destroyBackingResources(slot);
    this.#disposed = true;
    this.#slots.length = 0;
    this.#freeSlots.length = 0;
    this.#pendingDestroy.clear();
    this.#constraintSlots.length = 0;
    this.#freeConstraintSlots.length = 0;
  }

  #resolve(id: RuntimeId): b3BodyId {
    this.#assertLive();
    const slot = this.#slots[id.index];
    if (!slot || slot.generation !== id.generation || slot.body === null) {
      throw new Error(`stale physics handle ${id.index}:${id.generation}`);
    }
    return slot.body;
  }

  #runtimeIdForBody(body: b3BodyId): RuntimeId {
    const tracked = this.#runtimeIdForEventBody(body);
    if (tracked) return tracked;
    throw new Error("Box3D referenced an untracked body");
  }

  #runtimeIdForEventBody(body: b3BodyId): RuntimeId | null {
    for (let index = 0; index < this.#slots.length; index += 1) {
      const slot = this.#slots[index];
      if (
        slot?.body &&
        slot.body.index1 === body.index1 &&
        slot.body.world0 === body.world0 &&
        slot.body.generation === body.generation
      )
        return { index, generation: slot.generation };
    }
    return null;
  }

  #readSensorEvents(
    begin: boolean,
    events: Array<{ sensor: RuntimeId; visitor: RuntimeId }>,
  ): void {
    const count = begin
      ? this.#box3d.getNumSensorBeginEvents(this.#events)
      : this.#box3d.getNumSensorEndEvents(this.#events);
    for (let index = 0; index < count; index += 1) {
      if (begin) this.#box3d.getSensorBeginEventAt(this.#sensorEvent, this.#events, index);
      else this.#box3d.getSensorEndEventAt(this.#sensorEvent, this.#events, index);
      const sensor = this.#runtimeIdForEventBody(
        this.#box3d.b3Shape_GetBody(this.#sensorEvent.sensorShapeId),
      );
      const visitor = this.#runtimeIdForEventBody(
        this.#box3d.b3Shape_GetBody(this.#sensorEvent.visitorShapeId),
      );
      if (!sensor || !visitor) continue;
      events.push({
        sensor,
        visitor,
      });
    }
  }

  #readContactEvents(begin: boolean, events: Array<{ a: RuntimeId; b: RuntimeId }>): void {
    const count = begin
      ? this.#box3d.getNumContactBeginEvents(this.#events)
      : this.#box3d.getNumContactEndEvents(this.#events);
    for (let index = 0; index < count; index += 1) {
      if (begin) this.#box3d.getContactBeginEventAt(this.#contactTouchEvent, this.#events, index);
      else this.#box3d.getContactEndEventAt(this.#contactTouchEvent, this.#events, index);
      const a = this.#runtimeIdForEventBody(
        this.#box3d.b3Shape_GetBody(this.#contactTouchEvent.shapeIdA),
      );
      const b = this.#runtimeIdForEventBody(
        this.#box3d.b3Shape_GetBody(this.#contactTouchEvent.shapeIdB),
      );
      if (!a || !b) continue;
      events.push({
        a,
        b,
      });
    }
  }

  #readContactHits(): void {
    for (let index = 0; index < this.#box3d.getNumContactHitEvents(this.#events); index += 1) {
      this.#box3d.getContactHitEventAt(this.#contactHitEvent, this.#events, index);
      const a = this.#runtimeIdForEventBody(
        this.#box3d.b3Shape_GetBody(this.#contactHitEvent.shapeIdA),
      );
      const b = this.#runtimeIdForEventBody(
        this.#box3d.b3Shape_GetBody(this.#contactHitEvent.shapeIdB),
      );
      if (!a || !b) continue;
      this.#stepEvents.contactHit.push({
        a,
        b,
        point: { ...this.#contactHitEvent.point },
        normal: { ...this.#contactHitEvent.normal },
        approachSpeed: this.#contactHitEvent.approachSpeed,
      });
    }
  }

  #readBodyMoves(): void {
    for (let index = 0; index < this.#box3d.getNumBodyMoveEvents(this.#events); index += 1) {
      this.#box3d.getBodyMoveEventAt(this.#bodyMoveEvent, this.#events, index);
      const body = this.#runtimeIdForEventBody(this.#bodyMoveEvent.bodyId);
      if (!body) continue;
      this.#stepEvents.moved.push({
        body,
        position: { ...this.#bodyMoveEvent.position },
        rotation: { ...this.#bodyMoveEvent.rotation },
        fellAsleep: this.#bodyMoveEvent.fellAsleep,
      });
    }
  }

  #rotation(body: b3BodyId): Quat {
    const rotation = this.#box3d.b3Body_GetRotation(body);
    return { x: rotation.v.x, y: rotation.v.y, z: rotation.v.z, w: rotation.s };
  }

  #bodyType(type: BodyKind) {
    if (type === "static") return this.#box3d.b3BodyType.b3_staticBody;
    if (type === "kinematic") return this.#box3d.b3BodyType.b3_kinematicBody;
    return this.#box3d.b3BodyType.b3_dynamicBody;
  }

  #track(
    body: b3BodyId,
    meshes: b3MeshData[] = [],
    compounds: b3CompoundData[] = [],
    heightFields: b3HeightFieldData[] = [],
  ): RuntimeId {
    const index = this.#freeSlots.pop() ?? this.#slots.length;
    const existing = this.#slots[index];
    const generation = existing?.generation ?? 1;
    this.#slots[index] = { generation, body, meshes, compounds, heightFields };
    return { index, generation };
  }

  #destroySlot(index: number): void {
    const slot = this.#slots[index];
    if (!slot?.body) return;
    const id = { index, generation: slot.generation };
    for (
      let constraintIndex = 0;
      constraintIndex < this.#constraintSlots.length;
      constraintIndex += 1
    ) {
      const constraint = this.#constraintSlots[constraintIndex];
      if (!constraint?.joint) continue;
      if (sameId(constraint.bodyA, id) || sameId(constraint.bodyB, id)) {
        this.destroyConstraint({ index: constraintIndex, generation: constraint.generation });
      }
    }
    this.#box3d.b3DestroyBody(slot.body);
    this.#destroyBackingResources(slot);
    slot.body = null;
    slot.meshes = [];
    slot.compounds = [];
    slot.heightFields = [];
    slot.generation += 1;
    this.#freeSlots.push(index);
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("physics world is disposed");
  }

  #destroyBackingResources(slot: BodySlot | undefined): void {
    if (!slot) return;
    for (const mesh of slot.meshes) this.#box3d.b3DestroyMesh(mesh);
    for (const compound of slot.compounds) this.#box3d.b3DestroyCompound(compound);
    for (const heightField of slot.heightFields) this.#box3d.b3DestroyHeightField(heightField);
  }
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function multiply(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function sameId(a: RuntimeId, b: RuntimeId): boolean {
  return a.index === b.index && a.generation === b.generation;
}
