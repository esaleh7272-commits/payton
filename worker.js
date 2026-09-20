import { Buffer } from "buffer";
import {
  mnemonicToPrivateKey,
  deriveEd25519Path,
  keyPairFromSeed
} from "@ton/crypto";

import {
  WalletContractV4,
  WalletContractV5R1
} from "@ton/ton";

globalThis.Buffer = Buffer;
globalThis.window = globalThis;

const EXPECTED_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

// =====================================================
// TEMPORARY WALLET IDENTIFICATION TEST
// =====================================================
// NO TRANSACTION
// NO TON TRANSFER
// NO PTN TRANSFER
// NO BROADCAST
// =====================================================

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/__wallet_check_payton_739182"
    ) {
      try {

        // -------------------------------------------------
        // 1. Read Secret
        // -------------------------------------------------

        if (!env.PTN_MNEMONIC) {
          return new Response(
            "ERROR: PTN_MNEMONIC secret is missing"
          );
        }

        const mnemonic =
          env.PTN_MNEMONIC
            .trim()
            .replace(/\s+/g, " ");

        const words = mnemonic.split(" ");

        if (words.length !== 12 && words.length !== 24) {
          return new Response(
            "ERROR: mnemonic word count = " + words.length
          );
        }

        // -------------------------------------------------
        // 2. TON-NATIVE DERIVATION
        // -------------------------------------------------

        let tonKeyPair;

        try {

          tonKeyPair =
            await mnemonicToPrivateKey(words);

        } catch (error) {

          return new Response(
            "ERROR: TON mnemonic derivation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 3. TON-NATIVE V5R1
        // -------------------------------------------------

        let tonV5Address;

        try {

          const wallet =
            WalletContractV5R1.create({
              walletId: {
                networkGlobalId: -239
              },
              publicKey: tonKeyPair.publicKey,
              workchain: 0
            });

          tonV5Address =
            wallet.address.toString({
              urlSafe: true,
              bounceable: true,
              testOnly: false
            });

        } catch (error) {

          return new Response(
            "ERROR: TON V5R1 creation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 4. TON-NATIVE V4R2
        // -------------------------------------------------

        let tonV4Address;

        try {

          const wallet =
            WalletContractV4.create({
              workchain: 0,
              publicKey: tonKeyPair.publicKey,
              walletId: 0x29a9a317
            });

          tonV4Address =
            wallet.address.toString({
              urlSafe: true,
              bounceable: true,
              testOnly: false
            });

        } catch (error) {

          return new Response(
            "ERROR: TON V4R2 creation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 5. MULTICHAIN / BIP39
        //
        // BIP39:
        // PBKDF2-HMAC-SHA512
        //
        // password = normalized mnemonic
        // salt     = "mnemonic"
        // rounds   = 2048
        // output   = 64 bytes
        // -------------------------------------------------

        let bip39Seed;

        try {

          const normalizedMnemonic =
            mnemonic.normalize("NFKD");

          const encoder =
            new TextEncoder();

          const mnemonicBytes =
            encoder.encode(normalizedMnemonic);

          const saltBytes =
            encoder.encode("mnemonic");

          const baseKey =
            await crypto.subtle.importKey(
              "raw",
              mnemonicBytes,
              "PBKDF2",
              false,
              ["deriveBits"]
            );

          const derivedBits =
            await crypto.subtle.deriveBits(
              {
                name: "PBKDF2",
                salt: saltBytes,
                iterations: 2048,
                hash: "SHA-512"
              },
              baseKey,
              512
            );

          bip39Seed =
            Buffer.from(
              new Uint8Array(derivedBits)
            );

        } catch (error) {

          return new Response(
            "ERROR: BIP39 seed derivation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 6. MULTICHAIN SLIP-10
        //
        // m/44'/607'/0'
        //
        // deriveEd25519Path() uses hardened Ed25519
        // derivation for the supplied path.
        // -------------------------------------------------

        let multichainKeyPair;

        try {

          const derivedSeed =
            await deriveEd25519Path(
              bip39Seed,
              [44, 607, 0]
            );

          multichainKeyPair =
            keyPairFromSeed(derivedSeed);

        } catch (error) {

          return new Response(
            "ERROR: Multichain SLIP-10 derivation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 7. MULTICHAIN V5R1
        // -------------------------------------------------

        let multiV5Address;

        try {

          const wallet =
            WalletContractV5R1.create({
              walletId: {
                networkGlobalId: -239
              },
              publicKey:
                multichainKeyPair.publicKey,
              workchain: 0
            });

          multiV5Address =
            wallet.address.toString({
              urlSafe: true,
              bounceable: true,
              testOnly: false
            });

        } catch (error) {

          return new Response(
            "ERROR: Multichain V5R1 creation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 8. MULTICHAIN V4R2
        // -------------------------------------------------

        let multiV4Address;

        try {

          const wallet =
            WalletContractV4.create({
              workchain: 0,
              publicKey:
                multichainKeyPair.publicKey,
              walletId: 0x29a9a317
            });

          multiV4Address =
            wallet.address.toString({
              urlSafe: true,
              bounceable: true,
              testOnly: false
            });

        } catch (error) {

          return new Response(
            "ERROR: Multichain V4R2 creation failed: " +
            (error?.message || String(error))
          );
        }

        // -------------------------------------------------
        // 9. COMPARE
        // -------------------------------------------------

        const matches = [];

        if (tonV5Address === EXPECTED_WALLET) {
          matches.push("TON-V5R1");
        }

        if (tonV4Address === EXPECTED_WALLET) {
          matches.push("TON-V4R2");
        }

        if (multiV5Address === EXPECTED_WALLET) {
          matches.push("MULTICHAIN-V5R1");
        }

        if (multiV4Address === EXPECTED_WALLET) {
          matches.push("MULTICHAIN-V4R2");
        }

        // -------------------------------------------------
        // 10. RETURN ONLY SAFE RESULT
        // -------------------------------------------------

        if (matches.length > 0) {

          return new Response(
            "MATCH: " + matches.join(", ")
          );
        }

        return new Response(
          "MISMATCH: ALL TESTS"
        );

      } catch (error) {

        return new Response(
          "ERROR: " +
          (error?.message || String(error))
        );
      }
    }

    return new Response(
      "PAYTON Wallet Identification Test is running!"
    );
  }
};
