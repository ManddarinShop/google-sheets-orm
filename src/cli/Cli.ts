#!/usr/bin/env node

const command = process.argv[2];

if (command === "setup") {
  console.log("typed-sheets setup is not implemented yet.");
  process.exit(0);
}

console.error("Usage: typed-sheets setup");
process.exit(1);
