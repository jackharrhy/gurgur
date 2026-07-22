import { PHYSICS_HZ, PROTOCOL_VERSION, type InputCommand } from "@gurgur/shared";

const MOVEMENT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyE", "ControlLeft", "ControlRight"]);

export class PlayerInput {
  readonly #canvas: HTMLCanvasElement;
  readonly #send: (command: InputCommand) => void;
  readonly #onLook: (yaw: number, pitch: number) => void;
  readonly #interactionTarget: () => InputCommand["interactTarget"];
  readonly #keys = new Set<string>();
  #worldEpoch: number | null = null;
  #sequence = 0;
  #clientTick = 0;
  #yaw = 0;
  #pitch = -0.18;
  #jumpCounter = 0;
  #interactCounter = 0;
  #primaryCounter = 0;
  #gamepadJump = false;
  #gamepadInteract = false;
  #gamepadPrimary = false;
  #gamepadCrouch = false;
  #touchCrouch = false;
  #touchPrimary = false;
  #moveTouch: { id: number; startX: number; startY: number; x: number; y: number } | null = null;
  #lookTouch: { id: number; x: number; y: number } | null = null;
  readonly #touchButtons: HTMLElement[];
  #timer: number;

  constructor(
    canvas: HTMLCanvasElement,
    send: (command: InputCommand) => void,
    onLook: (yaw: number, pitch: number) => void,
    interactionTarget: () => InputCommand["interactTarget"] = () => null,
  ) {
    this.#canvas = canvas;
    this.#send = send;
    this.#onLook = onLook;
    this.#interactionTarget = interactionTarget;
    this.#touchButtons = [...document.querySelectorAll<HTMLElement>("[data-touch-action]")];
    canvas.addEventListener("click", this.#lockPointer);
    addEventListener("keydown", this.#keyDown);
    addEventListener("keyup", this.#keyUp);
    addEventListener("blur", this.#clearKeys);
    addEventListener("mousemove", this.#mouseMove);
    addEventListener("mousedown", this.#mouseDown);
    document.addEventListener("visibilitychange", this.#visibilityChanged);
    canvas.addEventListener("pointerdown", this.#pointerDown);
    canvas.addEventListener("pointermove", this.#pointerMove);
    canvas.addEventListener("pointerup", this.#pointerUp);
    canvas.addEventListener("pointercancel", this.#pointerUp);
    for (const button of this.#touchButtons) {
      button.addEventListener("pointerdown", this.#touchActionDown);
      button.addEventListener("pointerup", this.#touchActionUp);
      button.addEventListener("pointercancel", this.#touchActionUp);
    }
    this.#timer = window.setInterval(this.#flush, 1_000 / PHYSICS_HZ);
  }

  setWorld(worldEpoch: number, yaw?: number): void {
    if (this.#worldEpoch === worldEpoch) return;
    this.#worldEpoch = worldEpoch;
    this.#sequence = 0;
    this.#clientTick = 0;
    if (yaw !== undefined) this.#yaw = yaw;
  }

  get yaw(): number { return this.#yaw; }
  get pitch(): number { return this.#pitch; }

  dispose(): void {
    clearInterval(this.#timer);
    this.#canvas.removeEventListener("click", this.#lockPointer);
    removeEventListener("keydown", this.#keyDown);
    removeEventListener("keyup", this.#keyUp);
    removeEventListener("blur", this.#clearKeys);
    removeEventListener("mousemove", this.#mouseMove);
    removeEventListener("mousedown", this.#mouseDown);
    document.removeEventListener("visibilitychange", this.#visibilityChanged);
    this.#canvas.removeEventListener("pointerdown", this.#pointerDown);
    this.#canvas.removeEventListener("pointermove", this.#pointerMove);
    this.#canvas.removeEventListener("pointerup", this.#pointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#pointerUp);
    for (const button of this.#touchButtons) {
      button.removeEventListener("pointerdown", this.#touchActionDown);
      button.removeEventListener("pointerup", this.#touchActionUp);
      button.removeEventListener("pointercancel", this.#touchActionUp);
    }
  }

  readonly #lockPointer = (): void => {
    void this.#canvas.requestPointerLock();
  };

  readonly #keyDown = (event: KeyboardEvent): void => {
    if (MOVEMENT_KEYS.has(event.code)) event.preventDefault();
    if (!event.repeat && event.code === "Space") this.#jumpCounter += 1;
    if (!event.repeat && event.code === "KeyE") this.#interactCounter += 1;
    this.#keys.add(event.code);
  };

  readonly #keyUp = (event: KeyboardEvent): void => {
    this.#keys.delete(event.code);
  };

  readonly #clearKeys = (): void => this.#keys.clear();
  readonly #visibilityChanged = (): void => {
    if (document.hidden) this.#clearKeys();
  };

  readonly #mouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.#canvas) return;
    this.#yaw -= event.movementX * 0.0022;
    this.#pitch = Math.max(-1.35, Math.min(1.35, this.#pitch - event.movementY * 0.0022));
    this.#onLook(this.#yaw, this.#pitch);
  };

  readonly #mouseDown = (event: MouseEvent): void => {
    if (document.pointerLockElement === this.#canvas && event.button === 0) this.#primaryCounter += 1;
  };

  readonly #pointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    try { this.#canvas.setPointerCapture(event.pointerId); } catch { /* synthetic and cancelled pointers may not be capturable */ }
    if (event.clientX < innerWidth / 2 && !this.#moveTouch) {
      this.#moveTouch = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    } else if (!this.#lookTouch) {
      this.#lookTouch = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
  };

  readonly #pointerMove = (event: PointerEvent): void => {
    if (this.#moveTouch?.id === event.pointerId) {
      this.#moveTouch.x = event.clientX;
      this.#moveTouch.y = event.clientY;
    } else if (this.#lookTouch?.id === event.pointerId) {
      const dx = event.clientX - this.#lookTouch.x;
      const dy = event.clientY - this.#lookTouch.y;
      this.#lookTouch.x = event.clientX;
      this.#lookTouch.y = event.clientY;
      this.#yaw -= dx * 0.006;
      this.#pitch = Math.max(-1.35, Math.min(1.35, this.#pitch - dy * 0.006));
      this.#onLook(this.#yaw, this.#pitch);
    }
  };

  readonly #pointerUp = (event: PointerEvent): void => {
    if (this.#moveTouch?.id === event.pointerId) this.#moveTouch = null;
    if (this.#lookTouch?.id === event.pointerId) this.#lookTouch = null;
  };

  readonly #touchActionDown = (event: PointerEvent): void => {
    event.preventDefault();
    const action = (event.currentTarget as HTMLElement).dataset.touchAction;
    if (action === "jump") this.#jumpCounter += 1;
    if (action === "use") this.#interactCounter += 1;
    if (action === "grab" && !this.#touchPrimary) this.#primaryCounter += 1;
    if (action === "grab") this.#touchPrimary = true;
    if (action === "crouch") this.#touchCrouch = true;
  };

  readonly #touchActionUp = (event: PointerEvent): void => {
    if ((event.currentTarget as HTMLElement).dataset.touchAction === "crouch") this.#touchCrouch = false;
    if ((event.currentTarget as HTMLElement).dataset.touchAction === "grab") this.#touchPrimary = false;
  };

  #pollGamepad(): { x: number; z: number } {
    const gamepad = navigator.getGamepads?.().find((candidate) => candidate?.connected) ?? null;
    if (!gamepad) return { x: 0, z: 0 };
    const deadzone = (value: number): number => Math.abs(value) < 0.16 ? 0 : value;
    const jump = Boolean(gamepad.buttons[0]?.pressed);
    const interact = Boolean(gamepad.buttons[2]?.pressed);
    const primary = Boolean(gamepad.buttons[7]?.pressed);
    if (jump && !this.#gamepadJump) this.#jumpCounter += 1;
    if (interact && !this.#gamepadInteract) this.#interactCounter += 1;
    if (primary && !this.#gamepadPrimary) this.#primaryCounter += 1;
    this.#gamepadJump = jump;
    this.#gamepadInteract = interact;
    this.#gamepadPrimary = primary;
    this.#gamepadCrouch = Boolean(gamepad.buttons[1]?.pressed);
    return { x: deadzone(gamepad.axes[0] ?? 0), z: -deadzone(gamepad.axes[1] ?? 0) };
  }

  readonly #flush = (): void => {
    if (this.#worldEpoch === null || document.hidden) return;
    const gamepad = this.#pollGamepad();
    const touchX = this.#moveTouch ? Math.max(-1, Math.min(1, (this.#moveTouch.x - this.#moveTouch.startX) / 55)) : 0;
    const touchZ = this.#moveTouch ? Math.max(-1, Math.min(1, (this.#moveTouch.startY - this.#moveTouch.y) / 55)) : 0;
    const moveX = Math.max(-1, Math.min(1, Number(this.#keys.has("KeyD")) - Number(this.#keys.has("KeyA")) + gamepad.x + touchX));
    const moveZ = Math.max(-1, Math.min(1, Number(this.#keys.has("KeyW")) - Number(this.#keys.has("KeyS")) + gamepad.z + touchZ));
    this.#send({
      type: "input",
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: this.#worldEpoch,
      sequence: this.#sequence++,
      clientTick: this.#clientTick++,
      moveX,
      moveZ,
      lookYaw: this.#yaw,
      lookPitch: this.#pitch,
      buttons: Number(this.#keys.has("Space"))
        | (Number(this.#keys.has("KeyE")) << 1)
        | (Number(this.#keys.has("ControlLeft") || this.#keys.has("ControlRight") || this.#gamepadCrouch || this.#touchCrouch) << 2),
      jumpCounter: this.#jumpCounter,
      interactCounter: this.#interactCounter,
      interactTarget: this.#interactionTarget(),
      primaryCounter: this.#primaryCounter,
    });
  };
}
