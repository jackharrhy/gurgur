import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { compileWorld, PLAYER_HALF_HEIGHT } from "@gurgur/game";
import { createGurgurServer } from "../apps/server/src/server";

const scenario = process.env.SMOKE_SCENARIO ?? "all";
const path = "content/maps/fixtures/network-boxes.map";
const bundle = compileWorld(await Bun.file(path).text(), path);
const prop = bundle.entities.find(
  (entity) => entity.kind === "physics-prop" && entity.body.brushIndices.length === 1,
);
if (!prop) throw new Error("browser pickup fixture is unavailable");
const brush = bundle.brushes[prop.body!.brushIndices[0]!]!;
const spawn = {
  x: brush.center.x,
  y: PLAYER_HALF_HEIGHT,
  z: brush.center.z + 2.5,
};
const directory = await mkdtemp(join(tmpdir(), "gurgur-browser-v5-"));
const adminToken = "browser-v5-admin";
const server = await createGurgurServer({
  port: 0,
  hostname: "127.0.0.1",
  databasePath: join(directory, "world.sqlite"),
  worldBundle: bundle,
  playerSpawn: spawn,
  adminToken,
});
const executablePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

try {
  if (scenario === "all" || scenario === "movement") {
    await resetWorld();
    await movementAndBanding(chrome);
  }
  if (scenario === "all" || scenario === "pickup") {
    await resetWorld();
    await pickupAndRelease(chrome);
  }
  if (scenario === "all" || scenario === "contention") {
    await resetWorld();
    await contentionAndRecovery(chrome);
  }
  console.log(`protocol-v5 browser smoke passed (${scenario})`);
} finally {
  await chrome.close();
  server.stop();
  await rm(directory, { recursive: true, force: true });
}

async function resetWorld(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server.port}/admin/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw new Error(`browser fixture reset failed (${response.status})`);
}

