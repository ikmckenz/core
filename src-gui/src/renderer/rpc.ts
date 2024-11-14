import { invoke as invokeUnsafe } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BalanceArgs,
  BalanceResponse,
  BuyXmrArgs,
  BuyXmrResponse,
  TauriLogEvent,
  GetLogsArgs,
  GetLogsResponse,
  GetSwapInfoResponse,
  ListSellersArgs,
  MoneroRecoveryArgs,
  ResumeSwapArgs,
  ResumeSwapResponse,
  SuspendCurrentSwapResponse,
  TauriContextStatusEvent,
  TauriSwapProgressEventWrapper,
  WithdrawBtcArgs,
  WithdrawBtcResponse,
  TauriDatabaseStateEvent,
  TauriTimelockChangeEvent,
  GetSwapInfoArgs,
  ExportBitcoinWalletResponse,
  CheckMoneroNodeArgs,
  CheckMoneroNodeResponse,
  TauriSettings,
  CheckElectrumNodeArgs,
  CheckElectrumNodeResponse,
  GetMoneroAddressesResponse,
  TauriBackgroundRefundEvent,
} from "models/tauriModel";
import {
  contextStatusEventReceived,
  receivedCliLog,
  rpcSetBackgroundRefundState,
  rpcSetBalance,
  rpcSetSwapInfo,
  timelockChangeEventReceived,
} from "store/features/rpcSlice";
import { swapProgressEventReceived } from "store/features/swapSlice";
import { store } from "./store/storeRenderer";
import { Provider } from "models/apiModel";
import { providerToConcatenatedMultiAddr } from "utils/multiAddrUtils";
import { MoneroRecoveryResponse } from "models/rpcModel";
import { ListSellersResponse } from "../models/tauriModel";
import logger from "utils/logger";
import { getNetwork, getNetworkName, isTestnet } from "store/config";
import { Blockchain, Network } from "store/features/settingsSlice";
import { setStatus } from "store/features/nodesSlice";
import { discoveredProvidersByRendezvous } from "store/features/providersSlice";

export const PRESET_RENDEZVOUS_POINTS = [
  "/dns4/discover.unstoppableswap.net/tcp/8888/p2p/12D3KooWA6cnqJpVnreBVnoro8midDL9Lpzmg8oJPoAGi7YYaamE",
];

export async function fetchSellersAtPresetRendezvousPoints() {
  await Promise.all(PRESET_RENDEZVOUS_POINTS.map(async (rendezvousPoint) => {
    const response = await listSellersAtRendezvousPoint(rendezvousPoint);
    store.dispatch(discoveredProvidersByRendezvous(response.sellers));

    console.log(`Discovered ${response.sellers.length} sellers at rendezvous point ${rendezvousPoint} during startup fetch`);
  }),
  );
}

export async function initEventListeners() {
  // This operation is in-expensive
  // We do this in case we miss the context init progress event because the frontend took too long to load
  // TOOD: Replace this with a more reliable mechanism (such as an event replay mechanism)
  if (await checkContextAvailability()) {
    store.dispatch(contextStatusEventReceived({ type: "Available" }));
  } else {
    // Warning: If we reload the page while the Context is being initialized, this function will throw an error
    initializeContext().catch((e) => {
      logger.error(e, "Failed to initialize context on page load. This might be because we reloaded the page while the context was being initialized");
      // Wait a short time before retrying
      setTimeout(() => {
        initializeContext().catch((e) => {
          logger.error(e, "Failed to initialize context even after retry");
        });
      }, 2000); // 2 second delay
    });
  }

  listen<TauriSwapProgressEventWrapper>("swap-progress-update", (event) => {
    console.log("Received swap progress event", event.payload);
    store.dispatch(swapProgressEventReceived(event.payload));
  });

  listen<TauriContextStatusEvent>("context-init-progress-update", (event) => {
    console.log("Received context init progress event", event.payload);
    store.dispatch(contextStatusEventReceived(event.payload));
  });

  listen<TauriLogEvent>("cli-log-emitted", (event) => {
    console.log("Received cli log event", event.payload);
    store.dispatch(receivedCliLog(event.payload));
  });

  listen<BalanceResponse>("balance-change", (event) => {
    console.log("Received balance change event", event.payload);
    store.dispatch(rpcSetBalance(event.payload.balance));
  });

  listen<TauriDatabaseStateEvent>("swap-database-state-update", (event) => {
    console.log("Received swap database state update event", event.payload);
    getSwapInfo(event.payload.swap_id);

    // This is ugly but it's the best we can do for now
    // Sometimes we are too quick to fetch the swap info and the new state is not yet reflected
    // in the database. So we wait a bit before fetching the new state
    setTimeout(() => getSwapInfo(event.payload.swap_id), 3000);
  });

  listen<TauriTimelockChangeEvent>('timelock-change', (event) => {
    console.log('Received timelock change event', event.payload);
    store.dispatch(timelockChangeEventReceived(event.payload));
  })

  listen<TauriBackgroundRefundEvent>('background-refund', (event) => {
    console.log('Received background refund event', event.payload);
    store.dispatch(rpcSetBackgroundRefundState(event.payload));
  })
}

async function invoke<ARGS, RESPONSE>(
  command: string,
  args: ARGS,
): Promise<RESPONSE> {
  return invokeUnsafe(command, {
    args: args as Record<string, unknown>,
  }) as Promise<RESPONSE>;
}

async function invokeNoArgs<RESPONSE>(command: string): Promise<RESPONSE> {
  return invokeUnsafe(command) as Promise<RESPONSE>;
}

