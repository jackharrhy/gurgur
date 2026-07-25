import * as THREE from "three/webgpu";
import {
  SNAPSHOT_FLAG_GRABBED,
  SNAPSHOT_FLAG_LOCAL_GRAB,
  type BodySnapshot,
  type CompiledBrush,
  type LifecycleMessage,
  type CompiledRenderBatch,
  type PhysicsDebugFrame,
  type PhysicsDebugPrimitive,
  type RuntimeEntityRef,
  type RuntimeId,
  type TracePresentationFrame,
  type TracePresentedBody,
  type Vec3,
} from "@gurgur/engine";
import { PLAYER_GRAB_REACH, type WorldMessage } from "@gurgur/game";
import type { SnapshotTimeline } from "./interpolation";
import {
  createPredictedPoseTimeline,
  mergeBodySamples,
  type PredictedPoseTimeline,
} from "./presentation";
import {
  createInteractionOutlineMaterial,
  createInteractionOutlineMaskMaterial,
  createRealityNodeMaterial,
  createRetroRenderPipeline,
  createSpriteNodeMaterial,
  createWorldNodeMaterial,
  INTERACTION_OUTLINE_MASK_RENDER_ORDER,
  INTERACTION_OUTLINE_RENDER_ORDER,
  INTERACTION_OUTLINE_SCALE,
  PLAYER_RENDER_ORDER,
  type RetroRenderPipeline,
} from "./retro-rendering";
import playerBillboardLayout from "../../../content/generated/player-billboard/player-billboard.json";
import { playerBillboardAtlasOffset, playerBillboardView } from "./player-billboard";
import {
  CAMERA_BOOM_LENGTH,
  CAMERA_DISCONTINUITY_DISTANCE,
  cameraBoomClearance,
  createCameraBoomState,
  createCameraCollisionMesh,
  stepCameraBoom,
  type CameraBoomState,
} from "./camera";
import { createPresentationLight, VOLUMETRIC_LIGHT_LAYER } from "./lighting";

type MaterialTextureInfo = {
  url: string;
  width: number;
  height: number;
  renderMode: "retro" | "reality";
};

export function normalizeMaterialUv(
  uv: { x: number; y: number },
  texture: Pick<MaterialTextureInfo, "width" | "height">,
): [number, number] {
  return [uv.x / texture.width, -uv.y / texture.height];
}

export function createWebGPUOnlyRenderer(canvas: HTMLCanvasElement): THREE.Renderer {
  const backend = new THREE.WebGPUBackend({
    canvas,
    powerPreference: "high-performance",
  });
  const renderer = new THREE.Renderer(backend, {
    antialias: false,
    getFallback: null,
  });
  renderer.library = new THREE.StandardNodeLibrary();
  return renderer;
}

export function renderableBrushTriangleIndices(
  brush: Pick<CompiledBrush, "triangles" | "triangleSourceFaces" | "collisionOnlyFaceIndices">,
): number[] {
  const collisionOnlyFaces = new Set(brush.collisionOnlyFaceIndices);
  return brush.triangles.flatMap((_, triangleIndex) =>
    collisionOnlyFaces.has(brush.triangleSourceFaces[triangleIndex]!) ? [] : [triangleIndex],
  );
}

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;

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

function disposeLightResources(object: THREE.Object3D): void {
  if (
    object instanceof THREE.DirectionalLight ||
    object instanceof THREE.PointLight ||
    object instanceof THREE.SpotLight
  )
    object.shadow.dispose();
}

export function createBillboardGeometry(
  width: number,
  height: number,
  center: { x: number; y: number },
): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate((0.5 - center.x) * width, (0.5 - center.y) * height, 0);
  return geometry;
}