async function movementAndBanding(browser: Browser): Promise<void> {
  const owner = await openPage(browser, 0);
  const observer = await openPage(browser, 40);
  try {
    const ownerId = await localPlayerKey(owner);
    await observer.waitForFunction(
      (id) =>
        (window as unknown as SmokeWindow).__gurgurDiagnostics
          .presentation()
          .some((state) => state.runtimeId === id),
      ownerId,
    );
    await owner.locator("canvas").focus();
    const before = await position(owner, ownerId);
    const responseMs = await owner.evaluate(
      ({ id, z }) =>
        new Promise<number>((resolve, reject) => {
          const started = performance.now();
          (window as unknown as SmokeWindow).__gurgurSmokePad.axes[1] = 1;
          const sample = (): void => {
            const state = (window as unknown as SmokeWindow).__gurgurDiagnostics
              .presentation()
              .find((candidate) => candidate.runtimeId === id);
            if (state && Math.abs(state.position.z - z) > 0.015) {
              resolve(performance.now() - started);
              return;
            }
            if (performance.now() - started > 500) {
              reject(new Error("local owner did not move"));
              return;
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
      { id: ownerId, z: before.z },
    );
    const responseStages = await owner.evaluate(() => ({
      input: Number(document.body.dataset.inputMovementStartedAt),
      worker: Number(document.body.dataset.ownerStateAt),
      presented: Number(document.body.dataset.localPresentedAt),
    }));
    const inputToPresentation = responseStages.presented - responseStages.input;
    if (!Object.values(responseStages).every(Number.isFinite) || inputToPresentation > 75)
      throw new Error(
        `local owner response took ${responseMs.toFixed(1)}ms (${JSON.stringify(responseStages)})`,
      );

    const movingFrames = await observer.evaluate(
      (id) =>
        new Promise<{ eligible: number; advanced: number }>((resolve) => {
          let previous: number | null = null;
          let eligible = 0;
          let advanced = 0;
          const startedAt = performance.now();
          const sample = (now: number): void => {
            const state = (window as unknown as SmokeWindow).__gurgurDiagnostics
              .presentation()
              .find((candidate) => candidate.runtimeId === id);
            if (state && now - startedAt > 180) {
              if (previous !== null) {
                eligible += 1;
                if (Math.abs(state.position.z - previous) > 1e-5) advanced += 1;
              }
              previous = state.position.z;
            }
            if (now - startedAt >= 1_000) resolve({ eligible, advanced });
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
      ownerId,
    );
    await owner.evaluate(() => {
      (window as unknown as SmokeWindow).__gurgurSmokePad.axes[1] = 0;
    });
    const ratio = movingFrames.advanced / Math.max(1, movingFrames.eligible);
    if (movingFrames.eligible < 30 || ratio < 0.95) {
      const replication = await observer.evaluate(
        (id) =>
          (window as unknown as SmokeWindow).__gurgurDiagnostics
            .replication()
            .find((state) => state.runtimeId === id) ?? null,
        ownerId,
      );
      throw new Error(
        `remote presentation banded: ${movingFrames.advanced}/${movingFrames.eligible} advancing frames; ${JSON.stringify(replication)}`,
      );
    }
  } finally {
    await owner.close();
    await observer.close();
  }
}

async function pickupAndRelease(browser: Browser): Promise<void> {
  const page = await openPage(browser, 0);
  try {
    await page.waitForFunction(() => Boolean(document.body.dataset.interactionTarget));
    const targetId = await page.evaluate(() => document.body.dataset.interactionTarget!);
    const localId = await localPlayerKey(page);
    await pressPrimary(page);
    await page.waitForFunction(
      ({ target, local }) => {
        const entity = (window as unknown as SmokeWindow).__gurgurDiagnostics
          .network()
          .entities.find(
            (candidate) => `${candidate.id.index}:${candidate.id.generation}` === target,
          );
        return (
          entity?.ownerPlayerId &&
          `${entity.ownerPlayerId.index}:${entity.ownerPlayerId.generation}` === local
        );
      },
      { target: targetId, local: localId },
    );
    const startPosition = await position(page, targetId);
    await turnTouch(page, 150);
    await page.waitForFunction(
      ({ target, start }) => {
        const state = (window as unknown as SmokeWindow).__gurgurDiagnostics
          .presentation()
          .find((candidate) => candidate.runtimeId === target);
        return (
          state !== undefined &&
          Math.hypot(
            state.position.x - start.x,
            state.position.y - start.y,
            state.position.z - start.z,
          ) > 0.2
        );
      },
      { target: targetId, start: startPosition },
    );
    await pressPrimary(page);
    await page.waitForFunction((target) => {
      const entity = (window as unknown as SmokeWindow).__gurgurDiagnostics
        .network()
        .entities.find(
          (candidate) => `${candidate.id.index}:${candidate.id.generation}` === target,
        );
      return entity?.ownerPlayerId === null;
    }, targetId);
    const finalOwned = await page.evaluate(
      () =>
        (window as unknown as SmokeWindow).__gurgurDiagnostics.lastOwnershipDrop()?.position ??
        null,
    );
    if (!finalOwned) throw new Error("browser did not capture its final ownership state");
    const afterDrop = await position(page, targetId);
    const discontinuity = Math.hypot(
      afterDrop.x - finalOwned.x,
      afterDrop.y - finalOwned.y,
      afterDrop.z - finalOwned.z,
    );
    if (discontinuity >= 0.05)
      throw new Error(`release handoff discontinuity was ${(discontinuity * 100).toFixed(2)}cm`);
  } finally {
    await page.close();
  }
}

async function contentionAndRecovery(browser: Browser): Promise<void> {
  const first = await openPage(browser, 0);
  const second = await openPage(browser, 0);
  try {
    await Promise.all([
      first.waitForFunction(() => Boolean(document.body.dataset.interactionTarget)),
      second.waitForFunction(() => Boolean(document.body.dataset.interactionTarget)),
    ]);
    const firstPlayer = await localPlayerKey(first);
    const secondPlayer = await localPlayerKey(second);
    const targetId = await first.evaluate(() => document.body.dataset.interactionTarget!);
    await Promise.all([pressPrimary(first), pressPrimary(second)]);
    await first.waitForFunction(
      ({ target, owners }) => {
        const owner = (window as unknown as SmokeWindow).__gurgurDiagnostics
          .network()
          .entities.find(
            (candidate) => `${candidate.id.index}:${candidate.id.generation}` === target,
          )?.ownerPlayerId;
        return (
          owner !== null &&
          owner !== undefined &&
          owners.includes(`${owner.index}:${owner.generation}`)
        );
      },
      { target: targetId, owners: [firstPlayer, secondPlayer] },
    );
    const observedOwner = await first.evaluate((target) => {
      const owner = (window as unknown as SmokeWindow).__gurgurDiagnostics
        .network()
        .entities.find(
          (candidate) => `${candidate.id.index}:${candidate.id.generation}` === target,
        )?.ownerPlayerId;
      return owner ? `${owner.index}:${owner.generation}` : null;
    }, targetId);
    await second.waitForFunction(
      ({ target, owner }) => {
        const value = (window as unknown as SmokeWindow).__gurgurDiagnostics
          .network()
          .entities.find(
            (candidate) => `${candidate.id.index}:${candidate.id.generation}` === target,
          )?.ownerPlayerId;
        return (
          value !== undefined && (value ? `${value.index}:${value.generation}` : null) === owner
        );
      },
      { target: targetId, owner: observedOwner },
    );

    const holder = observedOwner === firstPlayer ? first : second;
    const observer = holder === first ? second : first;
    await holder.close();
    await observer.waitForFunction(
      (target) =>
        (window as unknown as SmokeWindow).__gurgurDiagnostics
          .network()
          .entities.find(
            (candidate) => `${candidate.id.index}:${candidate.id.generation}` === target,
          )?.ownerPlayerId === null,
      targetId,
    );

    const reconnectPlayer = await localPlayerKey(observer);
    const reconnectVersion = await authorityVersion(observer, reconnectPlayer);
    await observer.reload();
    await observer.locator('body[data-owner-physics="ready"]').waitFor({ timeout: 15_000 });
    await observer.locator('body[data-input-ready="true"]').waitFor({ timeout: 15_000 });
    await observer.locator('body[data-player-view-ready="true"]').waitFor({ timeout: 15_000 });
    const resumedPlayer = await localPlayerKey(observer);
    if (resumedPlayer !== reconnectPlayer)
      throw new Error(`reconnect changed player identity (${reconnectPlayer} -> ${resumedPlayer})`);
    await observer.waitForFunction(
      ({ id, version }) => {
        const entity = (window as unknown as SmokeWindow).__gurgurDiagnostics
          .network()
          .entities.find((candidate) => `${candidate.id.index}:${candidate.id.generation}` === id);
        return entity !== undefined && entity.authorityVersion > version;
      },
      { id: reconnectPlayer, version: reconnectVersion },
    );

    const epoch = await observer.evaluate(
      () => (window as unknown as SmokeWindow).__gurgurDiagnostics.network().worldEpoch,
    );
    if (epoch === null) throw new Error("browser reset has no current world epoch");
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) throw new Error(`connected reset failed (${response.status})`);
    await observer.waitForFunction(
      (previous) =>
        (window as unknown as SmokeWindow).__gurgurDiagnostics.network().worldEpoch ===
          previous + 1 &&
        document.body.dataset.ownerPhysics === "ready" &&
        document.body.dataset.inputReady === "true",
      epoch,
    );
  } finally {
    if (!first.isClosed()) await first.close();
    if (!second.isClosed()) await second.close();
  }
}

async function openPage(browser: Browser, simulatedLatencyMs: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      errors.push(message.text());
  });
  await page.addInitScript(() => {
    const pad = {
      connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })),
    };
    Object.defineProperty(window, "__gurgurSmokePad", { value: pad });
    Object.defineProperty(navigator, "getGamepads", { value: () => [pad] });
  });
  const url = new URL(`http://127.0.0.1:${server.port}/`);
  url.searchParams.set("test", "1");
  if (simulatedLatencyMs > 0)
    url.searchParams.set("simulatedLatencyMs", String(simulatedLatencyMs));
  await page.goto(url.href);
  await page.locator('body[data-owner-physics="ready"]').waitFor({ timeout: 15_000 });
  await page.locator('body[data-input-ready="true"]').waitFor({ timeout: 15_000 });
  await page.locator('body[data-player-view-ready="true"]').waitFor({ timeout: 15_000 });
  if (errors.length > 0) throw new Error(`browser startup errors: ${errors.join("; ")}`);
  return page;
}

async function localPlayerKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const id = (window as unknown as SmokeWindow).__gurgurDiagnostics.network().localPlayerId!;
    return `${id.index}:${id.generation}`;
  });
}

