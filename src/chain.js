// The ProofStreamRegistry connection used by the anchoring job. Configured with:
//   ANCHOR_PRIVATE_KEY (secret) - a wallet holding only ISSUER_ROLE, never the admin key
//   REGISTRY_ADDRESS, CHAIN_ID, CHAIN_RPC_URL (vars)
// Missing settings turn anchoring off rather than failing requests.
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const SPLIT = { type: 'tuple[]', components: [
  { name: 'beneficiaryHash', type: 'bytes32' },
  { name: 'basisPoints', type: 'uint16' },
  { name: 'rightType', type: 'bytes32' },
  { name: 'territory', type: 'bytes32' },
] };

export const REGISTRY_ABI = [
  { type: 'function', name: 'registerRecording', stateMutability: 'nonpayable', outputs: [{ type: 'bytes32' }], inputs: [
    { name: 'isrc', type: 'string' }, { name: 'claimant', type: 'address' }, { name: 'payloadHash', type: 'bytes32' },
    { name: 'claimHash', type: 'bytes32' }, { name: 'splits', ...SPLIT }, { name: 'parentIsrc', type: 'string' },
  ] },
  { type: 'function', name: 'updateClaim', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'isrc', type: 'string' }, { name: 'payloadHash', type: 'bytes32' }, { name: 'claimHash', type: 'bytes32' },
    { name: 'splits', ...SPLIT }, { name: 'reason', type: 'bytes32' },
  ] },
  { type: 'function', name: 'transferRights', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'isrc', type: 'string' }, { name: 'newClaimant', type: 'address' }, { name: 'transferHash', type: 'bytes32' },
  ] },
  { type: 'function', name: 'verify', stateMutability: 'view', inputs: [{ name: 'isrc', type: 'string' }], outputs: [
    { name: 'found', type: 'bool' }, { name: 'status', type: 'uint8' }, { name: 'payloadHash', type: 'bytes32' },
    { name: 'claimHash', type: 'bytes32' }, { name: 'claimant', type: 'address' }, { name: 'anchoredAt', type: 'uint64' },
    { name: 'version', type: 'uint256' }, { name: 'blockNumber', type: 'uint256' },
  ] },
];

export function chainFromEnv(env) {
  const { ANCHOR_PRIVATE_KEY: key, REGISTRY_ADDRESS: address, CHAIN_RPC_URL: rpc } = env;
  const chainId = Number(env.CHAIN_ID);
  if (!key || !address || !rpc || !Number.isInteger(chainId) || chainId <= 0) return null;
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const transport = http(rpc, { timeout: 20_000 });
  const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);
  const reader = createPublicClient({ chain, transport });
  const writer = createWalletClient({ chain, transport, account });
  const write = (functionName, args) => writer.writeContract({ address, abi: REGISTRY_ABI, functionName, args });
  const receiptOf = r => ({ status: r.status, blockNumber: Number(r.blockNumber) });

  return {
    chainId,
    address,
    signer: account.address,
    async read(isrc) {
      const [found, status, payloadHash, , claimant] = await reader.readContract({ address, abi: REGISTRY_ABI, functionName: 'verify', args: [isrc] });
      return { found, status: Number(status), payloadHash, claimant };
    },
    register: a => write('registerRecording', [a.isrc, a.claimant, a.payloadHash, a.claimHash, a.splits, a.parentIsrc]),
    update: a => write('updateClaim', [a.isrc, a.payloadHash, a.claimHash, a.splits, a.reason]),
    transfer: a => write('transferRights', [a.isrc, a.newClaimant, a.transferHash]),
    async wait(hash, timeout) {
      try { return receiptOf(await reader.waitForTransactionReceipt({ hash, timeout })); } catch { return null; }
    },
    async receipt(hash) {
      try { return receiptOf(await reader.getTransactionReceipt({ hash })); } catch { return null; }
    },
  };
}
