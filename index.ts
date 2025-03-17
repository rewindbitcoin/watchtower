import express from "express";
import { AddressInfo } from "net";
import path from "path";
import { initDb } from "./db";
import { registerRoutes } from "./routes";
import { startMonitoring } from "./monitor";
import { setRegtestApiUrl } from "./blockchain";
import fs from "fs";

// Check for help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Watchtower API for RewindBitcoin Wallet

Usage:
  npx ts-node src/index.ts --db-folder <path> [options]

Required:
  --db-folder <path>   Specify the folder path for database storage

Options:
  --port <number>      Specify the port number (random if not specified)
  --disable-bitcoin    Disable Bitcoin mainnet monitoring
  --disable-testnet    Disable Bitcoin testnet monitoring
  --disable-tape       Disable Tape network monitoring
  --enable-regtest <url> Enable Bitcoin regtest with custom Esplora API URL
  --help, -h           Show this help message

By default, the watchtower runs for bitcoin, testnet, and tape networks.
Regtest is disabled by default and must be explicitly enabled with a valid Esplora API URL.
  `);
  process.exit(0);
}

// Parse command line arguments
const portIndex = process.argv.indexOf("--port");
const dbFolderIndex = process.argv.indexOf("--db-folder");
const enableRegtestIndex = process.argv.indexOf("--enable-regtest");

// Get port value (next argument after --port)
const port = portIndex !== -1 && portIndex < process.argv.length - 1 
  ? parseInt(process.argv[portIndex + 1], 10) 
  : 0; // Use 0 for random port assignment

// Get database folder (next argument after --db-folder)
const dbFolder = dbFolderIndex !== -1 && dbFolderIndex < process.argv.length - 1 
  ? process.argv[dbFolderIndex + 1] 
  : null;

// Get regtest API URL (next argument after --enable-regtest)
const regtestApiUrl = enableRegtestIndex !== -1 && enableRegtestIndex < process.argv.length - 1 
  ? process.argv[enableRegtestIndex + 1] 
  : null;

// Check which networks to run
const runBitcoin = !process.argv.includes("--disable-bitcoin");
const runTestnet = !process.argv.includes("--disable-testnet");
const runTape = !process.argv.includes("--disable-tape");

// Ensure at least one network is enabled
if (!runBitcoin && !runTestnet && !runTape && !regtestApiUrl) {
  console.error("Error: At least one network must be enabled.");
  process.exit(1);
}

// Validate database folder path
if (!dbFolder) {
  console.error("Error: Database folder path is required.");
  console.error("Please provide the --db-folder <path> argument.");
  console.error("Example: npx ts-node src/index.ts --db-folder ./db");
  process.exit(1);
}

if (dbFolder.trim() === "") {
  console.error("Error: Database folder path cannot be empty.");
  console.error("Please provide a valid path with --db-folder <path>");
  process.exit(1);
}

// Ensure the database folder exists
try {
  if (!fs.existsSync(dbFolder)) {
    console.log(`Creating database folder: ${dbFolder}`);
    fs.mkdirSync(dbFolder, { recursive: true });
  }
} catch (error) {
  console.error(`Error creating database folder: ${error}`);
  process.exit(1);
}

// Initialize the app
const app = express();
app.use(express.json());

// Register API routes
registerRoutes(app);

// Start the server
const server = app.listen(port, async () => {
  const address = server.address() as AddressInfo;
  console.log(`Watchtower API running on port ${address.port}`);

  // Initialize databases for each enabled network
  const networks = [];

  if (runBitcoin) {
    networks.push("bitcoin");
    const dbPathBitcoin = path.join(dbFolder, "watchtower.bitcoin.sqlite");
    await initDb(dbPathBitcoin, "bitcoin").catch((err) => {
      console.error("Failed to initialize Bitcoin DB:", err);
      process.exit(1);
    });
    console.log("Bitcoin mainnet monitoring enabled");
    // Start monitoring for bitcoin
    startMonitoring("bitcoin", 60000);
  }

  if (runTestnet) {
    networks.push("testnet");
    const dbPathTestnet = path.join(dbFolder, "watchtower.testnet.sqlite");
    await initDb(dbPathTestnet, "testnet").catch((err) => {
      console.error("Failed to initialize Testnet DB:", err);
      process.exit(1);
    });
    console.log("Bitcoin testnet monitoring enabled");
    // Start monitoring for testnet
    startMonitoring("testnet", 60000);
  }

  if (runTape) {
    networks.push("tape");
    const dbPathTape = path.join(dbFolder, "watchtower.tape.sqlite");
    await initDb(dbPathTape, "tape").catch((err) => {
      console.error("Failed to initialize Tape DB:", err);
      process.exit(1);
    });
    console.log("Tape network monitoring enabled");
    // Start monitoring for tape
    startMonitoring("tape", 60000);
  }

  if (regtestApiUrl) {
    networks.push("regtest");
    // Set the custom API URL for regtest
    setRegtestApiUrl(regtestApiUrl);
    const dbPathRegtest = path.join(dbFolder, "watchtower.regtest.sqlite");
    await initDb(dbPathRegtest, "regtest").catch((err) => {
      console.error("Failed to initialize Regtest DB:", err);
      process.exit(1);
    });
    console.log(`Bitcoin regtest monitoring enabled with API: ${regtestApiUrl}`);
    // Start monitoring for regtest
    startMonitoring("regtest", 30000); // Faster polling for regtest
  }

  console.log(`Monitoring networks: ${networks.join(", ")}`);
});
