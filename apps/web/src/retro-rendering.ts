import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { RETRO_COLOR_INTERVALS } from "./retro-color";

// The public TSL declarations recursively encode complete shader graphs. Keeping
// graph composition behind this boundary prevents TypeScript 7 from attempting
// unbounded structural expansion while application-facing types remain precise.
const tsl: Record<string, any> = TSL;

const affineUv = tsl.varying(tsl.vec2());
const clipW = tsl.varying(tsl.float());

const retroClipPosition = tsl.Fn(() => {
  const clip = tsl.cameraProjectionMatrix.mul(tsl.cameraViewMatrix).mul(tsl.positionWorld);
  const snapped = clip.xy
    .div(clip.w.mul(2))
    .mul(tsl.screenSize.xy)
    .round()
    .div(tsl.screenSize.xy)
    .mul(clip.w.mul(2));
  affineUv.assign(tsl.uv().mul(clip.w));
  clipW.assign(clip.w);
  return tsl.vec4(snapped, clip.zw);
})();

const pointLightPosition = tsl.uniform(new THREE.Vector3(-18, 34, 16));

const vertexLighting = tsl.vertexStage(
  tsl.Fn(() => {
    const normal = tsl.normalWorldGeometry.normalize();
    const toLight = pointLightPosition.sub(tsl.positionWorld);
    const lightDistance = toLight.length().max(0.001);
    const diffuse = normal.dot(toLight.div(lightDistance)).max(0);
    const attenuation = tsl.float(1).div(tsl.float(1).add(lightDistance.mul(0.035)));
    const hemisphere = tsl.mix(
      tsl.vec3(0.24, 0.15, 0.28),
      tsl.vec3(0.76, 0.82, 0.86),
      normal.y.mul(0.5).add(0.5),
    );
    const warmLight = tsl.vec3(1.0, 0.76, 0.48).mul(diffuse).mul(attenuation).mul(1.7);
    return hemisphere.add(warmLight).clamp(0.12, 1.25);
  })(),
);

function animatedTexture(textureMap: THREE.Texture, name: string) {
  const perspectiveUv = tsl.uv();
  const affineAmount = name.includes("WATER") ? 0.3 : 0.08;
  const retroUv = tsl.mix(perspectiveUv, affineUv.div(clipW), affineAmount);

  if (name.includes("WATER")) {
    const waveA = tsl.vec2(
      tsl.time.mul(0.035).add(tsl.sin(retroUv.y.mul(6.283).add(tsl.time.mul(0.9))).mul(0.04)),
      tsl.time.mul(0.018),
    );
    const waveB = tsl.vec2(
      tsl.time.mul(-0.022),
      tsl.time.mul(0.028).add(tsl.sin(retroUv.x.mul(9.425).sub(tsl.time.mul(0.65))).mul(0.035)),
    );
    const first = tsl.texture(textureMap, retroUv.mul(1.08).add(waveA)).rgb;
    const second = tsl.texture(textureMap, retroUv.mul(0.73).add(waveB)).rgb;
    return first.mul(0.66).add(second.mul(0.42));
  }

  if (name.includes("DANGER") || name.includes("CAUTION")) {
    return tsl.texture(textureMap, retroUv.add(tsl.vec2(tsl.time.mul(0.045), 0))).rgb;
  }

  if (name.includes("PLATFORM")) {
    const wobble = tsl.sin(tsl.time.mul(1.3).add(retroUv.y.mul(6.283))).mul(0.018);
    return tsl.texture(textureMap, retroUv.add(tsl.vec2(wobble, tsl.time.mul(0.025)))).rgb;
  }

  return tsl.texture(textureMap, retroUv).rgb;
}

export function createWorldNodeMaterial(
  textureMap: THREE.Texture | null,
  name: string,
  sensor: boolean,
): THREE.MeshBasicNodeMaterial {
  const water = name.includes("WATER");
  const material = new THREE.MeshBasicNodeMaterial({
    color: sensor ? 0x56e0d2 : 0xffffff,
    map: textureMap,
    side: THREE.DoubleSide,
    transparent: sensor || water,
    opacity: sensor ? 0.16 : 1,
    depthWrite: !water,
    wireframe: sensor,
  });
  material.vertexNode = retroClipPosition;
  if (textureMap) {
    let color = animatedTexture(textureMap, name).mul(vertexLighting);
    if (water) {
      color = color.mul(tsl.sin(tsl.time.mul(0.7)).mul(0.06).add(1.02));
    }
    material.colorNode = tsl.vec4(color, water ? 0.76 : 1);
  }
  return material;
}

export function createSpriteNodeMaterial(
  textureMap: THREE.Texture,
  glow: boolean,
): THREE.SpriteNodeMaterial {
  const material = new THREE.SpriteNodeMaterial({
    map: textureMap,
    transparent: true,
    alphaTest: 0.42,
    depthWrite: !glow,
    fog: true,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  if (glow)
    material.colorNode = tsl.materialColor.mul(tsl.sin(tsl.time.mul(2.8)).mul(0.12).add(1.0));
  return material;
}

export type RetroRenderPipeline = {
  render(): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

export function createRetroRenderPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): RetroRenderPipeline {
  const scenePass = tsl.pass(scene, camera);
  scenePass.renderTarget.texture.type = THREE.UnsignedByteType;
  scenePass.renderTarget.texture.magFilter = THREE.NearestFilter;
  scenePass.renderTarget.texture.minFilter = THREE.NearestFilter;

  const sceneColor = scenePass;
  const vignette = tsl.smoothstep(0.35, 1.05, tsl.distance(tsl.screenUV, tsl.vec2(0.5))).oneMinus();
  const shaded = tsl
    .max(sceneColor.rgb, tsl.vec3(0))
    .mul(1.05)
    .mul(tsl.mix(0.76, 1, vignette))
    .clamp(0, 1);
  const retroResolution = tsl.uniform(new THREE.Vector2(480, 270));
  const ditherCell = tsl.floor(tsl.screenUV.mul(retroResolution)).mod(4);
  const bayer2 = (x: any, y: any) => x.mul(2).add(y.mul(3)).sub(x.mul(y).mul(4));
  const bayerIndex = bayer2(ditherCell.x.mod(2), ditherCell.y.mod(2))
    .mul(4)
    .add(bayer2(ditherCell.x.div(2).floor(), ditherCell.y.div(2).floor()));
  const bayerThreshold = tsl.mix(0.5, bayerIndex.add(0.5).div(16), 0.35);
  const levels = tsl.vec3(...RETRO_COLOR_INTERVALS);
  const displayColor = tsl.sRGBTransferOETF(shaded);
  const quantizedDisplay = tsl.floor(displayColor.mul(levels).add(bayerThreshold)).div(levels);
  const output = tsl.vec4(tsl.sRGBTransferEOTF(quantizedDisplay), sceneColor.a);
  const pipeline = new THREE.RenderPipeline(renderer, output);

  return {
    render: () => pipeline.render(),
    resize(width, height) {
      const scale = Math.min(1, 480 / Math.max(1, width), 270 / Math.max(1, height));
      scenePass.setResolutionScale(scale);
      retroResolution.value.set(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
      );
    },
    dispose() {
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}
