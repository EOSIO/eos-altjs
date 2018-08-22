// copyright defined in eosjs2/LICENSE.txt

'use strict';

import { Abi, GetInfoResult, JsonRpc, PushTransactionArgs, TransactionConfig, GetAbiResult } from './eosjs2-jsonrpc';
import * as ser from './eosjs2-serialize';
import { base64ToBinary } from './eosjs2-numeric';
const abiAbi = require('../src/abi.abi.json');
const transactionAbi = require('../src/transaction.abi.json');

export const serialize = ser;

export interface AuthorityProviderArgs {
  transaction: any;
  availableKeys: string[];
}

export interface AuthorityProvider {
  getRequiredKeys: (args: AuthorityProviderArgs) => Promise<string[]>;
}

export interface SignatureProviderArgs {
  chainId: string;
  requiredKeys: string[];
  serializedTransaction: Uint8Array;
  abis: GetAbiResult[];
}

export interface SignatureProvider {
  getAvailableKeys: () => Promise<string[]>;
  sign: (args: SignatureProviderArgs) => Promise<string[]>;
}

export interface CachedAbi {
  rawAbi: Uint8Array;
  abi: Abi;
  codeHash: string;
}

export class Api {
  rpc: JsonRpc;
  authorityProvider: AuthorityProvider;
  signatureProvider: SignatureProvider;
  chainId: string;
  textEncoder: TextEncoder;
  textDecoder: TextDecoder;

  abiTypes: Map<string, ser.Type>;
  transactionTypes: Map<string, ser.Type>;
  contracts = new Map<string, ser.Contract>();
  cachedAbis = new Map<string, CachedAbi>();

  constructor(args: {
    rpc: JsonRpc, authorityProvider?: AuthorityProvider,
    signatureProvider: SignatureProvider,
    chainId: string,
    textEncoder?: TextEncoder,
    textDecoder?: TextDecoder,
  }) {
    this.rpc = args.rpc;
    this.authorityProvider = args.authorityProvider || args.rpc;
    this.signatureProvider = args.signatureProvider;
    this.chainId = args.chainId;
    this.textEncoder = args.textEncoder
    this.textDecoder = args.textDecoder

    this.abiTypes = ser.getTypesFromAbi(ser.createInitialTypes(), abiAbi);
    this.transactionTypes = ser.getTypesFromAbi(ser.createInitialTypes(), transactionAbi);
  }

  async getCachedAbi(accountName: string, reload = false): Promise<CachedAbi> {
    if (!reload && this.cachedAbis.get(accountName))
      return this.cachedAbis.get(accountName);
    let cachedAbi: CachedAbi;
    try {
      let rawResult = await this.rpc.get_raw_abi(accountName);
      let rawAbi = base64ToBinary(rawResult.abi);
      const buffer = new ser.SerialBuffer({ textEncoder: this.textEncoder, textDecoder: this.textDecoder, array: rawAbi });
      let abi = this.abiTypes.get('abi_def').deserialize(buffer);
      cachedAbi = { rawAbi, abi, codeHash: rawResult.code_hash };
    } catch (e) {
      e.message = `fetching abi for ${accountName}: ${e.message}`;
      throw e;
    }
    if (!cachedAbi)
      throw new Error(`Missing abi for ${accountName}`);
    this.cachedAbis.set(accountName, cachedAbi);
    return cachedAbi;
  }

  async getAbi(accountName: string, reload = false): Promise<Abi> {
    return (await this.getCachedAbi(accountName, reload)).abi;
  }

  async getTransactionAbis(transaction: any, reload = false): Promise<GetAbiResult[]> {
    const accounts: string[] = transaction.actions.map((action: ser.Action): string => action.account);
    const uniqueAccounts: Set<string> = new Set(accounts);
    const actionPromises: Promise<GetAbiResult>[] = [...uniqueAccounts]
      .map(async (account: string): Promise<GetAbiResult> => ({ account_name: account, abi: await this.getAbi(account, reload) }));
    return Promise.all(actionPromises);
  }

  async getContract(accountName: string, reload = false): Promise<ser.Contract> {
    if (!reload && this.contracts.get(accountName))
      return this.contracts.get(accountName);
    const abi = await this.getAbi(accountName, reload);
    let types = ser.getTypesFromAbi(ser.createInitialTypes(), abi);
    let actions = new Map<string, ser.Type>();
    for (let { name, type } of abi.actions)
      actions.set(name, ser.getType(types, type));
    let result = { types, actions };
    this.contracts.set(accountName, result);
    return result;
  }

