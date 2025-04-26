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
  verifyTriggerSpendingCommitment,
} from "./blockchain";
import { sendPushNotification } from "./notifications";
import { createLogger } from "./logger";
import { getMessage, formatTimeSince } from "./i18n";

// Create logger for this module
const logger = createLogger("Monitor");

// Number of blocks to check for reorgs
const IRREVERSIBLE_THRESHOLD = 4;

// Maximum time to retry push notifications (in milliseconds)
// Default: 7 days = 7 * 24 * 60 * 60 * 1000 = 604800000 ms
const MAX_NOTIFICATION_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

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
  networkId: string, // Track rate limiting per network
  retries = 3,
  delayMs = 300,
): Promise<T> {
  // Enforce minimum delay between calls to the same network
  const now = Date.now();
  const lastCallTime = lastApiCallTime[networkId] || 0;
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
      lastApiCallTime[networkId] = Date.now();

      return await apiCall();
    } catch (error) {
      lastError = error;
      logger.warn(
        `API call failed on ${networkId} (attempt ${attempt + 1}/${retries}):`,
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
async function getBlockTxidsWithCache(
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
  const now = Math.floor(Date.now() / 1000); // Current time in seconds

  // Get all notifications that need to be sent or retried
  // Only include notifications that haven't exceeded the retry period
  const maxRetryTime = Math.floor(
    (Date.now() - MAX_NOTIFICATION_RETRY_MS) / 1000,
  );

  // Find notifications that need to be sent or retried
  const notificationsToSend = db
    .prepare(
      `
    SELECT n.pushToken, n.vaultId, vt.txid, vt.status,
           n.firstAttemptAt, n.lastAttemptAt, n.attemptCount, n.acknowledged,
           n.walletId, n.walletName, n.vaultNumber, n.watchtowerId, n.locale
    FROM notifications n
    JOIN vault_txids vt ON n.vaultId = vt.vaultId
    WHERE n.acknowledged = 0
      AND (vt.status = 'reversible' OR vt.status = 'irreversible')
      AND (n.firstAttemptAt > ? OR n.firstAttemptAt IS NULL)
      AND (
        -- First attempt
        n.attemptCount = 0
        OR
        -- First day: retry every 6 hours
        (n.firstAttemptAt > ? AND (? - n.lastAttemptAt) >= 21600)
        OR
        -- After first day: retry once per day
        ((? - n.firstAttemptAt) > 86400 AND (? - n.lastAttemptAt) >= 86400)
      )
  `,
    )
    .all(maxRetryTime, now - 86400, now, now, now) as Array<{
    pushToken: string;
    vaultId: string;
    txid: string;
    status: string;
    firstAttemptAt: number | null;
    lastAttemptAt: number | null;
    attemptCount: number;
    acknowledged: number;
    walletId: string;
    walletName: string;
    vaultNumber: number;
    watchtowerId: string;
    locale: string;
  }>;

  for (const notification of notificationsToSend) {
    try {
      // Set firstAttemptAt if this is the first attempt
      if (notification.firstAttemptAt === null) {
        // Verify commitment is present before sending 1st notification
        const tx = db
          .prepare(
            "SELECT txid, commitmentTxid FROM vault_txids WHERE txid = ? AND vaultId = ?",
          )
          .get(notification.txid, notification.vaultId) as
          | {
              txid: string;
              commitmentTxid: string;
            }
          | undefined;
        if (tx && tx.commitmentTxid) {
          const isValidSpend = await verifyTriggerSpendingCommitment(
            tx.txid,
            tx.commitmentTxid,
            networkId,
          );

          if (!isValidSpend) {
            logger.warn(
              `Trigger transaction ${tx.txid} is not spending from commitment ${tx.commitmentTxid} for vault ${notification.vaultId}. Skipping notification.`,
            );
            continue; // Skip this notification if commitment verification fails
          }
        }

        const firstDetectionTimestamp = Math.floor(Date.now() / 1000);

        db.prepare(
          "UPDATE notifications SET firstAttemptAt = ?, lastAttemptAt = ?, attemptCount = 1 WHERE vaultId = ? AND pushToken = ?",
        ).run(
          firstDetectionTimestamp,
          firstDetectionTimestamp,
          notification.vaultId,
          notification.pushToken,
        );
        notification.firstAttemptAt = firstDetectionTimestamp;
        notification.attemptCount = 1;
      } else {
        // Increment attempt count
        db.prepare(
          "UPDATE notifications SET lastAttemptAt = strftime('%s','now'), attemptCount = attemptCount + 1 WHERE vaultId = ? AND pushToken = ?",
        ).run(notification.vaultId, notification.pushToken);
        notification.attemptCount += 1;
      }

      // Get user's locale (default to 'en' if not set)
      const locale = notification.locale || "en";

      // Get notification title
      const title = getMessage(locale, "vaultAccessTitle", {});

      // Format time since first detection with appropriate prefix/suffix
      const isFirstNotification = notification.attemptCount === 1;
      const timeSince = formatTimeSince(
        notification.firstAttemptAt * 1000,
        locale,
        isFirstNotification,
      );

      // Get notification body
      const body = getMessage(locale, "vaultAccessBody", {
        vaultNumber: notification.vaultNumber,
        walletName: notification.walletName,
        timeSince: timeSince,
      });

      // Send notification
      const success = await sendPushNotification({
        to: notification.pushToken,
        title: title,
        body: body,
        data: {
          vaultId: notification.vaultId,
          walletId: notification.walletId,
          walletName: notification.walletName,
          vaultNumber: notification.vaultNumber,
          watchtowerId: notification.watchtowerId, // Client-provided unique ID for the watchtower instance
          txid: notification.txid,
          attemptCount: notification.attemptCount,
          firstDetectedAt: notification.firstAttemptAt,
          networkId,
        },
      });

      if (success) {
        logger.info(
          `Notification sent for vault ${notification.vaultId} to device ${notification.pushToken} (tx status: ${notification.status}, attempt: ${notification.attemptCount}, locale: ${locale} [normalized from: ${notification.locale}])`,
          {
            walletId: notification.walletId,
            walletName: notification.walletName,
            vaultNumber: notification.vaultNumber,
            watchtowerId: notification.watchtowerId,
          },
        );
      } else {
        logger.error(
          `Failed to send push notification for vault ${notification.vaultId}. Will retry in next cycle.`,
          { pushToken: notification.pushToken },
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
    const state = db
      .prepare("SELECT last_checked_height FROM network_state WHERE id = 1")
      .get() as
      | {
          last_checked_height: number | null;
        }
      | undefined;

    const lastCheckedHeight = state?.last_checked_height || 0;
    const currentHeight = parseInt(
      await apiCallWithRetry(() => getLatestBlockHeight(networkId), networkId),
      10,
    );

    if (!lastCheckedHeight) {
      logger.info(`First run for ${networkId}`);

      // Check if there are any vault_txids with status other than 'unchecked'
      const nonUncheckedTxs = db
        .prepare(
          `
    SELECT COUNT(*) as count 
    FROM vault_txids 
    WHERE status != 'unchecked'
  `,
        )
        .get() as { count: number } | undefined;

      if (nonUncheckedTxs && nonUncheckedTxs.count > 0) {
        throw new Error(
          `First run for ${networkId} but found ${nonUncheckedTxs.count} transactions with status other than 'unchecked'. Database may be corrupted.`,
        );
      }
    }
    // Check all unchecked transactions directly
    const uncheckedTxs = db
      .prepare(
        `
        SELECT vaultId, txid 
        FROM vault_txids
        WHERE status = 'unchecked'
      `,
      )
      .all() as Array<{ vaultId: string; txid: string }>;

    if (uncheckedTxs.length) {
      logger.info(
        `Checking status of ${uncheckedTxs.length} unchecked transactions on ${networkId} network`,
      );
    }
    const mempoolTxids = await apiCallWithRetry(
      () => getMempoolTxids(networkId),
      networkId,
    );
    for (const tx of uncheckedTxs) {
      const txStatus = await apiCallWithRetry(
        () => getTxStatus(tx.txid, networkId),
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
        db.prepare("UPDATE vault_txids SET status = ? WHERE txid = ?").run(
          status,
          tx.txid,
        );
      } else {
        //not seen yet
        db.prepare("UPDATE vault_txids SET status = ? WHERE txid = ?").run(
          "unseen",
          tx.txid,
        );
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
          networkId,
        );

        // Get block transactions (from cache if available)
        const blockTxids = await getBlockTxidsWithCache(blockHash, networkId);
        scannedBlockTxids.push(...blockTxids);

        // Get all transactions that need checking
        const txsToCheck = db
          .prepare(
            `
          SELECT txid, status, vaultId, commitmentTxid
          FROM vault_txids
          WHERE status = 'unseen' OR status = 'reversible'
        `,
          )
          .all() as Array<{
          txid: string;
          status: string;
          vaultId: string;
          commitmentTxid: string | null;
        }>;

        // Check each transaction
        for (const tx of txsToCheck) {
          if (blockTxids.includes(tx.txid)) {
            // Transaction found in this block
            const confirmations = currentHeight - height + 1;
            const status =
              confirmations >= IRREVERSIBLE_THRESHOLD
                ? "irreversible"
                : "reversible";

            db.prepare("UPDATE vault_txids SET status = ? WHERE txid = ?").run(
              status,
              tx.txid,
            );
          } else if (mempoolTxids.includes(tx.txid) && tx.status === "unseen") {
            // Transaction is in mempool
            db.prepare("UPDATE vault_txids SET status = ? WHERE txid = ?").run(
              "reversible",
              tx.txid,
            );
          }
        }
      }

      // This section handles transaction disappearance detection
      // A transaction can disappear due to:
      // 1. Blockchain reorganization (reorg) - when a chain of blocks is
      //    replaced by a longer chain
      // 2. Mempool purge - when a transaction is evicted from the mempool due
      //    to low fees, conflicts, or timeout
      const txsToCheck = db
        .prepare(
          `
          SELECT txid, status
          FROM vault_txids
          WHERE status = 'reversible'
        `,
        )
        .all() as Array<{
        txid: string;
        status: string;
        vaultId: string;
        commitmentTxid: string | null;
      }>;
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
          db.prepare("UPDATE vault_txids SET status = ? WHERE txid = ?").run(
            "unseen",
            tx.txid,
          );

          // Reset notifications for this transaction's vaultId
          // so they can be sent again if the transaction reappears
          db.prepare(
            `
            UPDATE notifications 
            SET firstAttemptAt = NULL, 
                lastAttemptAt = NULL, attemptCount = 0
            WHERE vaultId IN (
              SELECT vaultId FROM vault_txids WHERE txid = ?
            )
          `,
          ).run(tx.txid);

          logger.warn(
            `Reset notifications for txid ${tx.txid} due to transaction disappearance (reorg or mempool purge)`,
          );
        }
    }
    // Send notifications for triggered vaults
    await sendNotifications(networkId);

    db.prepare(
      "INSERT OR REPLACE INTO network_state (id, last_checked_height) VALUES (1, ?)",
    ).run(currentHeight);

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
