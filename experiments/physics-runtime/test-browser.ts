import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = import.meta.dir;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const routes = new Map([
  ["/", ["browser.html", "text/html; charset=utf-8"]],
  ["/worker.js", ["worker.js", "text/javascript; charset=utf-8"]],
  ["/scenario.js", ["scenario.js", "text/javascript; charset=utf-8"]],
  ["/vendor/box3d.mjs", ["node_modules/box3d.js/dist/box3d.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/box3d.inline.mjs", ["node_modules/box3d.js/dist/box3d.inline.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/box3d.wasm", ["node_modules/box3d.js/dist/box3d.wasm", "application/wasm"]],
]);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const route = routes.get(new URL(request.url).pathname);
    if (!route) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(root, route[0])), {
      headers: { "content-type": route[1] },
    });
  },
});

try {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => document.body.dataset.status !== "running");
  const status = await page.locator("body").getAttribute("data-status");
  const output = await page.locator("body").textContent();
  await browser.close();

  assert.equal(status, "passed", output);
  console.log("Chrome worker physics runtime: passed");
} finally {
  server.stop(true);
}
