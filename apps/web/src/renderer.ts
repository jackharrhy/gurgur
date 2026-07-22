import * as THREE from "three/webgpu";
import {
  INTERPOLATION_DELAY_TICKS,
  type BodySnapshot,
  type CompiledBrush,
  type LifecycleMessage,
  type CompiledRenderBatch,
  type RuntimeId,
  type WorldMessage,
} from "@gurgur/shared";
import type { SnapshotTimeline } from "./interpolation";
import { createPredictedPoseTimeline } from "./presentation";
import {
  createRetroRenderPipeline,
  createSpriteNodeMaterial,
  createWorldNodeMaterial,
  type RetroRenderPipeline,
} from "./retro-rendering";

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;

export class WorldRenderer {
  readonly #renderer: THREE.WebGPURenderer;
  readonly #pipeline: RetroRenderPipeline;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.1, 180);
  readonly #history: SnapshotTimeline;
  readonly #meshes = new Map<string, THREE.Object3D>();
  readonly #materials = new Map<string, THREE.Material>();
  readonly #textures = new Map<string, THREE.Texture>();
  #worldRoot = new THREE.Group();
  #localPlayer: RuntimeId | null = null;
  readonly #predictedLocal = createPredictedPoseTimeline();
  readonly #onLocalPresentation: (body: BodySnapshot) => void;
  #viewYaw = 0;
  #viewPitch = -0.18;
  #cameraFollowing = false;

