// tally's command line (`npm start`). A harness repo's entry point is these lines with its own harnesses.
import { runCli } from "galangan";
import { tallyHarness } from "./tally.ts";

runCli([tallyHarness]);
