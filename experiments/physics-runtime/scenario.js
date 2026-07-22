export async function runPhysicsScenario(createBox3D) {
  const b3 = await createBox3D();
  const version = b3.b3GetVersion();
  const results = [];

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const worldDef = b3.b3DefaultWorldDef();
    worldDef.gravity = { x: 0, y: -10, z: 0 };
    const world = b3.b3CreateWorld(worldDef);

    if (!b3.b3World_IsValid(world)) throw new Error("Box3D world is invalid");

    const groundDef = b3.b3DefaultBodyDef();
    groundDef.type = b3.b3BodyType.b3_staticBody;
    const ground = b3.b3CreateBody(world, groundDef);
    b3.b3CreateBoxShape(ground, b3.b3DefaultShapeDef(), 8, 0.5, 8);

    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type = b3.b3BodyType.b3_dynamicBody;
    bodyDef.position = { x: cycle * 0.125, y: 6, z: 0 };
    const body = b3.b3CreateBody(world, bodyDef);
    const shape = b3.b3CreateBoxShape(
      body,
      b3.b3DefaultShapeDef(),
      0.5,
      0.5,
      0.5,
    );

    const events = b3.createEventsBuffer();
    b3.b3World_Step(world, 1 / 60, 4);
    b3.getEvents(events, world);
    if (b3.getNumBodyMoveEvents(events) < 1) {
      throw new Error("Expected at least one body movement event");
    }

    for (let tick = 1; tick < 180; tick += 1) {
      b3.b3World_Step(world, 1 / 60, 4);
    }

    const contacts = b3.createContactsBuffer();
    b3.getShapeContactData(contacts, shape);
    const contactCount = b3.getNumContacts(contacts);
    const position = b3.b3Body_GetPosition(body);

    if (contactCount < 1) throw new Error("Falling body did not contact the ground");
    if (!(position.y > 0.9 && position.y < 1.1)) {
      throw new Error(`Unexpected resting height ${position.y}`);
    }

    results.push([
      Number(position.x.toFixed(6)),
      Number(position.y.toFixed(6)),
      Number(position.z.toFixed(6)),
      contactCount,
    ]);

    b3.destroyContactsBuffer(contacts);
    b3.destroyEventsBuffer(events);
    b3.b3DestroyWorld(world);
  }

  return {
    version: `${version.major}.${version.minor}.${version.revision}`,
    results,
  };
}
