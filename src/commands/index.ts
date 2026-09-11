import { frontendO11yCommand } from "./frontendO11y.js";
import { syntheticsCommand } from "./synthetics.js";
import type { Command } from "./shared.js";

// Add a new product's subcommand here — everything else (usage line,
// COMMANDS listing, dispatch) is derived from this list.
export const COMMANDS: Command[] = [syntheticsCommand, frontendO11yCommand];

export type { Command } from "./shared.js";
