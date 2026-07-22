import assert from "node:assert/strict";
import createBox3D from "box3d.js";

const b3 = await createBox3D();
const worldDef = b3.b3DefaultWorldDef();
worldDef.gravity = { x: 0, y: -10, z: 0 };
const world = b3.b3CreateWorld(worldDef);

function staticBox(position: { x: number; y: number; z: number }, halfExtents: { x: number; y: number; z: number }) {
  const bodyDef = b3.b3DefaultBodyDef();
  bodyDef.type = b3.b3BodyType.b3_staticBody;
  bodyDef.position = position;
  const body = b3.b3CreateBody(world, bodyDef);
  return b3.b3CreateBoxShape(body, b3.b3DefaultShapeDef(), halfExtents.x, halfExtents.y, halfExtents.z);
}

staticBox({ x: 0, y: 0, z: 0 }, { x: 10, y: 0.5, z: 10 });
staticBox({ x: 2.5, y: 2, z: 0 }, { x: 0.5, y: 2, z: 10 });
b3.b3World_Step(world, 1 / 60, 4);

const capsule = {
  center1: { x: 0, y: -0.55, z: 0 },
  center2: { x: 0, y: 0.55, z: 0 },
  radius: 0.35,
};
const filter = b3.b3DefaultQueryFilter();
const planeResult = b3.createPlaneResult();

function subtract(a: any, b: any) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: any, b: any) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function multiply(v: any, amount: number) {
  return { x: v.x * amount, y: v.y * amount, z: v.z * amount };
}

function move(start: any, desired: any) {
  let origin = { ...start };
  const target = add(start, desired);

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const planes: any[] = [];
    b3.b3World_CollideMover(world, origin, capsule, filter, (_shape: any, buffer: any) => {
      for (let index = 0; index < b3.getNumPlaneResults(buffer); index += 1) {
        b3.getPlaneResultAt(planeResult, buffer, index);
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
    });

    const solved = b3.b3SolvePlanes(subtract(target, origin), planes);
    const fraction = b3.b3World_CastMover(world, origin, capsule, solved.delta, filter, () => true);
    const delta = multiply(solved.delta, fraction);
    origin = add(origin, delta);
    if (Math.hypot(delta.x, delta.y, delta.z) < 0.001) break;
  }

  return origin;
}

try {
  const standing = { x: 0, y: 1.4, z: 0 };
  const grounded = move(standing, { x: 0, y: -1, z: 0 });
  assert.ok(Math.abs(grounded.y - 1.4) < 0.02, `ground penetration: ${grounded.y}`);

  const stopped = move(standing, { x: 4, y: -0.1, z: 0 });
  assert.ok(stopped.x > 1.6 && stopped.x < 1.7, `wall stop: ${stopped.x}`);

  const sliding = move(standing, { x: 4, y: -0.1, z: 2 });
  assert.ok(sliding.x > 1.6 && sliding.x < 1.7, `wall slide x: ${sliding.x}`);
  assert.ok(sliding.z > 1.8, `wall slide z: ${sliding.z}`);

  console.log("Box3D geometric capsule mover ground/wall/slide: passed");
} finally {
  b3.b3DestroyWorld(world);
}
