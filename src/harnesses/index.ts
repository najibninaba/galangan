// The harnesses this build ships, by name. `GALANGAN_HARNESS` picks one; the first is the default.
import type { HarnessSpec } from "../harness.ts";
import { tallyHarness } from "./tally.ts";

export const harnesses: readonly HarnessSpec[] = [tallyHarness];
