import { watch } from "node:fs";

const [command, subcommand, ...args] = process.argv.slice(2);

async function run(
  argv: string[],
  options: { env?: Record<string, string>; allowFailure?: boolean } = {},
): Promise<number> {
  const child = Bun.spawn(argv, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0 && !options.allowFailure)
    throw new Error(`${argv.join(" ")} exited with code ${exitCode}`);
  return exitCode;
}

async function content(action = "compile"): Promise<void> {
  if (action === "compile") {
    await import("../tools/generate-fgd/src/index");
    await import("../tools/compile-map/src/index");
    return;
  }
  if (action === "setup") {
    await content("compile");
    await run(["bun", "scripts/setup-trenchbroom.ts"]);
    return;
  }
  if (action === "render-player") {
    await run(["bun", "tools/render-player-billboard/src/index.ts"]);
    return;
  }
  if (action === "setup-player-harness") {
    await run([
      "bun",
      "tools/render-player-billboard/src/index.ts",
      "--setup-only",
      "--save-harness",
    ]);
    return;
  }
  throw new Error("content requires compile, setup, render-player, or setup-player-harness");
}

const browserScenarios = {
  movement: {},
  latency: { SMOKE_LATENCY_MS: "150" },
  dynamic: { SMOKE_SCENARIO: "dynamic-landing" },
  push: { SMOKE_SCENARIO: "dynamic-push", SMOKE_LATENCY_MS: "75" },
  grab: { SMOKE_SCENARIO: "grab" },
  touch: { SMOKE_SCENARIO: "touch" },
  gamepad: { SMOKE_SCENARIO: "gamepad" },
  reconnect: { SMOKE_SCENARIO: "stale-session" },
} as const;

async function testBrowser(action = "movement"): Promise<void> {
  if (action === "all") {
    for (const scenario of Object.keys(browserScenarios)) await testBrowser(scenario);
    return;
  }
  const environment = browserScenarios[action as keyof typeof browserScenarios];
  if (!environment)
    throw new Error(
      "test:browser requires movement, latency, dynamic, push, grab, touch, gamepad, reconnect, or all",
    );
  await run(["bun", "scripts/smoke-browser.ts"], {
    env: { ...environment, GURGUR_TEST_MODE: "1" },
  });
}

async function testNetwork(action = "single"): Promise<void> {
  const quick = args.includes("--quick");
  if (action === "single") {
    if (quick)
      await run(["bun", "tools/network-harness/src/run.ts"], {
        env: { HARNESS_CLIENTS: "2", HARNESS_DURATION_MS: "700" },
      });
    else await run(["bun", "tools/network-harness/src/run.ts"]);
    return;
  }
  if (action === "matrix") {
    await run(["bun", "tools/network-harness/src/matrix.ts"], {
      env: quick ? { HARNESS_QUICK: "1" } : {},
    });
    return;
  }
  throw new Error("test:network requires single or matrix [--quick]");
}

async function soak(action: string | undefined): Promise<void> {
  const file = {
    physics: "tools/physics-soak.ts",
    connections: "tools/connection-soak.ts",
    persistence: "tools/persistence-soak.ts",
  }[action ?? ""];
  if (!file) throw new Error("soak requires physics, connections, or persistence");
  await run(["bun", file]);
}

async function dev(): Promise<void> {
  await content("compile");
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let rebuilding = false;
  let queued = false;
  let debounce: Timer | null = null;
  const startServer = (): void => {
    server = Bun.spawn(["bun", "apps/server/src/index.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  };
  const rebuild = async (): Promise<void> => {
    if (rebuilding) {
      queued = true;
      return;
    }
    rebuilding = true;
    try {
      await content("compile");
      server?.kill();
      if (server) await server.exited;
      startServer();
    } catch (error) {
      console.error(error);
    } finally {
      rebuilding = false;
      if (queued) {
        queued = false;
        void rebuild();
      }
    }
  };
  startServer();
  const watchers = [
    watch("content/maps", { recursive: true }, () => schedule()),
    watch("content/sprites", { recursive: true }, () => schedule()),
    watch("content/textures", { recursive: true }, () => schedule()),
    watch("packages/game/src", { recursive: true }, () => schedule()),
  ];
  function schedule(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void rebuild(), 150);
  }
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (): void => {
    watchers.forEach((watcher) => watcher.close());
    server?.kill();
    finish();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await stopped;
}

if (command === "content") await content(subcommand);
else if (command === "test-browser") await testBrowser(subcommand);
else if (command === "test-network") await testNetwork(subcommand);
else if (command === "soak") await soak(subcommand);
else if (command === "dev") await dev();
else throw new Error("unknown repository command");
