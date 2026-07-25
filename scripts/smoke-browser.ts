import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGurgurServer, type GurgurServer } from "../apps/server/src/server";
import worldBundleJson from "../content/generated/systems-garden.json";
import {
  validateGurgurNetworkTrace,
  type GurgurNetworkTrace,
} from "../packages/engine/src/network-trace";
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
const lightingScenario = scenario === "lighting";
const followScenario = scenario === "follow-camera";
const fixtureScenario = interactionScenario || scenario === "prediction-drift";
const interactionFixture = scenario === "dynamic-push" ? "network-push-corridor" : "network-boxes";
const bundle = fixtureScenario
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
const playerSpawn = lightingScenario
  ? { x: -24.5, y: 2, z: -3 }
  : heavyBrush
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
      playerSpawn: interactionScenario || lightingScenario ? playerSpawn : undefined,
      worldBundle: fixtureScenario ? bundle : undefined,
      devMcpPort: followScenario ? 0 : undefined,
    })
  : null;
const url = new URL(process.env.GURGUR_URL ?? `http://127.0.0.1:${server!.port}/`);
let mcpClient: Client | null = null;
let followedControllerId: string | null = null;
const followedPosition = { x: -3.3329509925322056, y: 0.89, z: 3.7595095072943114 };
if (followScenario) {
  if (!server?.devMcpUrl) throw new Error("follow-camera smoke requires the development MCP");
  mcpClient = new Client({ name: "gurgur-follow-camera-smoke", version: "1.0.0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(server.devMcpUrl)));
  const result = await mcpClient.callTool({
    name: "spawn_player",
    arguments: { position: followedPosition, yaw: -0.6776000261306763 },
  });
  const spawned = result.structuredContent as {
    controllerId: string;
    player: { id: { index: number; generation: number } };
  };
  followedControllerId = spawned.controllerId;
  url.searchParams.set("follow", `${spawned.player.id.index}:${spawned.player.id.generation}`);
  url.searchParams.set("yaw", "-0.6776000261306763");
  url.searchParams.set("pitch", "-1.2");
}
const simulatedLatencyMs = Number(process.env.SMOKE_LATENCY_MS ?? 0);
if (simulatedLatencyMs > 0) url.searchParams.set("simulatedLatencyMs", String(simulatedLatencyMs));
if (process.env.GURGUR_TEST_MODE === "1") url.searchParams.set("test", "1");
if (scenario === "grab" && process.env.SMOKE_DISABLE_DEBUG !== "1")
  url.searchParams.set("debug", "1");
const browserName = process.env.SMOKE_BROWSER === "firefox" ? "firefox" : "chromium";
const chromiumArgs =
  process.platform === "linux"
    ? [
        "--use-angle=vulkan",
        "--enable-features=Vulkan",
        "--disable-vulkan-surface",
        "--enable-unsafe-webgpu",
      ]
    : [];
const browser =
  browserName === "firefox"
    ? await firefox.launch({ headless: true })
    : await chromium.launch({ executablePath, headless: true, args: chromiumArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  const state = { exposed: false, hiddenSamples: 0 };
  Object.defineProperty(window, "__gurgurSmokeViewGate", { value: state });
  const sample = (): void => {
    const canvas = document.querySelector("#world");
    if (canvas && document.body.dataset.playerViewReady !== "true") {
      state.hiddenSamples += 1;
      if (Number(getComputedStyle(canvas).opacity) !== 0) state.exposed = true;
    }
    if (document.body.dataset.playerViewReady !== "true") requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
if (process.env.SMOKE_RTC_TRACE === "1")
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"rtc-answer"')) console.log(payload);
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"rtc-offer"')) console.log(payload);
    });
  });
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
if (process.env.SMOKE_DENY_POINTER_LOCK === "1")
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "requestPointerLock", {
      configurable: true,
      value: () => Promise.reject(new DOMException("denied by smoke test", "NotAllowedError")),
    });
  });
