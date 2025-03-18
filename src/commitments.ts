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

import * as bitcoin from 'bitcoinjs-lib';
import * as fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createLogger } from './logger';

// Create logger for this module
const logger = createLogger("Commitments");

// Cache for address database connections
const addressDbConnections: Record<string, any> = {};

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
  dbFolder: string
): Promise<boolean> {
  try {
    // Get the network configuration for bitcoin-js-lib
    const network = networkId === 'bitcoin' ? bitcoin.networks.bitcoin : 
                    networkId === 'testnet' ? bitcoin.networks.testnet :
                    bitcoin.networks.regtest; // Use regtest for both regtest and tape
    
    // Parse the transaction
    const tx = bitcoin.Transaction.fromHex(commitment);
    
    // Extract output addresses
    const candidateAddresses = tx.outs.map(out => {
      try {
        return bitcoin.address.fromOutputScript(out.script, network);
      } catch (e) {
        // Skip non-standard outputs
        return null;
      }
    }).filter(addr => addr !== null) as string[];
    
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
    const db = await getAddressesDb(networkId, addressDbPath);
    
    // Check if any of the output addresses are authorized
    const placeholders = candidateAddresses.map(() => '?').join(',');
    const query = `SELECT COUNT(*) AS count FROM addresses WHERE address IN (${placeholders})`;
    
    const result = await db.get(query, candidateAddresses);
    
    if (!result || result.count === 0) {
      logger.warn(`No authorized addresses found in commitment transaction. Candidates: ${candidateAddresses.join(', ')}`);
      return false;
    }
    
    logger.info(`Found ${result.count} authorized addresses in commitment transaction`);
    return true;
  } catch (error) {
    logger.error(`Error verifying commitment:`, error);
    return false;
  }
}

/**
 * Get a connection to the addresses database
 */
async function getAddressesDb(networkId: string, dbPath: string): Promise<any> {
  if (addressDbConnections[networkId]) {
    return addressDbConnections[networkId];
  }
  
  // Open the database
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  // Check if the addresses table exists
  const tableExists = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'"
  );
  
  if (!tableExists) {
    logger.warn(`Addresses table does not exist in database: ${dbPath}`);
    // Create the addresses table if it doesn't exist
    await db.exec(`
      CREATE TABLE IF NOT EXISTS addresses (
        address TEXT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  
  // Cache the connection
  addressDbConnections[networkId] = db;
  
  return db;
}

/**
 * Close all address database connections
 */
export async function closeAllAddressDbConnections(): Promise<void> {
  const closePromises = Object.values(addressDbConnections).map(db => db.close());
  await Promise.all(closePromises);
  
  // Clear the connections object
  Object.keys(addressDbConnections).forEach(key => {
    delete addressDbConnections[key];
  });
}
