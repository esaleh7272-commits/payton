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
        sender
