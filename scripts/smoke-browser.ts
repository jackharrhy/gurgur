import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createGurgurServer, type GurgurServer } from "../apps/server/src/server";
import worldBundleJson from "../content/generated/systems-garden.json";
import { PLAYER_CAPSULE_RADIUS, PLAYER_HALF_HEIGHT } from "../packages/physics/src/index";
import type { WorldBundle } from "../packages/shared/src/index";

const directory = process.env.GURGUR_URL ? null : await mkdtemp(join(tmpdir(), "gurgur-browser-"));
const scenario = process.env.SMOKE_SCENARIO ?? "movement";
const bundle = worldBundleJson as unknown as WorldBundle;
const heavyEntity = bundle.entities.find((entity) => entity.authoredId === "physics.cube.heavy");
const heavyBrush =
  heavyEntity?.brushIndices.length === 1 ? bundle.brushes[heavyEntity.brushIndices[0]!] : null;
if (["dynamic-landing", "dynamic-push", "grab"].includes(scenario) && !heavyBrush)
  throw new Error("Systems Garden heavy cube fixture is missing");
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
      playerSpawn: ["dynamic-landing", "dynamic-push", "grab"].includes(scenario)
        ? playerSpawn
        : undefined,
    })
  : null;
const url = new URL(process.env.GURGUR_URL ?? `http://127.0.0.1:${server!.port}/`);
const simulatedLatencyMs = Number(process.env.SMOKE_LATENCY_MS ?? 0);
if (simulatedLatencyMs > 0) url.searchParams.set("simulatedLatencyMs", String(simulatedLatencyMs));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const worldBundleRequests: string[] = [];
page.on("request", (request) => {
  const requestUrl = new URL(request.url());
  if (requestUrl.pathname === "/world.bin") worldBundleRequests.push(requestUrl.href);
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
  const requestedRevision = new URL(worldBundleRequests.at(-1) ?? url.href).searchParams.get(
    "revision",
  );
  if (!requestedRevision || !/^[0-9a-f]{64}$/.test(requestedRevision)) {
    throw new Error(
      `world bundle request is not revision-addressed: ${worldBundleRequests.at(-1) ?? "missing"}`,
    );
  }
  await page.waitForFunction(() => Number(document.querySelector("#tick")?.textContent) >= 6);
  const start = await page.evaluate(() => ({
    x: Number(document.body.dataset.predictedX),
    y: Number(document.body.dataset.predictedY),
    z: Number(document.body.dataset.predictedZ),
  }));
  if (scenario === "dynamic-push") {
    const cubeHalfX = Math.max(...heavyBrush!.localVertices.map((vertex) => Math.abs(vertex.x)));
    const samples = page.evaluate(
      () =>
        new Promise<Array<{ playerX: number; cubeX: number }>>((resolve) => {
          const values: Array<{ playerX: number; cubeX: number }> = [];
          const started = performance.now();
          const sample = (now: number): void => {
            values.push({
              playerX: Number(document.body.dataset.renderedX),
              cubeX: Number(document.body.dataset.renderedHeavyCubeX),
            });
            if (now - started >= 1_500) resolve(values);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    const cubeStartX = Number(await page.evaluate(() => document.body.dataset.heavyCubeX));
    await page.keyboard.down("d");
    const presented = await samples;
    await page.keyboard.up("d");
    const presentedCubeEndX =
      presented.findLast(({ cubeX }) => Number.isFinite(cubeX))?.cubeX ?? cubeStartX;
    if (presentedCubeEndX < cubeStartX + 0.01) {
      throw new Error(
        `dynamic cube did not visibly respond to the push: ${(presentedCubeEndX - cubeStartX).toFixed(4)}m`,
      );
    }
    const penetrations = presented
      .filter(({ playerX, cubeX }) => Number.isFinite(playerX) && Number.isFinite(cubeX))
      .map(({ playerX, cubeX }) => playerX + PLAYER_CAPSULE_RADIUS - (cubeX - cubeHalfX));
    const maxPenetration = Math.max(0, ...penetrations);
    if (maxPenetration > 0.035) {
      throw new Error(`presented player phased into dynamic cube by ${maxPenetration.toFixed(4)}m`);
    }
  } else if (scenario === "dynamic-landing") {
    await page.waitForFunction(
      (halfHeight) => {
        const supportY = Number(document.body.dataset.heavyCubeTopY) + halfHeight;
        const authoritativeY = Number(document.body.dataset.playerY);
        const predictedY = Number(document.body.dataset.predictedY);
        return (
          Number.isFinite(supportY) &&
          Math.abs(authoritativeY - supportY) < 0.09 &&
          Math.abs(predictedY - supportY) < 0.09
        );
      },
      PLAYER_HALF_HEIGHT,
      { timeout: 5_000 },
    );
    const supportY = Number(await page.evaluate(() => document.body.dataset.predictedY));
    await page.keyboard.press("Space");
    await page.waitForFunction(
      (y) => Number(document.body.dataset.predictedY) > y + 0.08,
      supportY,
    );
    await page.waitForFunction(
      ({ halfHeight, jumpedFrom }) => {
        const target = Number(document.body.dataset.heavyCubeTopY) + halfHeight;
        return (
          Number(document.body.dataset.predictedY) < jumpedFrom + 0.05 &&
          Math.abs(Number(document.body.dataset.playerY) - target) < 0.1
        );
      },
      { halfHeight: PLAYER_HALF_HEIGHT, jumpedFrom: supportY },
      { timeout: 4_000 },
    );
  } else if (scenario === "grab") {
    await page.waitForFunction(() => Boolean(document.body.dataset.interactionTarget), null, {
      timeout: 5_000,
    });
    const beforeZ = Number(await page.evaluate(() => document.body.dataset.heavyCubeZ));
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
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = 1;
    });
    await page.waitForFunction(
      (z) => Number(document.body.dataset.heavyCubeZ) > z + 0.12,
      beforeZ,
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
    const groundedY = Number(await page.evaluate(() => document.body.dataset.predictedY));
    await page.dispatchEvent('[data-touch-action="jump"]', "pointerdown", {
      pointerType: "touch",
      pointerId: 41,
    });
    await page.dispatchEvent('[data-touch-action="jump"]', "pointerup", {
      pointerType: "touch",
      pointerId: 41,
    });
    await page.waitForFunction(
      (y) => Number(document.body.dataset.predictedY) > y + 0.08,
      groundedY,
    );
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
    );
    await page.evaluate(() => {
      (window as unknown as { __gurgurSmokePad: { axes: number[] } }).__gurgurSmokePad.axes[1] = 0;
    });
    const groundedY = Number(await page.evaluate(() => document.body.dataset.predictedY));
    await page.evaluate(() => {
      (
        window as unknown as { __gurgurSmokePad: { buttons: Array<{ pressed: boolean }> } }
      ).__gurgurSmokePad.buttons[0]!.pressed = true;
    });
    await page.waitForTimeout(40);
    await page.evaluate(() => {
      (
        window as unknown as { __gurgurSmokePad: { buttons: Array<{ pressed: boolean }> } }
      ).__gurgurSmokePad.buttons[0]!.pressed = false;
    });
    await page.waitForFunction(
      (y) => Number(document.body.dataset.predictedY) > y + 0.08,
      groundedY,
    );
  } else {
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
      start,
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
        Math.hypot(authorityDuringPrediction.x - start.x, authorityDuringPrediction.z - start.z) >
        0.15
      ) {
        throw new Error(
          "authoritative movement arrived before the shaped-latency prediction check",
        );
      }
    }
    const groundedY = Number(await page.evaluate(() => document.body.dataset.predictedY));
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
    status: document.querySelector("#connection")?.textContent,
    tick: Number(document.querySelector("#tick")?.textContent),
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
