import {
  Agent,
  ApiQueryResponse,
  CallRequest,
  Certificate,
  compare,
  CreateCertificateOptions,
  HttpAgent,
  Identity,
  QueryFields,
  QueryResponseStatus,
  ReadStateOptions,
  ReadStateResponse,
  RequestId,
  requestIdOf,
  RequestStatusResponseStatus,
  SignIdentity,
  SubmitRequestType,
  SubmitResponse,
} from "@dfinity/agent";
import { JsonObject } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import {
  DelegationChain,
  DelegationIdentity,
  ECDSAKeyIdentity,
  Ed25519KeyIdentity,
  isDelegationValid,
} from "@dfinity/identity";
import { Buffer } from "buffer";
import { Signer } from "./signer";
import { IdbStorage, SignerAgentStorage } from "./storage";
import { decode } from "./utils/cbor";

const ECDSA_KEY_LABEL = "ECDSA";
const ED25519_KEY_LABEL = "Ed25519";
type DelegationKeyType = typeof ECDSA_KEY_LABEL | typeof ED25519_KEY_LABEL;

export interface SignerAgentOptions {
  /** Signer instance that should be used to send ICRC-25 JSON-RPC messages */
  signer: Pick<Signer, "callCanister" | "getDelegation">;
  /** Principal of account that should be used to make calls */
  getPrincipal: () => Promise<Principal> | Principal;
  /**
   * Optional, used to generate random bytes
   * @default uses browser/node Crypto by default
   */
  crypto?: Pick<Crypto, "getRandomValues">;
  /**
   * Optional, used to fetch root key and make delegated calls,
   * @default uses {@link HttpAgent} by default
   */
  agent?: HttpAgent;
  /**
   * Optional polyfill for BLS verify used in query requests that are upgraded to calls
   */
  blsVerify?: CreateCertificateOptions["blsVerify"];
  /**
   * Optional storage with get, set, and remove.
   * @default uses {@link IdbStorage} by default
   */
  storage?: SignerAgentStorage;
  /**
   * Optional, use delegation for calls where possible
   */
  delegation?: {
    /**
     * Optional identity to use for delegation
     */
    identity?: Pick<SignIdentity, "getPublicKey" | "sign">;
    /**
     * Optional limit delegation targets to specific canisters
     */
    targets?: Principal[];
    /**
     * Key type to use for the default delegation identity
     * @default 'ECDSA'
     * If you are using a custom storage provider that does not support CryptoKey storage,
     * you should use 'Ed25519' as the key type, as it can serialize to a string
     */
    keyType?: DelegationKeyType;
  };
}

export class SignerAgentError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, SignerAgentError.prototype);
  }
}

export class SignerAgent implements Agent {
  private agent: HttpAgent;
  private storage: SignerAgentStorage;
  private readStateResponses = new Map<string, ReadStateResponse>();
  private delegatedRequestIds = new Set<string>();

  constructor(private options: SignerAgentOptions) {
    this.agent = options.agent ?? new HttpAgent();
    this.storage = new IdbStorage();
  }

  public get rootKey() {
    return this.agent.rootKey;
  }

  public async getDelegationIdentity(principal: Principal) {
    if (!this.options.delegation) {
      return;
    }
    const baseIdentity = await this.getDelegationBaseIdentity(principal);
    const delegationChain = await this.getDelegationChain(
      principal,
      baseIdentity.getPublicKey().toDer(),
    );
    if (delegationChain) {
      return DelegationIdentity.fromDelegation(baseIdentity, delegationChain);
    }
  }