export async function checkBitcoinBalance() {
  const response = await invoke<BalanceArgs, BalanceResponse>("get_balance", {
    force_refresh: true,
  });

  store.dispatch(rpcSetBalance(response.balance));
}

export async function getAllSwapInfos() {
  const response =
    await invokeNoArgs<GetSwapInfoResponse[]>("get_swap_infos_all");

  response.forEach((swapInfo) => {
    store.dispatch(rpcSetSwapInfo(swapInfo));
  });
}

export async function getSwapInfo(swapId: string) {
  const response = await invoke<GetSwapInfoArgs, GetSwapInfoResponse>(
    "get_swap_info",
    {
      swap_id: swapId,
    },
  );

  store.dispatch(rpcSetSwapInfo(response));
}

export async function withdrawBtc(address: string): Promise<string> {
  const response = await invoke<WithdrawBtcArgs, WithdrawBtcResponse>(
    "withdraw_btc",
    {
      address,
      amount: null,
    },
  );

  return response.txid;
}

export async function buyXmr(
  seller: Provider,
  bitcoin_change_address: string | null,
  monero_receive_address: string,
) {
  await invoke<BuyXmrArgs, BuyXmrResponse>(
    "buy_xmr",
    bitcoin_change_address == null
      ? {
        seller: providerToConcatenatedMultiAddr(seller),
        monero_receive_address,
      }
      : {
        seller: providerToConcatenatedMultiAddr(seller),
        monero_receive_address,
        bitcoin_change_address,
      },
  );
}

export async function resumeSwap(swapId: string) {
  await invoke<ResumeSwapArgs, ResumeSwapResponse>("resume_swap", {
    swap_id: swapId,
  });
}

export async function suspendCurrentSwap() {
  await invokeNoArgs<SuspendCurrentSwapResponse>("suspend_current_swap");
}

export async function getMoneroRecoveryKeys(
  swapId: string,
): Promise<MoneroRecoveryResponse> {
  return await invoke<MoneroRecoveryArgs, MoneroRecoveryResponse>(
    "monero_recovery",
    {
      swap_id: swapId,
    },
  );
}

export async function checkContextAvailability(): Promise<boolean> {
  const available = await invokeNoArgs<boolean>("is_context_available");
  return available;
}

export async function getLogsOfSwap(
  swapId: string,
  redact: boolean,
): Promise<GetLogsResponse> {
  return await invoke<GetLogsArgs, GetLogsResponse>("get_logs", {
    swap_id: swapId,
    redact,
  });
}

export async function listSellersAtRendezvousPoint(
  rendezvousPointAddress: string,
): Promise<ListSellersResponse> {
  return await invoke<ListSellersArgs, ListSellersResponse>("list_sellers", {
    rendezvous_point: rendezvousPointAddress,
  });
}

export async function initializeContext() {
  const network = getNetwork();
  const testnet = isTestnet();

  // This looks convoluted but it does the following:
  // - Fetch the status of all nodes for each blockchain in parallel
  // - Return the first available node for each blockchain
  // - If no node is available for a blockchain, return null for that blockchain
  const [bitcoinNode, moneroNode] = await Promise.all([Blockchain.Bitcoin, Blockchain.Monero].map(async (blockchain) => {
    const nodes = store.getState().settings.nodes[network][blockchain];

    if (nodes.length === 0) {
      return null;
    }

    try {
      return await Promise.any(nodes.map(async node => {
        const isAvailable = await getNodeStatus(node, blockchain, network);

        if (isAvailable) {
          return node;
        }

        throw new Error(`No available ${blockchain} node found`);
      }));
    } catch {
      return null;
    }
  }),
  );


  // Initialize Tauri settings with null values
  const tauriSettings: TauriSettings = {
    electrum_rpc_url: bitcoinNode,
    monero_node_url: moneroNode,
  };

  console.log("Initializing context with settings", tauriSettings);

  await invokeUnsafe<void>("initialize_context", {
    settings: tauriSettings,
    testnet,
  });
}

export async function getWalletDescriptor() {
  return await invokeNoArgs<ExportBitcoinWalletResponse>("get_wallet_descriptor");
}

export async function getMoneroNodeStatus(node: string, network: Network): Promise<boolean> {
  const response = await invoke<CheckMoneroNodeArgs, CheckMoneroNodeResponse>("check_monero_node", {
    url: node,
    network,
  });

  return response.available;
}

export async function getElectrumNodeStatus(url: string): Promise<boolean> {
  const response = await invoke<CheckElectrumNodeArgs, CheckElectrumNodeResponse>("check_electrum_node", {
    url,
  });

  return response.available;
}

export async function getNodeStatus(url: string, blockchain: Blockchain, network: Network): Promise<boolean> {
  switch (blockchain) {
    case Blockchain.Monero: return await getMoneroNodeStatus(url, network);
    case Blockchain.Bitcoin: return await getElectrumNodeStatus(url);
    default: throw new Error(`Unsupported blockchain: ${blockchain}`);
  }
}

async function updateNodeStatus(node: string, blockchain: Blockchain, network: Network) {
  const status = await getNodeStatus(node, blockchain, network);

  store.dispatch(setStatus({ node, status, blockchain }));
}

export async function updateAllNodeStatuses() {
  const network = getNetwork();
  const settings = store.getState().settings;

  // For all nodes, check if they are available and store the new status (in parallel)
  await Promise.all(
    Object.values(Blockchain).flatMap(blockchain =>
      settings.nodes[network][blockchain].map(node => updateNodeStatus(node, blockchain, network))
    )
  );
}

export async function getMoneroAddresses(): Promise<GetMoneroAddressesResponse> {
  return await invokeNoArgs<GetMoneroAddressesResponse>("get_monero_addresses");
}
