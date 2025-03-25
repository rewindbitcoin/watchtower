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

import { getDb } from "./db";
import {
  getLatestBlockHeight,
  getBlockHashByHeight,
  getBlockTxids,
  getMempoolTxids,
  getTxStatus,
} from "./blockchain";
import { sendPushNotification } from "./notifications";
import { createLogger } from "./logger";

// Create logger for this module
const logger = createLogger("Monitor");

// Number of blocks to check for reorgs
const IRREVERSIBLE_THRESHOLD = 4;

// Maximum time to retry push notifications (in milliseconds)
// Default: 3 days = 3 * 24 * 60 * 60 * 1000 = 259200000 ms
const MAX_NOTIFICATION_RETRY_MS = 3 * 24 * 60 * 60 * 1000;

// In-memory cache of block transactions to avoid redundant network calls
// Structure: { networkId: { blockHash: string[] } }
const blockTxidsCache: Record<string, Record<string, string[]>> = {
  bitcoin: {},
  testnet: {},
  tape: {},
  regtest: {},
};

// Maximum number of blocks to keep in the cache per network
const MAX_CACHED_BLOCKS = IRREVERSIBLE_THRESHOLD * 2;

// Track last API call time for rate limiting
const lastApiCallTime: Record<string, number> = {};

/**
 * Helper function to make API calls with retry and delay
 * Includes rate limiting to prevent "Too Many Requests" errors
 */
async function apiCallWithRetry<T>(
  apiCall: () => Promise<T>,
  retries = 3,
  delayMs = 500,
  apiKey = "default", // Use a key to track different API endpoints
): Promise<T> {
  // Enforce minimum delay between calls to the same API endpoint
  const now = Date.now();
  const lastCallTime = lastApiCallTime[apiKey] || 0;
  const timeSinceLastCall = now - lastCallTime;

  if (timeSinceLastCall < delayMs) {
    // Wait for the remaining time to reach minimum delay
    const waitTime = delayMs - timeSinceLastCall;
    await sleep(waitTime);
  }

  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Add delay between retry attempts (except for first attempt)
      if (attempt > 0) {
        await sleep(delayMs * attempt); // Increasing delay for each retry
      }

      // Update the last call time before making the call
      lastApiCallTime[apiKey] = Date.now();

      return await apiCall();
    } catch (error) {
      lastError = error;
      logger.warn(
        `API call failed (attempt ${attempt + 1}/${retries}):`,
        error,
      );
    }
  }
  throw lastError;
}

/**
 * Get block transactions with caching to reduce network calls
 * Returns cached transactions if available, otherwise fetches from network
 */
async function getCachedBlockTxids(
  blockHash: string,
  networkId: string,
): Promise<string[]> {
  if (!blockTxidsCache[networkId])
    throw new Error(`Block txids cache for ${networkId} is undefined`);

  // Check if we have this block's transactions in cache
  if (blockTxidsCache[networkId][blockHash]) {
    return blockTxidsCache[networkId][blockHash];
  }

  // Not in cache, fetch from network with retry
  const blockTxids = await apiCallWithRetry(
    () => getBlockTxids(blockHash, networkId),
    3,
    500,
    networkId,
  );

  // Add to cache
  blockTxidsCache[networkId][blockHash] = blockTxids;

  // Prune cache if it gets too large
  const blockHashes = Object.keys(blockTxidsCache[networkId]);
  if (blockHashes.length > MAX_CACHED_BLOCKS) {
    // Remove oldest entries (we'll remove 25% of the cache)
    const toRemove = Math.ceil(blockHashes.length * 0.25);
    const oldestHashes = blockHashes.slice(0, toRemove);
    for (const hash of oldestHashes) {
      delete blockTxidsCache[networkId][hash];
    }
  }

  return blockTxids;
}

/**
 * Send notifications for triggered vaults
 */