  public async call(
    canisterId: Principal | string,
    options: {
      methodName: string;
      arg: ArrayBuffer;
      effectiveCanisterId?: Principal | string;
    },
  ): Promise<SubmitResponse> {
    // Get sender and target canister id
    const sender = await this.options.getPrincipal();
    const target = Principal.from(canisterId);

    // Make delegated call when possible
    if (
      this.options.delegation &&
      (!this.options.delegation.targets ||
        this.options.delegation.targets.some(
          (target) => target.compareTo(target) === "eq",
        ))
    ) {
      const delegationIdentity = await this.getDelegationIdentity(sender);
      if (delegationIdentity) {
        const submitResponse = await this.agent.call(
          target,
          options,
          delegationIdentity,
        );
        this.delegatedRequestIds.add(
          Buffer.from(submitResponse.requestId).toString("base64"),
        );
        return submitResponse;
      }
    }

    // Make call through signer
    const { contentMap, certificate } = await this.options.signer.callCanister({
      canisterId: target,
      sender,
      method: options.methodName,
      arg: options.arg,
    });
    const requestBody = decode<CallRequest>(contentMap);
    if (
      SubmitRequestType.Call !== requestBody.request_type ||
      target.compareTo(requestBody.canister_id) !== "eq" ||
      options.methodName !== requestBody.method_name ||
      compare(options.arg, requestBody.arg) !== 0 ||
      sender.compareTo(Principal.from(requestBody.sender)) !== "eq"
    ) {
      throw new SignerAgentError("Received invalid content map from signer ");
    }
    const requestId = requestIdOf(requestBody);
    this.readStateResponses.set(Buffer.from(requestId).toString("base64"), {
      certificate,
    });
    return {
      requestId,
      response: {
        ok: true,
        status: 200,
        statusText: "Call has been sent over ICRC-25 JSON-RPC",
        body: null,
        headers: [],
      },
    };
  }

  public async fetchRootKey(): Promise<ArrayBuffer> {
    return this.agent.fetchRootKey();
  }

  public async getPrincipal(): Promise<Principal> {
    return this.options.getPrincipal();
  }

  public async query(
    canisterId: Principal | string,
    options: QueryFields,
  ): Promise<ApiQueryResponse> {
    // Get sender and target canister id
    const sender = await this.options.getPrincipal();
    const target = Principal.from(canisterId);

    // Make delegated query when possible
    if (
      this.options.delegation &&
      (!this.options.delegation.targets ||
        this.options.delegation.targets.some(
          (target) => target.compareTo(target) === "eq",
        ))
    ) {
      const delegationIdentity = await this.getDelegationIdentity(sender);
      if (delegationIdentity) {
        return this.agent.query(canisterId, options, delegationIdentity);
      }
    }

    // Upgrade query request to a call sent through signer
    const submitResponse = await this.call(canisterId, options);
    const requestKey = Buffer.from(submitResponse.requestId).toString("base64");
    const readStateResponse = this.readStateResponses.get(requestKey);
    if (!readStateResponse) {
      throw new SignerAgentError("Read state response could not be found");
    }
    this.readStateResponses.delete(requestKey);
    const certificate = await Certificate.create({
      certificate: readStateResponse.certificate,
      rootKey: this.rootKey,
      canisterId: target,
      blsVerify: this.options.blsVerify,
    });
    const path = [
      new TextEncoder().encode("request_status"),
      submitResponse.requestId,
    ];
    const maybeBuf = certificate.lookup([
      ...path,
      new TextEncoder().encode("status"),
    ]);
    const status = maybeBuf && new TextDecoder().decode(maybeBuf);
    if (status !== RequestStatusResponseStatus.Replied) {
      throw new SignerAgentError("Certificate is missing reply");
    }
    return {
      status: QueryResponseStatus.Replied,
      reply: {
        arg: certificate.lookup([...path, "reply"])!,
      },
      httpDetails: {
        ok: true,
        status: 200,
        statusText:
          "Certificate with reply has been received over ICRC-25 JSON-RPC",
        headers: [],
      },
    };
  }

  public async createReadStateRequest(
    options: ReadStateOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const requestId = this.requestIdFromReadStateOptions(options);
    if (!requestId) {
      throw new SignerAgentError(
        "Invalid read state request, request id could not be found in options",
      );
    }
    const requestKey = Buffer.from(requestId).toString("base64");
    if (this.delegatedRequestIds.has(requestKey)) {
      const sender = await this.getPrincipal();
      const delegationIdentity = await this.getDelegationIdentity(sender);
      return this.agent.createReadStateRequest(options, delegationIdentity);
    }
  }

