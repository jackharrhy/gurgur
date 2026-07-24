import * as THREE from "three/webgpu";
import {
  FULL_RATE_BODY_RADIUS_METRES,
  MATERIAL_TEXTURE_SIZE,
  SNAPSHOT_FLAG_GRABBED,
  SNAPSHOT_FLAG_LOCAL_GRAB,
  STATE_ALWAYS_NEAR_BODY_SLOTS,
  type BodySnapshot,
  type CompiledBrush,
  type LifecycleMessage,
  type CompiledRenderBatch,
  type PhysicsDebugFrame,
  type PhysicsDebugPrimitive,
  type RuntimeEntityRef,
  type RuntimeId,
  type Vec3,
} from "@gurgur/engine";
import type { WorldMessage } from "@gurgur/game";
import type { SnapshotTimeline } from "./interpolation";
import {
  createPredictedPoseTimeline,
  mergeBodySamples,
  type PredictedPoseTimeline,
} from "./presentation";
import {
  createInteractionOutlineMaterial,
  createRetroRenderPipeline,
  createSpriteNodeMaterial,
  createWorldNodeMaterial,
  type RetroRenderPipeline,
} from "./retro-rendering";
import playerBillboardLayout from "../../../content/generated/player-billboard/player-billboard.json";
import { playerBillboardAtlasOffset, playerBillboardView } from "./player-billboard";

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;
const distance = (left: BodySnapshot["position"], right: BodySnapshot["position"]): number =>
  Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);

type PickupDebugView = {
  group: THREE.Group;
  line: THREE.Line;
  origin: THREE.Mesh;
  endpoint: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicNodeMaterial;
  markerMaterial: THREE.MeshBasicNodeMaterial;
};

type PhysicsDebugView = {
  group: THREE.Group;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicNodeMaterial;
};

function createPickupDebugView(): PickupDebugView {
  const group = new THREE.Group();
  group.name = "pickup-cast-debug";
  group.renderOrder = 1_000;
  group.visible = false;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const lineMaterial = new THREE.LineBasicNodeMaterial({
    color: 0xff405c,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  const markerMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xff405c,
    depthTest: false,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, lineMaterial);
  const markerGeometry = new THREE.SphereGeometry(0.055, 8, 6);
  const origin = new THREE.Mesh(markerGeometry, markerMaterial);
  const endpoint = new THREE.Mesh(markerGeometry, markerMaterial);
  group.add(line, origin, endpoint);
  return { group, line, origin, endpoint, geometry, lineMaterial, markerMaterial };
}

function createPhysicsDebugView(): PhysicsDebugView {
  const group = new THREE.Group();
  group.name = "authoritative-physics-debug";
  group.renderOrder = 999;
  group.visible = false;
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.LineBasicNodeMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.82,
    fog: false,
    toneMapped: false,
  });
  group.add(new THREE.LineSegments(geometry, material));
  return { group, geometry, material };
}

const DEBUG_BOUNDS_EDGES = [
  [0, 1],
  [0, 2],
  [0, 4],
  [1, 3],
  [1, 5],
  [2, 3],
  [2, 6],
  [3, 7],
  [4, 5],
  [4, 6],
  [5, 7],
  [6, 7],
] as const;

function debugBoundsCorners(primitive: Extract<PhysicsDebugPrimitive, { kind: "bounds" }>): Vec3[] {
  const { lower, upper } = primitive;
  return [
    { x: lower.x, y: lower.y, z: lower.z },
    { x: upper.x, y: lower.y, z: lower.z },
    { x: lower.x, y: upper.y, z: lower.z },
    { x: upper.x, y: upper.y, z: lower.z },
    { x: lower.x, y: lower.y, z: upper.z },
    { x: upper.x, y: lower.y, z: upper.z },
    { x: lower.x, y: upper.y, z: upper.z },
    { x: upper.x, y: upper.y, z: upper.z },
  ];
}

