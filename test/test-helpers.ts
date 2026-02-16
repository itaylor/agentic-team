import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_OUTPUT_DIR = path.join(__dirname, "test-output");

function ensureOutputDir() {
  if (!fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 120);
}

export function createTestFileLogger(testName: string) {
  ensureOutputDir();
  const logFile = path.join(TEST_OUTPUT_DIR, `${sanitizeFilename(testName)}.log`);
  // Truncate the file at the start of each test run
  fs.writeFileSync(logFile, "");

  function write(level: string, message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const extra = args.length > 0 ? " " + args.map(a => {
      try { return typeof a === "string" ? a : JSON.stringify(a); }
      catch { return String(a); }
    }).join(" ") : "";
    fs.appendFileSync(logFile, `[${timestamp}] ${level}: ${message}${extra}\n`);
  }

  const logger = {
    error: (message: string, ...args: any[]) => write("ERROR", message, ...args),
    info: (message: string, ...args: any[]) => write("INFO", message, ...args),
    trace: (message: string, ...args: any[]) => write("TRACE", message, ...args),
  };

  function log(...args: any[]) {
    const parts = args.map(a => {
      try { return typeof a === "string" ? a : JSON.stringify(a); }
      catch { return String(a); }
    });
    write("LOG", parts.join(" "));
  }

  return { logger, log, logFile };
}