  public async readState(
    canisterId: Principal | string,
    options: ReadStateOptions,
    identity?: Identity | Promise<Identity>,
    // eslint-disable-next-line
    request?: any,
  ): Promise<ReadStateResponse> {
    const requestId = this.requestIdFromReadStateOptions(options);
    if (!requestId) {
      throw new SignerAgentError(
        "Invalid read state request, request id could not be found in options",
      );
    }
    const requestKey = Buffer.from(requestId).toString("base64");
    if (this.delegatedRequestIds.has(requestKey)) {
      this.delegatedRequestIds.delete(requestKey);
      const sender = await this.getPrincipal();
      const delegationIdentity = await this.getDelegationIdentity(sender);
      return this.agent.readState(canisterId, options, delegationIdentity);
    }
    const readStateResponse = this.readStateResponses.get(requestKey);
    if (!readStateResponse) {
      throw new SignerAgentError(
        "Invalid read state request, response could not be found",
      );
    }
    this.readStateResponses.delete(requestKey);
    return readStateResponse;
  }

  public async status(): Promise<JsonObject> {
    return this.agent.status();
  }

  private async getDelegationChain(
    principal: Principal,
    publicKey: ArrayBuffer,
  ) {
    const json = await this.storage.get(
      `delegation-chain-${principal.toText()}-${Buffer.from(publicKey).toString("base64")}`,
    );
    if (json && typeof json !== "string") {
      throw new SignerAgentError("Invalid delegation chain in storage");
    }
    if (
      !json ||
      !isDelegationValid(DelegationChain.fromJSON(json), {
        scope: this.options.delegation?.targets,
      })
    ) {
      const newDelegationChain = await this.options.signer.getDelegation({
        principal,
        publicKey,
        targets: this.options.delegation?.targets,
      });
      await this.setDelegationChain(newDelegationChain);
      return newDelegationChain;
    }
    return DelegationChain.fromJSON(json);
  }

  private async setDelegationChain(delegationChain: DelegationChain) {
    return this.storage.set(
      `delegation-chain-${Principal.selfAuthenticating(new Uint8Array(delegationChain.publicKey))}-${Buffer.from(delegationChain.delegations.slice(-1)[0].delegation.pubkey).toString("base64")}`,
      JSON.stringify(delegationChain.toJSON()),
    );
  }

  private async createDelegationBaseIdentity() {
    return this.options.delegation?.keyType === "Ed25519"
      ? Ed25519KeyIdentity.generate(
          this.getCrypto().getRandomValues(new Uint8Array(32)),
        )
      : ECDSAKeyIdentity.generate();
  }

  private async getDelegationBaseIdentity(sender: Principal) {
    if (this.options.delegation?.identity) {
      return this.options.delegation.identity;
    }
    const value = await this.storage.get(
      `delegation-identity-${sender.toText()}`,
    );
    if (!value) {
      const identity = await this.createDelegationBaseIdentity();
      await this.setDelegationBaseIdentity(sender, identity);
      return identity;
    }
    return typeof value === "string"
      ? Ed25519KeyIdentity.fromJSON(value)
      : ECDSAKeyIdentity.fromKeyPair(value);
  }

  private async setDelegationBaseIdentity(
    sender: Principal,
    identity: Ed25519KeyIdentity | ECDSAKeyIdentity,
  ) {
    const value =
      identity instanceof Ed25519KeyIdentity
        ? JSON.stringify(identity.toJSON())
        : identity.getKeyPair();
    return this.storage.set(`delegation-identity-${sender.toText()}`, value);
  }

  private requestIdFromReadStateOptions = (
    options: ReadStateOptions,
  ): RequestId | undefined => {
    if (options.paths.length === 1 && options.paths[0].length == 2) {
      const path = new TextDecoder().decode(options.paths[0][0]);
      if (path === "request_status") {
        return options.paths[0][1] as RequestId;
      }
    }
  };

  private getCrypto(): Pick<Crypto, "getRandomValues"> {
    return this.options.crypto ?? window.crypto;
  }
}
