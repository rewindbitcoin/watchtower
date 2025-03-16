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

// Get network type from command line arguments, default to bitcoin
let networkType = "bitcoin"; // Default
const networkArg = process.argv.find(arg => 
  !arg.startsWith('--') && 
  (arg === "bitcoin" || arg === "testnet" || arg === "regtest")
);

if (networkArg) {
  networkType = networkArg;
}

if (!process.env.DB_FOLDER) throw new Error("Incomplete env: DB_FOLDER");
const dbName = `watchtower.${networkType}.sqlite`;
const dbPath = path.join(process.cwd(), "..", process.env.DB_FOLDER, dbName);

// Initialize the database
initDb(dbPath)
  .then(() => {
    const app = express();
    app.use(express.json());

    // Register API routes
    registerRoutes(app);

    // Parse command line arguments for port
    const portArg = process.argv.find(arg => arg.startsWith('--port='));
    const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0; // Use 0 for random port assignment
    
    // Start the server
    const server = app.listen(port, () => {
      const address = server.address() as AddressInfo;
      console.log(`Watchtower API (${networkType}) running on port ${address.port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize DB:", err);
    process.exit(1);
  });