  serialize(buffer: ser.SerialBuffer, type: string, value: any): void {
    this.transactionTypes.get(type).serialize(buffer, value);
  }

  deserialize(buffer: ser.SerialBuffer, type: string): any {
    return this.transactionTypes.get(type).deserialize(buffer);
  }

  serializeTransaction(transaction: any): Uint8Array {
    let buffer = new ser.SerialBuffer({ textEncoder: this.textEncoder, textDecoder: this.textDecoder });
    this.serialize(buffer, 'transaction', {
      max_net_usage_words: 0,
      max_cpu_usage_ms: 0,
      delay_sec: 0,
      context_free_actions: [],
      actions: [],
      transaction_extensions: [],
      ...transaction,
    });
    return buffer.asUint8Array();
  }

  deserializeTransaction(transaction: Uint8Array): any {
    const buffer = new ser.SerialBuffer({ textEncoder: this.textEncoder, textDecoder: this.textDecoder });
    buffer.pushArray(transaction)
    return this.deserialize(buffer, 'transaction');
  }

  async serializeActions(actions: ser.Action[]): Promise<ser.SerializedAction[]> {
    return await Promise.all(actions.map(async ({ account, name, authorization, data }) => {
      const contract = await this.getContract(account)
      return ser.serializeAction(contract, account, name, authorization, data, this.textEncoder, this.textDecoder);
    }));
  }

  async deserializeActions(actions: ser.Action[]): Promise<ser.Action[]> {
    return await Promise.all(actions.map(async ({ account, name, authorization, data }) => {
      const contract = await this.getContract(account)
      return ser.deserializeAction(contract, account, name, authorization, data, this.textEncoder, this.textDecoder);
    }));
  }

  async deserializeTransactionWithActions(transaction: Uint8Array | string): Promise<any> {
    if (typeof transaction === "string") {
      transaction = ser.hexToUint8Array(transaction)
    }
    let deserializedTransaction = this.deserializeTransaction(transaction)
    const deserializedActions = await this.deserializeActions(deserializedTransaction.actions)
    return { ...deserializedTransaction, actions: deserializedActions }
  }

  // eventually break out into TransactionValidator class
  private hasRequiredTaposFields({ expiration, ref_block_num, ref_block_prefix, ...transaction }: any): boolean {
    return !!(expiration && ref_block_num && ref_block_prefix);
  }

  async transact(transaction: any, { broadcast = true, blocksBehind, expireSeconds }: TransactionConfig = {}): Promise<any> {
    let info: GetInfoResult;

    if (!this.chainId) {
      info = await this.rpc.get_info();
      this.chainId = info.chain_id;
    }

    if (typeof blocksBehind === "number" && expireSeconds) { // use config fields to generate TAPOS if they exist
      if (!info) {
        info = await this.rpc.get_info();
      }
      let refBlock = await this.rpc.get_block(info.head_block_num - blocksBehind);
      transaction = { ...ser.transactionHeader(refBlock, expireSeconds), ...transaction };
    }

    if (!this.hasRequiredTaposFields(transaction)) {
      throw new Error("Required configuration or TAPOS fields are not present");
    }

    let abis: GetAbiResult[] = await this.getTransactionAbis(transaction);
    transaction = { ...transaction, actions: await this.serializeActions(transaction.actions) };
    let serializedTransaction = this.serializeTransaction(transaction);
    let availableKeys = await this.signatureProvider.getAvailableKeys();
    let requiredKeys = await this.authorityProvider.getRequiredKeys({ transaction, availableKeys });
    let signatures = await this.signatureProvider.sign({ chainId: this.chainId, requiredKeys, serializedTransaction, abis });
    let pushTransactionArgs = { signatures, serializedTransaction };
    if (broadcast) {
      return this.pushSignedTransaction(pushTransactionArgs);
    }
    return pushTransactionArgs;
  }

  async pushSignedTransaction({ signatures, serializedTransaction }: PushTransactionArgs): Promise<any> {
    return this.rpc.push_transaction({
      signatures,
      serializedTransaction,
    });
  }

} // Api
