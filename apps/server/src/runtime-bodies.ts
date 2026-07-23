import type { BodyKind, PhysicsWorld } from "@gurgur/physics";
import type { RuntimeEntity, RuntimeId, WorldBundle } from "@gurgur/shared";
import type { PersistedWorld } from "./store";

type PhysicalRuntimeEntity = Extract<RuntimeEntity, { brushIndex: number }>;
export type RuntimeBody = PhysicalRuntimeEntity & { handle: RuntimeId };

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
    if (
      entity.classname !== "func_physics" &&
      entity.classname !== "func_door" &&
      entity.classname !== "func_platform" &&
      entity.classname !== "func_button"
    )
      continue;
    if (!entity.authoredId || entity.brushIndices.length === 0) {
      throw new Error(
        `physical map entity ${entityIndex} must have at least one brush and an authoredId`,
      );
    }
    const brushIndex = entity.brushIndices[0]!;
    const brush = bundle.brushes[brushIndex]!;
    const type: BodyKind =
      entity.classname === "func_physics"
        ? "dynamic"
        : entity.classname === "func_button"
          ? "static"
          : "kinematic";
    const material = {
      density: Number(entity.runtimeProperties.density ?? 1),
      friction: Number(entity.runtimeProperties.friction ?? 0.6),
      restitution: Number(entity.runtimeProperties.restitution ?? 0),
    };
    const saved = restoredById.get(entity.authoredId);
    const hulls = entity.brushIndices.map((index) => ({
      vertices: bundle.brushes[index]!.worldVertices.map((vertex) => ({
        x: vertex.x - brush.center.x,
        y: vertex.y - brush.center.y,
        z: vertex.z - brush.center.z,
      })),
    }));
    const handle =
      entity.brushIndices.length === 1
        ? saved
          ? physics.restoreHull({ type, vertices: brush.localVertices, ...material, ...saved })
          : physics.createHull({
              type,
              position: brush.center,
              vertices: brush.localVertices,
              ...material,
            })
        : physics.createCompoundHulls({
            type,
            position: saved?.position ?? brush.center,
            rotation: saved?.rotation,
            hulls,
            ...material,
          });
    if (saved && entity.brushIndices.length > 1) {
      physics.setBodyVelocity(handle, saved.linearVelocity, saved.angularVelocity);
      physics.setBodyAwake(handle, saved.awake);
    }
    bodies.push({
      handle,
      id: handle,
      authoredId: entity.authoredId,
      classname: entity.classname,
      brushIndex,
      ...(entity.brushIndices.length > 1 ? { brushIndices: [...entity.brushIndices] } : {}),
    });
  }
  return bodies;
}

function createStressBodies(
  physics: PhysicsWorld,
  bundle: WorldBundle,
  restored: PersistedWorld | null,
  count: number,
): RuntimeBody[] {
  if (!Number.isInteger(count) || count < 0 || count > 512) {
    throw new Error("extra dynamic body count must be between 0 and 512");
  }
  if (count === 0) return [];
  const templateEntity = bundle.entities.find((entity) => entity.classname === "func_physics");
  const brushIndex = templateEntity?.brushIndices[0];
  const brush = brushIndex === undefined ? null : bundle.brushes[brushIndex];
  if (!templateEntity || brushIndex === undefined || !brush) {
    throw new Error("dynamic stress-body template is missing");
  }
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
          density: 1,
          ...saved,
        })
      : physics.createHull({
          type: "dynamic",
          position,
          vertices: brush.localVertices,
          density: 1,
        });
    return { id: handle, handle, authoredId, classname: "func_physics", brushIndex };
  });
}
