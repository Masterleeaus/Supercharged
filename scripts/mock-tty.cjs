// Mock TTY properties so drizzle-kit doesn't crash in non-interactive environments
if (process.stdin) {
  process.stdin.isTTY = true;
  process.stdin.setRawMode = function() { return this; };
}
if (process.stdout) {
  process.stdout.isTTY = true;
}
