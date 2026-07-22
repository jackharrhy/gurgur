import { PHYSICS_HZ, PROTOCOL_VERSION, type InputCommand } from "@gurgur/shared";

const MOVEMENT_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "KeyE",
  "ControlLeft",
  "ControlRight",
]);

type TouchState = { id: number; x: number; y: number };

export type PlayerInput = {
  readonly yaw: number;
  readonly pitch: number;
  setWorld(worldEpoch: number, yaw?: number): void;
  dispose(): void;
};

export function createPlayerInput(
  canvas: HTMLCanvasElement,
  send: (command: InputCommand) => void,
  onLook: (yaw: number, pitch: number) => void,
  interactionTarget: () => InputCommand["interactTarget"] = () => null,
): PlayerInput {
  const keys = new Set<string>();
  const touchButtons = [...document.querySelectorAll<HTMLElement>("[data-touch-action]")];
  let worldEpoch: number | null = null;
  let sequence = 0;
  let clientTick = 0;
  let yaw = 0;
  let pitch = -0.18;
  let jumpCounter = 0;
  let interactCounter = 0;
  let primaryCounter = 0;
  let gamepadJump = false;
  let gamepadInteract = false;
  let gamepadPrimary = false;
  let gamepadCrouch = false;
  let touchCrouch = false;
  let touchPrimary = false;
  let moveTouch: (TouchState & { startX: number; startY: number }) | null = null;
  let lookTouch: TouchState | null = null;

  const clearKeys = (): void => keys.clear();
  const lockPointer = (): void => {
    void canvas.requestPointerLock();
  };
  const keyDown = (event: KeyboardEvent): void => {
    if (MOVEMENT_KEYS.has(event.code)) event.preventDefault();
    if (!event.repeat && event.code === "Space") jumpCounter += 1;
    if (!event.repeat && event.code === "KeyE") interactCounter += 1;
    keys.add(event.code);
  };
  const keyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  const visibilityChanged = (): void => {
    if (document.hidden) clearKeys();
  };
  const mouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== canvas) return;
    yaw -= event.movementX * 0.0022;
    pitch = Math.max(-1.35, Math.min(1.35, pitch - event.movementY * 0.0022));
    onLook(yaw, pitch);
  };
  const mouseDown = (event: MouseEvent): void => {
    if (document.pointerLockElement === canvas && event.button === 0) primaryCounter += 1;
  };
  const pointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic and cancelled pointers may not be capturable.
    }
    if (event.clientX < innerWidth / 2 && !moveTouch) {
      moveTouch = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
      };
    } else if (!lookTouch) {
      lookTouch = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
  };
  const pointerMove = (event: PointerEvent): void => {
    if (moveTouch?.id === event.pointerId) {
      moveTouch.x = event.clientX;
      moveTouch.y = event.clientY;
    } else if (lookTouch?.id === event.pointerId) {
      const dx = event.clientX - lookTouch.x;
      const dy = event.clientY - lookTouch.y;
      lookTouch.x = event.clientX;
      lookTouch.y = event.clientY;
      yaw -= dx * 0.006;
      pitch = Math.max(-1.35, Math.min(1.35, pitch - dy * 0.006));
      onLook(yaw, pitch);
    }
  };
  const pointerUp = (event: PointerEvent): void => {
    if (moveTouch?.id === event.pointerId) moveTouch = null;
    if (lookTouch?.id === event.pointerId) lookTouch = null;
  };
  const touchActionDown = (event: PointerEvent): void => {
    event.preventDefault();
    const action = (event.currentTarget as HTMLElement).dataset.touchAction;
    if (action === "jump") jumpCounter += 1;
    if (action === "use") interactCounter += 1;
    if (action === "grab" && !touchPrimary) primaryCounter += 1;
    if (action === "grab") touchPrimary = true;
    if (action === "crouch") touchCrouch = true;
  };
  const touchActionUp = (event: PointerEvent): void => {
    const action = (event.currentTarget as HTMLElement).dataset.touchAction;
    if (action === "crouch") touchCrouch = false;
    if (action === "grab") touchPrimary = false;
  };
  const pollGamepad = (): { x: number; z: number } => {
    const gamepad = navigator.getGamepads?.().find((candidate) => candidate?.connected) ?? null;
    if (!gamepad) return { x: 0, z: 0 };
    const deadzone = (value: number): number => (Math.abs(value) < 0.16 ? 0 : value);
    const jump = Boolean(gamepad.buttons[0]?.pressed);
    const interact = Boolean(gamepad.buttons[2]?.pressed);
    const primary = Boolean(gamepad.buttons[7]?.pressed);
    if (jump && !gamepadJump) jumpCounter += 1;
    if (interact && !gamepadInteract) interactCounter += 1;
    if (primary && !gamepadPrimary) primaryCounter += 1;
    gamepadJump = jump;
    gamepadInteract = interact;
    gamepadPrimary = primary;
    gamepadCrouch = Boolean(gamepad.buttons[1]?.pressed);
    return { x: deadzone(gamepad.axes[0] ?? 0), z: -deadzone(gamepad.axes[1] ?? 0) };
  };
  const flush = (): void => {
    if (worldEpoch === null || document.hidden) return;
    const gamepad = pollGamepad();
    const touchX = moveTouch ? Math.max(-1, Math.min(1, (moveTouch.x - moveTouch.startX) / 55)) : 0;
    const touchZ = moveTouch ? Math.max(-1, Math.min(1, (moveTouch.startY - moveTouch.y) / 55)) : 0;
    const moveX = Math.max(
      -1,
      Math.min(1, Number(keys.has("KeyD")) - Number(keys.has("KeyA")) + gamepad.x + touchX),
    );
    const moveZ = Math.max(
      -1,
      Math.min(1, Number(keys.has("KeyW")) - Number(keys.has("KeyS")) + gamepad.z + touchZ),
    );
    send({
      type: "input",
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch,
      sequence: sequence++,
      clientTick: clientTick++,
      moveX,
      moveZ,
      lookYaw: yaw,
      lookPitch: pitch,
      buttons:
        Number(keys.has("Space")) |
        (Number(keys.has("KeyE")) << 1) |
        (Number(
          keys.has("ControlLeft") || keys.has("ControlRight") || gamepadCrouch || touchCrouch,
        ) <<
          2),
      jumpCounter,
      interactCounter,
      interactTarget: interactionTarget(),
      primaryCounter,
    });
  };

  canvas.addEventListener("click", lockPointer);
  addEventListener("keydown", keyDown);
  addEventListener("keyup", keyUp);
  addEventListener("blur", clearKeys);
  addEventListener("mousemove", mouseMove);
  addEventListener("mousedown", mouseDown);
  document.addEventListener("visibilitychange", visibilityChanged);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  for (const button of touchButtons) {
    button.addEventListener("pointerdown", touchActionDown);
    button.addEventListener("pointerup", touchActionUp);
    button.addEventListener("pointercancel", touchActionUp);
  }
  const timer = window.setInterval(flush, 1_000 / PHYSICS_HZ);

  return {
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    setWorld(nextWorldEpoch, nextYaw) {
      if (worldEpoch === nextWorldEpoch) return;
      worldEpoch = nextWorldEpoch;
      sequence = 0;
      clientTick = 0;
      if (nextYaw !== undefined) yaw = nextYaw;
    },
    dispose() {
      clearInterval(timer);
      canvas.removeEventListener("click", lockPointer);
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
      removeEventListener("blur", clearKeys);
      removeEventListener("mousemove", mouseMove);
      removeEventListener("mousedown", mouseDown);
      document.removeEventListener("visibilitychange", visibilityChanged);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      for (const button of touchButtons) {
        button.removeEventListener("pointerdown", touchActionDown);
        button.removeEventListener("pointerup", touchActionUp);
        button.removeEventListener("pointercancel", touchActionUp);
      }
    },
  };
}
