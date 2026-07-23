import * as THREE from "three/webgpu";
import {
  INTERPOLATION_DELAY_TICKS,
  MATERIAL_TEXTURE_SIZE,
  type BodySnapshot,
  type CompiledBrush,
  type LifecycleMessage,
  type CompiledRenderBatch,
  type RuntimeId,
  type WorldMessage,
} from "@gurgur/shared";
import type { SnapshotTimeline } from "./interpolation";
import {
  createPredictedPoseTimeline,
  mergeBodySamples,
  type PredictedPoseTimeline,
} from "./presentation";
import {
  createRetroRenderPipeline,
  createSpriteNodeMaterial,
  createWorldNodeMaterial,
  type RetroRenderPipeline,
} from "./retro-rendering";
import playerBillboardLayout from "../../../content/generated/player-billboard/player-billboard.json";
import { playerBillboardAtlasOffset, playerBillboardView } from "./player-billboard";

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;

function disposeOwnedResources(object: THREE.Object3D): void {
  if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
  if (object instanceof THREE.Mesh) object.geometry.dispose();
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
  readonly #materialTextureUrls: Readonly<Record<string, string>>;
  #worldRoot = new THREE.Group();
  #localPlayer: RuntimeId | null = null;
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
  ) {
    this.#history = history;
    this.#onLocalPresentation = onLocalPresentation;
    this.#onBodyPresentation = onBodyPresentation;
    this.#materialTextureUrls = materialTextureUrls;
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
    this.#predictedBodies.clear();
    this.#cameraFollowing = false;
    for (const batch of message.bundle.renderBatches)
      this.#worldRoot.add(this.#meshForBatch(batch));
    for (const entity of message.bundle.entities) {
      if (entity.classname !== "env_sprite" || !entity.origin) continue;
      this.#worldRoot.add(this.#mapSprite(entity));
    }
    for (const runtime of message.runtimeEntities) {
      if (!("brushIndex" in runtime)) continue;
      const brushIndices = runtime.brushIndices ?? [runtime.brushIndex];
      const origin = message.bundle.brushes[runtime.brushIndex]?.center;
      if (!origin) continue;
      const group = new THREE.Group();
      group.name = runtime.authoredId;
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
        mesh.userData.interactable =
          runtime.classname === "func_button" || runtime.classname === "func_physics";
        mesh.userData.interactionOccluder = true;
        group.add(mesh);
      }
      this.#meshes.set(idKey(runtime.id), group);
      this.#worldRoot.add(group);
    }
    for (const player of message.runtimeEntities.filter((entity) => entity.classname === "player"))
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
    for (const entity of message.created)
      if (entity.classname === "player") this.#addPlayer(entity);
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

  setViewAngles(yaw: number, pitch: number): void {
    this.#viewYaw = yaw;
    this.#viewPitch = pitch;
  }

  interactionTarget(): RuntimeId | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.#camera);
    raycaster.far = 7.5;
    for (const hit of raycaster.intersectObject(this.#worldRoot, true)) {
      const object = hit.object;
      if (object.userData.interactable && object.userData.runtimeId) {
        return { ...object.userData.runtimeId } as RuntimeId;
      }
      if (object.userData.interactionOccluder !== false) return null;
    }
    return null;
  }

  start(): void {
    const render = (): void => {
      if (document.hidden) return;
      const latest = this.#history.latestTick;
      if (latest !== null) {
        const now = performance.now();
        const estimatedServerTick = this.#history.serverTickAt(now);
        const authoritative = this.#history.sample(estimatedServerTick - INTERPOLATION_DELAY_TICKS);
        const predictedBodies = [...this.#predictedBodies.values()].flatMap((timeline) => {
          const body = timeline.sample(now);
          return body ? [body] : [];
        });
        this.#apply(mergeBodySamples(authoritative, predictedBodies));
        const current = this.#history.sample(estimatedServerTick);
        const predictedLocal = this.#predictedLocal.sample(now);
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
      materialNames.map((name) => this.#material(name, brush.classname)),
    );
    mesh.name = brush.authoredId ?? `${brush.classname}-${brush.entityIndex}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.interactionOccluder = !brush.classname.startsWith("trigger_");
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
    const mesh = new THREE.Mesh(
      geometry,
      this.#material(batch.material, batch.sensor ? "trigger_batch" : "worldspawn"),
    );
    mesh.name = `material.${batch.material}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.interactionOccluder = !batch.sensor;
    return mesh;
  }

  #addPlayer(player: Extract<LifecycleMessage["created"][number], { classname: "player" }>): void {
    if (this.#meshes.has(idKey(player.id))) return;
    const local = this.#localPlayer && idKey(player.id) === idKey(this.#localPlayer);
    const texture = new THREE.TextureLoader().load("/player-billboard.png");
    texture.name = `player-billboard:${player.authoredId}`;
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
    mesh.name = player.authoredId;
    mesh.userData.ownedMaterial = true;
    mesh.userData.ownedTexture = texture;
    mesh.userData.playerDirection = 0;
    mesh.userData.runtimeId = player.id;
    mesh.userData.interactionOccluder = false;
    this.#meshes.set(idKey(player.id), mesh);
    this.#worldRoot.add(mesh);
  }

  #material(name: string, classname: string): THREE.Material {
    const sensor = classname.startsWith("trigger_");
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

  #mapSprite(entity: WorldMessage["bundle"]["entities"][number]): THREE.Sprite {
    const spriteName = String(entity.runtimeProperties.sprite ?? "fern");
    const glow = Boolean(entity.runtimeProperties.glow);
    const material = createSpriteNodeMaterial(this.#spriteTexture(spriteName), glow);
    const sprite = new THREE.Sprite(material);
    const height = Number(entity.runtimeProperties.scale ?? 1.6);
    sprite.center.set(0.5, 0.04);
    sprite.scale.set(height, height, 1);
    sprite.position.set(entity.origin!.x, entity.origin!.y, entity.origin!.z);
    sprite.name = `sprite.${spriteName}`;
    sprite.userData.ownedMaterial = true;
    sprite.userData.interactionOccluder = false;
    return sprite;
  }

  #spriteTexture(name: string): THREE.Texture {
    const key = `sprite:${name}`;
    const cached = this.#textures.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable for sprite textures");
    context.imageSmoothingEnabled = false;
    const rect = (color: string, x: number, y: number, width: number, height: number): void => {
      context.fillStyle = color;
      context.fillRect(x, y, width, height);
    };
    if (name.startsWith("player")) {
      const coat = name.endsWith("local") ? "#e5b94b" : "#42a58c";
      rect("#30243f", 10, 6, 12, 22);
      rect("#f1c49b", 12, 3, 8, 9);
      rect(coat, 8, 10, 16, 15);
      rect("#efe1b4", 14, 12, 4, 5);
      rect("#181625", 9, 27, 5, 4);
      rect("#181625", 18, 27, 5, 4);
      rect("#4e3252", 11, 5, 10, 3);
      rect("#f05d5e", 15, 6, 2, 2);
    } else if (name === "terminal") {
      rect("#29243c", 6, 5, 20, 26);
      rect("#566176", 8, 7, 16, 13);
      rect("#46d9b1", 10, 9, 12, 7);
      rect("#b8f5c8", 11, 10, 7, 1);
      rect("#db5b54", 10, 23, 3, 3);
      rect("#e9bd56", 16, 23, 3, 3);
    } else if (name === "sign") {
      rect("#49334f", 14, 17, 4, 15);
      rect("#e5b94b", 3, 4, 26, 16);
      rect("#31243b", 5, 6, 22, 12);
      rect("#f3e6bc", 7, 9, 18, 2);
      rect("#f05d5e", 12, 13, 8, 2);
    } else if (name === "lamp") {
      rect("#34324a", 14, 12, 4, 20);
      rect("#566176", 10, 8, 12, 6);
      rect("#fff3a8", 12, 3, 8, 9);
      rect("#e26a5c", 14, 5, 4, 5);
    } else if (name === "crystal") {
      rect("#47345d", 13, 7, 7, 24);
      rect("#6954a1", 9, 14, 6, 17);
      rect("#63d6c1", 15, 3, 4, 21);
      rect("#b8f5c8", 16, 6, 2, 13);
    } else {
      rect("#382d45", 14, 18, 4, 14);
      rect("#347e63", 7, 13, 8, 14);
      rect("#4fb778", 4, 8, 8, 12);
      rect("#8bc56f", 17, 10, 10, 17);
      rect("#d2cf78", 21, 6, 4, 9);
    }
    const texture = new THREE.CanvasTexture(canvas);
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
  }

  #follow(player: BodySnapshot): void {
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
