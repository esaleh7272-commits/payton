import { Buffer } from "buffer";
import { Address } from "@ton/core";
import {
  TonClient,
  WalletContractV4,
  WalletContractV5R1
} from "@ton/ton";

globalThis.Buffer = Buffer;

const ADMIN_TELEGRAM_ID = "113074274";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const TONCENTER_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";


function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}


function normalizeMnemonic(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
}


function sameAddress(a, b) {
  try {
    return Address.parse(a).equals(Address.parse(b));
  } catch {
    return false;
  }
}


async function telegram(env, method, body) {
  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return response.json();
}


async function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text
  });
}


async function runDiagnostic(env) {

  const result = {
    test: "PTN sender wallet diagnostic",
    transaction_sent: false,
    configured_sender: PTN_SENDER_WALLET
  };


  // --------------------------------------------------
  // Check mnemonic secret
  // --------------------------------------------------

  if (!env.PTN_MNEMONIC) {
    result.error =
      "PTN_MNEMONIC secret is missing.";

    return result;
  }


  const words =
    normalizeMnemonic(env.PTN_MNEMONIC);

  result.mnemonic_word_count =
    words.length;


  if (words.length !== 12 && words.length !== 24) {
    result.mnemonic_status =
      "INVALID_WORD_COUNT";

    return result;
  }


  // --------------------------------------------------
  // Load TON crypto
  // --------------------------------------------------

  let cryptoModule;

  try {

    if (typeof globalThis.window === "undefined") {
      globalThis.window = globalThis;
    }

    cryptoModule =
      await import("@ton/crypto");

  } catch (error) {

    result.mnemonic_status =
      "CRYPTO_IMPORT_FAILED";

    result.error =
      String(error?.message || error);

    return result;
  }


  // --------------------------------------------------
  // Validate mnemonic
  // --------------------------------------------------

  let mnemonicValid = false;

  try {

    if (
      typeof cryptoModule.mnemonicValidate ===
      "function"
    ) {

      mnemonicValid =
        await cryptoModule.mnemonicValidate(words);

    } else {

      result.mnemonic_validation =
        "VALIDATION_FUNCTION_NOT_AVAILABLE";

      mnemonicValid = true;
    }

  } catch (error) {

    result.mnemonic_status =
      "MNEMONIC_VALIDATION_ERROR";

    result.error =
      String(error?.message || error);

    return result;
  }


  result.mnemonic_valid =
    mnemonicValid;


  if (!mnemonicValid) {

    result.mnemonic_status =
      "INVALID_TON_MNEMONIC";

    return result;
  }


  // --------------------------------------------------
  // Derive key pair from mnemonic
  // --------------------------------------------------

  let keyPair;

  try {

    keyPair =
      await cryptoModule.mnemonicToPrivateKey(words);

  } catch (error) {

    result.mnemonic_status =
      "KEY_DERIVATION_FAILED";

    result.error =
      String(error?.message || error);

    return result;
  }


  result.key_derivation =
    "SUCCESS";


  // --------------------------------------------------
  // Derive V4R2 wallet
  // --------------------------------------------------

  let v4Address = null;

  try {

    const v4 =
      WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
        walletId: 0x29a9a317
      });


    v4Address =
      v4.address.toString({
        bounceable: true,
        urlSafe: true
      });


    result.v4r2 = {
      derived_address: v4Address,

      matches_sender:
        sameAddress(
          v4Address,
          PTN_SENDER_WALLET
        ),

      wallet_id:
        "0x29a9a317"
    };

  } catch (error) {

    result.v4r2 = {
      error:
        String(error?.message || error)
    };
  }


  // --------------------------------------------------
  // Derive V5R1 wallet
  // --------------------------------------------------

  let v5Address = null;

  try {

    const v5 =
      WalletContractV5R1.create({
        workchain: 0,
        publicKey: keyPair.publicKey,

        walletId: {
          networkGlobalId: -239
        }
      });


    v5Address =
      v5.address.toString({
        bounceable: true,
        urlSafe: true
      });


    result.v5r1 = {
      derived_address: v5Address,

      matches_sender:
        sameAddress(
          v5Address,
          PTN_SENDER_WALLET
        ),

      network:
        "mainnet",

      network_global_id:
        -239
    };

  } catch (error) {

    result.v5r1 = {
      error:
        String(error?.message || error)
    };
  }


  // --------------------------------------------------
  // Connect to TON
  // --------------------------------------------------

  let client;

  try {

    client =
      new TonClient({
        endpoint:
          TONCENTER_ENDPOINT,

        apiKey:
          env.TONCENTER_API_KEY
      });

  } catch (error) {

    result.blockchain_client =
      String(error?.message || error);

    return result;
  }


  // --------------------------------------------------
  // Parse actual sender address
  // --------------------------------------------------

  let senderAddress;

  try {

    senderAddress =
      Address.parse(
        PTN_SENDER_WALLET
      );

  } catch (error) {

    result.sender_address_error =
      String(error?.message || error);

    return result;
  }


  // --------------------------------------------------
  // Read actual sender wallet state
  // --------------------------------------------------

  result.on_chain = {};

  try {

    const state =
      await client.getContractState(
        senderAddress
      );


    result.on_chain.state =
      state.state;

    result.on_chain.balance_gram =
      state.balance?.toString?.() ||
      null;

    result.on_chain.code_present =
      !!state.code;

    result.on_chain.data_present =
      !!state.data;

  } catch (error) {

    result.on_chain.state_error =
      String(error?.message || error);
  }


  // --------------------------------------------------
  // Read public key from actual wallet
  // --------------------------------------------------

  try {

    const publicKeyResult =
      await client.runMethod(
        senderAddress,
        "get_public_key"
      );


    let onChainPublicKey = null;

    try {

      const first =
        publicKeyResult.stack.readBigNumber();

      onChainPublicKey =
        BigInt(first)
          .toString(16)
          .padStart(64, "0");

    } catch {

      onChainPublicKey = null;
    }


    result.on_chain.get_public_key =
      onChainPublicKey
        ? "AVAILABLE"
        : "AVAILABLE_BUT_NOT_PARSED";


    // Never display the actual public key.
    // Only compare it internally.

    if (onChainPublicKey) {

      const derivedPublicKey =
        Buffer.from(
          keyPair.publicKey
        )
          .toString("hex")
          .toLowerCase();


      result.on_chain.public_key_matches_mnemonic =
        onChainPublicKey.toLowerCase() ===
        derivedPublicKey;
    }

  } catch (error) {

    result.on_chain.get_public_key =
      "NOT_AVAILABLE_OR_NOT_STANDARD";

    result.on_chain.get_public_key_error =
      String(error?.message || error);
  }


  // --------------------------------------------------
  // Read subwallet ID if available
  // --------------------------------------------------

  try {

    const subwalletResult =
      await client.runMethod(
        senderAddress,
        "get_subwallet_id"
      );


    let value = null;

    try {

      value =
        subwalletResult.stack
          .readBigNumber()
          .toString();

    } catch {

      value = null;
    }


    result.on_chain.subwallet_id =
      value;

  } catch {

    result.on_chain.subwallet_id =
      "NOT_AVAILABLE_OR_NOT_STANDARD";
  }


  // --------------------------------------------------
  // Final diagnosis
  // --------------------------------------------------

  const v4Match =
    result.v4r2?.matches_sender === true;

  const v5Match =
    result.v5r1?.matches_sender === true;

  const publicKeyMatch =
    result.on_chain
      ?.public_key_matches_mnemonic === true;


  if (v4Match || v5Match) {

    result.diagnosis =
      "MNEMONIC_MATCHES_CONFIGURED_WALLET";

  } else if (publicKeyMatch) {

    result.diagnosis =
      "MNEMONIC_PUBLIC_KEY_MATCHES_ON_CHAIN_WALLET_BUT_WALLET_CONTRACT_OR_WALLET_ID_IS_DIFFERENT";

  } else if (
    result.on_chain
      ?.public_key_matches_mnemonic === false
  ) {

    result.diagnosis =
      "MNEMONIC_DERIVES_A_DIFFERENT_PUBLIC_KEY_THAN_THE_CONFIGURED_SENDER";

  } else {

    result.diagnosis =
      "MNEMONIC_DERIVATION_WORKED_BUT_WALLET_TYPE_OR_DERIVATION_SCHEME_IS_NOT_YET_IDENTIFIED";
  }


  result.safety =
    "DIAGNOSTIC_ONLY. NO TRANSACTION WAS CREATED OR SENT.";


  return result;
}


