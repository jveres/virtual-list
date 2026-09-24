// macOS 27 rejects Firefox's profile discovery for processes started from an
// agent or editor, even with an explicit profile: Playwright's Firefox exits
// with "Could not find profile folder" (Mozilla bug 2060476). Temporary
// app-data directories keep it away from ~/Library/Application Support.
// Only Firefox reads these variables. Import this module before launching
// browsers; child processes inherit the variables and the directory is
// removed when this process exits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

if (process.platform === "darwin" && !process.env.MOZ_APP_DATA) {
  const directory = mkdtempSync(join(tmpdir(), "playwright-firefox-"));
  process.env.MOZ_APP_DATA = join(directory, "app-data");
  process.env.MOZ_LOCAL_APP_DATA = join(directory, "local-data");
  process.once("exit", () =>
    rmSync(directory, { recursive: true, force: true }),
  );
}
