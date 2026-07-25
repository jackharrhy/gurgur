import { webGPUAvailable, type WebGPUAdapterRequester } from "./webgpu-support";

const canvas = document.querySelector<HTMLCanvasElement>("#world");
if (!canvas) throw new Error("game canvas is missing");

const gpu = (navigator as Navigator & { gpu?: WebGPUAdapterRequester }).gpu;
if (await webGPUAvailable(gpu)) {
  document.body.dataset.webgpu = "ready";
  await import("./client");
} else {
  document.body.dataset.webgpu = "unsupported";
  const message = document.createElement("section");
  message.id = "webgpu-unsupported";
  message.setAttribute("role", "alert");
  message.innerHTML = `
    <h1>WebGPU is required</h1>
    <p>This browser or device does not currently provide WebGPU.</p>
    <p>Try a current version of Chrome, Edge, Firefox, or Safari on supported hardware.</p>
  `;
  canvas.replaceWith(message);
}
