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

import Database from "better-sqlite3";
import { createLogger } from "./logger";

const logger = createLogger("Database");

// Map to store database connections for each network
const dbConnections: Record<string, Database.Database> = {};

export function initDb(dbPath: string, networkId: string) {
  // Create a new database connection
  const db = new Database(dbPath, {
    readonly: false,
    fileMustExist: false,
    timeout: 10000, // 10 seconds timeout on busy
  });

  // Enable WAL mode for better concurrency handling
  db.pragma("journal_mode = WAL");

  // Create tables if they do not exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      pushToken TEXT NOT NULL,
      vaultId TEXT NOT NULL,
      walletId TEXT NOT NULL,
      walletName TEXT NOT NULL,
      vaultNumber INTEGER NOT NULL,
      watchtowerId TEXT NOT NULL, -- Client-provided unique ID for the watchtower instance
      firstAttemptAt INTEGER DEFAULT NULL, -- Unix timestamp of first attempt, NULL until first attempt
      acknowledged INTEGER DEFAULT 0, -- 0 = not acknowledged, 1 = acknowledged
      lastAttemptAt INTEGER DEFAULT NULL, -- timestamp of last attempt
      attemptCount INTEGER DEFAULT 0, -- number of retry attempts
      locale TEXT DEFAULT 'en', -- User's preferred language
      PRIMARY KEY (pushToken, vaultId)
    );

    CREATE TABLE IF NOT EXISTS vault_txids (
      txid TEXT PRIMARY KEY,
      vaultId TEXT NOT NULL,
      status TEXT DEFAULT 'unchecked', -- 'unchecked', 'unseen', 'reversible', or 'irreversible'
      commitmentTxid TEXT -- The txid of the commitment transaction
    );
    
    CREATE TABLE IF NOT EXISTS commitments (
      txid TEXT PRIMARY KEY,
      vaultId TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    
    CREATE TABLE IF NOT EXISTS network_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_checked_height INTEGER NULL
    );
  `);

  // Store the connection for this network
  dbConnections[networkId] = db;

  logger.info(`Initialized database for ${networkId} at ${dbPath}`);
  return db;
}

export function getDb(networkId: string) {
  if (!dbConnections[networkId]) {
    throw new Error(`Database for network ${networkId} not initialized`);
  }
  return dbConnections[networkId];
}

/**
 * Close and remove a database connection for a specific network
 * @param networkId The network ID
 */
export function closeDb(networkId: string): void {
  const db = dbConnections[networkId];
  if (db) {
    db.close();
    delete dbConnections[networkId];
    logger.info(`Database for ${networkId} closed successfully`);
  }
}
