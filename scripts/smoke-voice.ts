import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createGurgurServer } from "../apps/server/src/server";

const directory = await mkdtemp(join(tmpdir(), "gurgur-voice-browser-"));
const adminToken = "voice-smoke-admin-token";
const server = await createGurgurServer({
  port: 0, hostname: "127.0.0.1", databasePath: join(directory, "world.sqlite"), adminToken,
});
const origin = `http://127.0.0.1:${server.port}`;
const clientCount = Number(process.env.VOICE_CLIENTS ?? 6);
const cycles = Number(process.env.VOICE_CYCLES ?? 1);
if (!Number.isInteger(clientCount) || clientCount < 2 || clientCount > 6) throw new Error("VOICE_CLIENTS must be between 2 and 6");
if (!Number.isInteger(cycles) || cycles < 1) throw new Error("VOICE_CYCLES must be a positive integer");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const holder = window as unknown as {
        __gurgurVoiceStreams?: MediaStream[];
        __gurgurVoiceSource?: { audio: AudioContext; oscillator: OscillatorNode };
      };
      if (!holder.__gurgurVoiceSource) {
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        oscillator.start();
        holder.__gurgurVoiceSource = { audio, oscillator };
      }
      const { audio, oscillator } = holder.__gurgurVoiceSource;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(destination);
      (holder.__gurgurVoiceStreams ??= []).push(destination.stream);
      return destination.stream;
    };
  });
  const pages = await Promise.all(Array.from({ length: clientCount }, () => context.newPage()));
  const errors: string[] = [];
  for (const page of pages) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
    });
    await page.goto(origin);
    await page.locator('body[data-ready="true"]').waitFor({ timeout: 5_000 });
  }
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await Promise.all(pages.map((page) => page.locator("#voice").click()));
    try {
      await Promise.all(pages.map((page) => page.waitForFunction((expectedMedia) =>
        document.body.dataset.voice?.includes(`· ${expectedMedia} media`),
      clientCount - 1, { timeout: 10_000 })));
    } catch (error) {
      const states = await Promise.all(pages.map((page) => page.evaluate(() => ({
        voice: document.body.dataset.voice,
        button: document.querySelector("#voice")?.textContent,
        ready: document.body.dataset.ready,
        configured: document.body.dataset.voiceConfigured,
        clicked: document.body.dataset.voiceClicked,
      }))));
      throw new Error(`voice connection timeout at cycle ${cycle}: ${JSON.stringify({ states, errors, cause: String(error) })}`);
    }
    if (cycle + 1 < cycles) {
      await Promise.all(pages.map((page) => page.locator("#voice").click()));
      await Promise.all(pages.map((page) => page.waitForFunction(() => document.body.dataset.voice === "voice off")));
    }
  }
  if (errors.length) throw new Error(`voice browser errors: ${JSON.stringify(errors)}`);
  const reset = await fetch(`${origin}/admin/reset`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!reset.ok) throw new Error(`voice reset failed with ${reset.status}`);
  await Promise.all(pages.map((page) => page.waitForFunction((expectedMedia) =>
    document.querySelector("#epoch")?.textContent === "2"
      && document.body.dataset.voice?.includes(`· ${expectedMedia} media`),
  clientCount - 1, { timeout: 10_000 })));
  if (errors.length) throw new Error(`voice reset browser errors: ${JSON.stringify(errors)}`);
  await pages[0]!.evaluate(() => {
    const stream = (window as unknown as { __gurgurVoiceStreams: MediaStream[] }).__gurgurVoiceStreams.at(-1)!;
    stream.getAudioTracks()[0]!.dispatchEvent(new Event("ended"));
  });
  await pages[0]!.waitForFunction(() => document.body.dataset.voice === "device lost");
  if (!await pages[1]!.locator('body[data-ready="true"]').isVisible()) throw new Error("device loss affected gameplay");

  const denial = await browser.newContext();
  try {
    await denial.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("permission denied", "NotAllowedError"); };
    });
    const page = await denial.newPage();
    await page.goto(origin);
    await page.locator('body[data-ready="true"]').waitFor({ timeout: 5_000 });
    await page.locator("#voice").click();
    await page.waitForFunction(() => document.body.dataset.voice?.startsWith("voice unavailable:"));
    if (await page.locator('body[data-ready="true"]').getAttribute("data-ready") === "false") {
      throw new Error("microphone denial affected gameplay");
    }
  } finally {
    await denial.close();
  }
  console.log(`${clientCount}-browser WebRTC proximity voice (${cycles} cycle${cycles === 1 ? "" : "s"}), epoch-reset, device-loss, and denial smoke passed`);
} finally {
  await browser.close();
  server.stop();
  await rm(directory, { recursive: true, force: true });
}
