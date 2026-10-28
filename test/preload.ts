// Every test run gets a throwaway SERVER_OS_HOME, so a test that forgets to set one can't write into ~/server-os
// (or the legacy ~/server-dash) on the machine running it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME ??= mkdtempSync(join(tmpdir(), "sd-test-"));
