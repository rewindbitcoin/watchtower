import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDb(dbPath: string) {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Create tables if they do not exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      vaultId TEXT PRIMARY KEY,
      pushToken TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_txids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vaultId TEXT NOT NULL,
      txid TEXT NOT NULL,
      FOREIGN KEY(vaultId) REFERENCES vaults(vaultId)
    );
  `);
}

export function getDb() {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}
