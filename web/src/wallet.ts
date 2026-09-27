import { isAddress, type Address, type EIP1193Provider } from "viem";
import { isUnknownChain } from "./domain";
import type { Deployment } from "./config";

export interface WalletProvider extends EIP1193Provider {
  providers?: WalletProvider[];
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}
declare global {
  interface Window {
    ethereum?: WalletProvider;
  }
}
export function browserWallet() {
  return window.ethereum?.providers?.[0] ?? window.ethereum;
}
export async function switchNetwork(provider: WalletProvider, d: Deployment) {
  const chainId = d.walletAddChain.chainId;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (e) {
    if (!isUnknownChain(e)) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [d.walletAddChain],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  }
  return Number(await provider.request({ method: "eth_chainId" }));
}
export async function assertWallet(
  provider: WalletProvider,
  d: Deployment,
  account: Address,
) {
  const chain = Number(await provider.request({ method: "eth_chainId" }));
  const accounts = await provider.request({ method: "eth_accounts" });
  if (
    chain !== d.chainId ||
    !accounts[0] ||
    !isAddress(accounts[0]) ||
    accounts[0].toLowerCase() !== account.toLowerCase()
  )
    throw Error(
      "Your wallet account or network changed. Reconnect and review the action again.",
    );
}