async function sendNotifications(networkId: string) {
  const db = getDb(networkId);

  // Get all notifications that need to be sent
  // Only include notifications that haven't exceeded the retry period
  const maxRetryTime = Math.floor(
    (Date.now() - MAX_NOTIFICATION_RETRY_MS) / 1000,
  );

  const notificationsToSend = await db.all(
    `
    SELECT n.pushToken, n.vaultId, vt.txid, vt.status, n.firstAttemptAt
    FROM notifications n
    JOIN vault_txids vt ON n.vaultId = vt.vaultId
    WHERE n.status = 'pending' 
      AND (vt.status = 'reversible' OR vt.status = 'irreversible')
      AND (n.firstAttemptAt > ? OR n.firstAttemptAt IS NULL)
  `,
    [maxRetryTime],
  );

  for (const notification of notificationsToSend) {
    try {
      // Get wallet name and vault number for this notification
      const notificationDetails = await db.get(
        "SELECT walletName, vaultNumber FROM notifications WHERE vaultId = ? AND pushToken = ?",
        [notification.vaultId, notification.pushToken],
      );

      // Set firstAttemptAt if this is the first attempt
      if (notification.firstAttemptAt === null) {
        await db.run(
          "UPDATE notifications SET firstAttemptAt = strftime('%s','now') WHERE vaultId = ? AND pushToken = ?",
          [notification.vaultId, notification.pushToken],
        );
      }

      // Send notification
      const success = await sendPushNotification({
        to: notification.pushToken,
        title: "Vault Access Alert!",
        body: `Your vault ${notification.vaultId} in wallet '${notificationDetails.walletName}' is being accessed!`,
        data: {
          vaultId: notification.vaultId,
          walletName: notificationDetails.walletName,
          vaultNumber: notificationDetails.vaultNumber,
          txid: notification.txid,
        },
      });

      if (success) {
        // Update notification status to 'sent' only if the push was successful
        await db.run(
          "UPDATE notifications SET status = 'sent' WHERE vaultId = ? AND pushToken = ?",
          [notification.vaultId, notification.pushToken],
        );

        logger.info(
          `Notification sent for vault ${notification.vaultId} to device ${notification.pushToken} (tx status: ${notification.status})`,
          {
            walletName: notificationDetails.walletName,
            vaultNumber: notificationDetails.vaultNumber,
          },
        );
      } else {
        logger.error(
          `Failed to send push notification for vault ${notification.vaultId}. Will retry in next cycle.`,
          { pushToken: notification.pushToken.substring(0, 10) + "..." },
        );
        // We don't update the status, so it will be retried in the next cycle
      }
    } catch (error) {
      logger.error(
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

    const lastCheckedHeight = state?.last_checked_height || 0;
    const currentHeight = parseInt(
      await apiCallWithRetry(
        () => getLatestBlockHeight(networkId),
        3,
        500,
        networkId,
      ),
      10,
    );

    if (!lastCheckedHeight) {
      logger.info(`First run for ${networkId}`);

      // Check if there are any vault_txids with status other than 'unchecked'
      const nonUncheckedTxs = await db.get(`
        SELECT COUNT(*) as count 
        FROM vault_txids 
        WHERE status != 'unchecked'
      `);

      if (nonUncheckedTxs && nonUncheckedTxs.count > 0) {
        throw new Error(
          `First run for ${networkId} but found ${nonUncheckedTxs.count} transactions with status other than 'unchecked'. Database may be corrupted.`,
        );
      }
    }
    // Check all unchecked transactions directly
    const uncheckedTxs = await db.all(`
        SELECT vaultId, txid 
        FROM vault_txids
        WHERE status = 'unchecked'
      `);

    if (uncheckedTxs.length) {
      logger.info(
        `Checking status of ${uncheckedTxs.length} unchecked transactions on ${networkId} network`,
      );
    }
    const mempoolTxids = await apiCallWithRetry(
      () => getMempoolTxids(networkId),
      3,
      500,
      networkId,
    );
    for (const tx of uncheckedTxs) {
      const txStatus = await apiCallWithRetry(
        () => getTxStatus(tx.txid, networkId),
        3,
        500,
        networkId,
      );

      if (txStatus.confirmed || mempoolTxids.includes(tx.txid)) {
        // Transaction is confirmed in a block
        const confirmations = txStatus.block_height
          ? currentHeight - txStatus.block_height + 1
          : 0;
        const status =
          confirmations >= IRREVERSIBLE_THRESHOLD
            ? "irreversible"
            : "reversible";

        //mempool or few blocks in:
        await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
          status,
          tx.txid,
        ]);
      } else {
        //not seen yet
        await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
          "unseen",
          tx.txid,
        ]);
      }
    }
    if (uncheckedTxs.length) {
      logger.info(
        `Completed checking ${uncheckedTxs.length} transactions on ${networkId} network`,
      );
    }

    if (lastCheckedHeight) {
      const reorgSafeStartHeight = lastCheckedHeight - IRREVERSIBLE_THRESHOLD;
      logger.info(
        `Resuming ${networkId} monitoring from block height ${reorgSafeStartHeight} to ${currentHeight} (accounting for possible reorgs)`,
      );
      const scannedBlockTxids: string[] = [];
      // Process all blocks from last checked to current.
      // Consider possible reorg by start the search IRREVERSIBLE_THRESHOLD
      // blocks before the last checked.
      for (
        let height = reorgSafeStartHeight;
        height <= currentHeight;
        height++
      ) {
        const blockHash = await apiCallWithRetry(
          () => getBlockHashByHeight(height, networkId),
          3,
          500,
          networkId,
        );

        // Get block transactions (from cache if available)
        const blockTxids = await getCachedBlockTxids(blockHash, networkId);
        scannedBlockTxids.push(...blockTxids);

        // Get all transactions that need checking
        const txsToCheck = await db.all(`
          SELECT txid, status
          FROM vault_txids
          WHERE status = 'unseen' OR status = 'reversible'
        `);

        // Check each transaction
        for (const tx of txsToCheck) {
          if (blockTxids.includes(tx.txid)) {
            // Transaction found in this block
            const confirmations = currentHeight - height + 1;
            const status =
              confirmations >= IRREVERSIBLE_THRESHOLD
                ? "irreversible"
                : "reversible";

            await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
              status,
              tx.txid,
            ]);
          } else if (mempoolTxids.includes(tx.txid) && tx.status === "unseen") {
            // Transaction is in mempool
            await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
              "reversible",
              tx.txid,
            ]);
          }
        }
      }

      // This section handles transaction disappearance detection
      // A transaction can disappear due to:
      // 1. Blockchain reorganization (reorg) - when a chain of blocks is
      //    replaced by a longer chain
      // 2. Mempool purge - when a transaction is evicted from the mempool due
      //    to low fees, conflicts, or timeout
      const txsToCheck = await db.all(`
          SELECT txid, status
          FROM vault_txids
          WHERE status = 'reversible'
        `);
      // Check if transaction is in either scanned blocks OR mempool
      for (const tx of txsToCheck)
        if (
          !scannedBlockTxids.includes(tx.txid) &&
          !mempoolTxids.includes(tx.txid)
        ) {
          // This reversible transaction cannot be found anymore in the last
          // IRREVERSIBLE_THRESHOLD blocks or mempool!
          // This means it was either reorg or purged from the mempool.

          // Reset the transaction status
          await db.run("UPDATE vault_txids SET status = ? WHERE txid = ?", [
            "unseen",
            tx.txid,
          ]);

          // Reset notifications for this transaction's vaultId back to pending
          // so they can be sent again if the transaction reappears
          await db.run(
            `
              UPDATE notifications 
              SET status = 'pending', firstAttemptAt = NULL
              WHERE vaultId IN (
                SELECT vaultId FROM vault_txids WHERE txid = ?
              )
            `,
            [tx.txid],
          );

          logger.warn(
            `Reset notifications for txid ${tx.txid} due to transaction disappearance (reorg or mempool purge)`,
          );
        }
    }
    // Send notifications for triggered vaults
    await sendNotifications(networkId);

    await db.run(
      "INSERT OR REPLACE INTO network_state (id, last_checked_height) VALUES (1, ?)",
      [currentHeight],
    );

    logger.info(
      `${networkId} monitoring completed. Checked blocks up to height ${currentHeight}`,
    );
  } catch (error) {
    logger.error(`Error in monitorTransactions for ${networkId}:`, error);

    // Clear the block txids cache for this network to ensure
    // fresh data in the next cycle
    blockTxidsCache[networkId] = {};
    logger.info(`Cleared block txids cache for ${networkId} due to error`);
  }
}