  constructor(
    canvas: HTMLCanvasElement,
    history: SnapshotTimeline,
    onLocalPresentation: (body: BodySnapshot) => void = () => {},
  ) {
    this.#history = history;
    this.#onLocalPresentation = onLocalPresentation;
    this.#renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: "high-performance" });
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
    this.#worldRoot.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
        if (object.userData.ownedMaterial) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      }
    });
    this.#worldRoot = new THREE.Group();
    this.#worldRoot.name = `world-${message.worldEpoch}`;
    this.#meshes.clear();
    this.#cameraFollowing = false;
    for (const batch of message.bundle.renderBatches) this.#worldRoot.add(this.#meshForBatch(batch));
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
        mesh.position.set(brush.center.x - origin.x, brush.center.y - origin.y, brush.center.z - origin.z);
        mesh.userData.runtimeId = runtime.id;
        mesh.userData.interactable = runtime.classname === "func_button" || runtime.classname === "func_physics";
        mesh.userData.interactionOccluder = true;
        group.add(mesh);
      }
      this.#meshes.set(idKey(runtime.id), group);
      this.#worldRoot.add(group);
    }
    for (const player of message.runtimeEntities.filter((entity) => entity.classname === "player")) this.#addPlayer(player);
    this.#scene.add(this.#worldRoot);
  }

  applyLifecycle(message: LifecycleMessage): void {
    for (const id of message.removed) {
      const mesh = this.#meshes.get(idKey(id));
      if (!mesh) continue;
      this.#meshes.delete(idKey(id));
      this.#worldRoot.remove(mesh);
      mesh.traverse((object) => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return;
        if (object instanceof THREE.Mesh) object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
    }
    for (const entity of message.created) if (entity.classname === "player") this.#addPlayer(entity);
  }

  setLocalPlayer(id: RuntimeId): void {
    this.#localPlayer = id;
  }

  setPredictedPlayer(body: BodySnapshot | null): void {
    if (body) this.#predictedLocal.push(body, performance.now());
    else this.#predictedLocal.clear();
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
        const estimatedServerTick = this.#history.serverTickAt(performance.now());
        this.#apply(this.#history.sample(estimatedServerTick - INTERPOLATION_DELAY_TICKS));
        const current = this.#history.sample(estimatedServerTick);
        const predictedLocal = this.#predictedLocal.sample(performance.now());
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
    this.#worldRoot.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
        if (object.userData.ownedMaterial) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      }
    });
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
        uvs.push(triangleUvs[corner]!.x / 64, triangleUvs[corner]!.y / 64);
      }
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    const materialNames = [...new Set(brush.triangleMaterials)];
    const materialIndices = new Map(materialNames.map((name, index) => [name, index]));
    for (let triangle = 0; triangle < brush.triangles.length; triangle += 1) {
      geometry.addGroup(triangle * 3, 3, materialIndices.get(brush.triangleMaterials[triangle]!) ?? 0);
    }
    const mesh = new THREE.Mesh(geometry, materialNames.map((name) => this.#material(name, brush.classname)));
    mesh.name = brush.authoredId ?? `${brush.classname}-${brush.entityIndex}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.interactionOccluder = !brush.classname.startsWith("trigger_");
    return mesh;
  }

  #meshForBatch(batch: CompiledRenderBatch): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(batch.positions.flatMap((v) => [v.x, v.y, v.z]), 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(batch.normals.flatMap((v) => [v.x, v.y, v.z]), 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(batch.uvs.flatMap((v) => [v.x / 64, v.y / 64]), 2));
    geometry.setIndex(batch.indices);
    const mesh = new THREE.Mesh(geometry, this.#material(batch.material, batch.sensor ? "trigger_batch" : "worldspawn"));
    mesh.name = `material.${batch.material}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.interactionOccluder = !batch.sensor;
    return mesh;
  }

  #addPlayer(player: Extract<LifecycleMessage["created"][number], { classname: "player" }>): void {
    if (this.#meshes.has(idKey(player.id))) return;
    const local = this.#localPlayer && idKey(player.id) === idKey(this.#localPlayer);
    const material = createSpriteNodeMaterial(this.#spriteTexture(local ? "player-local" : "player-remote"), false);
    material.alphaTest = 0.45;
    const mesh = new THREE.Sprite(material);
    mesh.center.set(0.5, 0.08);
    mesh.scale.set(1.08, 1.78, 1);
    mesh.name = player.authoredId;
    mesh.userData.ownedMaterial = true;
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
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable for material textures");
    context.imageSmoothingEnabled = false;
    const palette = this.#materialPalette(name);
    context.fillStyle = palette[0];
    context.fillRect(0, 0, 32, 32);
    context.strokeStyle = palette[1];
    context.fillStyle = palette[1];
    if (name.includes("CONCRETE") || name.includes("STONE")) {
      // Large horizontal surfaces turn regular line grids into severe moire at
      // grazing angles. Irregular, deterministic aggregate keeps the chunky
      // 32 px material language without introducing a dominant frequency.
      let seed = name.includes("STONE") ? 0x5a17 : 0xc0c0;
      for (let index = 0; index < 86; index += 1) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        const x = seed & 31;
        const y = (seed >>> 8) & 31;
        context.fillStyle = index % 5 === 0 ? palette[2] : palette[1];
        context.fillRect(x, y, index % 7 === 0 ? 2 : 1, index % 11 === 0 ? 2 : 1);
      }
    } else if (name.includes("WATER")) {
      context.fillStyle = palette[1];
      for (let y = 3; y < 32; y += 6) {
        for (let x = -4; x < 32; x += 8) context.fillRect(x + (y % 4), y, 6, 2);
      }
      context.fillStyle = palette[2];
      for (let y = 6; y < 32; y += 12) {
        for (let x = 1; x < 32; x += 12) context.fillRect(x, y, 4, 1);
      }
    } else if (name.includes("CAUTION")) {
      context.lineWidth = 6;
      for (let offset = -32; offset < 64; offset += 12) {
        context.beginPath(); context.moveTo(offset, 32); context.lineTo(offset + 32, 0); context.stroke();
      }
    } else if (name.includes("METAL") || name.includes("DOOR")) {
      context.fillRect(0, 0, 32, 2);
      context.fillRect(0, 15, 32, 2);
      context.fillStyle = palette[2];
      for (const x of [2, 14, 18, 30]) for (const y of [3, 13, 19, 29]) context.fillRect(x, y, 1, 1);
    } else if (name.includes("WOOD")) {
      for (let y = 5; y < 32; y += 8) context.fillRect(0, y, 32, 2);
      context.fillStyle = palette[2];
      for (let x = 4; x < 32; x += 10) context.fillRect(x, 0, 1, 32);
    } else if (name.includes("DANGER")) {
      for (let y = 0; y < 32; y += 8) for (let x = 0; x < 32; x += 8) {
        if (((x + y) / 8) % 2 === 0) context.fillRect(x, y, 8, 8);
      }
    } else {
      for (let y = 0; y < 32; y += 8) context.fillRect(0, y, 32, 1);
      context.fillStyle = palette[2];
      for (const [x, y] of [[3, 4], [21, 6], [13, 13], [28, 21], [7, 27]] as const) context.fillRect(x, y, 2, 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
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

  #materialPalette(name: string): [string, string, string] {
    if (name.includes("CONCRETE")) return ["#4f5655", "#34383f", "#8b806d"];
    if (name.includes("STONE")) return ["#62536f", "#3c334d", "#9b6b68"];
    if (name.includes("WOOD")) return ["#a55b3f", "#663744", "#d18a4f"];
    if (name.includes("RUBBER")) return ["#71335f", "#452542", "#cb4c73"];
    if (name.includes("CAUTION")) return ["#d9a92f", "#28253c", "#ffe18a"];
    if (name.includes("DANGER")) return ["#a52b4c", "#292037", "#ff6b5b"];
    if (name.includes("BUTTON")) return ["#d94b3e", "#732d46", "#ffb35c"];
    if (name.includes("PLATFORM")) return ["#347e87", "#24485d", "#70c3a6"];
    if (name.includes("RAMP")) return ["#687447", "#3c493d", "#a6a85b"];
    if (name.includes("DOOR")) return ["#596878", "#303b50", "#a2b0ad"];
    if (name.includes("WATER")) return ["#173a5c", "#197d88", "#6bd2b2"];
    return ["#4a5868", "#2d3445", "#8396a0"];
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
      rect("#30243f", 10, 6, 12, 22); rect("#f1c49b", 12, 3, 8, 9);
      rect(coat, 8, 10, 16, 15); rect("#efe1b4", 14, 12, 4, 5);
      rect("#181625", 9, 27, 5, 4); rect("#181625", 18, 27, 5, 4);
      rect("#4e3252", 11, 5, 10, 3); rect("#f05d5e", 15, 6, 2, 2);
    } else if (name === "terminal") {
      rect("#29243c", 6, 5, 20, 26); rect("#566176", 8, 7, 16, 13);
      rect("#46d9b1", 10, 9, 12, 7); rect("#b8f5c8", 11, 10, 7, 1);
      rect("#db5b54", 10, 23, 3, 3); rect("#e9bd56", 16, 23, 3, 3);
    } else if (name === "sign") {
      rect("#49334f", 14, 17, 4, 15); rect("#e5b94b", 3, 4, 26, 16);
      rect("#31243b", 5, 6, 22, 12); rect("#f3e6bc", 7, 9, 18, 2); rect("#f05d5e", 12, 13, 8, 2);
    } else if (name === "lamp") {
      rect("#34324a", 14, 12, 4, 20); rect("#566176", 10, 8, 12, 6);
      rect("#fff3a8", 12, 3, 8, 9); rect("#e26a5c", 14, 5, 4, 5);
    } else if (name === "crystal") {
      rect("#47345d", 13, 7, 7, 24); rect("#6954a1", 9, 14, 6, 17);
      rect("#63d6c1", 15, 3, 4, 21); rect("#b8f5c8", 16, 6, 2, 13);
    } else {
      rect("#382d45", 14, 18, 4, 14); rect("#347e63", 7, 13, 8, 14);
      rect("#4fb778", 4, 8, 8, 12); rect("#8bc56f", 17, 10, 10, 17);
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
