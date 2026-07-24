import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createGurgurServer, type GurgurServer } from "../apps/server/src/server";
import worldBundleJson from "../content/generated/systems-garden.json";
import {
  PLAYER_CAPSULE_HALF_SEGMENT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_HALF_HEIGHT,
} from "../packages/game/src/controller";
import type { WorldBundle } from "../packages/game/src/index";
import { compileWorld } from "../packages/game/src/index";

const directory = process.env.GURGUR_URL ? null : await mkdtemp(join(tmpdir(), "gurgur-browser-"));
const scenario = process.env.SMOKE_SCENARIO ?? "movement";
const interactionScenario = ["dynamic-landing", "dynamic-push", "grab"].includes(scenario);
const interactionFixture =
  scenario === "dynamic-push" || scenario === "grab" ? "network-push-corridor" : "network-boxes";
const bundle = interactionScenario
  ? compileWorld(
      await Bun.file(
        new URL(`../content/maps/fixtures/${interactionFixture}.map`, import.meta.url),
      ).text(),
      `${interactionFixture}.map`,
    )
  : (worldBundleJson as unknown as WorldBundle);
const heavyEntity = bundle.entities.find(
  (entity) => entity.kind === "physics-prop" && entity.body.brushIndices.length === 1,
);
const heavyEntityIndex = heavyEntity ? bundle.entities.indexOf(heavyEntity) : -1;
const heavyBrush =
  heavyEntity?.kind === "physics-prop" ? bundle.brushes[heavyEntity.body.brushIndices[0]!] : null;
if (interactionScenario && !heavyBrush)
  throw new Error("Systems Garden physics-prop fixture is missing");
const playerSpawn = heavyBrush
  ? scenario === "grab"
    ? {
        x: heavyBrush.center.x,
        y: PLAYER_HALF_HEIGHT,
        z: heavyBrush.center.z + 2.5,
      }
    : scenario === "dynamic-push"
      ? {
          x:
            heavyBrush.center.x -
            Math.max(...heavyBrush.localVertices.map((vertex) => Math.abs(vertex.x))) -
            1.2,
          y: PLAYER_HALF_HEIGHT,
          z: heavyBrush.center.z,
        }
      : {
          x: heavyBrush.center.x,
          y:
            heavyBrush.center.y +
            Math.max(...heavyBrush.localVertices.map((vertex) => vertex.y)) +
            2.5,
          z: heavyBrush.center.z,
        }
  : undefined;
const executablePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const server: GurgurServer | null = directory
  ? await createGurgurServer({
      port: 0,
      hostname: "127.0.0.1",
      databasePath: join(directory, "world.sqlite"),
      playerSpawn: interactionScenario ? playerSpawn : undefined,
      worldBundle: interactionScenario ? bundle : undefined,
    })
  : null;
const url = new URL(process.env.GURGUR_URL ?? `http://127.0.0.1:${server!.port}/`);
const simulatedLatencyMs = Number(process.env.SMOKE_LATENCY_MS ?? 0);
if (simulatedLatencyMs > 0) url.searchParams.set("simulatedLatencyMs", String(simulatedLatencyMs));
if (process.env.GURGUR_TEST_MODE === "1") url.searchParams.set("test", "1");
if (scenario === "grab") url.searchParams.set("debug", "1");
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const waitForStablePlayerHeight = async (): Promise<number> =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let stableSince = performance.now();
        let previousY = Number(document.body.dataset.predictedY);
        const sample = (now: number): void => {
          const y = Number(document.body.dataset.predictedY);
          if (!Number.isFinite(y) || !Number.isFinite(previousY) || Math.abs(y - previousY) > 0.01)
            stableSince = now;
          previousY = y;
          if (now - stableSince >= 300) resolve(y);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
const worldBundleRequests: string[] = [];
const materialTextureRequests: string[] = [];
page.on("request", (request) => {
  const requestUrl = new URL(request.url());
  if (requestUrl.pathname === "/world.bin") worldBundleRequests.push(requestUrl.href);
  if (requestUrl.pathname.startsWith("/textures/") && requestUrl.pathname.endsWith(".png")) {
    materialTextureRequests.push(requestUrl.href);
  }
});
if (scenario === "grab" || scenario === "gamepad")
  await page.addInitScript(() => {
    const pad = {
      connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })),
    };
    Object.defineProperty(window, "__gurgurSmokePad", { value: pad });
    Object.defineProperty(navigator, "getGamepads", { value: () => [pad] });
  });
