import {
  Argon2id,
  Argon2idOptions,
  Bip39,
  EnglishMnemonic,
  pathToString,
  Random,
  Secp256k1,
  Sha256,
  Sha512,
  Slip10,
  Slip10Curve,
  Slip10RawIndex,
  xchacha20NonceLength,
  Xchacha20poly1305Ietf,
} from "@cosmjs/crypto";
import { toAscii, toBase64, toHex, toUtf8 } from "@cosmjs/encoding";
import { isUint8Array } from "@cosmjs/utils";

import { rawSecp256k1PubkeyToAddress } from "./address";
import { encodeSecp256k1Signature } from "./signature";
import { StdSignature } from "./types";

export type PrehashType = "sha256" | "sha512" | null;

export type Algo = "secp256k1" | "ed25519" | "sr25519";

export interface AccountData {
  // bech32-encoded
  readonly address: string;
  readonly algo: Algo;
  readonly pubkey: Uint8Array;
}

export interface OfflineSigner {
  /**
   * Get AccountData array from wallet. Rejects if not enabled.
   */
  readonly getAccounts: () => Promise<readonly AccountData[]>;

  /**
   * Request signature from whichever key corresponds to provided bech32-encoded address. Rejects if not enabled.
   */
  readonly sign: (address: string, message: Uint8Array, prehashType?: PrehashType) => Promise<StdSignature>;
}

function prehash(bytes: Uint8Array, type: PrehashType): Uint8Array {
  switch (type) {
    case null:
      return new Uint8Array([...bytes]);
    case "sha256":
      return new Sha256(bytes).digest();
    case "sha512":
      return new Sha512(bytes).digest();
    default:
      throw new Error("Unknown prehash type");
  }
}

/**
 * The Cosmoshub derivation path in the form `m/44'/118'/0'/0/a`
 * with 0-based account index `a`.
 */
export function makeCosmoshubPath(a: number): readonly Slip10RawIndex[] {
  return [
    Slip10RawIndex.hardened(44),
    Slip10RawIndex.hardened(118),
    Slip10RawIndex.hardened(0),
    Slip10RawIndex.normal(0),
    Slip10RawIndex.normal(a),
  ];
}

const serializationType1 = "v1";

/**
 * A fixed salt is chosen to archive a deterministic password to key derivation.
 * This reduces the scope of a potential rainbow attack to all Secp256k1Wallet v1 users.
 * Must be 16 bytes due to implementation limitations.
 */
const secp256k1WalletSalt = toAscii("Secp256k1Wallet1");

/**
 * Not great but can be used on the main thread
 */
const passwordHashingOptions: Argon2idOptions = {
  outputLength: 32,
  opsLimit: 11,
  memLimitKib: 8 * 1024,
};

const algorithmIdXchacha20poly1305Ietf = "xchacha20poly1305-ietf";

/**
 * This interface describes a JSON object holding the encrypted wallet and the meta data
 */
export interface EncryptedSecp256k1Wallet {
  /** A format+version identifier for this serialization format */
  readonly type: string;
  /** Information about the key derivation function (i.e. password to encrytion key) */
  readonly kdf: {
    /**
     * An algorithm identifier, such as "argon2id" or "scrypt".
     */
    readonly algorithm: string;
    /** A map of algorithm-specific parameters */
    readonly params: Record<string, unknown>;
  };
  /** Information about the symmetric encryption */
  readonly encryption: {
    /**
     * An algorithm identifier, such as "xchacha20poly1305-ietf".
     */
    readonly algorithm: string;
    /** A map of algorithm-specific parameters */
    readonly params: Record<string, unknown>;
  };
  /** base64 encoded enccrypted value */
  readonly value: string;
}

export interface EncryptedSecp256k1WalletData {
  readonly mnemonic: string;
  readonly accounts: ReadonlyArray<{
    readonly algo: string;
    readonly hdPath: string;
    readonly prefix: string;
  }>;
}