/**
 * Create an interruptible sleep function
 * Returns both a sleep function and a way to interrupt it
 */
function createInterruptibleSleep() {
  let timeoutId: NodeJS.Timeout | null = null;
  let resolvePromise: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      resolvePromise = resolve;
      timeoutId = setTimeout(resolve, ms);
    });
  };

  const interrupt = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (resolvePromise) {
      resolvePromise();
      resolvePromise = null;
    }
  };

  return { sleep, interrupt };
}

/**
 * Simple sleep function for cases where interruption is not needed
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set up periodic monitoring
 */
export function startMonitoring(networkId: string, intervalMs = 60000) {
  logger.info(`Starting transaction monitoring for ${networkId} network`);

  // Flag to allow stopping the monitoring loop
  let running = true;
  let currentCycle: Promise<void> | null = null;
  const { sleep: interruptibleSleep, interrupt } = createInterruptibleSleep();

  // Start the monitoring loop
  (async () => {
    while (running) {
      try {
        // Run the monitoring cycle
        logger.info(`Starting monitoring cycle for ${networkId}`);
        currentCycle = monitorTransactions(networkId);
        await currentCycle;
        currentCycle = null;
        logger.info(
          `Completed monitoring cycle for ${networkId}, sleeping for ${intervalMs}ms`,
        );
      } catch (error) {
        logger.error(`Error in monitoring cycle for ${networkId}:`, error);
        currentCycle = null;
      }

      // Only sleep if we're still running
      if (running) {
        // Wait for the specified interval before the next cycle
        // Use interruptible sleep so we can exit quickly on shutdown
        await interruptibleSleep(intervalMs);
      }
    }
    logger.info(`Monitoring loop for ${networkId} has exited cleanly`);
  })();

  // Return a function that can be used to stop the monitoring
  return (): Promise<void> => {
    running = false;
    logger.info(
      `Stopping monitoring for ${networkId}. Waiting for current cycle to complete...`,
    );

    // Interrupt any ongoing sleep to exit immediately
    interrupt();

    // Return a promise that resolves when the current cycle completes
    return new Promise<void>((resolve) => {
      if (currentCycle) {
        // If there's a cycle running, wait for it to complete
        currentCycle.finally(() => {
          logger.info(
            `Current cycle for ${networkId} completed after stop request`,
          );
          resolve();
        });
      } else {
        // If no cycle is running, resolve immediately
        resolve();
      }
    });
  };
}