if (scenario === "stale-session")
  await page.addInitScript(() => {
    sessionStorage.setItem("gurgur.session", "stale-session-token-for-browser-smoke");
  });
try {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      pageErrors.push(message.text());
      console.error(`browser console: ${message.text()}`);
    }
  });
  await page.goto(url.href);
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-world-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-player-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-prediction-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-input-ready="true"]').waitFor({ timeout: 5_000 });
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => new URL(entry.name).pathname.startsWith("/textures/")),
  );
  const shell = await page.evaluate(() => {
    const canvas = document.querySelector("#world");
    const main = document.querySelector("main");
    return {
      mainChildren: main?.childElementCount,
      canvasChildren: main?.querySelectorAll(":scope > canvas").length,
      controls: document.querySelectorAll("button, [role=button], input, .hud").length,
      cursor: canvas ? getComputedStyle(canvas).cursor : null,
      reticle: main ? getComputedStyle(main, "::after").content : null,
    };
  });
  if (
    shell.mainChildren !== 1 ||
    shell.canvasChildren !== 1 ||
    shell.controls !== 0 ||
    shell.cursor !== "none" ||
    !["none", "normal"].includes(shell.reticle ?? "")
  ) {
    throw new Error(`play view is not canvas-only: ${JSON.stringify(shell)}`);
  }
  const requestedRevision = new URL(worldBundleRequests.at(-1) ?? url.href).searchParams.get(
    "revision",
  );
  if (!requestedRevision || !/^[0-9a-f]{64}$/.test(requestedRevision)) {
    throw new Error(
      `world bundle request is not revision-addressed: ${worldBundleRequests.at(-1) ?? "missing"}`,
    );
  }
  if (
    materialTextureRequests.length === 0 ||
    materialTextureRequests.some(
      (requestUrl) => !/^[0-9a-f]{64}$/.test(new URL(requestUrl).searchParams.get("v") ?? ""),
    )
  ) {
    throw new Error(
      `material textures are not content-addressed: ${materialTextureRequests.join(", ") || "missing"}`,
    );
  }
  await page.waitForFunction(() => Number(document.body.dataset.serverTick) >= 6);
  if (scenario === "dynamic-push") {
    const cubeHalfX = Math.max(...heavyBrush!.localVertices.map((vertex) => Math.abs(vertex.x)));
    await page.waitForFunction(
      (entityIndex) => {
        const playerX = Number(document.body.dataset.renderedX);
        const cubeX = (
          window as unknown as {
            __gurgurDiagnostics: {
              bodies(): Array<{
                entityIndex: number;
                rendered?: { position: { x: number } };
              }>;
            };
          }
        ).__gurgurDiagnostics
          .bodies()
          .find((body) => body.entityIndex === entityIndex)?.rendered?.position.x;
        return (
          Number.isFinite(playerX) && Number.isFinite(cubeX) && Math.abs(cubeX! - playerX) > 0.1
        );
      },
      heavyEntityIndex,
      { timeout: 5_000 },
    );
    const samples = page.evaluate(
      (entityIndex) =>
        new Promise<
          Array<{
            player: { x: number; y: number; z: number };
            predictedCubeX: number;
            cube: {
              position: { x: number; y: number; z: number };
              rotation: { x: number; y: number; z: number; w: number };
            };
          }>
        >((resolve) => {
          const values: Array<{
            player: { x: number; y: number; z: number };
            predictedCubeX: number;
            cube: {
              position: { x: number; y: number; z: number };
              rotation: { x: number; y: number; z: number; w: number };
            };
          }> = [];
          const started = performance.now();
          const sample = (now: number): void => {
            const diagnostic = (
              window as unknown as {
                __gurgurDiagnostics: {
                  bodies(): Array<{
                    entityIndex: number;
                    predicted?: { position: { x: number } };
                    rendered?: {
                      position: { x: number; y: number; z: number };
                      rotation: { x: number; y: number; z: number; w: number };
                    };
                  }>;
                };
              }
            ).__gurgurDiagnostics
              .bodies()
              .find((body) => body.entityIndex === entityIndex);
            values.push({
              player: {
                x: Number(document.body.dataset.renderedX),
                y: Number(document.body.dataset.renderedY),
                z: Number(document.body.dataset.renderedZ),
              },
              predictedCubeX: diagnostic?.predicted?.position.x ?? Number.NaN,
              cube: {
                position: diagnostic?.rendered?.position ?? {
                  x: Number.NaN,
                  y: Number.NaN,
                  z: Number.NaN,
                },
                rotation: diagnostic?.rendered?.rotation ?? {
                  x: Number.NaN,
                  y: Number.NaN,
                  z: Number.NaN,
                  w: Number.NaN,
                },
              },
            });
            if (now - started >= 1_500) resolve(values);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
      heavyEntityIndex,
    );
    const cubeStartX = await page.evaluate(
      (entityIndex) =>
        (
          window as unknown as {
            __gurgurDiagnostics: {
              bodies(): Array<{
                entityIndex: number;
                authoritative?: { position: { x: number } };
              }>;
            };
          }
        ).__gurgurDiagnostics
          .bodies()
          .find((body) => body.entityIndex === entityIndex)?.authoritative?.position.x ??
        Number.NaN,
      heavyEntityIndex,
    );
    await page.keyboard.down("d");
    const presented = await samples;
    await page.keyboard.up("d");
    const presentedCubeEndX =
      presented.findLast(({ cube }) => Number.isFinite(cube.position.x))?.cube.position.x ??
      cubeStartX;
    if (presentedCubeEndX < cubeStartX + 0.01) {
      throw new Error(
        `dynamic cube did not visibly respond to the push: ${(presentedCubeEndX - cubeStartX).toFixed(4)}m`,
      );
    }
    const halfExtents = {
      x: cubeHalfX,
      y: Math.max(...heavyBrush!.localVertices.map((vertex) => Math.abs(vertex.y))),
      z: Math.max(...heavyBrush!.localVertices.map((vertex) => Math.abs(vertex.z))),
    };
    const penetrationSamples = presented
      .filter(({ player, cube }) =>
        [
          ...Object.values(player),
          ...Object.values(cube.position),
          ...Object.values(cube.rotation),
        ].every(Number.isFinite),
      )
      .map(({ player, predictedCubeX, cube }) => ({
        player,
        predictedCubeX,
        cube: cube.position,
        penetration: capsuleBoxPenetration(player, cube, halfExtents),
      }));
    const worstPenetration = penetrationSamples.toSorted(
      (left, right) => right.penetration - left.penetration,
    )[0];
    const maxPenetration = Math.max(0, worstPenetration?.penetration ?? 0);
    if (maxPenetration > 0.035) {
      throw new Error(
        `presented player phased into dynamic cube by ${maxPenetration.toFixed(4)}m ` +
          `(player=${JSON.stringify(worstPenetration?.player)}, ` +
          `cube=${JSON.stringify(worstPenetration?.cube)}, ` +
          `predictedCubeX=${worstPenetration?.predictedCubeX})`,
      );
    }
  } else if (scenario === "dynamic-landing") {
    await page.waitForFunction(
      ({ halfHeight, entityIndex }) => {
        const body = (
          window as unknown as {
            __gurgurDiagnostics: {
              bodies(): Array<{
                entityIndex: number;
                localTop: number;
                authoritative?: { position: { y: number } };
              }>;
            };
          }
        ).__gurgurDiagnostics
          .bodies()
          .find((candidate) => candidate.entityIndex === entityIndex);
        const supportY =
          (body?.authoritative?.position.y ?? Number.NaN) +
          (body?.localTop ?? Number.NaN) +
          halfHeight;
        const authoritativeY = Number(document.body.dataset.playerY);
        const predictedY = Number(document.body.dataset.predictedY);
        return (
          Number.isFinite(supportY) &&
          Math.abs(authoritativeY - supportY) < 0.09 &&
          Math.abs(predictedY - supportY) < 0.09
        );
      },
      { halfHeight: PLAYER_HALF_HEIGHT, entityIndex: heavyEntityIndex },
      { timeout: 5_000 },
    );
    const supportY = Number(await page.evaluate(() => document.body.dataset.predictedY));
    await page.keyboard.press("Space");
    await page.waitForFunction(
      (y) => Number(document.body.dataset.predictedY) > y + 0.08,
      supportY,
    );
    await page.waitForFunction(
      ({ halfHeight, jumpedFrom, entityIndex }) => {
        const body = (
          window as unknown as {
            __gurgurDiagnostics: {
              bodies(): Array<{
                entityIndex: number;
                localTop: number;
                authoritative?: { position: { y: number } };
              }>;
            };
          }
        ).__gurgurDiagnostics
          .bodies()
          .find((candidate) => candidate.entityIndex === entityIndex);
        const target =
          (body?.authoritative?.position.y ?? Number.NaN) +
          (body?.localTop ?? Number.NaN) +
          halfHeight;
        return (
          Number(document.body.dataset.predictedY) < jumpedFrom + 0.05 &&
          Math.abs(Number(document.body.dataset.playerY) - target) < 0.1
        );
      },
      {
        halfHeight: PLAYER_HALF_HEIGHT,
        jumpedFrom: supportY,
        entityIndex: heavyEntityIndex,
      },
      { timeout: 4_000 },
    );
  } else if (scenario === "grab") {
    await page.waitForFunction(
      () => Number(document.body.dataset.physicsDebugPrimitives) > 0,
      null,
      { timeout: 5_000 },
    );
    await page.waitForFunction(() => Boolean(document.body.dataset.interactionTarget), null, {
      timeout: 5_000,
    });
    await page.waitForFunction(
      () => document.body.dataset.interactionOutline === "available",
      null,
      { timeout: 5_000 },
    );
    const beforeZ = await page.evaluate(
      (entityIndex) =>
        (
          window as unknown as {
            __gurgurDiagnostics: {
              bodies(): Array<{
                entityIndex: number;
                authoritative?: { position: { z: number } };
              }>;
            };
          }
        ).__gurgurDiagnostics
          .bodies()
          .find((body) => body.entityIndex === entityIndex)?.authoritative?.position.z ??
        Number.NaN,
      heavyEntityIndex,
    );
    await page.evaluate(() => {
      (
        window as unknown as {
          __gurgurSmokePad: { buttons: Array<{ pressed: boolean; value: number }> };
        }
      ).__gurgurSmokePad.buttons[7]!.pressed = true;
    });
    await page.waitForTimeout(40);
    await page.evaluate(() => {
      (
        window as unknown as {
          __gurgurSmokePad: { buttons: Array<{ pressed: boolean; value: number }> };
        }
      ).__gurgurSmokePad.buttons[7]!.pressed = false;
    });
    await page.waitForFunction(() => document.body.dataset.interactionOutline === "held", null, {
      timeout: 5_000,
    });
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = 1;
    });
    await page.waitForFunction(
      ({ z, entityIndex }) => {
        const current = (
          window as unknown as {
            __gurgurDiagnostics: {
              bodies(): Array<{
                entityIndex: number;
                authoritative?: { position: { z: number } };
              }>;
            };
          }
        ).__gurgurDiagnostics
          .bodies()
          .find((body) => body.entityIndex === entityIndex)?.authoritative?.position.z;
        return current !== undefined && current > z + 0.12;
      },
      { z: beforeZ, entityIndex: heavyEntityIndex },
      { timeout: 4_000 },
    );
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = 0;
    });
    await page.evaluate(() => {
      (
        window as unknown as {
          __gurgurSmokePad: { buttons: Array<{ pressed: boolean; value: number }> };
        }
      ).__gurgurSmokePad.buttons[7]!.pressed = true;
    });
    await page.waitForTimeout(40);
    await page.evaluate(() => {
      (
        window as unknown as {
          __gurgurSmokePad: { buttons: Array<{ pressed: boolean; value: number }> };
        }
      ).__gurgurSmokePad.buttons[7]!.pressed = false;
    });
  } else if (scenario === "touch") {
    const before = await page.evaluate(() => ({
      x: Number(document.body.dataset.predictedX),
      z: Number(document.body.dataset.predictedZ),
    }));
    await page.dispatchEvent("#world", "pointerdown", {
      pointerType: "touch",
      pointerId: 42,
      clientX: 120,
      clientY: 560,
    });
    await page.dispatchEvent("#world", "pointermove", {
      pointerType: "touch",
      pointerId: 42,
      clientX: 180,
      clientY: 500,
    });
    await page.waitForFunction(
      ({ x, z }) =>
        Math.hypot(
          Number(document.body.dataset.predictedX) - x,
          Number(document.body.dataset.predictedZ) - z,
        ) > 0.2,
      before,
    );
    await page.dispatchEvent("#world", "pointerup", {
      pointerType: "touch",
      pointerId: 42,
      clientX: 180,
      clientY: 500,
    });
  } else if (scenario === "gamepad") {
    const groundedY = await waitForStablePlayerHeight();
    const jumpCounter = Number(await page.evaluate(() => document.body.dataset.inputJumpCounter));
    await page.evaluate(() => {
      (
        window as unknown as { __gurgurSmokePad: { buttons: Array<{ pressed: boolean }> } }
      ).__gurgurSmokePad.buttons[0]!.pressed = true;
    });
    await page.waitForFunction(
      (previous) => Number(document.body.dataset.inputJumpCounter) > previous,
      jumpCounter,
      { timeout: 2_000 },
    );
    await page.evaluate(() => {
      (
        window as unknown as { __gurgurSmokePad: { buttons: Array<{ pressed: boolean }> } }
      ).__gurgurSmokePad.buttons[0]!.pressed = false;
    });
    await page.waitForFunction(
      (y) => Number(document.body.dataset.predictedY) > y + 0.08,
      groundedY,
    );
    await waitForStablePlayerHeight();
    const before = await page.evaluate(() => ({
      x: Number(document.body.dataset.predictedX),
      z: Number(document.body.dataset.predictedZ),
    }));
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = -1;
    });
    await page.waitForFunction(
      ({ x, z }) =>
        Math.hypot(
          Number(document.body.dataset.predictedX) - x,
          Number(document.body.dataset.predictedZ) - z,
        ) > 0.4,
      before,
      { timeout: 5_000 },
    );
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = 0;
    });
  } else {
    await waitForStablePlayerHeight();
    const movementStart = await page.evaluate(() => ({
      x: Number(document.body.dataset.predictedX),
      z: Number(document.body.dataset.predictedZ),
    }));
    const cadence = page.evaluate(
      () =>
        new Promise<Array<{ x: number; z: number }>>((resolve) => {
          const samples: Array<{ x: number; z: number }> = [];
          const started = performance.now();
          const sample = (now: number): void => {
            samples.push({
              x: Number(document.body.dataset.renderedX),
              z: Number(document.body.dataset.renderedZ),
            });
            if (now - started >= 180) resolve(samples);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    await page.keyboard.down("w");
    await page.waitForTimeout(190);
    await page.keyboard.up("w");
    const renderedSamples = await cadence;
    await page.waitForFunction(
      ({ x, z }) =>
        Math.hypot(
          Number(document.body.dataset.predictedX) - x,
          Number(document.body.dataset.predictedZ) - z,
        ) > 0.5,
      movementStart,
    );
    const deltas = renderedSamples
      .slice(1)
      .map((sample, index) =>
        Math.hypot(sample.x - renderedSamples[index]!.x, sample.z - renderedSamples[index]!.z),
      )
      .filter(Number.isFinite);
    if (
      deltas.length >= 8 &&
      deltas.filter((delta) => delta < 0.0005).length > deltas.length * 0.25
    ) {
      throw new Error(
        `rendered prediction repeated too many display frames: ${JSON.stringify(deltas)}`,
      );
    }
    if (simulatedLatencyMs >= 100) {
      const authorityDuringPrediction = await page.evaluate(() => ({
        x: Number(document.body.dataset.playerX),
        z: Number(document.body.dataset.playerZ),
      }));
      if (
        Math.hypot(
          authorityDuringPrediction.x - movementStart.x,
          authorityDuringPrediction.z - movementStart.z,
        ) > 0.15
      ) {
        throw new Error(
          "authoritative movement arrived before the shaped-latency prediction check",
        );
      }
    }
    const groundedY = await waitForStablePlayerHeight();
    await page.keyboard.press("Space");
    await page.waitForFunction(
      (y) => Number(document.body.dataset.predictedY) > y + 0.08,
      groundedY,
    );
  }
  if (simulatedLatencyMs > 0) {
    await page.waitForTimeout(simulatedLatencyMs * 2 + 150);
    const correction = Number(
      await page.evaluate(() => document.body.dataset.predictionCorrection),
    );
    if (!Number.isFinite(correction) || correction > 0.05) {
      throw new Error(`prediction did not converge under shaped latency: ${correction}`);
    }
  }
  const result = await page.evaluate(() => ({
    status: document.body.dataset.connection,
    tick: Number(document.body.dataset.serverTick),
    canvasWidth: document.querySelector("canvas")?.width,
    canvasHeight: document.querySelector("canvas")?.height,
    player: {
      x: Number(document.body.dataset.playerX),
      y: Number(document.body.dataset.playerY),
      z: Number(document.body.dataset.playerZ),
    },
    predictedPlayer: {
      x: Number(document.body.dataset.predictedX),
      y: Number(document.body.dataset.predictedY),
      z: Number(document.body.dataset.predictedZ),
    },
  }));
  if (
    result.status !== "connected" ||
    !result.canvasWidth ||
    !result.canvasHeight ||
    pageErrors.length > 0
  ) {
    throw new Error(`browser smoke failed: ${JSON.stringify({ result, pageErrors })}`);
  }
  if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
  const latencyLabel =
    simulatedLatencyMs > 0 ? ` with ${simulatedLatencyMs * 2}ms simulated RTT` : "";
  const resolution = `${result.canvasWidth}x${result.canvasHeight}`;
  console.log(
    `browser ${scenario} prediction smoke passed${latencyLabel} at tick ${result.tick} (${resolution})`,
  );
} catch (error) {
  const failurePath =
    process.env.SMOKE_SCREENSHOT ?? join(tmpdir(), `gurgur-browser-${scenario}-failure.png`);
  await page.screenshot({ path: failurePath });
  console.error(
    "browser smoke failure state",
    await page.evaluate(() => ({ ...document.body.dataset })),
  );
  console.error(`browser smoke failure screenshot: ${failurePath}`);
  throw error;
} finally {
  await browser.close();
  server?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}

function capsuleBoxPenetration(
  player: { x: number; y: number; z: number },
  box: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
  },
  halfExtents: { x: number; y: number; z: number },
): number {
  let minimumDistance = Number.POSITIVE_INFINITY;
  const inverse = {
    x: -box.rotation.x,
    y: -box.rotation.y,
    z: -box.rotation.z,
    w: box.rotation.w,
  };
  for (let index = 0; index <= 64; index += 1) {
    const amount = index / 64;
    const point = {
      x: player.x - box.position.x,
      y:
        player.y -
        PLAYER_CAPSULE_HALF_SEGMENT +
        amount * PLAYER_CAPSULE_HALF_SEGMENT * 2 -
        box.position.y,
      z: player.z - box.position.z,
    };
    const local = rotateVector(point, inverse);
    const separation = {
      x: Math.max(0, Math.abs(local.x) - halfExtents.x),
      y: Math.max(0, Math.abs(local.y) - halfExtents.y),
      z: Math.max(0, Math.abs(local.z) - halfExtents.z),
    };
    minimumDistance = Math.min(
      minimumDistance,
      Math.hypot(separation.x, separation.y, separation.z),
    );
  }
  return Math.max(0, PLAYER_CAPSULE_RADIUS - minimumDistance);
}

function rotateVector(
  vector: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number } {
  const tx = 2 * (rotation.y * vector.z - rotation.z * vector.y);
  const ty = 2 * (rotation.z * vector.x - rotation.x * vector.z);
  const tz = 2 * (rotation.x * vector.y - rotation.y * vector.x);
  return {
    x: vector.x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: vector.y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: vector.z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
}