export class WorldRenderer {
  readonly #renderer: THREE.Renderer;
  readonly #pipeline: RetroRenderPipeline;
  readonly #scene = new THREE.Scene();
  readonly #realityScene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.1, 180);
  readonly #history: SnapshotTimeline;
  readonly #meshes = new Map<string, THREE.Object3D>();
  readonly #materials = new Map<string, THREE.Material>();
  readonly #textures = new Map<string, THREE.Texture>();
  readonly #materialTextures: Readonly<Record<string, MaterialTextureInfo>>;
  readonly #spriteAssetUrls: Readonly<Record<string, string>>;
  readonly #outlineMaskMaterial = createInteractionOutlineMaskMaterial();
  readonly #availableOutlineMaterial = createInteractionOutlineMaterial(false);
  readonly #heldOutlineMaterial = createInteractionOutlineMaterial(true);
  readonly #cameraCollisionMaterial = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
  });
  readonly #cameraRaycaster = new THREE.Raycaster();
  readonly #pickupDebug: PickupDebugView | null;
  readonly #physicsDebug: PhysicsDebugView | null;
  #worldRoot = new THREE.Group();
  #realityRoot = new THREE.Group();
  #lightRoot = new THREE.Group();
  #realityLightRoot = new THREE.Group();
  #cameraCollisionRoot = new THREE.Group();
  readonly #cameraCollisionBodies = new Map<string, THREE.Object3D>();
  #localPlayer: RuntimeId | null = null;
  #interactionCandidate: THREE.Object3D | null = null;
  #heldTarget: THREE.Object3D | null = null;
  #outlinedTarget: THREE.Object3D | null = null;
  #pickupPlayerPosition: THREE.Vector3 | null = null;
  readonly #predictedLocal = createPredictedPoseTimeline();
  readonly #predictedBodies = new Map<string, PredictedPoseTimeline>();
  readonly #onLocalPresentation: (body: BodySnapshot) => void;
  readonly #onBodyPresentation: (body: BodySnapshot) => void;
  #traceSink: ((frame: TracePresentationFrame) => void) | null = null;
  #viewYaw = 0;
  #viewPitch = -0.18;
  #followTarget: RuntimeId | null = null;
  #onFollowPresentation: (body: BodySnapshot) => void = () => {};
  #cameraFollowing = false;
  #cameraBoom: CameraBoomState = createCameraBoomState();
  #cameraSafeDistance = CAMERA_BOOM_LENGTH;
  #cameraFrameTime: number | null = null;
  readonly #cameraPreviousPivot = new THREE.Vector3();

  constructor(
    canvas: HTMLCanvasElement,
    history: SnapshotTimeline,
    onLocalPresentation: (body: BodySnapshot) => void = () => {},
    onBodyPresentation: (body: BodySnapshot) => void = () => {},
    materialTextures: Readonly<Record<string, MaterialTextureInfo>> = {},
    spriteAssetUrls: Readonly<Record<string, string>> = {},
    debug = false,
  ) {
    this.#history = history;
    this.#onLocalPresentation = onLocalPresentation;
    this.#onBodyPresentation = onBodyPresentation;
    this.#materialTextures = materialTextures;
    this.#spriteAssetUrls = spriteAssetUrls;
    this.#renderer = createWebGPUOnlyRenderer(canvas);
    document.body.dataset.rendererBackend =
      this.#renderer.backend instanceof THREE.WebGPUBackend ? "webgpu" : "unknown";
    this.#renderer.setPixelRatio(1);
    this.#renderer.setClearAlpha(0);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFShadowMap;
    this.#scene.background = null;
    this.#scene.fog = new THREE.Fog(0x17111f, 34, 82);
    this.#camera.position.set(31, 28, 38);
    this.#camera.lookAt(0, 1.5, 0);
    this.#scene.add(this.#worldRoot);
    this.#scene.add(this.#lightRoot);
    this.#realityScene.add(this.#realityRoot);
    this.#realityScene.add(this.#realityLightRoot);
    this.#pickupDebug = debug ? createPickupDebugView() : null;
    if (this.#pickupDebug) this.#scene.add(this.#pickupDebug.group);
    this.#physicsDebug = debug ? createPhysicsDebugView() : null;
    if (this.#physicsDebug) this.#scene.add(this.#physicsDebug.group);
    this.#pipeline = createRetroRenderPipeline(
      this.#renderer,
      this.#scene,
      this.#realityScene,
      this.#camera,
    );
    this.#pipeline.configureSky(new THREE.Color(0x17111f));
    this.#resize();
    addEventListener("resize", this.#resize);
  }

  setWorld(message: WorldMessage): void {
    this.#scene.remove(this.#worldRoot);
    this.#scene.remove(this.#lightRoot);
    this.#realityScene.remove(this.#realityRoot);
    this.#realityScene.remove(this.#realityLightRoot);
    this.#worldRoot.traverse(disposeOwnedResources);
    this.#lightRoot.traverse(disposeLightResources);
    this.#realityLightRoot.traverse(disposeLightResources);
    this.#cameraCollisionRoot.traverse(disposeOwnedResources);
    this.#worldRoot = new THREE.Group();
    this.#realityRoot = new THREE.Group();
    this.#lightRoot = new THREE.Group();
    this.#realityLightRoot = new THREE.Group();
    this.#cameraCollisionRoot = new THREE.Group();
    this.#worldRoot.name = `world-${message.worldEpoch}`;
    this.#realityRoot.name = `reality-${message.worldEpoch}`;
    this.#lightRoot.name = `lights-${message.worldEpoch}`;
    this.#realityLightRoot.name = `reality-lights-${message.worldEpoch}`;
    this.#cameraCollisionRoot.name = `camera-collision-${message.worldEpoch}`;
    this.#meshes.clear();
    this.#cameraCollisionBodies.clear();
    this.#predictedBodies.clear();
    this.#interactionCandidate = null;
    this.#heldTarget = null;
    this.#outlinedTarget = null;
    this.#pickupPlayerPosition = null;
    if (this.#pickupDebug) this.#pickupDebug.group.visible = false;
    if (this.#physicsDebug) this.#physicsDebug.group.visible = false;
    this.#cameraFollowing = false;
    this.#cameraBoom = createCameraBoomState();
    this.#cameraSafeDistance = CAMERA_BOOM_LENGTH;
    this.#cameraFrameTime = null;
    this.#buildCameraCollisionWorld(message);
    const sky = message.bundle.settings.skyColor;
    const skyColor = new THREE.Color(sky.r, sky.g, sky.b);
    this.#scene.background = null;
    this.#scene.fog = new THREE.Fog(skyColor, 34, 82);
    this.#pipeline.configureSky(skyColor);
    for (const batch of message.bundle.renderBatches) {
      const mesh = this.#meshForBatch(batch);
      this.#worldRoot.add(mesh);
      if (this.#isRealityMaterial(batch.material))
        this.#realityRoot.add(this.#realityClone(mesh, batch.material));
    }
    let volumeDensity = 0;
    let volumetricLights = false;
    for (const entity of message.bundle.entities) {
      if (entity.kind === "sprite") {
        this.#worldRoot.add(this.#mapSprite(entity));
        continue;
      }
      if (entity.presentation.kind !== "light" || !entity.origin) continue;
      const presentationLight = createPresentationLight(entity.presentation, entity.origin);
      presentationLight.light.name = `light.${entity.presentation.mode}`;
      this.#lightRoot.add(presentationLight.light);
      if (presentationLight.target) this.#lightRoot.add(presentationLight.target);
      const realityLight = createPresentationLight(entity.presentation, entity.origin);
      realityLight.light.name = `reality-light.${entity.presentation.mode}`;
      realityLight.light.castShadow = false;
      realityLight.light.layers.disable(VOLUMETRIC_LIGHT_LAYER);
      this.#realityLightRoot.add(realityLight.light);
      if (realityLight.target) this.#realityLightRoot.add(realityLight.target);
      volumeDensity = Math.max(volumeDensity, presentationLight.volumeDensity);
      volumetricLights ||= presentationLight.volumetric;
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
      this.#worldRoot.add(group);
    }
    for (const player of message.runtimeEntities.filter((entity) => entity.kind === "player"))
      this.#addPlayer(player);
    this.#scene.add(this.#worldRoot);
    this.#scene.add(this.#lightRoot);
    this.#realityScene.add(this.#realityRoot);
    this.#realityScene.add(this.#realityLightRoot);
    const worldBounds = new THREE.Box3().setFromPoints(
      message.bundle.staticCollision.vertices.map(
        (vertex) => new THREE.Vector3(vertex.x, vertex.y, vertex.z),
      ),
    );
    this.#pipeline.configureVolume(worldBounds, volumeDensity, volumetricLights);
  }

  applyLifecycle(message: LifecycleMessage): void {
    for (const id of message.removed) {
      const identity = idKey(id);
      const mesh = this.#meshes.get(identity);
      if (mesh) {
        this.#meshes.delete(identity);
        this.#predictedBodies.delete(identity);
        this.#worldRoot.remove(mesh);
        mesh.traverse(disposeOwnedResources);
      }
      const cameraCollision = this.#cameraCollisionBodies.get(identity);
      if (cameraCollision) {
        this.#cameraCollisionBodies.delete(identity);
        this.#cameraCollisionRoot.remove(cameraCollision);
        cameraCollision.traverse(disposeOwnedResources);
      }
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

  setFollowCamera(
    target: RuntimeId | null,
    onPresentation: (body: BodySnapshot) => void = () => {},
  ): void {
    this.#followTarget = target ? { ...target } : null;
    this.#onFollowPresentation = onPresentation;
    this.#cameraFollowing = false;
    this.#cameraFrameTime = null;
  }

  setTraceSink(sink: ((frame: TracePresentationFrame) => void) | null): void {
    this.#traceSink = sink;
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
    raycaster.far = PLAYER_GRAB_REACH;
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
    this.#updatePickupDebug(
      origin,
      origin.clone().addScaledVector(direction, PLAYER_GRAB_REACH),
      0xff405c,
    );
    return null;
  }

  interactionOutlineState(): "available" | "held" | "none" {
    if (this.#heldTarget) return "held";
    return this.#interactionCandidate ? "available" : "none";
  }

  cameraDiagnostics(): { distance: number; safeDistance: number } {
    return {
      distance: this.#cameraBoom.distance,
      safeDistance: this.#cameraSafeDistance,
    };
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
        const presentationTargetTick = estimatedServerTick - this.#history.interpolationDelayTicks;
        const authoritativeSample = this.#history.sampleWithMetadata(presentationTargetTick);
        const currentSample = this.#history.sampleWithMetadata(estimatedServerTick);
        const authoritative = authoritativeSample.bodies;
        const current = currentSample.bodies;
        const predictedLocal = this.#predictedLocal.sample(now);
        const predictedBodies = [...this.#predictedBodies.values()].flatMap((timeline) => {
          const body = timeline.sample(now);
          return body ? [body] : [];
        });
        const renderedBodies = mergeBodySamples(authoritative, predictedBodies);
        this.#apply(renderedBodies);
        let localFallback: BodySnapshot | null = null;
        let localPresentation: BodySnapshot | null = null;
        if (predictedLocal) {
          this.#apply([predictedLocal]);
          localPresentation = predictedLocal;
          this.#onLocalPresentation(predictedLocal);
        } else if (this.#localPlayer) {
          const local = current.find((body) => idKey(body.id) === idKey(this.#localPlayer!));
          if (local) {
            localFallback = local;
            localPresentation = local;
            this.#apply([local]);
          }
        }
        if (localPresentation) {
          this.#pickupPlayerPosition ??= new THREE.Vector3();
          this.#pickupPlayerPosition.set(
            localPresentation.position.x,
            localPresentation.position.y,
            localPresentation.position.z,
          );
        }
        if (this.#followTarget) {
          const targetKey = idKey(this.#followTarget);
          const followed =
            localPresentation && idKey(localPresentation.id) === targetKey
              ? localPresentation
              : renderedBodies.find((body) => idKey(body.id) === targetKey);
          if (followed) {
            this.#pickupPlayerPosition ??= new THREE.Vector3();
            this.#pickupPlayerPosition.set(
              followed.position.x,
              followed.position.y,
              followed.position.z,
            );
            this.#follow(followed, now);
            this.#onFollowPresentation(followed);
          }
        } else if (localPresentation) {
          this.#follow(localPresentation, now);
        }
        if (this.#traceSink) {
          const presented = new Map<string, TracePresentedBody>();
          for (const body of authoritative)
            presented.set(idKey(body.id), {
              body: structuredClone(body),
              source: "interpolated",
              comparisonServerTick: presentationTargetTick,
            });
          for (const body of predictedBodies)
            presented.set(idKey(body.id), {
              body: structuredClone(body),
              source: "predicted-proxy",
              comparisonServerTick: estimatedServerTick,
            });
          if (predictedLocal)
            presented.set(idKey(predictedLocal.id), {
              body: structuredClone(predictedLocal),
              source: "predicted-local",
              comparisonServerTick: estimatedServerTick,
            });
          else if (localFallback)
            presented.set(idKey(localFallback.id), {
              body: structuredClone(localFallback),
              source: "current-local-fallback",
              comparisonServerTick: estimatedServerTick,
            });
          this.#traceSink({
            clientAtMs: now,
            latestSnapshotTick: latest,
            estimatedServerTick,
            interpolationDelayTicks: this.#history.interpolationDelayTicks,
            presentationTargetTick,
            extrapolatedBodyIds: [
              ...authoritativeSample.extrapolatedBodyIds,
              ...currentSample.extrapolatedBodyIds,
            ],
            bodies: [...presented.values()],
          });
        }
      }
      this.#orientBillboards();
      this.#pipeline.render();
    };
    this.#renderer.setAnimationLoop(render);
  }

  dispose(): void {
    this.#renderer.setAnimationLoop(null);
    removeEventListener("resize", this.#resize);
    this.#worldRoot.traverse(disposeOwnedResources);
    this.#lightRoot.traverse(disposeLightResources);
    this.#realityLightRoot.traverse(disposeLightResources);
    this.#cameraCollisionRoot.traverse(disposeOwnedResources);
    for (const material of this.#materials.values()) material.dispose();
    for (const texture of this.#textures.values()) texture.dispose();
    this.#outlineMaskMaterial.dispose();
    this.#availableOutlineMaterial.dispose();
    this.#heldOutlineMaterial.dispose();
    this.#cameraCollisionMaterial.dispose();
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
    const triangleIndices = renderableBrushTriangleIndices(brush);
    for (const triangleIndex of triangleIndices) {
      const triangle = brush.triangles[triangleIndex]!;
      const normal = brush.triangleNormals[triangleIndex]!;
      const triangleUvs = brush.triangleUvs[triangleIndex]!;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = vertices[triangle[corner]!]!;
        positions.push(vertex.x, vertex.y, vertex.z);
        normals.push(normal.x, normal.y, normal.z);
        const texture = this.#materialInfo(brush.triangleMaterials[triangleIndex]!);
        uvs.push(...normalizeMaterialUv(triangleUvs[corner]!, texture));
      }
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    const materialNames = [
      ...new Set(triangleIndices.map((triangleIndex) => brush.triangleMaterials[triangleIndex]!)),
    ];
    const materialIndices = new Map(materialNames.map((name, index) => [name, index]));
    for (const [renderTriangleIndex, triangleIndex] of triangleIndices.entries()) {
      geometry.addGroup(
        renderTriangleIndex * 3,
        3,
        materialIndices.get(brush.triangleMaterials[triangleIndex]!) ?? 0,
      );
    }
    const mesh = new THREE.Mesh(
      geometry,
      materialNames.map((name) => this.#material(name, false)),
    );
    mesh.name = `brush.${brush.entityIndex}.${brush.sourceBrushIndex}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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
        batch.uvs.flatMap((v) => {
          const texture = this.#materialInfo(batch.material);
          return normalizeMaterialUv(v, texture);
        }),
        2,
      ),
    );
    geometry.setIndex(batch.indices);
    const mesh = new THREE.Mesh(geometry, this.#material(batch.material, batch.sensor));
    mesh.name = `material.${batch.material}`;
    mesh.castShadow = !batch.sensor;
    mesh.receiveShadow = !batch.sensor;
    mesh.userData.interactionOccluder = !batch.sensor;
    return mesh;
  }

  #buildCameraCollisionWorld(message: WorldMessage): void {
    // Camera containment follows authored collision rather than visible meshes so
    // collision-only SKIP faces still bound the third-person view.
    if (message.bundle.staticCollision.triangles.length > 0) {
      this.#cameraCollisionRoot.add(
        createCameraCollisionMesh(
          message.bundle.staticCollision,
          this.#cameraCollisionMaterial,
          "camera-collision.static",
        ),
      );
    }
    for (const runtime of message.runtimeEntities) {
      if (runtime.kind !== "world-entity") continue;
      const entity = message.bundle.entities[runtime.entityIndex];
      if (
        !entity?.body ||
        entity.body.kind === "sensor-brush" ||
        entity.body.kind === "dynamic-brush"
      ) {
        // Loose replicated props would make the view pump as they roll through
        // the boom; stable kinematic mechanisms remain camera obstacles.
        continue;
      }
      const origin = message.bundle.brushes[entity.body.brushIndices[0]!]?.center;
      if (!origin) continue;
      const group = new THREE.Group();
      group.name = `camera-collision.body.${runtime.entityIndex}`;
      group.position.set(origin.x, origin.y, origin.z);
      for (const brushIndex of entity.body.brushIndices) {
        const brush = message.bundle.brushes[brushIndex];
        if (!brush) continue;
        const mesh = createCameraCollisionMesh(
          { vertices: brush.localVertices, triangles: brush.triangles },
          this.#cameraCollisionMaterial,
          `camera-collision.brush.${brush.entityIndex}.${brush.sourceBrushIndex}`,
        );
        mesh.position.set(
          brush.center.x - origin.x,
          brush.center.y - origin.y,
          brush.center.z - origin.z,
        );
        group.add(mesh);
      }
      this.#cameraCollisionBodies.set(idKey(runtime.id), group);
      this.#cameraCollisionRoot.add(group);
    }
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
    const geometry = createBillboardGeometry(
      playerBillboardLayout.quad.widthMeters,
      playerBillboardLayout.quad.heightMeters,
      playerBillboardLayout.quad.center,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `player.${idKey(player.id)}`;
    mesh.renderOrder = PLAYER_RENDER_ORDER;
    mesh.userData.ownedMaterial = true;
    mesh.userData.ownedTexture = texture;
    mesh.userData.billboard = true;
    mesh.userData.playerBillboard = true;
    mesh.userData.playerDirection = 0;
    mesh.userData.runtimeId = player.id;
    mesh.userData.interactionOccluder = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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

  #realityMaterial(name: string): THREE.Material {
    const key = `${name}:reality`;
    const cached = this.#materials.get(key);
    if (cached) return cached;
    const material = createRealityNodeMaterial(this.#texture(name));
    this.#materials.set(key, material);
    return material;
  }

  #realityClone(mesh: THREE.Mesh, materialName: string): THREE.Mesh {
    const clone = new THREE.Mesh(mesh.geometry, this.#realityMaterial(materialName));
    clone.name = `${mesh.name}.reality`;
    clone.receiveShadow = false;
    clone.userData.sharedGeometry = true;
    clone.raycast = () => {};
    return clone;
  }

  #isRealityMaterial(name: string): boolean {
    return this.#materialInfo(name).renderMode === "reality";
  }

  #texture(name: string): THREE.Texture {
    const cached = this.#textures.get(name);
    if (cached) return cached;
    const info = this.#materialInfo(name);
    const texture = new THREE.TextureLoader().load(info.url);
    texture.name = name;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = info.renderMode === "reality" ? THREE.LinearFilter : THREE.NearestFilter;
    texture.minFilter =
      info.renderMode === "reality"
        ? THREE.LinearMipmapLinearFilter
        : THREE.NearestMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    this.#textures.set(name, texture);
    return texture;
  }

  #materialInfo(name: string): MaterialTextureInfo {
    const info = this.#materialTextures[name];
    if (!info) throw new Error(`missing authored material texture: ${name}`);
    return info;
  }

  #mapSprite(
    entity: Extract<WorldMessage["bundle"]["entities"][number], { kind: "sprite" }>,
  ): THREE.Mesh {
    const spriteName = entity.presentation.asset;
    const glow = entity.presentation.glow;
    const material = createSpriteNodeMaterial(this.#spriteTexture(spriteName), glow);
    const height = entity.presentation.height;
    const sprite = new THREE.Mesh(
      createBillboardGeometry(height, height, { x: 0.5, y: 0.04 }),
      material,
    );
    sprite.position.set(entity.origin.x, entity.origin.y, entity.origin.z);
    sprite.name = `sprite.${spriteName}`;
    sprite.userData.ownedMaterial = true;
    sprite.userData.billboard = true;
    sprite.userData.interactionOccluder = false;
    sprite.castShadow = !glow;
    sprite.receiveShadow = !glow;
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
      const cameraCollision = this.#cameraCollisionBodies.get(idKey(body.id));
      if (cameraCollision) {
        cameraCollision.position.set(body.position.x, body.position.y, body.position.z);
        cameraCollision.quaternion.set(
          body.rotation.x,
          body.rotation.y,
          body.rotation.z,
          body.rotation.w,
        );
      }
      if (!mesh) continue;
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      if (!mesh.userData.billboard)
        mesh.quaternion.set(body.rotation.x, body.rotation.y, body.rotation.z, body.rotation.w);
      const texture = mesh.userData.ownedTexture;
      if (mesh.userData.playerBillboard && texture instanceof THREE.Texture) {
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

  #orientBillboards(): void {
    this.#worldRoot.traverse((object) => {
      if (!object.userData.billboard) return;
      object.quaternion.copy(this.#camera.quaternion);
    });
  }

  #addInteractionOutline(mesh: THREE.Mesh): void {
    const mask = new THREE.Mesh(mesh.geometry, this.#outlineMaskMaterial);
    mask.name = `${mesh.name}.interaction-outline-mask`;
    mask.renderOrder = INTERACTION_OUTLINE_MASK_RENDER_ORDER;
    mask.visible = false;
    mask.userData.interactionOutlineMask = true;
    mask.userData.interactionOccluder = false;
    mask.userData.sharedGeometry = true;
    mask.castShadow = false;
    mask.receiveShadow = false;
    mask.raycast = () => {};

    const outline = new THREE.Mesh(mesh.geometry, this.#availableOutlineMaterial);
    outline.name = `${mesh.name}.interaction-outline`;
    outline.scale.setScalar(INTERACTION_OUTLINE_SCALE);
    outline.renderOrder = INTERACTION_OUTLINE_RENDER_ORDER;
    outline.visible = false;
    outline.userData.interactionOutline = true;
    outline.userData.interactionOccluder = false;
    outline.userData.sharedGeometry = true;
    outline.castShadow = false;
    outline.receiveShadow = false;
    outline.raycast = () => {};
    mesh.add(mask, outline);
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
      if (!(object instanceof THREE.Mesh)) return;
      if (object.userData.interactionOutlineMask) {
        object.visible = visible;
        return;
      }
      if (!object.userData.interactionOutline) return;
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

  #follow(player: BodySnapshot, now: number): void {
    const target = new THREE.Vector3(player.position.x, player.position.y + 0.4, player.position.z);
    const horizontal = Math.cos(this.#viewPitch);
    const forward = new THREE.Vector3(
      -Math.sin(this.#viewYaw) * horizontal,
      Math.sin(this.#viewPitch),
      -Math.cos(this.#viewYaw) * horizontal,
    );
    const discontinuity =
      this.#cameraFollowing &&
      this.#cameraPreviousPivot.distanceTo(target) > CAMERA_DISCONTINUITY_DISTANCE;
    if (!this.#cameraFollowing || discontinuity) {
      this.#cameraBoom = createCameraBoomState();
      this.#cameraFrameTime = now;
    }
    const boomDirection = forward.multiplyScalar(-1);
    this.#cameraSafeDistance = cameraBoomClearance(
      this.#cameraCollisionRoot,
      target,
      boomDirection,
      this.#cameraRaycaster,
    );
    const deltaSeconds =
      this.#cameraFrameTime === null ? 0 : Math.max(0, (now - this.#cameraFrameTime) / 1_000);
    this.#cameraBoom = stepCameraBoom(this.#cameraBoom, this.#cameraSafeDistance, deltaSeconds);
    this.#camera.position.copy(target).addScaledVector(boomDirection, this.#cameraBoom.distance);
    this.#cameraFollowing = true;
    this.#cameraFrameTime = now;
    this.#cameraPreviousPivot.copy(target);
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
