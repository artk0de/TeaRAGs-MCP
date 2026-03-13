import type { Trajectory } from "../../../contracts/types/trajectory.js";
import { staticFilters } from "./filters.js";
import { BASE_PAYLOAD_SIGNALS } from "./payload-signals.js";
import { staticDerivedSignals } from "./rerank/derived-signals/index.js";
import { STATIC_PRESETS } from "./rerank/presets/index.js";

export class StaticTrajectory implements Trajectory {
  readonly key = "static";
  readonly name = "Static";
  readonly description = "Base payload signals, structural derived signals, and generic presets";
  readonly payloadSignals = BASE_PAYLOAD_SIGNALS;
  readonly derivedSignals = staticDerivedSignals;
  readonly filters = staticFilters;
  readonly presets = STATIC_PRESETS;
}
