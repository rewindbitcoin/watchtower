// Functions to interact with the blockchain endpoints using fetch()

// Base URLs for different networks
const API_BASE_URLS = {
  bitcoin: 'https://blockstream.info/api',
  testnet: 'https://blockstream.info/testnet/api',
  tape: 'https://tape.rewindbitcoin.com/api',
  regtest: '' // This will be set dynamically
};

// Function to set custom API URL for regtest
export function setRegtestApiUrl(url: string): void {
  if (!url.endsWith('/')) {
    url = url + '/';
  }
  if (!url.endsWith('api/')) {
    url = url.endsWith('api') ? url + '/' : url + 'api/';
  }
  API_BASE_URLS.regtest = url;
}

export async function getLatestBlockHeight(network: string = 'bitcoin'): Promise<string> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  const response = await fetch(`${baseUrl}/blocks/tip/height`);
  if (!response.ok) throw new Error(`Failed to fetch latest block height: ${response.statusText}`);
  return response.text();
}

export async function getBlockHashByHeight(height: number, network: string = 'bitcoin'): Promise<string> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  const response = await fetch(`${baseUrl}/block-height/${height}`);
  if (!response.ok) throw new Error(`Failed to fetch block hash: ${response.statusText}`);
  return response.text();
}

export async function getBlockTxids(blockHash: string, network: string = 'bitcoin'): Promise<string[]> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  const response = await fetch(`${baseUrl}/block/${blockHash}/txids`);
  if (!response.ok) throw new Error(`Failed to fetch txids for block: ${response.statusText}`);
  return response.json();
}

export async function getMempoolTxids(network: string = 'bitcoin'): Promise<string[]> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  const response = await fetch(`${baseUrl}/mempool/txids`);
  if (!response.ok) throw new Error(`Failed to fetch mempool txids: ${response.statusText}`);
  return response.json();
}

// Check transaction status
export async function getTxStatus(txid: string, network: string = 'bitcoin'): Promise<any> {
  const baseUrl = API_BASE_URLS[network as keyof typeof API_BASE_URLS];
  const response = await fetch(`${baseUrl}/tx/${txid}/status`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to get tx status for ${txid}: ${response.statusText}`);
  }
  if (response.status === 404) {
    return null; // Transaction not found
  }
  return response.json();
}