if (scenario === "stale-session")
  await page.addInitScript(() => {
    sessionStorage.setItem("gurgur.session", "stale-session-token-for-browser-smoke");
  });
if (scenario === "webgpu-unsupported")
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      get: () => undefined,
    });
  });
const smokeComplete = Symbol("smoke complete");
try {
  const pageErrors: string[] = [];
  const recordPageError = (message: string): void => {
    // Debian's software Vulkan adapter emits this during Three's error-scope
    // teardown even when the WebGPU readiness and rendered-frame gates pass.
    if (
      process.env.SMOKE_SOFTWARE_WEBGPU === "1" &&
      message === "Instance dropped in popErrorScope"
    )
      return;
    pageErrors.push(message);
  };
  page.on("pageerror", (error) => recordPageError(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      const error = message.text();
      recordPageError(error);
      if (pageErrors.at(-1) === error) console.error(`browser console: ${error}`);
    }
  });
  await page.goto(url.href);
  if (scenario === "webgpu-unsupported") {
    await page.locator('body[data-webgpu="unsupported"]').waitFor({ timeout: 5_000 });
    const unsupported = await page.evaluate(() => ({
      canvasCount: document.querySelectorAll("canvas").length,
      mainChildren: document.querySelector("main")?.childElementCount,
      text: document.querySelector("#webgpu-unsupported")?.textContent ?? "",
    }));
    if (
      unsupported.canvasCount !== 0 ||
      unsupported.mainChildren !== 1 ||
      !unsupported.text.includes("WebGPU is required") ||
      worldBundleRequests.length !== 0 ||
      materialTextureRequests.length !== 0 ||
      pageErrors.length !== 0
    )
      throw new Error(
        `unsupported WebGPU gate failed: ${JSON.stringify({
          unsupported,
          worldBundleRequests,
          materialTextureRequests,
          pageErrors,
        })}`,
      );
    if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT });
    console.log("browser WebGPU unsupported-state smoke passed without loading the game client");
    throw smokeComplete;
  }
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-world-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-player-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-prediction-ready="true"]').waitFor({ timeout: 5_000 });
  await page.locator('body[data-input-ready="true"]').waitFor({ timeout: 5_000 });
  if (followScenario) {
    await page.locator('body[data-follow-camera="ready"]').waitFor({ timeout: 5_000 });
    const followed = await page.evaluate(() => ({
      x: Number(document.body.dataset.followX),
      y: Number(document.body.dataset.followY),
      z: Number(document.body.dataset.followZ),
      yaw: Number(document.body.dataset.followYaw),
      pitch: Number(document.body.dataset.followPitch),
    }));
    if (
      Math.hypot(
        followed.x - followedPosition.x,
        followed.y - followedPosition.y,
        followed.z - followedPosition.z,
      ) > 0.05 ||
      followed.yaw !== -0.6776000261306763 ||
      followed.pitch !== -1.2
    )
      throw new Error(
        `follow camera did not acquire the requested pose: ${JSON.stringify(followed)}`,
      );
  }
  if (scenario === "grab" && process.env.SMOKE_DISABLE_DEBUG !== "1") {
    const traceButton = page.locator("#network-trace-controls button");
    await traceButton.waitFor({ timeout: 5_000 });
    if ((await traceButton.textContent()) !== "Record trace" || !(await traceButton.isEnabled()))
      throw new Error("development network trace control is not ready");
  }
  const viewGate = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __gurgurSmokeViewGate: { exposed: boolean; hiddenSamples: number };
      }
    ).__gurgurSmokeViewGate;
    const canvas = document.querySelector("#world");
    return {
      ...state,
      canvasOpacity: canvas ? getComputedStyle(canvas).opacity : null,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      ready: document.body.dataset.playerViewReady,
    };
  });
  if (
    viewGate.exposed ||
    viewGate.hiddenSamples === 0 ||
    viewGate.canvasOpacity !== "1" ||
    viewGate.bodyBackground !== "rgb(0, 0, 0)" ||
    viewGate.ready !== "true"
  ) {
    throw new Error(`player-view reveal gate failed: ${JSON.stringify(viewGate)}`);
  }
  const camera = await page.evaluate(() =>
    (
      window as unknown as {
        __gurgurDiagnostics: {
          camera(): { distance: number; safeDistance: number };
        };
      }
    ).__gurgurDiagnostics.camera(),
  );
  if (
    !Number.isFinite(camera.distance) ||
    !Number.isFinite(camera.safeDistance) ||
    camera.distance < 0 ||
    camera.distance > camera.safeDistance + 1e-6 ||
    camera.safeDistance > 4.2
  ) {
    throw new Error(`camera boom escaped its safe distance: ${JSON.stringify(camera)}`);
  }
  if (scenario === "stale-session") {
    for (let reload = 0; reload < 3; reload += 1) {
      await page.reload();
      const outcome = await Promise.race([
        page
          .locator('body[data-close-reason="stale socket generation"]')
          .waitFor({ timeout: 5_000 })
          .then(() => "stale" as const),
        page
          .locator('body[data-input-ready="true"]')
          .waitFor({ timeout: 5_000 })
          .then(() => "ready" as const),
      ]);
      if (outcome === "stale")
        throw new Error(`hard reload ${reload + 1} reused a stale socket generation`);
    }
  }
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => new URL(entry.name).pathname.startsWith("/textures/")),
  );
  const shell = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#world");
    const main = document.querySelector("main");
    canvas?.focus();
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    return {
      mainChildren: main?.childElementCount,
      canvasChildren: main?.querySelectorAll(":scope > canvas").length,
      controls: document.querySelectorAll("button, [role=button], input, .hud").length,
      canvasFocused: document.activeElement === canvas,
      canvasBorderWidth: canvasStyle?.borderWidth,
      canvasOutlineStyle: canvasStyle?.outlineStyle,
      cursor: canvasStyle?.cursor,
      reticle: main ? getComputedStyle(main, "::after").content : null,
    };
  });
  const expectedControls = scenario === "grab" && process.env.SMOKE_DISABLE_DEBUG !== "1" ? 1 : 0;
  if (
    shell.mainChildren !== 1 ||
    shell.canvasChildren !== 1 ||
    shell.controls !== expectedControls ||
    !shell.canvasFocused ||
    shell.canvasBorderWidth !== "0px" ||
    shell.canvasOutlineStyle !== "none" ||
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
  if (scenario === "lighting") {
    await waitForStablePlayerHeight();
    await page.waitForTimeout(250);
  } else if (scenario === "prediction-drift") {
    const driftDurationMs = Number(process.env.SMOKE_DRIFT_DURATION_MS ?? 6_500);
    const started = await page.evaluate(() => ({
      serverTick: Number(document.body.dataset.serverTick),
      inputSequence: Number(document.body.dataset.inputSequence),
    }));
    await page.waitForTimeout(driftDurationMs);
    const before = await page.evaluate(() => ({
      authority: {
        x: Number(document.body.dataset.playerX),
        z: Number(document.body.dataset.playerZ),
      },
      predicted: {
        x: Number(document.body.dataset.predictedX),
        z: Number(document.body.dataset.predictedZ),
      },
      serverTick: Number(document.body.dataset.serverTick),
      predictionTick: Number(document.body.dataset.predictionTick),
      pendingPredictionTicks: Number(document.body.dataset.pendingPredictionTicks),
      inputSequence: Number(document.body.dataset.inputSequence),
    }));
    const inputRateHz = ((before.inputSequence - started.inputSequence) * 1_000) / driftDurationMs;
    const predictionLeadTicks = before.predictionTick - before.serverTick;
    if (
      !Object.values(before.authority).every(Number.isFinite) ||
      !Object.values(before.predicted).every(Number.isFinite) ||
      before.serverTick - started.serverTick < (driftDurationMs / 1_000) * 55 ||
      !Number.isFinite(inputRateHz) ||
      inputRateHz < 57 ||
      inputRateHz > 61 ||
      !Number.isFinite(predictionLeadTicks) ||
      predictionLeadTicks < -2 ||
      predictionLeadTicks > 4 ||
      before.pendingPredictionTicks < 0 ||
      before.pendingPredictionTicks > 4
    ) {
      throw new Error(
        `prediction drift warmup did not stay clocked: ` +
          JSON.stringify({ ...before, inputRateHz, predictionLeadTicks }),
      );
    }
    await page.keyboard.down("w");
    await page.waitForTimeout(350);
    const moving = await page.evaluate(() => ({
      authority: {
        x: Number(document.body.dataset.playerX),
        z: Number(document.body.dataset.playerZ),
      },
      predicted: {
        x: Number(document.body.dataset.predictedX),
        z: Number(document.body.dataset.predictedZ),
      },
    }));
    await page.keyboard.up("w");
    const predictionLead = Math.hypot(
      moving.predicted.x - moving.authority.x,
      moving.predicted.z - moving.authority.z,
    );
    if (!Number.isFinite(predictionLead) || predictionLead > 0.25) {
      throw new Error(
        `real browser prediction accumulated ${predictionLead.toFixed(4)}m of clock drift: ` +
          JSON.stringify(moving),
      );
    }
    console.log(
      `real browser clock: ${inputRateHz.toFixed(2)} Hz input, ` +
        `${predictionLeadTicks} pending tick lead, ${predictionLead.toFixed(4)}m moving lead`,
    );
  } else if (scenario === "dynamic-push") {
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
    if (process.env.SMOKE_DISABLE_DEBUG !== "1")
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
    if (process.env.SMOKE_OUTLINE_SCREENSHOT)
      await page.screenshot({ path: process.env.SMOKE_OUTLINE_SCREENSHOT });
    if (process.env.SMOKE_OUTLINE_PLAYER_SCREENSHOT) {
      await page.dispatchEvent("canvas", "pointerdown", {
        pointerId: 91,
        pointerType: "touch",
        clientX: 960,
        clientY: 360,
      });
      await page.dispatchEvent("canvas", "pointermove", {
        pointerId: 91,
        pointerType: "touch",
        clientX: 960,
        clientY: 388,
      });
      await page.dispatchEvent("canvas", "pointerup", {
        pointerId: 91,
        pointerType: "touch",
        clientX: 960,
        clientY: 388,
      });
      await page.waitForTimeout(120);
      await page.screenshot({ path: process.env.SMOKE_OUTLINE_PLAYER_SCREENSHOT });
      await page.dispatchEvent("canvas", "pointerdown", {
        pointerId: 92,
        pointerType: "touch",
        clientX: 960,
        clientY: 388,
      });
      await page.dispatchEvent("canvas", "pointermove", {
        pointerId: 92,
        pointerType: "touch",
        clientX: 960,
        clientY: 360,
      });
      await page.dispatchEvent("canvas", "pointerup", {
        pointerId: 92,
        pointerType: "touch",
        clientX: 960,
        clientY: 360,
      });
      await page.waitForFunction(
        () => document.body.dataset.interactionOutline === "available",
        null,
        { timeout: 5_000 },
      );
    }
    const traceButton =
      process.env.SMOKE_DISABLE_DEBUG === "1"
        ? null
        : page.locator("#network-trace-controls button");
    if (traceButton) {
      await traceButton.click();
      await page.waitForFunction(
        () =>
          document.querySelector("#network-trace-controls button")?.textContent ===
          "Stop and download",
      );
    }
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
    await page.dispatchEvent("canvas", "pointerdown", {
      pointerId: 93,
      pointerType: "touch",
      clientX: 960,
      clientY: 360,
    });
    await page.dispatchEvent("canvas", "pointermove", {
      pointerId: 93,
      pointerType: "touch",
      clientX: 1_040,
      clientY: 340,
    });
    await page.dispatchEvent("canvas", "pointerup", {
      pointerId: 93,
      pointerType: "touch",
      clientX: 1_040,
      clientY: 340,
    });
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = 0;
    });
    const releaseZ = await page.evaluate(
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
    await page.waitForFunction(() => document.body.dataset.interactionOutline !== "held", null, {
      timeout: 5_000,
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
        return current !== undefined && Number.isFinite(current) && Math.abs(current - z) > 0.005;
      },
      { z: releaseZ, entityIndex: heavyEntityIndex },
      { timeout: 2_000 },
    );
    if (traceButton) {
      await page.waitForTimeout(250);
      const downloadPromise = page.waitForEvent("download");
      await traceButton.click();
      const download = await downloadPromise;
      const tracePath = await download.path();
      if (!tracePath) throw new Error("browser grab trace download has no local path");
      const trace = validateGurgurNetworkTrace(await Bun.file(tracePath).json());
      const correctionP95 =
        trace.analysis.prediction.rawCorrectionMetres.p95 ?? Number.POSITIVE_INFINITY;
      const correctionMax =
        trace.analysis.prediction.rawCorrectionMetres.max ?? Number.POSITIVE_INFINITY;
      const visibleCorrectionMax = Math.max(
        0,
        ...trace.client.prediction.flatMap(({ event }) =>
          event.kind === "reconciliation" ? [event.visibleCorrectionMetres] : [],
        ),
      );
      const proxyPosition = trace.analysis.presentation.bySource["predicted-proxy"]?.positionMetres;
      const proxyP95 = proxyPosition?.p95 ?? Number.POSITIVE_INFINITY;
      const proxyMax = proxyPosition?.max ?? Number.POSITIVE_INFINITY;
      const releaseProxy = releasedPropProxyError(trace);
      const worstProxy = trace.analysis.presentation.worst
        .filter(({ source }) => source === "predicted-proxy")
        .slice(0, 5);
      if (
        correctionP95 > 0.09 ||
        correctionMax > 0.22 ||
        visibleCorrectionMax > 0.22 ||
        proxyP95 > 0.1 ||
        proxyMax > 0.25 ||
        releaseProxy.samples === 0 ||
        releaseProxy.maxMetres > 0.25
      )
        throw new Error(
          `browser grab prediction diverged: ${JSON.stringify({
            correctionP95,
            correctionMax,
            visibleCorrectionMax,
            proxyP95,
            proxyMax,
            releaseProxy,
            worstProxy,
          })}`,
        );
      console.log(
        `grab trace: ${(correctionP95 * 100).toFixed(2)}cm correction p95, ` +
          `${(releaseProxy.maxMetres * 100).toFixed(2)}cm post-release proxy max`,
      );
    }
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
    if (process.env.SMOKE_DENY_POINTER_LOCK === "1") {
      await page.locator("#world").click();
      await page.waitForFunction(
        () =>
          document.body.dataset.pointerLockFailed === "true" &&
          document.activeElement === document.querySelector("#world") &&
          document.pointerLockElement === null,
      );
    }
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
    webgpu: document.body.dataset.webgpu,
    rendererBackend: document.body.dataset.rendererBackend,
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
    result.webgpu !== "ready" ||
    result.rendererBackend !== "webgpu" ||
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
  if (lightingScenario)
    console.log(
      `lighting viewpoint: ${result.player.x.toFixed(2)}, ${result.player.y.toFixed(2)}, ${result.player.z.toFixed(2)}`,
    );
  console.log(
    `browser ${scenario} prediction smoke passed${latencyLabel} at tick ${result.tick} (${resolution})`,
  );
} catch (error) {
  if (error === smokeComplete) {
    // The unsupported-capability path deliberately exits before creating a
    // renderer, network session, or prediction worker.
  } else {
    const failurePath =
      process.env.SMOKE_SCREENSHOT ?? join(tmpdir(), `gurgur-browser-${scenario}-failure.png`);
    await page.screenshot({ path: failurePath });
    console.error(
      "browser smoke failure state",
      await page.evaluate(() => ({ ...document.body.dataset })),
    );
    console.error(`browser smoke failure screenshot: ${failurePath}`);
    throw error;
  }
} finally {
  await browser.close();
  if (mcpClient && followedControllerId)
    await mcpClient.callTool({
      name: "remove_player",
      arguments: { controllerId: followedControllerId },
    });
  await mcpClient?.close();
  server?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}

