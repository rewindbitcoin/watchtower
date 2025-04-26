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

import { createLogger } from "./logger";

const logger = createLogger("blockchain");

// Functions to interact with the blockchain endpoints using fetch()

// Base URLs for different networks
const API_BASE_URLS = {
  bitcoin: "https://blockstream.info/api",
  //testnet: "https://blockstream.info/testnet/api",
  testnet: "https://mempool.space/testnet/api",
  tape: "https://tape.rewindbitcoin.com/api",
  regtest: "", // This will be set dynamically
};

// Default timeout for API requests (in milliseconds)
const DEFAULT_TIMEOUT = 30000; // 30 seconds

// Function to set custom API URL for regtest
export function setRegtestApiUrl(url: string): void {
  API_BASE_URLS.regtest = url;
}

/**
 * Performs a fetch request with timeout
 * @param url The URL to fetch
 * @param options Fetch options
 * @param timeout Timeout in milliseconds
 * @returns Promise with the fetch response
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = DEFAULT_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getLatestBlockHeight(
  network: string = "bitcoin",
): Promise<string> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  try {
    const response = await fetchWithTimeout(`${baseUrl}/blocks/tip/height`);
    if (!response.ok)
      throw new Error(
        `Failed to fetch latest block height: ${response.statusText}`,
      );
    return response.text();
  } catch (error) {
    logger.error(`Error fetching latest block height for ${network}`, error);
    throw error;
  }
}

export async function getBlockHashByHeight(
  height: number,
  network: string = "bitcoin",
): Promise<string> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/block-height/${height}`,
    );
    if (!response.ok)
      throw new Error(
        `Failed to fetch block hash for height ${height} on network ${network}: ${response.statusText}`,
      );
    return response.text();
  } catch (error) {
    logger.error(
      `Error fetching block hash for height ${height} on ${network}`,
      error,
    );
    throw error;
  }
}

export async function getBlockTxids(
  blockHash: string,
  network: string = "bitcoin",
): Promise<string[]> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/block/${blockHash}/txids`,
    );
    if (!response.ok)
      throw new Error(
        `Failed to fetch txids for block: ${response.statusText}`,
      );
    return response.json();
  } catch (error) {
    logger.error(
      `Error fetching txids for block ${blockHash} on ${network}`,
      error,
    );
    throw error;
  }
}

export async function getMempoolTxids(
  network: string = "bitcoin",
): Promise<string[]> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  try {
    const response = await fetchWithTimeout(`${baseUrl}/mempool/txids`);
    if (!response.ok)
      throw new Error(`Failed to fetch mempool txids: ${response.statusText}`);
    return response.json();
  } catch (error) {
    logger.error(`Error fetching mempool txids for ${network}`, error);
    throw error;
  }
}

// Check transaction status
export async function getTxStatus(txid: string, network: string = "bitcoin") {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  try {
    const response = await fetchWithTimeout(`${baseUrl}/tx/${txid}/status`);
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Failed to get tx status for ${txid}: ${response.statusText}`,
      );
    }
    if (response.status === 404) {
      return null; // Transaction not found
    }
    return response.json();
  } catch (error) {
    logger.error(`Error fetching tx status for ${txid} on ${network}`, error);
    throw error;
  }
}

/**
 * Get transaction details including inputs and outputs
 * @param txid Transaction ID
 * @param network Network identifier
 * @returns Transaction details
 */
async function getTransaction(txid: string, network: string = "bitcoin") {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  try {
    const response = await fetchWithTimeout(`${baseUrl}/tx/${txid}`);
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Failed to get tx details for ${txid}: ${response.statusText}`,
      );
    }
    if (response.status === 404) {
      return null; // Transaction not found
    }
    return response.json();
  } catch (error) {
    logger.error(`Error fetching tx details for ${txid} on ${network}`, error);
    throw error;
  }
}

/**
 * Verify that a trigger transaction is spending from the commitment
 * @param triggerTxid The transaction ID of the trigger
 * @param commitmentTxid The transaction ID of the commitment
 * @param networkId Network identifier
 * @returns True if the trigger is spending from the commitment, false otherwise
 */
export async function verifyTriggerSpendingCommitment(
  triggerTxid: string,
  commitmentTxid: string,
  networkId: string,
): Promise<boolean> {
  try {
    logger.info(
      `Verifying trigger ${triggerTxid} is spending from commitment ${commitmentTxid} on ${networkId}`,
    );

    // Get the trigger transaction details
    const triggerTx = await getTransaction(triggerTxid, networkId);

    if (!triggerTx) {
      logger.warn(
        `Trigger transaction ${triggerTxid} not found on ${networkId}`,
      );
      return false;
    }

    // Check if any of the inputs are spending from the commitment transaction
    const isSpendingFromCommitment = triggerTx.vin.some(
      (input: { txid: string }) => {
        return input.txid === commitmentTxid;
      },
    );

    if (isSpendingFromCommitment) {
      logger.info(
        `Verified: Trigger ${triggerTxid} is spending from commitment ${commitmentTxid}`,
      );
    } else {
      logger.warn(
        `Trigger ${triggerTxid} is NOT spending from commitment ${commitmentTxid}`,
      );
    }

    return isSpendingFromCommitment;
  } catch (error) {
    logger.error(`Error verifying trigger spending from commitment:`, error);
    return false;
  }
}