export class Secp256k1Wallet implements OfflineSigner {
  /**
   * Restores a wallet from the given BIP39 mnemonic.
   *
   * @param mnemonic Any valid English mnemonic.
   * @param hdPath The BIP-32/SLIP-10 derivation path. Defaults to the Cosmos Hub/ATOM path `m/44'/118'/0'/0/0`.
   * @param prefix The bech32 address prefix (human readable part). Defaults to "cosmos".
   */
  public static async fromMnemonic(
    mnemonic: string,
    hdPath: readonly Slip10RawIndex[] = makeCosmoshubPath(0),
    prefix = "cosmos",
  ): Promise<Secp256k1Wallet> {
    const mnemonicChecked = new EnglishMnemonic(mnemonic);
    const seed = await Bip39.mnemonicToSeed(mnemonicChecked);
    const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, hdPath);
    const uncompressed = (await Secp256k1.makeKeypair(privkey)).pubkey;
    return new Secp256k1Wallet(
      mnemonicChecked,
      hdPath,
      privkey,
      Secp256k1.compressPubkey(uncompressed),
      prefix,
    );
  }

  /**
   * Generates a new wallet with a BIP39 mnemonic of the given length.
   *
   * @param length The number of words in the mnemonic (12, 15, 18, 21 or 24).
   * @param hdPath The BIP-32/SLIP-10 derivation path. Defaults to the Cosmos Hub/ATOM path `m/44'/118'/0'/0/0`.
   * @param prefix The bech32 address prefix (human readable part). Defaults to "cosmos".
   */
  public static async generate(
    length: 12 | 15 | 18 | 21 | 24 = 12,
    hdPath: readonly Slip10RawIndex[] = makeCosmoshubPath(0),
    prefix = "cosmos",
  ): Promise<Secp256k1Wallet> {
    const entropyLength = 4 * Math.floor((11 * length) / 33);
    const entropy = Random.getBytes(entropyLength);
    const mnemonic = Bip39.encode(entropy);
    return Secp256k1Wallet.fromMnemonic(mnemonic.toString(), hdPath, prefix);
  }

  /** Base secret */
  private readonly secret: EnglishMnemonic;
  /** Derivation instrations */
  private readonly accounts: ReadonlyArray<{
    readonly algo: Algo;
    readonly hdPath: readonly Slip10RawIndex[];
    readonly prefix: string;
  }>;
  /** Derived data */
  private readonly pubkey: Uint8Array;
  private readonly privkey: Uint8Array;

  private constructor(
    mnemonic: EnglishMnemonic,
    hdPath: readonly Slip10RawIndex[],
    privkey: Uint8Array,
    pubkey: Uint8Array,
    prefix: string,
  ) {
    this.secret = mnemonic;
    this.accounts = [
      {
        algo: "secp256k1",
        hdPath: hdPath,
        prefix: prefix,
      },
    ];
    this.privkey = privkey;
    this.pubkey = pubkey;
  }

  public get mnemonic(): string {
    return this.secret.toString();
  }

  private get address(): string {
    return rawSecp256k1PubkeyToAddress(this.pubkey, this.accounts[0].prefix);
  }

  public async getAccounts(): Promise<readonly AccountData[]> {
    return [
      {
        address: this.address,
        algo: this.accounts[0].algo,
        pubkey: this.pubkey,
      },
    ];
  }

  public async sign(
    address: string,
    message: Uint8Array,
    prehashType: PrehashType = "sha256",
  ): Promise<StdSignature> {
    if (address !== this.address) {
      throw new Error(`Address ${address} not found in wallet`);
    }
    const hashedMessage = prehash(message, prehashType);
    const signature = await Secp256k1.createSignature(hashedMessage, this.privkey);
    const signatureBytes = new Uint8Array([...signature.r(32), ...signature.s(32)]);
    return encodeSecp256k1Signature(this.pubkey, signatureBytes);
  }

  /**
   * Generates an encrypted serialization of this wallet.
   *
   * @param secret If set to a string, a KDF runs internally. If set to an Uin8Array, this is used a the encryption key directly.
   */
  public async save(secret: string | Uint8Array): Promise<string> {
    let encryptionKey: Uint8Array;
    if (typeof secret === "string") {
      encryptionKey = await Argon2id.execute(secret, secp256k1WalletSalt, passwordHashingOptions);
    } else if (isUint8Array(secret)) {
      encryptionKey = secret;
    } else {
      throw new Error("Unsupported type of encryption secret");
    }

    const encrytedData: EncryptedSecp256k1WalletData = {
      mnemonic: this.mnemonic,
      accounts: this.accounts.map((account) => ({
        algo: account.algo,
        hdPath: pathToString(account.hdPath),
        prefix: account.prefix,
      })),
    };
    const message = toUtf8(JSON.stringify(encrytedData));
    const nonce = Random.getBytes(xchacha20NonceLength);
    const encrypted = await Xchacha20poly1305Ietf.encrypt(message, encryptionKey, nonce);

    const out: EncryptedSecp256k1Wallet = {
      type: serializationType1,
      kdf: { algorithm: "scrypt", params: {} },
      encryption: {
        algorithm: algorithmIdXchacha20poly1305Ietf,
        params: {
          nonce: toHex(nonce),
        },
      },
      value: toBase64(encrypted),
    };
    return JSON.stringify(out);
  }
}