function disposeOwnedResources(object: THREE.Object3D): void {
  if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
  if (object instanceof THREE.Mesh && !object.userData.sharedGeometry) object.geometry.dispose();
  if (object.userData.ownedMaterial) {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  }
  const texture = object.userData.ownedTexture;
  if (texture instanceof THREE.Texture) texture.dispose();
}

export class WorldRenderer {
  readonly #renderer: THREE.WebGPURenderer;
  readonly #pipeline: RetroRenderPipeline;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.1, 180);
  readonly #history: SnapshotTimeline;
  readonly #meshes = new Map<string, THREE.Object3D>();
  readonly #materials = new Map<string, THREE.Material>();
  readonly #textures = new Map<string, THREE.Texture>();
  readonly #physicsPropIds = new Set<string>();
  readonly #materialTextureUrls: Readonly<Record<string, string>>;
  readonly #spriteAssetUrls: Readonly<Record<string, string>>;
  readonly #availableOutlineMaterial = createInteractionOutlineMaterial(false);
  readonly #heldOutlineMaterial = createInteractionOutlineMaterial(true);
  readonly #pickupDebug: PickupDebugView | null;
  readonly #physicsDebug: PhysicsDebugView | null;
  #worldRoot = new THREE.Group();
  #localPlayer: RuntimeId | null = null;
  #interactionCandidate: THREE.Object3D | null = null;
  #heldTarget: THREE.Object3D | null = null;
  #outlinedTarget: THREE.Object3D | null = null;
  #pickupPlayerPosition: THREE.Vector3 | null = null;
  readonly #predictedLocal = createPredictedPoseTimeline();
  readonly #predictedBodies = new Map<string, PredictedPoseTimeline>();
  readonly #onLocalPresentation: (body: BodySnapshot) => void;
  readonly #onBodyPresentation: (body: BodySnapshot) => void;
  #viewYaw = 0;
  #viewPitch = -0.18;
  #cameraFollowing = false;

