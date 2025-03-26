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

import * as bitcoin from "bitcoinjs-lib";
import * as fs from "fs";
import * as path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { createLogger } from "./logger";

// Create logger for this module
const logger = createLogger("Commitments");

// Cache for addresses database connections
const addressesDbConnections: Record<string, any> = {};

/**
 * Verify that a commitment transaction pays to an authorized address
 * @param commitment Hex-encoded transaction
 * @param networkId Network identifier
 * @param dbFolder Folder containing the address database
 * @returns True if the commitment is valid, false otherwise
 */
export async function verifyCommitment(
  commitment: string,
  networkId: string,
  dbFolder: string,
): Promise<boolean> {
  try {
    // Get the network configuration for bitcoin-js-lib
    const network =
      networkId === "bitcoin"
        ? bitcoin.networks.bitcoin
        : networkId === "testnet"
          ? bitcoin.networks.testnet
          : bitcoin.networks.regtest; // Use regtest for both regtest and tape

    // Parse the transaction
    const tx = bitcoin.Transaction.fromHex(commitment);

    // Extract output addresses
    const candidateAddresses = tx.outs
      .map((out) => {
        try {
          return bitcoin.address.fromOutputScript(out.script, network);
        } catch (e) {
          // Skip non-standard outputs
          return null;
        }
      })
      .filter((addr) => addr !== null) as string[];

    if (candidateAddresses.length === 0) {
      logger.warn(`No valid addresses found in commitment transaction`);
      return false;
    }

    // Open the addresses database
    const addressDbPath = path.join(dbFolder, `${networkId}.sqlite`);

    // Check if the addresses database exists
    if (!fs.existsSync(addressDbPath)) {
      logger.warn(`Addresses database not found: ${addressDbPath}`);
      return false;
    }

    // Connect to the addresses database
    const db = await initAddressesDb(networkId, addressDbPath);

    // Check if any of the output addresses are authorized
    const placeholders = candidateAddresses.map(() => "?").join(",");
    const query = `SELECT COUNT(*) AS count FROM addresses WHERE address IN (${placeholders})`;

    const result = await db.get(query, candidateAddresses);

    if (!result || result.count === 0) {
      logger.warn(
        `No authorized addresses found in commitment transaction. Candidates: ${candidateAddresses.join(", ")}`,
      );
      return false;
    }

    logger.info(
      `Found ${result.count} authorized addresses in commitment transaction`,
    );
    return true;
  } catch (error) {
    logger.error(`Error verifying commitment:`, error);
    return false;
  }
}

/**
 * Initialize a connection to the addresses database
 */
async function initAddressesDb(
  networkId: string,
  dbPath: string,
): Promise<any> {
  if (addressesDbConnections[networkId]) {
    return addressesDbConnections[networkId];
  }

  // Open the database
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });

  // Check if the addresses table exists
  const tableExists = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'",
  );

  if (!tableExists) {
    logger.warn(
      `Addresses table does not exist in database: ${dbPath}. This database is managed by another process and should contain the addresses table.`,
    );
    return db;
  }

  // Cache the connection
  addressesDbConnections[networkId] = db;

  return db;
}

export function getAddressDb(networkId: string): any {
  return addressesDbConnections[networkId] || null;
}

/**
 * Close and remove an address database connection
 * @param networkId The network ID
 */
export async function closeAddressDb(networkId: string): Promise<void> {
  const db = addressesDbConnections[networkId];
  if (db) {
    await db.close();
    delete addressesDbConnections[networkId];
  }
}
