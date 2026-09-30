/**
 * `porch extension pi`: prints what a caller passes to Pi to attach Porch's inside
 * part to a session, the Pi counterpart of `porch hooks claude`. It installs
 * nothing. `porch launch pi` adds the same arguments (piExtensionArgs in launch.ts).
 */
import path from "node:path";
import { parseArgs } from "node:util";

import type { AdapterCommand, CommandContext } from "../../adapter.js";
import { jsonLine } from "../../cli/output.js";
import { PorchError } from "../../errors.js";
import { SCHEMA_VERSION } from "../../types.js";
import { piExtensionArgs, piExtensionPath } from "./launch.js";
import { PI_HARNESS } from "./observe.js";

function extensionCommand(): AdapterCommand {
  const usage = "porch extension pi [--porch-home <dir>]";
  return {
    path: ["extension", "pi"],
    summary: "print the Pi arguments (pi -e <file>) that attach Porch's extension to a session",
    usage,
    async run(args: string[], ctx: CommandContext): Promise<number> {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "porch-home": { type: "string" } } });
      if (positionals.length > 0) throw new PorchError("usage", `usage: ${usage}`);
      const porchHome = values["porch-home"];
      if (porchHome !== undefined && porchHome.trim() === "") throw new PorchError("usage", "--porch-home must not be empty");
      const home = porchHome === undefined ? null : path.resolve(porchHome);
      ctx.stdout(
        jsonLine({
          schema: SCHEMA_VERSION,
          harness: PI_HARNESS,
          extension: piExtensionPath(),
          porchHome: home,
          args: piExtensionArgs(),
          // The extension finds the records folder in Pi's environment.
          env: home === null ? {} : { PORCH_HOME: home },
        }),
      );
      return 0;
    },
  };
}

export const piCommands: AdapterCommand[] = [extensionCommand()];
