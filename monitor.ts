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
 * @returns An object with lastCheckedHeight and isFirstRun flag
 */
async function initMonitoring(networkId: string): Promise<{ lastCheckedHeight: number, isFirstRun: boolean }> {
  const db = getDb(networkId);
  
  // Get the last checked height from the database
  const state = await db.get("SELECT last_checked_height FROM network_state WHERE id = 1");
  
  // True first run - no state record exists or last_checked_height is null
  if (!state || state.last_checked_height === null) {
    // Get current height to initialize
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    const startHeight = Math.max(0, currentHeight);
    
    // Create state record with initial height
    await db.run(
      "INSERT OR REPLACE INTO network_state (id, last_checked_height) VALUES (1, ?)",
      [startHeight]
    );
    
    console.log(`First run: Initialized ${networkId} monitoring from block height ${startHeight}`);
    return { lastCheckedHeight: startHeight, isFirstRun: true };
  }
  
  console.log(`Resuming ${networkId} monitoring from block height ${state.last_checked_height}`);
  return { lastCheckedHeight: state.last_checked_height, isFirstRun: false };
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
  
  // Get all notifications that need to be sent
  const notificationsToSend = await db.all(`
    SELECT n.pushToken, n.vaultId, vt.txid, vt.block_height
    FROM notifications n
    JOIN vault_txids vt ON n.vaultId = vt.vaultId
    WHERE n.status = 'pending' AND vt.block_height > -1
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
      
      // For now, all notifications are treated as irreversible
      const status = 'notified_irreversible';
      
      // Update notification status
      await db.run(
        "UPDATE notifications SET status = ? WHERE vaultId = ? AND pushToken = ?",
        [status, notification.vaultId, notification.pushToken]
      );
      
      console.log(`Notification sent for vault ${notification.vaultId} to device ${notification.pushToken} (${status})`);
    } catch (error) {
      console.error(`Error sending notification for vault ${notification.vaultId}:`, error);
    }
  }
}

/**
 * Main monitoring function
 */
async function monitorTransactions(networkId: string) {
  const db = getDb(networkId);
  
  try {
    // Initialize monitoring and get state
    const { lastCheckedHeight, isFirstRun } = await initMonitoring(networkId);
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    
    // Get mempool transactions
    const mempoolTxids = await getMempoolTxids(networkId);
    
    // If this is the first run - use direct transaction status checks
    if (isFirstRun) {
      console.log(`First run for ${networkId}: Checking all pending transactions directly`);
      // Check all pending transactions directly
      const pendingTxs = await db.all(`
        SELECT vt.vaultId, vt.txid 
        FROM vault_txids vt
        JOIN notifications n ON vt.vaultId = n.vaultId
        WHERE n.status = 'pending' AND vt.block_height = -1
        GROUP BY vt.txid
      `);
      
      for (const tx of pendingTxs) {
        const status = await getTxStatus(tx.txid, networkId);
        
        if (status && status.confirmed) {
          // Transaction is confirmed in a block
          await db.run(
            "UPDATE vault_txids SET block_height = ? WHERE txid = ?",
            [status.block_height, tx.txid]
          );
          
          // No need to update vault status as we don't have a vaults table anymore
          // Notifications will be updated in the sendNotifications function
        } else if (mempoolTxids.includes(tx.txid)) {
          // Transaction is in mempool
          await db.run(
            "UPDATE vault_txids SET block_height = -2 WHERE txid = ?",
            [tx.txid]
          );
          
          // No need to update vault status as we don't have a vaults table anymore
          // Notifications will be updated in the sendNotifications function
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
          JOIN notifications n ON vt.vaultId = n.vaultId
          WHERE n.status = 'pending' AND (vt.block_height = -1 OR vt.block_height = -2)
          GROUP BY vt.txid
        `);
        
        // Check each pending transaction
        for (const tx of pendingTxs) {
          if (blockTxids.includes(tx.txid)) {
            // Transaction found in this block
            await db.run(
              "UPDATE vault_txids SET block_height = ? WHERE txid = ?",
              [height, tx.txid]
            );
            
            // No need to update vault status as we don't have a vaults table anymore
            // Notifications will be updated in the sendNotifications function
          } else if (mempoolTxids.includes(tx.txid)) {
            // Transaction is in mempool
            await db.run(
              "UPDATE vault_txids SET block_height = -2 WHERE txid = ?",
              [tx.txid]
            );
          }
        }
      }
    }
    
    // Reorg checking removed for now - will be implemented later
    
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
  
  // Run immediately on start - initialization happens inside monitorTransactions
  monitorTransactions(networkId);
  
  // Then run periodically
  return setInterval(() => monitorTransactions(networkId), intervalMs);
}
