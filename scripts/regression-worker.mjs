import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";

// Keep cleanup ownership even when an older script throws before its finally.
const launches = new Set();
let closing = false;
for (const type of [firefox, webkit, chromium]) {
  const launch = type.launch.bind(type);
  type.launch = (...args) => {
    if (closing)
      return Promise.reject(new Error("Regression worker is stopping"));
    const pending = launch(...args);
    launches.add(pending);
    return pending;
  };
}

async function closeBrowsers() {
  closing = true;
  await Promise.allSettled(
    [...launches].map(async (pending) => (await pending).close()),
  );
}

const stop = async () => {
  await closeBrowsers();
  process.exit(143);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  await import(pathToFileURL(process.argv[2]).href);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeBrowsers();
}
