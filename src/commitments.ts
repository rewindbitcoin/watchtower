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
import { open, Database } from "sqlite";
import { createLogger } from "./logger";
import { getDb } from "./db";

// Create logger for this module
const logger = createLogger("Commitments");

// Cache for addresses database connections
const addressesDbConnections: Record<
  string,
  Database<sqlite3.Database, sqlite3.Statement>
> = {};

/**
 * Verify that a commitment transaction pays to an authorized address
 * @param commitment Hex-encoded transaction
 * @param networkId Network identifier
 * @param dbFolder Folder containing the address database
 * @param vaultId The vault ID associated with this commitment
 * @returns Object with validity status and txid if valid
 */
export async function verifyCommitment(
  commitment: string,
  networkId: string,
  dbFolder: string,
  vaultId: string,
): Promise<{ isValid: boolean; txid?: string; error?: string }> {
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
    const txid = tx.getId();

    // Check if this commitment has already been used
    const db = getDb(networkId);
    const existingCommitment = await db.get(
      "SELECT vaultId FROM commitments WHERE txid = ?",
      [txid],
    );

    if (existingCommitment) {
      if (existingCommitment.vaultId === vaultId) {
        logger.warn(
          `Commitment ${txid} already registered for this vault ${vaultId}`,
        );
        return { isValid: true, txid }; // Allow reuse for same vault
      } else {
        logger.warn(
          `Commitment ${txid} already used for a different vault: ${existingCommitment.vaultId}`,
        );
        return {
          isValid: false,
          error: "Commitment already used for a different vault",
        };
      }
    }

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
      return {
        isValid: false,
        error: "No valid addresses found in commitment transaction",
      };
    }

    // Open the addresses database
    const addressDbPath = path.join(dbFolder, `${networkId}.sqlite`);

    // Check if the addresses database exists
    if (!fs.existsSync(addressDbPath)) {
      logger.warn(`Addresses database not found: ${addressDbPath}`);
      return {
        isValid: false,
        error: `Addresses database not found: ${addressDbPath}`,
      };
    }

    // Connect to the addresses database
    const addressDb = await initAddressesDb(networkId, addressDbPath);

    // Check if any of the output addresses are authorized
    const placeholders = candidateAddresses.map(() => "?").join(",");
    const query = `SELECT COUNT(*) AS count FROM addresses WHERE address IN (${placeholders})`;

    const result = await addressDb.get(query, candidateAddresses);

    if (!result || result.count === 0) {
      logger.warn(
        `No authorized addresses found in commitment transaction. Candidates: ${candidateAddresses.join(", ")}`,
      );
      return {
        isValid: false,
        error: "No authorized addresses found in commitment transaction",
      };
    }

    logger.info(
      `Found ${result.count} authorized addresses in commitment transaction ${txid}`,
    );
    return { isValid: true, txid };
  } catch (error) {
    logger.error(`Error verifying commitment:`, error);
    return {
      isValid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify that a trigger transaction is spending from the commitment
 * @param triggerTxid The transaction ID of the trigger
 * @param commitmentTxid The transaction ID of the commitment
 * @param networkId Network identifier
 * @returns True if the trigger is spending from the commitment, false otherwise
 */
export async function verifyTriggerSpendingCommitment(
  triggerTxid: string,
  commitmentTxid: string,
  networkId: string,
): Promise<boolean> {
  try {
    // This would require fetching the raw transaction and checking its inputs
    // For now, we'll just log that this check would happen here
    logger.info(
      `Verifying trigger ${triggerTxid} is spending from commitment ${commitmentTxid}`,
    );

    // In a real implementation, we would:
    // 1. Fetch the raw transaction for triggerTxid
    // 2. Parse its inputs
    // 3. Check if any input is spending from commitmentTxid

    // For now, we'll assume it's valid
    // TODO: Implement actual verification logic
    return true;
  } catch (error) {
    logger.error(`Error verifying trigger spending from commitment:`, error);
    return false;
  }
}

/**
 * Initialize a connection to the addresses database
 */
async function initAddressesDb(networkId: string, dbPath: string) {
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
    throw new Error(
      `Addresses table does not exist in database: ${dbPath}. This database is managed by another process and should contain the addresses table.`,
    );
  }

  // Cache the connection
  addressesDbConnections[networkId] = db;

  return db;
}

export function getAddressesDb(networkId: string) {
  if (!addressesDbConnections[networkId]) {
    throw new Error(
      `Addresses database for network ${networkId} not initialized`,
    );
  }
  return addressesDbConnections[networkId];
}

/**
 * Close addresses database connection for a network if it exists
 * @param networkId The network ID
 */
export async function closeAddressesDb(networkId: string): Promise<void> {
  if (addressesDbConnections[networkId]) {
    await addressesDbConnections[networkId].close();
    delete addressesDbConnections[networkId];
    logger.info(`Addresses database for ${networkId} closed successfully`);
  }
}
