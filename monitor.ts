import { getDb } from "./db";
import { 
  getLatestBlockHeight, 
  getBlockHashByHeight, 
  getBlockTxids, 
  getMempoolTxids,
  getTxStatus
} from "./blockchain";
import { sendPushNotification } from "./notifications";

// Number of blocks to check for reorgs
const IRREVERSIBLE_THRESHOLD = 6;

// In-memory cache of checked blocks
const checkedBlocks: Record<string, Set<number>> = {
  bitcoin: new Set(),
  testnet: new Set(),
  regtest: new Set()
};

/**
 * Initialize the monitoring system
 */
export async function initMonitoring(networkId: string) {
  const db = getDb(networkId);
  
  // Get the last checked height from the database
  const state = await db.get("SELECT last_checked_height FROM network_state WHERE id = 1");
  
  if (!state || !state.last_checked_height) {
    // If no last checked height, initialize with current height - IRREVERSIBLE_THRESHOLD
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    const startHeight = Math.max(0, currentHeight - IRREVERSIBLE_THRESHOLD);
    
    await db.run(
      "INSERT OR REPLACE INTO network_state (id, last_checked_height) VALUES (1, ?)",
      [startHeight]
    );
    
    console.log(`Initialized ${networkId} monitoring from block height ${startHeight}`);
    return startHeight;
  }
  
  return state.last_checked_height;
}

/**
 * Check if a transaction exists in a block or mempool
 */
async function checkTransactionInBlockOrMempool(txid: string, blockTxids: string[], mempoolTxids: string[]): Promise<boolean> {
  // Check if transaction is in the block
  if (blockTxids.includes(txid)) {
    return true;
  }
  
  // Check if transaction is in mempool
  if (mempoolTxids.includes(txid)) {
    return true;
  }
  
  return false;
}

/**
 * Send notifications for triggered vaults
 */
async function sendNotifications(networkId: string) {
  const db = getDb(networkId);
  
  // Get all vaults with triggered status
  const triggeredVaults = await db.all(`
    SELECT DISTINCT v.vaultId, v.pushToken, vt.txid
    FROM vaults v
    JOIN vault_txids vt ON v.vaultId = vt.vaultId
    WHERE v.status = 'triggered'
  `);
  
  for (const vault of triggeredVaults) {
    try {
      // Send notification
      await sendPushNotification({
        to: vault.pushToken,
        title: "Vault Access Alert!",
        body: `Your vault ${vault.vaultId} is being accessed!`,
        data: { vaultId: vault.vaultId, txid: vault.txid }
      });
      
      // Update vault status to notified
      await db.run(
        "UPDATE vaults SET status = 'notified' WHERE vaultId = ? AND pushToken = ?",
        [vault.vaultId, vault.pushToken]
      );
      
      console.log(`Notification sent for vault ${vault.vaultId} to device ${vault.pushToken}`);
    } catch (error) {
      console.error(`Error sending notification for vault ${vault.vaultId}:`, error);
    }
  }
}

/**
 * Main monitoring function
 */
