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
  
  // Get all vaults that are not pending and have notifications that haven't been sent
  const notificationsToSend = await db.all(`
    SELECT n.pushToken, n.vaultId, vt.txid
    FROM notifications n
    JOIN vaults v ON n.vaultId = v.vaultId
    JOIN vault_txids vt ON v.vaultId = vt.vaultId
    WHERE v.pending = FALSE AND n.notified = FALSE
  `);
  
  for (const notification of notificationsToSend) {
    try {
      // Send notification
      await sendPushNotification({
        to: notification.pushToken,
        title: "Vault Access Alert!",
        body: `Your vault ${notification.vaultId} is being accessed!`,
        data: { vaultId: notification.vaultId, txid: notification.txid }
      });
      
      // Update notification status to sent
      await db.run(
        "UPDATE notifications SET notified = TRUE WHERE vaultId = ? AND pushToken = ?",
        [notification.vaultId, notification.pushToken]
      );
      
      console.log(`Notification sent for vault ${notification.vaultId} to device ${notification.pushToken}`);
    } catch (error) {
      console.error(`Error sending notification for vault ${notification.vaultId}:`, error);
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
      const pendingTxs = await db.all(`
        SELECT vt.vaultId, vt.txid 
        FROM vault_txids vt
        JOIN vaults v ON vt.vaultId = v.vaultId
        WHERE v.pending = TRUE AND vt.block_height = -1
      `);
      
      for (const tx of pendingTxs) {
        const status = await getTxStatus(tx.txid, networkId);
        
        if (status && status.confirmed) {
          // Transaction is confirmed in a block
          await db.run(
            "UPDATE vault_txids SET block_height = ? WHERE txid = ? AND vaultId = ?",
            [status.block_height, tx.txid, tx.vaultId]
          );
          
          // Update vault status to not pending
          await db.run(
            "UPDATE vaults SET pending = FALSE WHERE vaultId = ?",
            [tx.vaultId]
          );
        } else if (mempoolTxids.includes(tx.txid)) {
          // Transaction is in mempool
          await db.run(
            "UPDATE vault_txids SET block_height = -2 WHERE txid = ? AND vaultId = ?",
            [tx.txid, tx.vaultId]
          );
          
          // Update vault status to not pending
          await db.run(
            "UPDATE vaults SET pending = FALSE WHERE vaultId = ?",
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
        const pendingTxs = await db.all(`
          SELECT vt.vaultId, vt.txid 
          FROM vault_txids vt
          JOIN vaults v ON vt.vaultId = v.vaultId
          WHERE v.pending = TRUE AND (vt.block_height = -1 OR vt.block_height = -2)
        `);
        
        // Check each pending transaction
        for (const tx of pendingTxs) {
          if (blockTxids.includes(tx.txid)) {
            // Transaction found in this block
            await db.run(
              "UPDATE vault_txids SET block_height = ? WHERE txid = ? AND vaultId = ?",
              [height, tx.txid, tx.vaultId]
            );
            
            // Update vault status to not pending
            await db.run(
              "UPDATE vaults SET pending = FALSE WHERE vaultId = ?",
              [tx.vaultId]
            );
          } else if (mempoolTxids.includes(tx.txid)) {
            // Transaction is in mempool
            await db.run(
              "UPDATE vault_txids SET block_height = -2 WHERE txid = ? AND vaultId = ?",
              [tx.txid, tx.vaultId]
            );
          }
        }
      }
    }
    
    // Also check for reorgs by rechecking the last IRREVERSIBLE_THRESHOLD blocks
    const reorgStartHeight = Math.max(0, currentHeight - IRREVERSIBLE_THRESHOLD);
    
    // Only recheck if we've already processed past this point
    if (lastCheckedHeight >= reorgStartHeight) {
      // Get transactions that were supposedly mined in blocks we're rechecking
      const txsToRecheck = await db.all(`
        SELECT vt.vaultId, vt.txid, vt.block_height
        FROM vault_txids vt
        WHERE vt.block_height >= ? AND vt.block_height <= ?
      `, [reorgStartHeight, currentHeight]);
      
      // Check if these transactions are still in their blocks
      for (const tx of txsToRecheck) {
        const blockHash = await getBlockHashByHeight(tx.block_height, networkId);
        const blockTxids = await getBlockTxids(blockHash, networkId);
        
        if (!blockTxids.includes(tx.txid)) {
          // Transaction is no longer in the block it was in - possible reorg
          console.log(`Possible reorg detected: ${tx.txid} no longer in block ${tx.block_height}`);
          
          // Check if it's in the mempool
          if (mempoolTxids.includes(tx.txid)) {
            await db.run(
              "UPDATE vault_txids SET block_height = -2 WHERE txid = ? AND vaultId = ?",
              [tx.txid, tx.vaultId]
            );
          } else {
            // Check if it's in another block
            let found = false;
            for (let height = reorgStartHeight; height <= currentHeight; height++) {
              if (height === tx.block_height) continue; // Skip the original block
              
              const otherBlockHash = await getBlockHashByHeight(height, networkId);
              const otherBlockTxids = await getBlockTxids(otherBlockHash, networkId);
              
              if (otherBlockTxids.includes(tx.txid)) {
                // Found in another block
                await db.run(
                  "UPDATE vault_txids SET block_height = ? WHERE txid = ? AND vaultId = ?",
                  [height, tx.txid, tx.vaultId]
                );
                found = true;
                break;
              }
            }
            
            if (!found) {
              // Not found in any block or mempool - reset to pending
              await db.run(
                "UPDATE vault_txids SET block_height = -1 WHERE txid = ? AND vaultId = ?",
                [tx.txid, tx.vaultId]
              );
              
              // Reset vault to pending
              await db.run(
                "UPDATE vaults SET pending = TRUE WHERE vaultId = ?",
                [tx.vaultId]
              );
              
              // Reset notifications to not sent
              await db.run(
                "UPDATE notifications SET notified = FALSE WHERE vaultId = ?",
                [tx.vaultId]
              );
            }
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