// ==================================================
// TELEGRAM
// ==================================================

async function handleTelegramUpdate(env, update) {

  const message =
    update?.message;

  if (!message) {
    return;
  }


  const chatId =
    String(message.chat?.id || "");

  const userId =
    String(message.from?.id || "");


  if (userId !== ADMIN_TELEGRAM_ID) {
    return;
  }


  const text =
    String(message.text || "").trim();


  // --------------------------------------------------
  // START
  // --------------------------------------------------

  if (text === "/start") {

    await sendMessage(
      env,
      chatId,

      "PAYTON diagnostic bot.\n\n" +
      "Send /diag to check the PTN sender wallet.\n\n" +
      "No transaction will be sent."
    );

    return;
  }


  // --------------------------------------------------
  // DIAGNOSTIC
  // --------------------------------------------------

  if (text === "/diag") {

    await sendMessage(
      env,
      chatId,

      "🔎 Running wallet diagnostic...\n\n" +
      "No transaction will be sent."
    );


    try {

      const result =
        await runDiagnostic(env);


      await sendMessage(
        env,
        chatId,

        "🔎 DIAGNOSTIC RESULT\n\n" +
        JSON.stringify(
          result,
          null,
          2
        )
      );

    } catch (error) {

      await sendMessage(
        env,
        chatId,

        "❌ Diagnostic failed.\n\n" +
        String(
          error?.message || error
        )
      );
    }

    return;
  }


  await sendMessage(
    env,
    chatId,

    "Send /diag to run the sender-wallet diagnostic."
  );
}


// ==================================================
// WORKER
// ==================================================

export default {

  async fetch(request, env) {

    try {

      // ----------------------------------------------
      // GET
      // ----------------------------------------------

      if (request.method === "GET") {

        const url =
          new URL(request.url);


        if (url.pathname === "/diag") {

          if (!env.PTN_MNEMONIC) {

            return json(
              {
                ok: false,
                error:
                  "PTN_MNEMONIC secret is missing."
              },
              500
            );
          }


          const result =
            await runDiagnostic(env);


          return json(result);
        }


        return new Response(
          "PAYTON diagnostic worker is running.",
          {
            status: 200
          }
        );
      }


      // ----------------------------------------------
      // POST - Telegram webhook
      // ----------------------------------------------

      if (request.method === "POST") {

        const update =
          await request.json();


        await handleTelegramUpdate(
          env,
          update
        );


        return new Response("OK");
      }


      return new Response(
        "Method Not Allowed",
        {
          status: 405
        }
      );

    } catch (error) {

      return json(
        {
          ok: false,
          error:
            String(
              error?.message || error
            )
        },
        500
      );
    }
  }
};