export async function monitorTransactions(networkId: string) {
  const db = getDb(networkId);
  
  try {
    // Get the last checked height
    const state = await db.get("SELECT last_checked_height FROM network_state WHERE id = 1");
    if (!state) {
      console.error(`No state found for ${networkId}. Please initialize monitoring first.`);
      return;
    }
    
    const lastCheckedHeight = state.last_checked_height;
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    
    // Get mempool transactions
    const mempoolTxids = await getMempoolTxids(networkId);
    
    // If this is the first run or we're starting from scratch
    if (lastCheckedHeight === 0) {
      // Check all pending transactions directly
      const pendingTxs = await db.all(
        "SELECT vaultId, txid FROM vault_txids WHERE status = 'pending'"
      );
      
      for (const tx of pendingTxs) {
        const status = await getTxStatus(tx.txid, networkId);
        
        if (status && (status.confirmed || mempoolTxids.includes(tx.txid))) {
          // Update transaction status
          await db.run(
            "UPDATE vault_txids SET status = 'triggered' WHERE txid = ? AND vaultId = ?",
            [tx.txid, tx.vaultId]
          );
          
          // Update vault status
          await db.run(
            "UPDATE vaults SET status = 'triggered' WHERE vaultId = ? AND status = 'pending'",
            [tx.vaultId]
          );
        }
      }
    } else {
      // Process all blocks from last checked to current
      for (let height = lastCheckedHeight + 1; height <= currentHeight; height++) {
        // Skip if we've already checked this block in this session
        if (checkedBlocks[networkId].has(height)) {
          continue;
        }
        
        // Get block hash and transactions
        const blockHash = await getBlockHashByHeight(height, networkId);
        const blockTxids = await getBlockTxids(blockHash, networkId);
        
        // Add to in-memory cache
        checkedBlocks[networkId].add(height);
        
        // Get all pending transactions
        const pendingTxs = await db.all(
          "SELECT vaultId, txid FROM vault_txids WHERE status = 'pending'"
        );
        
        // Check each pending transaction
        for (const tx of pendingTxs) {
          if (await checkTransactionInBlockOrMempool(tx.txid, blockTxids, mempoolTxids)) {
            // Update transaction status
            await db.run(
              "UPDATE vault_txids SET status = 'triggered' WHERE txid = ? AND vaultId = ?",
              [tx.txid, tx.vaultId]
            );
            
            // Update vault status
            await db.run(
              "UPDATE vaults SET status = 'triggered' WHERE vaultId = ? AND status = 'pending'",
              [tx.vaultId]
            );
          }
        }
      }
    }
    
    // Also check for reorgs by rechecking the last IRREVERSIBLE_THRESHOLD blocks
    const reorgStartHeight = Math.max(0, currentHeight - IRREVERSIBLE_THRESHOLD);
    
    // Only recheck if we've already processed past this point
    if (lastCheckedHeight >= reorgStartHeight) {
      for (let height = reorgStartHeight; height <= currentHeight; height++) {
        // Get block hash and transactions
        const blockHash = await getBlockHashByHeight(height, networkId);
        const blockTxids = await getBlockTxids(blockHash, networkId);
        
        // Get all pending transactions
        const pendingTxs = await db.all(
          "SELECT vaultId, txid FROM vault_txids WHERE status = 'pending'"
        );
        
        // Check each pending transaction
        for (const tx of pendingTxs) {
          if (await checkTransactionInBlockOrMempool(tx.txid, blockTxids, mempoolTxids)) {
            // Update transaction status
            await db.run(
              "UPDATE vault_txids SET status = 'triggered' WHERE txid = ? AND vaultId = ?",
              [tx.txid, tx.vaultId]
            );
            
            // Update vault status
            await db.run(
              "UPDATE vaults SET status = 'triggered' WHERE vaultId = ? AND status = 'pending'",
              [tx.vaultId]
            );
          }
        }
      }
    }
    
    // Update the last checked height
    await db.run(
      "UPDATE network_state SET last_checked_height = ? WHERE id = 1",
      [currentHeight]
    );
    
    // Send notifications for triggered vaults
    await sendNotifications(networkId);
    
    console.log(`${networkId} monitoring completed. Checked blocks up to height ${currentHeight}`);
  } catch (error) {
    console.error(`Error in monitorTransactions for ${networkId}:`, error);
  }
}

/**
 * Set up periodic monitoring
 */
export function startMonitoring(networkId: string, intervalMs = 60000) {
  console.log(`Starting transaction monitoring for ${networkId} network`);
  
  // Initialize monitoring
  initMonitoring(networkId).then(() => {
    // Run immediately on start
    monitorTransactions(networkId);
    
    // Then run periodically
    return setInterval(() => monitorTransactions(networkId), intervalMs);
  }).catch(error => {
    console.error(`Failed to initialize monitoring for ${networkId}:`, error);
  });
}
