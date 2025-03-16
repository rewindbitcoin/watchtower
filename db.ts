import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

// Map to store database connections for each network
const dbConnections: Record<string, Database<sqlite3.Database, sqlite3.Statement>> = {};

export async function initDb(dbPath: string, networkId: string) {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Create tables if they do not exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vaultId TEXT NOT NULL,
      pushToken TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      UNIQUE(vaultId, pushToken)
    );

    CREATE TABLE IF NOT EXISTS vault_txids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vaultId TEXT NOT NULL,
      txid TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY(vaultId) REFERENCES vaults(vaultId)
    );
    
    CREATE TABLE IF NOT EXISTS network_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_checked_height INTEGER
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

export function closeAllConnections() {
  return Promise.all(
    Object.values(dbConnections).map(db => db.close())
  );
}
