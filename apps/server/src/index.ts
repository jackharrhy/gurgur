import { createGurgurServer } from "./server";

const port = Number(process.env.PORT ?? 3000);
const adminToken = process.env.ADMIN_TOKEN ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("PORT must be an integer between 1 and 65535");
if (process.env.NODE_ENV === "production" && adminToken.length < 16) {
  throw new Error("ADMIN_TOKEN must contain at least 16 characters in production");
}
if (process.env.PUBLIC_ORIGIN) {
  const origin = new URL(process.env.PUBLIC_ORIGIN);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== process.env.PUBLIC_ORIGIN.replace(/\/$/, "")
  ) {
    throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path");
  }
}
if (Boolean(process.env.TURN_USERNAME) !== Boolean(process.env.TURN_CREDENTIAL)) {
  throw new Error("TURN_USERNAME and TURN_CREDENTIAL must be configured together");
}
if (process.env.VOICE_RELAY_ONLY && !["true", "false"].includes(process.env.VOICE_RELAY_ONLY)) {
  throw new Error("VOICE_RELAY_ONLY must be true or false");
}
for (const value of process.env.STUN_URL?.split(",").filter(Boolean) ?? []) {
  if (!/^stuns?:/i.test(value.trim())) throw new Error("STUN_URL entries must use stun: or stuns:");
}
for (const value of process.env.TURN_URL?.split(",").filter(Boolean) ?? []) {
  if (!/^turns?:/i.test(value.trim())) throw new Error("TURN_URL entries must use turn: or turns:");
}
const extraDynamicBodies = Number(process.env.EXTRA_DYNAMIC_BODIES ?? 0);
if (!Number.isInteger(extraDynamicBodies) || extraDynamicBodies < 0 || extraDynamicBodies > 512) {
  throw new Error("EXTRA_DYNAMIC_BODIES must be an integer between 0 and 512");
}
const playerSpawn = process.env.PLAYER_SPAWN?.split(",").map(Number);
if (playerSpawn && (playerSpawn.length !== 3 || !playerSpawn.every(Number.isFinite))) {
  throw new Error("PLAYER_SPAWN must contain three comma-separated finite numbers");
}
const server = await createGurgurServer({
  port,
  adminToken,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  extraDynamicBodies,
  playerSpawn: playerSpawn
    ? { x: playerSpawn[0]!, y: playerSpawn[1]!, z: playerSpawn[2]! }
    : undefined,
});
console.log(`gurgur listening on http://localhost:${server.port}`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  server.stop();
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
