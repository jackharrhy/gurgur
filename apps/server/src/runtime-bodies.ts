import type { BodyKind, PhysicsWorld, RuntimeEntityRef, RuntimeId } from "@gurgur/engine";
import type { WorldBundle } from "@gurgur/game";
import type { PersistedWorld } from "./store";

export type RuntimeBody = {
  handle: RuntimeId;
  id: RuntimeId;
  entityIndex: number;
  authoredId: string;
};

export function runtimeBodyRef(body: RuntimeBody): RuntimeEntityRef {
  return { id: body.id, kind: "world-entity", entityIndex: body.entityIndex };
}

export function createRuntimeBodies(
  physics: PhysicsWorld,
  bundle: WorldBundle,
  restored: PersistedWorld | null,
  extraDynamicBodyCount = 0,
): RuntimeBody[] {
  const bodies = createAuthoredBodies(physics, bundle, restored);
  bodies.push(...createStressBodies(physics, bundle, restored, extraDynamicBodyCount));
  return bodies;
}

function createAuthoredBodies(
  physics: PhysicsWorld,
  bundle: WorldBundle,
  restored: PersistedWorld | null,
): RuntimeBody[] {
  const bodies: RuntimeBody[] = [];
  const restoredById = new Map(restored?.bodies.map((body) => [body.authoredId, body]));
  for (const [entityIndex, entity] of bundle.entities.entries()) {
    const spec = entity.body;
    if (!spec) continue;
    if (spec.brushIndices.length === 0)
      throw new Error(`world entity ${entityIndex} must have at least one brush`);
    const authoredId = entity.authoredId ?? `transient.entity.${entityIndex}`;
    const firstBrush = bundle.brushes[spec.brushIndices[0]!]!;
    const saved = restoredById.get(authoredId);
    const authoredPosition =
      entity.kind === "linear-mover" && entity.startOpen
        ? {
            x: firstBrush.center.x + entity.moveDirection.x * entity.distance,
            y: firstBrush.center.y + entity.moveDirection.y * entity.distance,
            z: firstBrush.center.z + entity.moveDirection.z * entity.distance,
          }
        : firstBrush.center;
    if (spec.kind === "sensor-brush") {
      if (spec.brushIndices.length !== 1)
        throw new Error(`sensor entity ${entityIndex} must use exactly one brush`);
      const handle = physics.createSensorHull({
        position: { x: 0, y: 0, z: 0 },
        vertices: firstBrush.worldVertices,
      });
      bodies.push({ handle, id: handle, entityIndex, authoredId });
      continue;
    }
    const type: BodyKind =
      spec.kind === "dynamic-brush"
        ? "dynamic"
        : spec.kind === "kinematic-brush"
          ? "kinematic"
          : "static";
    const material =
      spec.kind === "dynamic-brush"
        ? {
            density: spec.density,
            friction: spec.friction,
            restitution: spec.restitution,
          }
        : {};
    const hulls = spec.brushIndices.map((index) => ({
      vertices: bundle.brushes[index]!.worldVertices.map((vertex) => ({
        x: vertex.x - firstBrush.center.x,
        y: vertex.y - firstBrush.center.y,
        z: vertex.z - firstBrush.center.z,
      })),
    }));
    const handle =
      spec.brushIndices.length === 1
        ? saved
          ? physics.restoreHull({ type, vertices: firstBrush.localVertices, ...material, ...saved })
          : physics.createHull({
              type,
              position: authoredPosition,
              vertices: firstBrush.localVertices,
              ...material,
            })
        : physics.createCompoundHulls({
            type,
            position: saved?.position ?? authoredPosition,
            rotation: saved?.rotation,
            hulls,
            ...material,
          });
    if (saved && spec.brushIndices.length > 1) {
      physics.setBodyVelocity(handle, saved.linearVelocity, saved.angularVelocity);
      physics.setBodyAwake(handle, saved.awake);
    }
    bodies.push({ handle, id: handle, entityIndex, authoredId });
  }
  return bodies;
}

function createStressBodies(
  physics: PhysicsWorld,
  bundle: WorldBundle,
  restored: PersistedWorld | null,
  count: number,
): RuntimeBody[] {
  if (!Number.isInteger(count) || count < 0 || count > 512)
    throw new Error("extra dynamic body count must be between 0 and 512");
  if (count === 0) return [];
  const entityIndex = bundle.entities.findIndex((entity) => entity.kind === "physics-prop");
  const templateEntity = bundle.entities[entityIndex];
  if (!templateEntity || templateEntity.kind !== "physics-prop")
    throw new Error("dynamic stress-body template is missing");
  const brushIndex = templateEntity.body.brushIndices[0];
  const brush = brushIndex === undefined ? null : bundle.brushes[brushIndex];
  if (!brush) throw new Error("dynamic stress-body template brush is missing");
  const restoredById = new Map(restored?.bodies.map((body) => [body.authoredId, body]));
  return Array.from({ length: count }, (_, index) => {
    const authoredId = `stress.dynamic.${index.toString().padStart(3, "0")}`;
    const saved = restoredById.get(authoredId);
    const position = {
      x: 2 + (index % 8) * 3,
      y: 1 + Math.floor(index / 32) * 1.3,
      z: -18 + (Math.floor(index / 8) % 4) * 3,
    };
    const handle = saved
      ? physics.restoreHull({
          type: "dynamic",
          vertices: brush.localVertices,
          density: templateEntity.body.density,
          friction: templateEntity.body.friction,
          restitution: templateEntity.body.restitution,
          ...saved,
        })
      : physics.createHull({
          type: "dynamic",
          position,
          vertices: brush.localVertices,
          density: templateEntity.body.density,
          friction: templateEntity.body.friction,
          restitution: templateEntity.body.restitution,
        });
    return { id: handle, handle, authoredId, entityIndex };
  });
}
