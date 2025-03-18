/**
 * Project: Rewind Bitcoin
 * Website: https://rewindbitcoin.com
 *
 * Author: Jose-Luis Landabaso
 * Email: landabaso@gmail.com
 *
 * Contact Email: hello@rewindbitcoin.com
 *
 * License: MIT License
 *
 * Copyright (c) 2025 Jose-Luis Landabaso, Rewind Bitcoin
 */

import express from "express";
import { AddressInfo } from "net";
import path from "path";
import { initDb, closeAllConnections } from "./db";
import { registerRoutes } from "./routes";
import { startMonitoring } from "./monitor";
import { setRegtestApiUrl } from "./blockchain";
import { closeAllAddressDbConnections } from "./commitments";
import fs from "fs";
import { createLogger } from "./logger";

// Create logger for this module
const logger = createLogger("Main");

// Check for help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Watchtower API for RewindBitcoin Wallet

Usage:
  npx ts-node src/index.ts [options]

Options:
  --db-folder <path>       Specify the folder path for database storage (default: ./db)

Options:
  --port <number>          Specify the port number (random if not specified)
  --disable-bitcoin        Disable Bitcoin mainnet monitoring
  --disable-testnet        Disable Bitcoin testnet monitoring
  --disable-tape           Disable Tape network monitoring
  --enable-regtest <url>   Enable Bitcoin regtest with custom Esplora API URL
  --with-commitments       Enable commitment verification for vault registration
  --help, -h               Show this help message

By default, the watchtower runs for bitcoin, testnet, and tape networks.
Regtest is disabled by default and must be explicitly enabled with a valid Esplora API URL.
  `);
  process.exit(0);
}

// Parse command line arguments
const portIndex = process.argv.indexOf("--port");
const dbFolderIndex = process.argv.indexOf("--db-folder");
const enableRegtestIndex = process.argv.indexOf("--enable-regtest");
const requireCommitments = process.argv.includes("--with-commitments");

// Get port value (next argument after --port)
const port =
  portIndex !== -1 && portIndex < process.argv.length - 1
    ? parseInt(process.argv[portIndex + 1], 10)
    : 0; // Use 0 for random port assignment

// Get database folder (next argument after --db-folder) or default to ./db
const dbFolder =
  dbFolderIndex !== -1 && dbFolderIndex < process.argv.length - 1
    ? process.argv[dbFolderIndex + 1]
    : "./db";

// Get regtest API URL (next argument after --enable-regtest)
const regtestApiUrl =
  enableRegtestIndex !== -1 && enableRegtestIndex < process.argv.length - 1
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
if (dbFolder.trim() === "") {
  console.error("Error: Database folder path cannot be empty.");
  console.error("Please provide a valid path with --db-folder <path>");
  process.exit(1);
}

// Ensure the database folder exists
try {
  if (!fs.existsSync(dbFolder)) {
    logger.info(`Creating database folder: ${dbFolder}`);
    fs.mkdirSync(dbFolder, { recursive: true });
  }
} catch (error) {
  logger.error(`Error creating database folder:`, error);
  process.exit(1);
}

// Initialize the app
const app = express();
app.use(express.json());

// Register API routes
registerRoutes(app, dbFolder, requireCommitments);

// Start the server
const server = app.listen(port, async () => {
  const address = server.address() as AddressInfo;
  logger.info(`Watchtower API running on port ${address.port}`);

  // Initialize databases for each enabled network
  const networks = [];
  const stopFunctions: Array<() => void> = [];

  if (runBitcoin) {
    networks.push("bitcoin");
    const dbPathBitcoin = path.join(dbFolder, "watchtower.bitcoin.sqlite");
    await initDb(dbPathBitcoin, "bitcoin").catch((err) => {
      logger.error("Failed to initialize Bitcoin DB:", err);
      process.exit(1);
    });
    logger.info("Bitcoin mainnet monitoring enabled");
    // Start monitoring for bitcoin
    stopFunctions.push(startMonitoring("bitcoin", 60000));
  }

  if (runTestnet) {
    networks.push("testnet");
    const dbPathTestnet = path.join(dbFolder, "watchtower.testnet.sqlite");
    await initDb(dbPathTestnet, "testnet").catch((err) => {
      logger.error("Failed to initialize Testnet DB:", err);
      process.exit(1);
    });
    logger.info("Bitcoin testnet monitoring enabled");
    // Start monitoring for testnet
    stopFunctions.push(startMonitoring("testnet", 60000));
  }

  if (runTape) {
    networks.push("tape");
    const dbPathTape = path.join(dbFolder, "watchtower.tape.sqlite");
    await initDb(dbPathTape, "tape").catch((err) => {
      logger.error("Failed to initialize Tape DB:", err);
      process.exit(1);
    });
    logger.info("Tape network enabled");
    // Start monitoring for tape
    stopFunctions.push(startMonitoring("tape", 60000));
  }

  if (regtestApiUrl) {
    networks.push("regtest");
    // Set the custom API URL for regtest
    setRegtestApiUrl(regtestApiUrl);
    const dbPathRegtest = path.join(dbFolder, "watchtower.regtest.sqlite");
    await initDb(dbPathRegtest, "regtest").catch((err) => {
      logger.error("Failed to initialize Regtest DB:", err);
      process.exit(1);
    });
    logger.info(
      `Bitcoin regtest monitoring enabled with API: ${regtestApiUrl}`,
    );
    // Start monitoring for regtest
    stopFunctions.push(startMonitoring("regtest", 30000)); // Faster polling for regtest
  }

  logger.info(`Monitoring networks: ${networks.join(", ")}`);

  // Setup graceful shutdown
  const shutdown = async (signal: string) => {
    logger.warn(`${signal} received. Shutting down gracefully...`);

    // Stop all monitoring loops and wait for them to complete
    logger.info("Stopping monitoring loops...");
    const stopPromises = stopFunctions.map((stop) => stop());
    await Promise.all(stopPromises);
    logger.info("All monitoring loops stopped successfully");

    // Close server
    logger.info("Closing HTTP server...");
    await new Promise<void>((resolve) => {
      server.close(() => {
        logger.info("HTTP server closed.");
        resolve();
      });
    });

    // Close database connections
    logger.info("Closing database connections...");
    try {
      await closeAllConnections();
      await closeAllAddressDbConnections();
      logger.info("All database connections closed.");
      logger.info("Shutdown complete.");
      process.exit(0);
    } catch (err) {
      logger.error("Error closing database connections:", err);
      process.exit(1);
    }

    // Force exit after timeout if graceful shutdown fails
    setTimeout(() => {
      logger.error("Forced shutdown after timeout!");
      process.exit(1);
    }, 10000);
  };

  // Handle termination signals
  process.on("SIGINT", () => shutdown("SIGINT")); // CTRL+C
  process.on("SIGTERM", () => shutdown("SIGTERM")); // kill
});
