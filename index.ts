import { initEnv } from "@rewindbitcoin/env";
initEnv(undefined, undefined, {
  validateHostType: false,
  handleExceptions: true,
});

import express from "express";
import { AddressInfo } from "net";
import path from "path";
import { initDb } from "./db";
import { registerRoutes } from "./routes";

// Check for help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Watchtower API for RewindBitcoin Wallet

Usage:
  npx ts-node src/index.ts [options]

Options:
  --port=<number>      Specify the port number (random if not specified)
  --disable-bitcoin    Disable Bitcoin mainnet monitoring
  --disable-testnet    Disable Bitcoin testnet monitoring
  --disable-regtest    Disable Bitcoin regtest monitoring
  --help, -h           Show this help message

By default, the watchtower runs for all networks (bitcoin, testnet, regtest).
Use the disable flags to turn off specific networks.
  `);
  process.exit(0);
}

// Parse command line arguments for port
const portArg = process.argv.find(arg => arg.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0; // Use 0 for random port assignment

// Check which networks to run
const runBitcoin = !process.argv.includes('--disable-bitcoin');
const runTestnet = !process.argv.includes('--disable-testnet');
const runRegtest = !process.argv.includes('--disable-regtest');

// Ensure at least one network is enabled
if (!runBitcoin && !runTestnet && !runRegtest) {
  console.error("Error: At least one network must be enabled.");
  process.exit(1);
}

if (!process.env.DB_FOLDER) throw new Error("Incomplete env: DB_FOLDER");

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
    const dbPathBitcoin = path.join(process.cwd(), "..", process.env.DB_FOLDER, "watchtower.bitcoin.sqlite");
    await initDb(dbPathBitcoin).catch(err => {
      console.error("Failed to initialize Bitcoin DB:", err);
      process.exit(1);
    });
    console.log("Bitcoin mainnet monitoring enabled");
  }
  
  if (runTestnet) {
    networks.push("testnet");
    const dbPathTestnet = path.join(process.cwd(), "..", process.env.DB_FOLDER, "watchtower.testnet.sqlite");
    await initDb(dbPathTestnet).catch(err => {
      console.error("Failed to initialize Testnet DB:", err);
      process.exit(1);
    });
    console.log("Bitcoin testnet monitoring enabled");
  }
  
  if (runRegtest) {
    networks.push("regtest");
    const dbPathRegtest = path.join(process.cwd(), "..", process.env.DB_FOLDER, "watchtower.regtest.sqlite");
    await initDb(dbPathRegtest).catch(err => {
      console.error("Failed to initialize Regtest DB:", err);
      process.exit(1);
    });
    console.log("Bitcoin regtest monitoring enabled");
  }
  
  console.log(`Monitoring networks: ${networks.join(', ')}`);
});
