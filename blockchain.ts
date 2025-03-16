// Example functions to interact with the blockchain endpoints using fetch()

export async function getLatestBlockHeight(): Promise<string> {
  const response = await fetch('https://blockstream.info/api/blocks/tip/height');
  if (!response.ok) throw new Error(`Failed to fetch latest block height: ${response.statusText}`);
  return response.text();
}

export async function getBlockHashByHeight(height: number): Promise<string> {
  const response = await fetch(`https://blockstream.info/api/block-height/${height}`);
  if (!response.ok) throw new Error(`Failed to fetch block hash: ${response.statusText}`);
  return response.text();
}

export async function getBlockTxids(blockHash: string): Promise<string[]> {
  const response = await fetch(`https://blockstream.info/api/block/${blockHash}/txids`);
  if (!response.ok) throw new Error(`Failed to fetch txids for block: ${response.statusText}`);
  return response.json();
}

export async function getMempoolTxids(): Promise<string[]> {
  const response = await fetch('https://blockstream.info/api/mempool/txids');
  if (!response.ok) throw new Error(`Failed to fetch mempool txids: ${response.statusText}`);
  return response.json();
}

// Additional functions to check tx status can be added following your specifications.
