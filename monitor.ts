import { getDb } from "./db";
import { 
  getLatestBlockHeight, 
  getBlockHashByHeight, 
  getBlockTxids, 
  getMempoolTxids,
  getTxStatus
} from "./blockchain";
import { sendPushNotification, NotificationPayload } from "./notifications";

// Safety margin for reorgs (in blocks)
const REORG_SAFETY_MARGIN = 6;

// Check if a transaction exists
export async function checkTransaction(txid: string, vaultId: string, networkId: string): Promise<boolean> {
  const db = getDb(networkId);
  
  try {
    // Check if transaction is in mempool
    const mempoolTxids = await getMempoolTxids(networkId);
    if (mempoolTxids.includes(txid)) {
      // Transaction found in mempool
      await db.run(
        "UPDATE vault_txids SET status = 'mempool' WHERE txid = ? AND vaultId = ?",
        [txid, vaultId]
      );
      return true;
    }
    
    // Get transaction info from database
    const txInfo = await db.get(
      "SELECT confirmed_not_exist_below_height FROM vault_txids WHERE txid = ? AND vaultId = ?",
      [txid, vaultId]
    );
    
    // Get current block height
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    
    // If this is the first check or we don't have a confirmed_not_exist_below_height
    if (!txInfo || !txInfo.confirmed_not_exist_below_height) {
      // Check transaction status directly
      const status = await getTxStatus(txid, networkId);
      
      if (status) {
        if (status.confirmed) {
          // Transaction is confirmed
          await db.run(
            "UPDATE vault_txids SET status = 'confirmed' WHERE txid = ? AND vaultId = ?",
            [txid, vaultId]
          );
          return true;
        } else {
          // Transaction exists but not confirmed (likely in mempool)
          await db.run(
            "UPDATE vault_txids SET status = 'mempool' WHERE txid = ? AND vaultId = ?",
            [txid, vaultId]
          );
          return true;
        }
      } else {
        // Transaction doesn't exist yet
        // Record current height minus safety margin as the confirmed_not_exist_below_height
        const safeHeight = Math.max(0, currentHeight - REORG_SAFETY_MARGIN);
        await db.run(
          "UPDATE vault_txids SET confirmed_not_exist_below_height = ? WHERE txid = ? AND vaultId = ?",
          [safeHeight, txid, vaultId]
        );
        return false;
      }
    } else {
      // We have a confirmed_not_exist_below_height, so check blocks after that height
      const startHeight = txInfo.confirmed_not_exist_below_height + 1;
      
      // Check blocks from startHeight to currentHeight
      for (let height = startHeight; height <= currentHeight; height++) {
        // Check if we've already processed this block
        const blockInfo = await db.get(
          "SELECT checked FROM monitored_blocks WHERE height = ?", 
          [height]
        );
        
        if (blockInfo && blockInfo.checked) {
          continue; // Skip blocks we've already checked
        }
        
        // Get block hash
        const blockHash = await getBlockHashByHeight(height, networkId);
        
        // Get all transactions in this block
        const blockTxids = await getBlockTxids(blockHash, networkId);
        
        // Store block info
        await db.run(
          "INSERT OR REPLACE INTO monitored_blocks (height, hash, checked) VALUES (?, ?, ?)",
          [height, blockHash, true]
        );
        
        // Check if our txid is in this block
        if (blockTxids.includes(txid)) {
          // Transaction found in this block
          await db.run(
            "UPDATE vault_txids SET status = 'confirmed' WHERE txid = ? AND vaultId = ?",
            [txid, vaultId]
          );
          return true;
        }
      }
      
      return false;
    }
  } catch (error) {
    console.error(`Error in checkTransaction for ${txid}:`, error);
    return false;
  }
}

// Main monitoring function
export async function monitorTransactions(networkId: string) {
  const db = getDb(networkId);
  
  try {
    // Get all pending transactions to monitor
    const pendingTxs = await db.all(
      "SELECT vt.vaultId, vt.txid, v.pushToken FROM vault_txids vt JOIN vaults v ON vt.vaultId = v.vaultId WHERE vt.status = 'pending'"
    );
    
    for (const tx of pendingTxs) {
      const found = await checkTransaction(tx.txid, tx.vaultId, network);
      
      if (found) {
        // Send notification
        await sendPushNotification({
          to: tx.pushToken,
          title: "Vault Access Alert!",
          body: `Your vault ${tx.vaultId} is being accessed!`,
          data: { vaultId: tx.vaultId, txid: tx.txid }
        });
        
        console.log(`Notification sent for vault ${tx.vaultId} - transaction ${tx.txid} detected`);
      }
    }
    
    // Clean up old monitored blocks (keep only recent ones)
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    const oldestNeededHeight = await db.get(
      "SELECT MIN(confirmed_not_exist_below_height) as min_height FROM vault_txids WHERE status = 'pending'"
    );
    
    if (oldestNeededHeight && oldestNeededHeight.min_height) {
      // Delete blocks that are older than the oldest needed height
      await db.run(
        "DELETE FROM monitored_blocks WHERE height < ?",
        [oldestNeededHeight.min_height]
      );
    }
  } catch (error) {
    console.error(`Error in monitorTransactions for ${networkId}:`, error);
  }
}

// Set up periodic monitoring
export function startMonitoring(networkId: string, intervalMs = 60000) {
  console.log(`Starting transaction monitoring for ${networkId} network`);
  
  // Run immediately on start
  monitorTransactions(networkId);
  
  // Then run periodically
  return setInterval(() => monitorTransactions(networkId), intervalMs);
}
