import { Buffer } from "buffer";
import {
  pbkdf2_sha512,
  deriveEd25519Path,
  keyPairFromSeed,
  mnemonicWordList
} from "@ton/crypto";

import { WalletContractV5R1 } from "@ton/ton";

globalThis.Buffer = Buffer;
globalThis.window = globalThis;

const EXPECTED_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // ==========================================
    // TEMPORARY MULTICHAIN WALLET TEST
    // NO TRANSACTION
    // NO PTN TRANSFER
    // ==========================================

    if (
      request.method === "GET" &&
      url.pathname === "/__wallet_check_payton_739182"
    ) {
      try {

        if (!env.PTN_MNEMONIC) {
          return new Response(
            "ERROR: PTN_MNEMONIC secret is missing"
          );
        }

        const words = env.PTN_MNEMONIC
          .trim()
          .split(/\s+/)
          .map(w => w.toLowerCase());

        if (words.length !== 12 && words.length !== 24) {
          return new Response(
            "ERROR: mnemonic word count = " + words.length
          );
        }

        // ==========================================
        // Convert BIP39 words -> entropy
        // ==========================================

        const indexes = [];

        for (const word of words) {
          const index = mnemonicWordList.indexOf(word);

          if (index === -1) {
            return new Response(
              "ERROR: invalid mnemonic word"
            );
          }

          indexes.push(index);
        }

        let bits = "";

        for (const index of indexes) {
          bits += index.toString(2).padStart(11, "0");
        }

        // BIP39 entropy length:
        // 12 words = 128 bits
        // 24 words = 256 bits

        const entropyBits =
          words.length === 12 ? 128 : 256;

        bits = bits.slice(0, entropyBits);

        const entropy = Buffer.alloc(
          entropyBits / 8
        );

        for (let i = 0; i < entropy.length; i++) {
          entropy[i] = parseInt(
            bits.slice(i * 8, i * 8 + 8),
            2
          );
        }

        // ==========================================
        // BIP39 seed
        //
        // PBKDF2-HMAC-SHA512
        // password = mnemonic entropy
        // salt = "mnemonic"
        // iterations = 2048
        // output = 64 bytes
        // ==========================================

        const normalizedPassphrase = "";

        const salt = Buffer.from(
          "mnemonic" + normalizedPassphrase,
          "utf8"
        );

        const bip39Seed = await pbkdf2_sha512(
          entropy,
          salt,
          2048,
          64
        );

        // ==========================================
        // SLIP-0010 Ed25519
        //
        // m/44'/607'/0'
        // ==========================================

        const derivedSeed =
          await deriveEd25519Path(
            bip39Seed,
            [44, 607, 0]
          );

        // ==========================================
        // Create Ed25519 key pair
        // ==========================================

        const keyPair =
          keyPairFromSeed(derivedSeed);

        // ==========================================
        // Create TON V5R1 Mainnet wallet
        // ==========================================

        const wallet =
          WalletContractV5R1.create({
            walletId: {
              networkGlobalId: -239
            },
            publicKey: keyPair.publicKey,
            workchain: 0
          });

        const derivedAddress =
          wallet.address.toString({
            urlSafe: true,
            bounceable: true,
            testOnly: false
          });

        // ==========================================
        // Compare addresses
        // ==========================================

        if (derivedAddress === EXPECTED_WALLET) {
          return new Response("MATCH");
        }

        return new Response("MISMATCH");

      } catch (error) {

        return new Response(
          "ERROR: " +
          (error?.message || String(error))
        );
      }
    }

    return new Response(
      "PAYTON Multichain Wallet Test is running!"
    );
  }
};
