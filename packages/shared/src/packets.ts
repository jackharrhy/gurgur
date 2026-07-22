import type { ServerTextMessage } from "./control-codec";
import type { Snapshot } from "./types";
import type { LifecycleMessage } from "./world";

export type ServerPacket = ServerTextMessage | Snapshot | LifecycleMessage;
