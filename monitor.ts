import { getDb } from "./db";
import {
  getLatestBlockHeight,
  getBlockHashByHeight,
  getBlockTxids,
  getMempoolTxids,
  getTxStatus,
} from "./blockchain";
import { sendPushNotification } from "./notifications";

// Number of blocks to check for reorgs
const IRREVERSIBLE_THRESHOLD = 6;

// In-memory cache of checked blocks
const checkedBlocks: Record<string, Set<number>> = {
  bitcoin: new Set(),
  testnet: new Set(),
  regtest: new Set(),
};

/**
 * Send notifications for triggered vaults
 */
async function sendNotifications(networkId: string) {
  const db = getDb(networkId);

  // Get all notifications that need to be sent
  const notificationsToSend = await db.all(`
    SELECT n.pushToken, n.vaultId, vt.txid, vt.status
    FROM notifications n
    JOIN vault_txids vt ON n.vaultId = vt.vaultId
    WHERE n.status = 'pending' AND (vt.status = 'reversible' OR vt.status = 'irreversible' OR vt.status = 'pending')
  `);

  for (const notification of notificationsToSend) {
    try {
      // Send notification
      await sendPushNotification({
        to: notification.pushToken,
        title: "Vault Access Alert!",
        body: `Your vault ${notification.vaultId} is being accessed!`,
        data: {
          vaultId: notification.vaultId,
          txid: notification.txid,
          status: notification.status,
        },
      });

      // Update notification status based on transaction status
      let notificationStatus;
      if (notification.status === "irreversible") {
        notificationStatus = "notified_irreversible";
      } else {
        notificationStatus = "notified_reversible";
      }

      // Update notification status
      await db.run(
        "UPDATE notifications SET status = ? WHERE vaultId = ? AND pushToken = ?",
        [notificationStatus, notification.vaultId, notification.pushToken],
      );

      console.log(
        `Notification sent for vault ${notification.vaultId} to device ${notification.pushToken} (${notificationStatus})`,
      );
    } catch (error) {
      console.error(
        `Error sending notification for vault ${notification.vaultId}:`,
        error,
      );
    }
  }
}

/**
 * Main monitoring function
 */
async function monitorTransactions(networkId: string): Promise<void> {
  const db = getDb(networkId);

  try {
    // Get the last checked height from the database
    const state = await db.get(
      "SELECT last_checked_height FROM network_state WHERE id = 1",
    );

    const lastCheckedHeight = state.last_checked_height || 0;
    const currentHeight = parseInt(await getLatestBlockHeight(networkId), 10);
    const mempoolTxids = await getMempoolTxids(networkId);

    if (!lastCheckedHeight) {
      console.log(`First run for ${networkId}`);
      //TODO: make sure all the vault_txids.status are unknown or throw
    }
    // Check all unknown transactions directly
    const unknownTxs = await db.all(`
        SELECT vt.vaultId, vt.txid 
        FROM vault_txids vt
        JOIN notifications n ON vt.vaultId = n.vaultId
        WHERE n.status = 'pending' AND vt.status = 'unknown'
        GROUP BY vt.txid
      `);

    for (const tx of unknownTxs) {
      const txStatus = await getTxStatus(tx.txid, networkId);

      if (txStatus && txStatus.confirmed) {
        // Transaction is confirmed in a block
        const confirmations = currentHeight - txStatus.block_height + 1;
        const status =
          confirmations >= IRREVERSIBLE_THRESHOLD
            ? "irreversible"
            : "reversible";

        await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
          status,
          tx.txid,
        ]);
      } else if (mempoolTxids.includes(tx.txid)) {
        // Transaction is in mempool
        await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
          "pending",
          tx.txid,
        ]);
      } else {
        // Transaction not found, keep as unknown
        // No update needed
      }
    }

    if (lastCheckedHeight) {
      console.log(
        `Resuming ${networkId} monitoring from block height ${lastCheckedHeight}`,
      );
      // Process all blocks from last checked to current
      for (
        let height = lastCheckedHeight + 1;
        height <= currentHeight;
        height++
      ) {
        // Skip if we've already checked this block in this session
        if (checkedBlocks[networkId].has(height)) {
          continue;
        }

        // Get block hash and transactions
        const blockHash = await getBlockHashByHeight(height, networkId);
        const blockTxids = await getBlockTxids(blockHash, networkId);

        // Add to in-memory cache
        checkedBlocks[networkId].add(height);

        // Get all transactions that need checking
        const txsToCheck = await db.all(`
          SELECT vt.vaultId, vt.txid, vt.status
          FROM vault_txids vt
          JOIN notifications n ON vt.vaultId = n.vaultId
          WHERE n.status = 'pending' AND (vt.status = 'unknown' OR vt.status = 'pending' OR vt.status = 'reversible')
          GROUP BY vt.txid
        `);

        // Check each transaction
        for (const tx of txsToCheck) {
          if (blockTxids.includes(tx.txid)) {
            // Transaction found in this block
            const status =
              currentHeight - height + 1 >= IRREVERSIBLE_THRESHOLD
                ? "irreversible"
                : "reversible";

            await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
              status,
              tx.txid,
            ]);
          } else if (mempoolTxids.includes(tx.txid)) {
            // Transaction is in mempool
            await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
              "pending",
              tx.txid,
            ]);
          } else if (tx.status === "unknown") {
            // For unknown transactions, check status directly
            const txStatus = await getTxStatus(tx.txid, networkId);

            if (txStatus && txStatus.confirmed) {
              const confirmations = currentHeight - txStatus.block_height + 1;
              const newStatus =
                confirmations >= IRREVERSIBLE_THRESHOLD
                  ? "irreversible"
                  : "reversible";

              await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
                newStatus,
                tx.txid,
              ]);
            } else if (txStatus) {
              // Transaction exists but not confirmed
              await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
                "pending",
                tx.txid,
              ]);
            }
            // If txStatus is null, keep as unknown
          }
        }
      }
    }

    // Reorg checking removed for now - will be implemented later

    // Send notifications for triggered vaults
    await sendNotifications(networkId);

    // Only update the last checked height after all checks are complete
    await db.run(
      "UPDATE network_state SET last_checked_height = ? WHERE id = 1",
      [currentHeight],
    );

    console.log(
      `${networkId} monitoring completed. Checked blocks up to height ${currentHeight}`,
    );
  } catch (error) {
    console.error(`Error in monitorTransactions for ${networkId}:`, error);
  }
}

/**
 * Sleep function to wait between monitoring cycles
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set up periodic monitoring
 */
export function startMonitoring(networkId: string, intervalMs = 60000) {
  console.log(`Starting transaction monitoring for ${networkId} network`);

  // Flag to allow stopping the monitoring loop
  let running = true;

  // Start the monitoring loop
  (async () => {
    while (running) {
      try {
        // Run the monitoring cycle
        console.log(`Starting monitoring cycle for ${networkId}`);
        await monitorTransactions(networkId);
        console.log(
          `Completed monitoring cycle for ${networkId}, sleeping for ${intervalMs}ms`,
        );
      } catch (error) {
        console.error(`Error in monitoring cycle for ${networkId}:`, error);
      }

      // Wait for the specified interval before the next cycle
      await sleep(intervalMs);
    }
  })();

  // Return a function that can be used to stop the monitoring
  return () => {
    running = false;
    console.log(`Stopping monitoring for ${networkId}`);
  };
}
