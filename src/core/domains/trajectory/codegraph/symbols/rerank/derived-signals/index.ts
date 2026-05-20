import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import { ChunkFanInSignal } from "./chunk-fan-in.js";
import { ChunkFanOutSignal } from "./chunk-fan-out.js";
import { FanInSignal } from "./fan-in.js";
import { FanOutSignal } from "./fan-out.js";
import { InstabilitySignal } from "./instability.js";
import { IsHubSignal } from "./is-hub.js";
import { IsLeafSignal } from "./is-leaf.js";

export { ChunkFanInSignal, ChunkFanOutSignal, FanInSignal, FanOutSignal, InstabilitySignal, IsHubSignal, IsLeafSignal };

export const CODEGRAPH_SYMBOLS_DERIVED_SIGNALS: DerivedSignalDescriptor[] = [
  new FanInSignal(),
  new FanOutSignal(),
  new InstabilitySignal(),
  new IsHubSignal(),
  new IsLeafSignal(),
  new ChunkFanInSignal(),
  new ChunkFanOutSignal(),
];