async function authorityVersion(page: Page, id: string): Promise<number> {
  return page.evaluate((runtimeId) => {
    const entity = (window as unknown as SmokeWindow).__gurgurDiagnostics
      .network()
      .entities.find(
        (candidate) => `${candidate.id.index}:${candidate.id.generation}` === runtimeId,
      );
    if (!entity) throw new Error(`missing network entity ${runtimeId}`);
    return entity.authorityVersion;
  }, id);
}

async function position(page: Page, id: string) {
  return page.evaluate((runtimeId) => {
    const state = (window as unknown as SmokeWindow).__gurgurDiagnostics
      .presentation()
      .find((candidate) => candidate.runtimeId === runtimeId);
    if (!state) throw new Error(`missing presentation state ${runtimeId}`);
    return state.position;
  }, id);
}

async function pressPrimary(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pad = (window as unknown as SmokeWindow).__gurgurSmokePad;
    pad.buttons[7]!.pressed = true;
  });
  await page.waitForTimeout(40);
  await page.evaluate(() => {
    const pad = (window as unknown as SmokeWindow).__gurgurSmokePad;
    pad.buttons[7]!.pressed = false;
  });
  await page.waitForTimeout(40);
}

async function turnTouch(page: Page, pixels: number): Promise<void> {
  await page.dispatchEvent("canvas", "pointerdown", {
    pointerId: 77,
    pointerType: "touch",
    clientX: 960,
    clientY: 360,
  });
  await page.dispatchEvent("canvas", "pointermove", {
    pointerId: 77,
    pointerType: "touch",
    clientX: 960 + pixels,
    clientY: 360,
  });
  await page.dispatchEvent("canvas", "pointerup", {
    pointerId: 77,
    pointerType: "touch",
    clientX: 960 + pixels,
    clientY: 360,
  });
}

type DiagnosticRuntime = {
  id: { index: number; generation: number };
  ownerPlayerId: { index: number; generation: number } | null;
  authorityVersion: number;
};
type SmokeWindow = {
  __gurgurSmokePad: {
    axes: number[];
    buttons: Array<{ pressed: boolean; value: number }>;
  };
  __gurgurDiagnostics: {
    presentation(): Array<{
      runtimeId: string;
      position: { x: number; y: number; z: number };
    }>;
    network(): {
      worldEpoch: number | null;
      localPlayerId: { index: number; generation: number } | null;
      entities: DiagnosticRuntime[];
    };
    replication(): Array<{
      runtimeId: string;
      count: number;
      stateSequence: number;
      receivedAtMs: number;
      position: { x: number; y: number; z: number };
    }>;
    lastOwnershipDrop(): {
      position: { x: number; y: number; z: number };
    } | null;
  };
};