function releasedPropProxyError(trace: GurgurNetworkTrace): {
  id: { index: number; generation: number } | null;
  releaseTick: number | null;
  samples: number;
  maxMetres: number;
} {
  let previousTarget: { index: number; generation: number } | null = null;
  let releasedTarget: { index: number; generation: number } | null = null;
  let releaseTick: number | null = null;
  for (const frame of trace.server.frames) {
    const target =
      frame.players.find(({ id }) => sameRuntimeId(id, trace.session.playerId))?.grabTarget ?? null;
    if (previousTarget && !target) {
      releasedTarget = previousTarget;
      releaseTick = frame.serverTick;
      break;
    }
    previousTarget = target ? { ...target } : null;
  }
  if (!releasedTarget || releaseTick === null)
    return { id: null, releaseTick: null, samples: 0, maxMetres: Number.POSITIVE_INFINITY };

  let samples = 0;
  let maxMetres = 0;
  for (const frame of trace.client.presentation) {
    const presented = frame.bodies.find(
      ({ body, source }) => source === "predicted-proxy" && sameRuntimeId(body.id, releasedTarget),
    );
    if (
      !presented ||
      presented.comparisonServerTick < releaseTick ||
      presented.comparisonServerTick > releaseTick + 30
    )
      continue;
    const authority = traceBodyPositionAt(trace, releasedTarget, presented.comparisonServerTick);
    if (!authority) continue;
    samples += 1;
    maxMetres = Math.max(
      maxMetres,
      Math.hypot(
        presented.body.position.x - authority.x,
        presented.body.position.y - authority.y,
        presented.body.position.z - authority.z,
      ),
    );
  }
  return { id: releasedTarget, releaseTick, samples, maxMetres };
}

function traceBodyPositionAt(
  trace: GurgurNetworkTrace,
  id: { index: number; generation: number },
  tick: number,
): { x: number; y: number; z: number } | null {
  let before: GurgurNetworkTrace["server"]["frames"][number] | null = null;
  let after: GurgurNetworkTrace["server"]["frames"][number] | null = null;
  for (const frame of trace.server.frames) {
    if (frame.serverTick <= tick) before = frame;
    if (frame.serverTick >= tick) {
      after = frame;
      break;
    }
  }
  if (!before || !after) return null;
  const left = before.bodies.find((body) => sameRuntimeId(body.id, id));
  const right = after.bodies.find((body) => sameRuntimeId(body.id, id));
  if (!left || !right) return null;
  const span = after.serverTick - before.serverTick;
  const amount = span <= 0 ? 0 : (tick - before.serverTick) / span;
  return {
    x: left.position.x + (right.position.x - left.position.x) * amount,
    y: left.position.y + (right.position.y - left.position.y) * amount,
    z: left.position.z + (right.position.z - left.position.z) * amount,
  };
}

function sameRuntimeId(
  left: { index: number; generation: number },
  right: { index: number; generation: number },
): boolean {
  return left.index === right.index && left.generation === right.generation;
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
