/** `npm run conformance`: see command.ts. Run from the repo root. */
import { conformanceCommand } from "./command.js";
import { DRIVERS } from "./drivers/index.js";

process.exitCode = await conformanceCommand(process.argv.slice(2), {
  env: process.env,
  root: process.cwd(),
  drivers: DRIVERS,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
