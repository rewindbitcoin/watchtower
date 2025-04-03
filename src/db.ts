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

import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";

// Map to store database connections for each network
const dbConnections: Record<
  string,
  Database<sqlite3.Database, sqlite3.Statement>
> = {};

export async function initDb(dbPath: string, networkId: string) {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Create tables if they do not exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      pushToken TEXT NOT NULL,
      vaultId TEXT NOT NULL,
      walletName TEXT NOT NULL,
      vaultNumber INTEGER NOT NULL,
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
      status TEXT DEFAULT 'unchecked' -- 'unchecked', 'unseen', 'reversible', or 'irreversible'
    );
    
    CREATE TABLE IF NOT EXISTS network_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_checked_height INTEGER NULL
    );
  `);

  // Store the connection for this network
  dbConnections[networkId] = db;

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
export async function closeDb(networkId: string): Promise<void> {
  const db = dbConnections[networkId];
  if (db) {
    await db.close();
    delete dbConnections[networkId];
  }
}
