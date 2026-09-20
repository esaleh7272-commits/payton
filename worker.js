import { Buffer } from "buffer";
import { WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

globalThis.Buffer = Buffer;
globalThis.window = globalThis;

const EXPECTED_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // ==========================================
    // TEMPORARY WALLET DERIVATION TEST
    // NO TRANSACTION / NO PTN TRANSFER
    // ==========================================

    if (
      request.method === "GET" &&
      url.pathname === "/__wallet_check_payton_739182"
    ) {
      try {

        // Check Secret
        if (!env.PTN_MNEMONIC) {
          return new Response(
            "ERROR: PTN_MNEMONIC secret is missing"
          );
        }

        // Read mnemonic
        const words = env.PTN_MNEMONIC
          .trim()
          .split(/\s+/)
          .filter(Boolean);

        // Check word count
        if (words.length !== 12 && words.length !== 24) {
          return new Response(
            "ERROR: mnemonic word count = " + words.length
          );
        }

        // Derive private/public key
        let keyPair;

        try {
          keyPair = await mnemonicToPrivateKey(words);
        } catch (error) {
          return new Response(
            "ERROR at mnemonicToPrivateKey: " +
            (error?.message || String(error))
          );
        }

        // Create V5R1 wallet
        let wallet;

        try {
          wallet = WalletContractV5R1.create({
            walletId: {
              networkGlobalId: -239
            },
            publicKey: keyPair.publicKey,
            workchain: 0
          });
        } catch (error) {
          return new Response(
            "ERROR at WalletContractV5R1.create: " +
            (error?.message || String(error))
          );
        }

        // Convert derived address
        let derivedAddress;

        try {
          derivedAddress = wallet.address.toString({
            urlSafe: true,
            bounceable: true,
            testOnly: false
          });
        } catch (error) {
          return new Response(
            "ERROR at address conversion: " +
            (error?.message || String(error))
          );
        }

        // Compare with PTN sender wallet
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

    return new Response("PAYTON Wallet Test is running!");
  }
};
