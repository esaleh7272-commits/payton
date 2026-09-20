import { Buffer } from "buffer";
import { WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

globalThis.Buffer = Buffer;

const EXPECTED_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

// Temporary wallet derivation test only.
// NO blockchain transaction is created or sent.

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // Temporary test endpoint
    if (
      request.method === "GET" &&
      url.pathname === "/__wallet_check_payton_739182"
    ) {
      try {
        const mnemonic = env.PTN_MNEMONIC;

        if (!mnemonic) {
          return new Response("MISMATCH: PTN_MNEMONIC secret is missing");
        }

        const words = mnemonic
          .trim()
          .split(/\s+/)
          .filter(Boolean);

        if (words.length !== 12 && words.length !== 24) {
          return new Response(
            "MISMATCH: mnemonic must contain 12 or 24 words"
          );
        }

        const keyPair = await mnemonicToPrivateKey(words);

        const wallet = WalletContractV5R1.create({
          walletId: {
            networkGlobalId: -239
          },
          publicKey: keyPair.publicKey
        });

        const derivedAddress = wallet.address.toString({
          urlSafe: true,
          bounceable: true,
          testOnly: false
        });

        if (derivedAddress === EXPECTED_WALLET) {
          return new Response("MATCH");
        }

        return new Response("MISMATCH");
      } catch (error) {
        console.error(error);
        return new Response("MISMATCH: derivation error");
      }
    }

    return new Response("PAYTON Wallet Test is running!");
  }
};