  constructor(
    canvas: HTMLCanvasElement,
    history: SnapshotTimeline,
    onLocalPresentation: (body: BodySnapshot) => void = () => {},
    onBodyPresentation: (body: BodySnapshot) => void = () => {},
    materialTextureUrls: Readonly<Record<string, string>> = {},
    spriteAssetUrls: Readonly<Record<string, string>> = {},
    debug = false,
  ) {
    this.#history = history;
    this.#onLocalPresentation = onLocalPresentation;
    this.#onBodyPresentation = onBodyPresentation;
    this.#materialTextureUrls = materialTextureUrls;
    this.#spriteAssetUrls = spriteAssetUrls;
    this.#renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.#renderer.setPixelRatio(1);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.shadowMap.enabled = false;
    this.#scene.background = new THREE.Color(0x17111f);
    this.#scene.fog = new THREE.Fog(0x17111f, 34, 82);
    this.#camera.position.set(31, 28, 38);
    this.#camera.lookAt(0, 1.5, 0);
    this.#scene.add(this.#worldRoot);
    this.#pickupDebug = debug ? createPickupDebugView() : null;
    if (this.#pickupDebug) this.#scene.add(this.#pickupDebug.group);
    this.#physicsDebug = debug ? createPhysicsDebugView() : null;
    if (this.#physicsDebug) this.#scene.add(this.#physicsDebug.group);
    this.#pipeline = createRetroRenderPipeline(this.#renderer, this.#scene, this.#camera);
    this.#resize();
    addEventListener("resize", this.#resize);
  }

  setWorld(message: WorldMessage): void {
    this.#scene.remove(this.#worldRoot);
    this.#worldRoot.traverse(disposeOwnedResources);
    this.#worldRoot = new THREE.Group();
    this.#worldRoot.name = `world-${message.worldEpoch}`;
    this.#meshes.clear();
    this.#physicsPropIds.clear();
    this.#predictedBodies.clear();
    this.#interactionCandidate = null;
    this.#heldTarget = null;
    this.#outlinedTarget = null;
    this.#pickupPlayerPosition = null;
    if (this.#pickupDebug) this.#pickupDebug.group.visible = false;
    if (this.#physicsDebug) this.#physicsDebug.group.visible = false;
    this.#cameraFollowing = false;
    const sky = message.bundle.settings.skyColor;
    const skyColor = new THREE.Color(sky.r, sky.g, sky.b);
    this.#scene.background = skyColor;
    this.#scene.fog = new THREE.Fog(skyColor, 34, 82);
    for (const batch of message.bundle.renderBatches)
      this.#worldRoot.add(this.#meshForBatch(batch));
    for (const entity of message.bundle.entities) {
      if (entity.kind !== "sprite") continue;
      this.#worldRoot.add(this.#mapSprite(entity));
    }
    for (const runtime of message.runtimeEntities) {
      if (runtime.kind !== "world-entity") continue;
      const entity = message.bundle.entities[runtime.entityIndex];
      if (!entity || entity.presentation.kind !== "brush" || !entity.body) continue;
      const brushIndices = entity.body.brushIndices;
      const origin = message.bundle.brushes[brushIndices[0]!]?.center;
      if (!origin) continue;
      const group = new THREE.Group();
      group.name = `${entity.kind}.${runtime.entityIndex}`;
      for (const brushIndex of brushIndices) {
        const brush = message.bundle.brushes[brushIndex];
        if (!brush) continue;
        const mesh = this.#meshForBrush(brush, true);
        mesh.position.set(
          brush.center.x - origin.x,
          brush.center.y - origin.y,
          brush.center.z - origin.z,
        );
        mesh.userData.runtimeId = runtime.id;
        mesh.userData.interactable = entity.interaction !== "none";
        mesh.userData.grabbable = entity.interaction === "grab";
        mesh.userData.interactionOccluder = true;
        if (mesh.userData.grabbable) this.#addInteractionOutline(mesh);
        group.add(mesh);
      }
      this.#meshes.set(idKey(runtime.id), group);
      if (entity.kind === "physics-prop") this.#physicsPropIds.add(idKey(runtime.id));
      this.#worldRoot.add(group);
    }
    for (const player of message.runtimeEntities.filter((entity) => entity.kind === "player"))
      this.#addPlayer(player);
    this.#scene.add(this.#worldRoot);
  }

  applyLifecycle(message: LifecycleMessage): void {
    for (const id of message.removed) {
      const mesh = this.#meshes.get(idKey(id));
      if (!mesh) continue;
      this.#meshes.delete(idKey(id));
      this.#predictedBodies.delete(idKey(id));
      this.#worldRoot.remove(mesh);
      mesh.traverse(disposeOwnedResources);
    }
    for (const entity of message.created) if (entity.kind === "player") this.#addPlayer(entity);
  }

  setLocalPlayer(id: RuntimeId): void {
    this.#localPlayer = id;
  }

  setPredictedPlayer(body: BodySnapshot | null): void {
    if (body) this.#predictedLocal.push(body, performance.now());
    else this.#predictedLocal.clear();
  }

  setPredictedBodies(bodies: BodySnapshot[]): void {
    const now = performance.now();
    const retained = new Set<string>();
    for (const body of bodies) {
      const identity = idKey(body.id);
      retained.add(identity);
      const timeline = this.#predictedBodies.get(identity) ?? createPredictedPoseTimeline();
      timeline.push(body, now);
      this.#predictedBodies.set(identity, timeline);
    }
    for (const identity of this.#predictedBodies.keys()) {
      if (!retained.has(identity)) this.#predictedBodies.delete(identity);
    }
  }

  applyAuthoritativeInteractionState(bodies: BodySnapshot[]): void {
    for (const body of bodies) {
      const mesh = this.#meshes.get(idKey(body.id));
      if (!mesh) continue;
      mesh.userData.snapshotFlags = body.flags ?? 0;
      if ((body.flags ?? 0) & SNAPSHOT_FLAG_LOCAL_GRAB) {
        this.#heldTarget = mesh;
      } else if (this.#heldTarget === mesh) {
        this.#heldTarget = null;
      }
    }
    this.#updateInteractionOutline();
  }

  setViewAngles(yaw: number, pitch: number): void {
    this.#viewYaw = yaw;
    this.#viewPitch = pitch;
  }

  interactionTarget(): RuntimeId | null {
    const playerPosition = this.#pickupPlayerPosition;
    if (!playerPosition) return null;
    const horizontal = Math.cos(this.#viewPitch);
    const direction = new THREE.Vector3(
      -Math.sin(this.#viewYaw) * horizontal,
      Math.sin(this.#viewPitch),
      -Math.cos(this.#viewYaw) * horizontal,
    );
    const origin = new THREE.Vector3(playerPosition.x, playerPosition.y + 0.4, playerPosition.z);
    const raycaster = new THREE.Raycaster();
    raycaster.set(origin, direction);
    raycaster.camera = this.#camera;
    raycaster.far = 3;
    for (const hit of raycaster.intersectObject(this.#worldRoot, true)) {
      const object = hit.object;
      if (object.userData.interactable && object.userData.runtimeId) {
        const target = { ...object.userData.runtimeId } as RuntimeId;
        const runtimeObject = this.#meshes.get(idKey(target)) ?? null;
        const flags = Number(runtimeObject?.userData.snapshotFlags ?? 0);
        this.#interactionCandidate =
          object.userData.grabbable && (flags & SNAPSHOT_FLAG_GRABBED) === 0 ? runtimeObject : null;
        this.#updateInteractionOutline();
        const unavailable = object.userData.grabbable && (flags & SNAPSHOT_FLAG_GRABBED) !== 0;
        this.#updatePickupDebug(
          origin,
          hit.point,
          unavailable ? 0xff405c : object.userData.grabbable ? 0x31ffc0 : 0x6fc7ff,
        );
        if (unavailable) return null;
        return target;
      }
      if (object.userData.interactionOccluder !== false) {
        this.#interactionCandidate = null;
        this.#updateInteractionOutline();
        this.#updatePickupDebug(origin, hit.point, 0xff405c);
        return null;
      }
    }
    this.#interactionCandidate = null;
    this.#updateInteractionOutline();
    this.#updatePickupDebug(origin, origin.clone().addScaledVector(direction, 3), 0xff405c);
    return null;
  }

  interactionOutlineState(): "available" | "held" | "none" {
    if (this.#heldTarget) return "held";
    return this.#interactionCandidate ? "available" : "none";
  }

  applyPhysicsDebugFrame(frame: PhysicsDebugFrame): void {
    if (!this.#physicsDebug) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    const appendLine = (from: Vec3, to: Vec3, hex: number): void => {
      positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
      color.setHex(hex);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    };
    for (const primitive of frame.primitives) {
      if (primitive.kind === "segment") {
        appendLine(primitive.from, primitive.to, primitive.color);
      } else if (primitive.kind === "bounds") {
        const corners = debugBoundsCorners(primitive);
        for (const [from, to] of DEBUG_BOUNDS_EDGES)
          appendLine(corners[from]!, corners[to]!, primitive.color);
      } else {
        const radius = Math.max(0.045, Math.min(0.16, primitive.size * 0.008));
        appendLine(
          { x: primitive.position.x - radius, y: primitive.position.y, z: primitive.position.z },
          { x: primitive.position.x + radius, y: primitive.position.y, z: primitive.position.z },
          primitive.color,
        );
        appendLine(
          { x: primitive.position.x, y: primitive.position.y - radius, z: primitive.position.z },
          { x: primitive.position.x, y: primitive.position.y + radius, z: primitive.position.z },
          primitive.color,
        );
        appendLine(
          { x: primitive.position.x, y: primitive.position.y, z: primitive.position.z - radius },
          { x: primitive.position.x, y: primitive.position.y, z: primitive.position.z + radius },
          primitive.color,
        );
      }
    }
    this.#physicsDebug.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    this.#physicsDebug.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.#physicsDebug.geometry.computeBoundingSphere();
    this.#physicsDebug.group.visible = positions.length > 0;
  }

  start(): void {
    const render = (): void => {
      if (document.hidden) return;
      const latest = this.#history.latestTick;
      if (latest !== null) {
        const now = performance.now();
        const estimatedServerTick = this.#history.serverTickAt(now);
        const authoritative = this.#history.sample(
          estimatedServerTick - this.#history.interpolationDelayTicks,
        );
        const current = this.#history.sample(estimatedServerTick);
        const predictedLocal = this.#predictedLocal.sample(now);
        const contactProps = predictedLocal
          ? current
              .filter(
                (body) =>
                  this.#physicsPropIds.has(idKey(body.id)) &&
                  distance(body.position, predictedLocal.position) <= FULL_RATE_BODY_RADIUS_METRES,
              )
              .toSorted(
                (left, right) =>
                  distance(left.position, predictedLocal.position) -
                  distance(right.position, predictedLocal.position),
              )
              .slice(0, STATE_ALWAYS_NEAR_BODY_SLOTS)
          : [];
        const predictedBodies = [...this.#predictedBodies.values()].flatMap((timeline) => {
          const body = timeline.sample(now);
          return body ? [body] : [];
        });
        this.#apply(
          mergeBodySamples(mergeBodySamples(authoritative, contactProps), predictedBodies),
        );
        if (predictedLocal) {
          this.#apply([predictedLocal]);
          this.#follow(predictedLocal);
          this.#onLocalPresentation(predictedLocal);
        } else if (this.#localPlayer) {
          const local = current.find((body) => idKey(body.id) === idKey(this.#localPlayer!));
          if (local) {
            this.#apply([local]);
            this.#follow(local);
          }
        }
      }
      this.#pipeline.render();
    };
    this.#renderer.setAnimationLoop(render);
  }

  dispose(): void {
    this.#renderer.setAnimationLoop(null);
    removeEventListener("resize", this.#resize);
    this.#worldRoot.traverse(disposeOwnedResources);
    for (const material of this.#materials.values()) material.dispose();
    for (const texture of this.#textures.values()) texture.dispose();
    this.#availableOutlineMaterial.dispose();
    this.#heldOutlineMaterial.dispose();
    if (this.#pickupDebug) {
      this.#pickupDebug.geometry.dispose();
      this.#pickupDebug.origin.geometry.dispose();
      this.#pickupDebug.lineMaterial.dispose();
      this.#pickupDebug.markerMaterial.dispose();
    }
    if (this.#physicsDebug) {
      this.#physicsDebug.geometry.dispose();
      this.#physicsDebug.material.dispose();
    }
    this.#pipeline.dispose();
    this.#renderer.dispose();
  }

  #meshForBrush(brush: CompiledBrush, local: boolean): THREE.Mesh {
    const vertices = local ? brush.localVertices : brush.worldVertices;
    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (let triangleIndex = 0; triangleIndex < brush.triangles.length; triangleIndex += 1) {
      const triangle = brush.triangles[triangleIndex]!;
      const normal = brush.triangleNormals[triangleIndex]!;
      const triangleUvs = brush.triangleUvs[triangleIndex]!;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = vertices[triangle[corner]!]!;
        positions.push(vertex.x, vertex.y, vertex.z);
        normals.push(normal.x, normal.y, normal.z);
        uvs.push(
          triangleUvs[corner]!.x / MATERIAL_TEXTURE_SIZE,
          triangleUvs[corner]!.y / MATERIAL_TEXTURE_SIZE,
        );
      }
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    const materialNames = [...new Set(brush.triangleMaterials)];
    const materialIndices = new Map(materialNames.map((name, index) => [name, index]));
    for (let triangle = 0; triangle < brush.triangles.length; triangle += 1) {
      geometry.addGroup(
        triangle * 3,
        3,
        materialIndices.get(brush.triangleMaterials[triangle]!) ?? 0,
      );
    }
    const mesh = new THREE.Mesh(
      geometry,
      materialNames.map((name) => this.#material(name, false)),
    );
    mesh.name = `brush.${brush.entityIndex}.${brush.sourceBrushIndex}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.interactionOccluder = true;
    return mesh;
  }

  #meshForBatch(batch: CompiledRenderBatch): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        batch.positions.flatMap((v) => [v.x, v.y, v.z]),
        3,
      ),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(
        batch.normals.flatMap((v) => [v.x, v.y, v.z]),
        3,
      ),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(
        batch.uvs.flatMap((v) => [v.x / MATERIAL_TEXTURE_SIZE, v.y / MATERIAL_TEXTURE_SIZE]),
        2,
      ),
    );
    geometry.setIndex(batch.indices);
    const mesh = new THREE.Mesh(geometry, this.#material(batch.material, batch.sensor));
    mesh.name = `material.${batch.material}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.interactionOccluder = !batch.sensor;
    return mesh;
  }

  #addPlayer(player: Extract<RuntimeEntityRef, { kind: "player" }>): void {
    if (this.#meshes.has(idKey(player.id))) return;
    const local = this.#localPlayer && idKey(player.id) === idKey(this.#localPlayer);
    const texture = new THREE.TextureLoader().load("/player-billboard.png");
    texture.name = `player-billboard:${idKey(player.id)}`;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(1 / playerBillboardLayout.columns, 1 / playerBillboardLayout.rows);
    const initialOffset = playerBillboardAtlasOffset(0, playerBillboardLayout);
    texture.offset.set(initialOffset.x, initialOffset.y);
    const material = createSpriteNodeMaterial(texture, false);
    material.alphaTest = 0.45;
    if (local) material.color.set(0xfff2cc);
    const mesh = new THREE.Sprite(material);
    mesh.center.set(playerBillboardLayout.quad.center.x, playerBillboardLayout.quad.center.y);
    mesh.scale.set(
      playerBillboardLayout.quad.widthMeters,
      playerBillboardLayout.quad.heightMeters,
      1,
    );
    mesh.name = `player.${idKey(player.id)}`;
    mesh.userData.ownedMaterial = true;
    mesh.userData.ownedTexture = texture;
    mesh.userData.playerDirection = 0;
    mesh.userData.runtimeId = player.id;
    mesh.userData.interactionOccluder = false;
    this.#meshes.set(idKey(player.id), mesh);
    this.#worldRoot.add(mesh);
  }

  #material(name: string, sensor: boolean): THREE.Material {
    const key = `${name}:${sensor ? "sensor" : "solid"}`;
    const cached = this.#materials.get(key);
    if (cached) return cached;
    const material = createWorldNodeMaterial(sensor ? null : this.#texture(name), name, sensor);
    this.#materials.set(key, material);
    return material;
  }

  #texture(name: string): THREE.Texture {
    const cached = this.#textures.get(name);
    if (cached) return cached;
    const url = this.#materialTextureUrls[name];
    if (!url) throw new Error(`missing authored material texture: ${name}`);
    const texture = new THREE.TextureLoader().load(url);
    texture.name = name;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    this.#textures.set(name, texture);
    return texture;
  }

  #mapSprite(
    entity: Extract<WorldMessage["bundle"]["entities"][number], { kind: "sprite" }>,
  ): THREE.Sprite {
    const spriteName = entity.presentation.asset;
    const glow = entity.presentation.glow;
    const material = createSpriteNodeMaterial(this.#spriteTexture(spriteName), glow);
    const sprite = new THREE.Sprite(material);
    const height = entity.presentation.height;
    sprite.center.set(0.5, 0.04);
    sprite.scale.set(height, height, 1);
    sprite.position.set(entity.origin.x, entity.origin.y, entity.origin.z);
    sprite.name = `sprite.${spriteName}`;
    sprite.userData.ownedMaterial = true;
    sprite.userData.interactionOccluder = false;
    return sprite;
  }

  #spriteTexture(name: string): THREE.Texture {
    const key = `sprite:${name}`;
    const cached = this.#textures.get(key);
    if (cached) return cached;
    const url = this.#spriteAssetUrls[name];
    if (!url) throw new Error(`missing authored sprite asset: ${name}`);
    const texture = new THREE.TextureLoader().load(url);
    texture.name = key;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    this.#textures.set(key, texture);
    return texture;
  }

  #apply(bodies: BodySnapshot[]): void {
    for (const body of bodies) {
      const mesh = this.#meshes.get(idKey(body.id));
      if (!mesh) continue;
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      mesh.quaternion.set(body.rotation.x, body.rotation.y, body.rotation.z, body.rotation.w);
      const texture = mesh.userData.ownedTexture;
      if (mesh instanceof THREE.Sprite && texture instanceof THREE.Texture) {
        const yaw = 2 * Math.atan2(body.rotation.y, body.rotation.w);
        const direction = playerBillboardView(
          yaw,
          this.#camera.position.x,
          this.#camera.position.y,
          this.#camera.position.z,
          body.position.x,
          body.position.y,
          body.position.z,
          playerBillboardLayout.views,
        );
        if (mesh.userData.playerDirection !== direction) {
          const offset = playerBillboardAtlasOffset(direction, playerBillboardLayout);
          texture.offset.set(offset.x, offset.y);
          mesh.userData.playerDirection = direction;
        }
      }
      this.#onBodyPresentation(body);
    }
    this.#updateInteractionOutline();
  }

  #addInteractionOutline(mesh: THREE.Mesh): void {
    const outline = new THREE.Mesh(mesh.geometry, this.#availableOutlineMaterial);
    outline.name = `${mesh.name}.interaction-outline`;
    outline.scale.setScalar(1.045);
    outline.visible = false;
    outline.userData.interactionOutline = true;
    outline.userData.interactionOccluder = false;
    outline.userData.sharedGeometry = true;
    outline.raycast = () => {};
    mesh.add(outline);
  }

  #updateInteractionOutline(): void {
    const target = this.#heldTarget ?? this.#interactionCandidate;
    if (this.#outlinedTarget !== target) {
      this.#setInteractionOutline(this.#outlinedTarget, false, false);
      this.#outlinedTarget = target;
    }
    this.#setInteractionOutline(target, true, target === this.#heldTarget);
  }

  #setInteractionOutline(target: THREE.Object3D | null, visible: boolean, held: boolean): void {
    target?.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.userData.interactionOutline) return;
      object.visible = visible;
      object.material = held ? this.#heldOutlineMaterial : this.#availableOutlineMaterial;
    });
  }

  #updatePickupDebug(origin: THREE.Vector3, endpoint: THREE.Vector3, color: number): void {
    if (!this.#pickupDebug) return;
    const positions = this.#pickupDebug.geometry.getAttribute("position");
    positions.setXYZ(0, origin.x, origin.y, origin.z);
    positions.setXYZ(1, endpoint.x, endpoint.y, endpoint.z);
    positions.needsUpdate = true;
    this.#pickupDebug.geometry.computeBoundingSphere();
    this.#pickupDebug.origin.position.copy(origin);
    this.#pickupDebug.endpoint.position.copy(endpoint);
    this.#pickupDebug.group.visible = true;
    this.#pickupDebug.lineMaterial.color.setHex(color);
    this.#pickupDebug.markerMaterial.color.setHex(color);
  }

  #follow(player: BodySnapshot): void {
    this.#pickupPlayerPosition ??= new THREE.Vector3();
    this.#pickupPlayerPosition.set(player.position.x, player.position.y, player.position.z);
    const target = new THREE.Vector3(player.position.x, player.position.y + 0.4, player.position.z);
    const horizontal = Math.cos(this.#viewPitch);
    const forward = new THREE.Vector3(
      -Math.sin(this.#viewYaw) * horizontal,
      Math.sin(this.#viewPitch),
      -Math.cos(this.#viewYaw) * horizontal,
    );
    const desired = target.clone().addScaledVector(forward, -4.2);
    if (this.#cameraFollowing) this.#camera.position.lerp(desired, 0.18);
    else this.#camera.position.copy(desired);
    this.#cameraFollowing = true;
    this.#camera.lookAt(target);
  }

  readonly #resize = (): void => {
    const canvas = this.#renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    this.#camera.aspect = width / Math.max(1, height);
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height, false);
    this.#pipeline.resize(width, height);
  };
}
