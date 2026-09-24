import { Buffer } from "buffer";

import {
  Address,
  beginCell,
  internal,
  SendMode,
  toNano
} from "@ton/core";

import {
  TonClient,
  WalletContractV5R1,
  JettonMaster,
  JettonWallet
} from "@ton/ton";

globalThis.Buffer = Buffer;


/*
 * ==================================================
 * CLOUDFLARE WORKERS CACHE COMPATIBILITY
 * ==================================================
 *
 * Cloudflare Workers supports:
 *
 *   cache: "no-store"
 *   cache: "no-cache"
 *
 * Some HTTP libraries may explicitly create:
 *
 *   cache: "default"
 *
 * Cloudflare rejects that value.
 *
 * Convert only "default" to "no-store".
 */

if (
  typeof globalThis.Request !== "undefined" &&
  !globalThis.__PAYTON_REQUEST_PATCHED__
) {

  const OriginalRequest =
    globalThis.Request;

  globalThis.Request =
    class PaytonRequest extends OriginalRequest {

      constructor(input, init) {

        if (
          init &&
          init.cache === "default"
        ) {

          init = {
            ...init,
            cache: "no-store"
          };
        }

        super(input, init);
      }
    };

  globalThis.__PAYTON_REQUEST_PATCHED__ = true;
}


// ==================================================
// CONFIG
// ==================================================

const ADMIN_TELEGRAM_ID =
  "113074274";

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const PTN_DECIMALS =
  9;

const TONCENTER_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";

const JETTON_TRANSFER_VALUE =
  toNano("0.05");

const MIN_SENDER_TON =
  toNano("0.10");


// ==================================================
// ADMIN SESSIONS
// ==================================================

const sessions =
  new Map();


// ==================================================
// TELEGRAM
// ==================================================

async function telegram(
  env,
  method,
  body
) {

  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(body),

        cache:
          "no-store"
      }
    );

  return response.json();
}


async function sendMessage(
  env,
  chatId,
  text,
  keyboard = null
) {

  const body = {
    chat_id:
      chatId,

    text:
      text
  };

  if (keyboard) {

    body.reply_markup =
      keyboard;
  }

  return telegram(
    env,
    "sendMessage",
    body
  );
}


async function answerCallback(
  env,
  callbackId
) {

  return telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callbackId
    }
  );
}


// ==================================================
// KEYBOARDS
// ==================================================

function mainKeyboard() {

  return {

    inline_keyboard: [

      [
        {
          text:
            "💸 Manual PTN Payment",

          callback_data:
            "manual_ptn"
        }
      ]

    ]
  };
}


function cancelKeyboard() {

  return {

    inline_keyboard: [

      [
        {
          text:
            "❌ Cancel",

          callback_data:
            "cancel_payment"
        }
      ]

    ]
  };
}


// ==================================================
// MNEMONIC
// ==================================================

function normalizeMnemonic(
  raw
) {

  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
}


// ==================================================
// PTN AMOUNT
// ==================================================

function parsePtnAmount(
  value
) {

  const input =
    String(value || "")
      .trim()
      .replace(/,/g, "");

  if (!input) {

    throw new Error(
      "PTN amount is required."
    );
  }


  if (
    !/^\d+(\.\d{1,9})?$/.test(
      input
    )
  ) {

    throw new Error(
      "Invalid PTN amount. Use numbers with up to 9 decimal places."
    );
  }


  const parts =
    input.split(".");

  const whole =
    parts[0];

  const fraction =
    parts[1] || "";

  const padded =
    fraction.padEnd(
      PTN_DECIMALS,
      "0"
    );

  const amount =
    BigInt(
      whole + padded
    );


  if (
    amount <= 0n
  ) {

    throw new Error(
      "PTN amount must be greater than zero."
    );
  }


  return {

    display:
      input,

    nano:
      amount
  };
}


// ==================================================
// DESTINATION ADDRESS
// ==================================================

function parseDestination(
  value
) {

  const input =
    String(value || "")
      .trim();

  if (!input) {

    throw new Error(
      "Wallet address is required."
    );
  }


  /*
   * IMPORTANT:
   *
   * Destination is ONLY a TON Address.
   *
   * No V4/V5 detection.
   */

  return Address.parse(
    input
  );
}


// ==================================================
// TON CLIENT
// ==================================================

function createClient(
  env
) {

  return new TonClient({

    endpoint:
      TONCENTER_ENDPOINT,

    apiKey:
      env.TONCENTER_API_KEY
  });
}


// ==================================================
// CREATE V5R1 SENDER
// ==================================================

async function createSenderWallet(
  env
) {

  if (!env.PTN_MNEMONIC) {

    throw new Error(
      "PTN_MNEMONIC secret is missing."
    );
  }


  const words =
    normalizeMnemonic(
      env.PTN_MNEMONIC
    );


  if (
    words.length !== 12 &&
    words.length !== 24
  ) {

    throw new Error(
      "Invalid mnemonic word count."
    );
  }


  if (
    typeof globalThis.window ===
    "undefined"
  ) {

    globalThis.window =
      globalThis;
  }


  const cryptoModule =
    await import(
      "@ton/crypto"
    );


  const mnemonicValid =
    await cryptoModule.mnemonicValidate(
      words
    );


  if (!mnemonicValid) {

    throw new Error(
      "The configured mnemonic is not a valid TON mnemonic."
    );
  }


  const keyPair =
    await cryptoModule.mnemonicToPrivateKey(
      words
    );


  /*
   * Confirmed wallet type:
   *
   * V5R1
   *
   * Mainnet:
   *
   * networkGlobalId = -239
   */

  const wallet =
    WalletContractV5R1.create({

      workchain:
        0,

      publicKey:
        keyPair.publicKey,

      walletId: {

        networkGlobalId:
          -239
      }
    });


  /*
   * SAFETY CHECK
   *
   * Never sign if the mnemonic produces
   * a different sender wallet.
   */

  const configured =
    Address.parse(
      PTN_SENDER_WALLET
    );


  if (
    !wallet.address.equals(
      configured
    )
  ) {

    throw new Error(
      "The mnemonic does not derive the configured PTN sender wallet. No transaction was sent."
    );
  }


  return {

    wallet:
      wallet,

    keyPair:
      keyPair
  };
}


// ==================================================
// CHECK TON BALANCE
// ==================================================

async function checkTonBalance(
  client,
  wallet
) {

  const balance =
    await client.getBalance(
      wallet.address
    );


  if (
    balance <
    MIN_SENDER_TON
  ) {

    throw new Error(
      `Insufficient TON balance for network fees. Current balance: ${Number(balance) / 1e9} TON.`
    );
  }


  return balance;
}


// ==================================================
// PTN JETTON WALLET
// ==================================================

async function getPtnJettonWallet(
  client,
  senderAddress
) {

  const master =
    client.open(

      JettonMaster.create(

        Address.parse(
          PTN_MASTER
        )

      )

    );


  const jettonWalletAddress =
    await master.getWalletAddress(
      senderAddress
    );


  return client.open(

    JettonWallet.create(
      jettonWalletAddress
    )

  );
}


// ==================================================
// CHECK PTN BALANCE
// ==================================================

async function checkPtnBalance(
  jettonWallet,
  requiredAmount
) {

  const balance =
    await jettonWallet.getBalance();


  if (
    balance <
    requiredAmount
  ) {

    const human =
      Number(balance) /
      10 ** PTN_DECIMALS;


    throw new Error(
      `Insufficient PTN balance. Available: ${human} PTN.`
    );
  }


  return balance;
}


// ==================================================
// SEND PTN
// ==================================================

async function sendPtn(
  env,
  destination,
  amount
) {

  const client =
    createClient(
      env
    );


  // ----------------------------------------------
  // Sender
  // ----------------------------------------------

  const {
    wallet,
    keyPair
  } =
    await createSenderWallet(
      env
    );


  // ----------------------------------------------
  // TON balance
  // ----------------------------------------------

  const tonBalance =
    await checkTonBalance(
      client,
      wallet
    );


  // ----------------------------------------------
  // PTN Jetton Wallet
  // ----------------------------------------------

  const ptnWallet =
    await getPtnJettonWallet(
      client,
      wallet.address
    );


  // ----------------------------------------------
  // PTN balance
  // ----------------------------------------------

  const ptnBalance =
    await checkPtnBalance(
      ptnWallet,
      amount.nano
    );


  // ----------------------------------------------
  // Query ID
  // ----------------------------------------------

  const queryId =
    BigInt(
      Date.now()
    );


  // ----------------------------------------------
  // Jetton transfer body
  // ----------------------------------------------

  const body =
    beginCell()

      .storeUint(
        0x0f8a7ea5,
        32
      )

      .storeUint(
        queryId,
        64
      )

      .storeCoins(
        amount.nano
      )

      /*
       * Destination only.
       * No V4/V5 detection.
       */

      .storeAddress(
        destination
      )

      /*
       * Response/refund address.
       */

      .storeAddress(
        wallet.address
      )

      /*
       * No custom payload.
       */

      .storeBit(0)

      /*
       * Forward TON amount.
       */

      .storeCoins(
        toNano("0.01")
      )

      /*
       * No forward payload.
       */

      .storeBit(0)

      .endCell();


  // ----------------------------------------------
  // Internal message to PTN Jetton Wallet
  // ----------------------------------------------

  const message =
    internal({

      to:
        ptnWallet.address,

      value:
        JETTON_TRANSFER_VALUE,

      bounce:
        true,

      body:
        body
    });


  // ----------------------------------------------
  // Open V5R1 wallet
  // ----------------------------------------------

  const senderContract =
    client.open(
      wallet
    );


  // ----------------------------------------------
  // Current seqno
  // ----------------------------------------------

  const seqno =
    await senderContract.getSeqno();


  // ----------------------------------------------
  // SEND
  // ----------------------------------------------

  await senderContract.sendTransfer({

    seqno:
      seqno,

    secretKey:
      keyPair.secretKey,

    messages: [
      message
    ],

    sendMode:
      SendMode.PAY_GAS_SEPARATELY,

    timeout:
      Math.floor(
        Date.now() / 1000
      ) + 300
  });


  return {

    sender:
      wallet.address.toString({
        bounceable:
          true,

        urlSafe:
          true
      }),

    jettonWallet:
      ptnWallet.address.toString({
        bounceable:
          true,

        urlSafe:
          true
      }),

    destination:
      destination.toString({
        bounceable:
          true,

        urlSafe:
          true
      }),

    ptnAmount:
      amount.display,

    ptnAmountNano:
      amount.nano.toString(),

    queryId:
      queryId.toString(),

    seqno:
      seqno,

    tonBalance:
      tonBalance.toString(),

    ptnBalance:
      ptnBalance.toString()
  };
}


// ==================================================
// MAIN MENU
// ==================================================

async function showMainMenu(
  env,
  chatId
) {

  await sendMessage(

    env,
    chatId,

    "PAYTON PTN Sender\n\nChoose an action:",

    mainKeyboard()
  );
}


// ==================================================
// CALLBACK HANDLER
// ==================================================

async function handleCallback(
  env,
  callback
) {

  const callbackId =
    callback.id;

  const fromId =
    String(
      callback.from?.id || ""
    );

  const chatId =
    String(
      callback.message?.chat?.id || ""
    );

  const data =
    callback.data;


  if (
    fromId !==
    ADMIN_TELEGRAM_ID
  ) {

    await answerCallback(
      env,
      callbackId
    );

    return;
  }


  await answerCallback(
    env,
    callbackId
  );


  // ----------------------------------------------
  // Manual PTN
  // ----------------------------------------------

  if (
    data ===
    "manual_ptn"
  ) {

    sessions.set(

      chatId,

      {
        step:
          "destination"
      }

    );


    await sendMessage(

      env,
      chatId,

      "💸 Manual PTN Payment\n\n" +

      "Send the destination TON wallet address.\n\n" +

      "The destination is treated only as a TON address.\n" +

      "V4/V5 detection is not used.",

      cancelKeyboard()
    );

    return;
  }


  // ----------------------------------------------
  // Cancel
  // ----------------------------------------------

  if (
    data ===
    "cancel_payment"
  ) {

    sessions.delete(
      chatId
    );


    await sendMessage(

      env,
      chatId,

      "❌ Payment cancelled."
    );


    await showMainMenu(
      env,
      chatId
    );

    return;
  }
}


// ==================================================
// MESSAGE HANDLER
// ==================================================

async function handleMessage(
  env,
  message
) {

  const userId =
    String(
      message.from?.id || ""
    );

  const chatId =
    String(
      message.chat?.id || ""
    );

  const text =
    String(
      message.text || ""
    ).trim();


  // ----------------------------------------------
  // ADMIN ONLY
  // ----------------------------------------------

  if (
    userId !==
    ADMIN_TELEGRAM_ID
  ) {

    return;
  }


  // ----------------------------------------------
  // START
  // ----------------------------------------------

  if (
    text ===
    "/start"
  ) {

    sessions.delete(
      chatId
    );


    await sendMessage(

      env,
      chatId,

      "PAYTON PTN Sender",

      mainKeyboard()
    );

    return;
  }


  // ----------------------------------------------
  // CANCEL
  // ----------------------------------------------

  if (
    text ===
    "/cancel"
  ) {

    sessions.delete(
      chatId
    );


    await sendMessage(

      env,
      chatId,

      "❌ Payment cancelled."
    );


    await showMainMenu(
      env,
      chatId
    );

    return;
  }


  // ----------------------------------------------
  // MENU
  // ----------------------------------------------

  if (
    text ===
    "/menu"
  ) {

    sessions.delete(
      chatId
    );


    await showMainMenu(
      env,
      chatId
    );

    return;
  }


  // ----------------------------------------------
  // SESSION
  // ----------------------------------------------

  const session =
    sessions.get(
      chatId
    );


  if (!session) {

    await showMainMenu(
      env,
      chatId
    );

    return;
  }


  // ----------------------------------------------
  // DESTINATION
  // ----------------------------------------------

  if (
    session.step ===
    "destination"
  ) {

    try {

      const destination =
        parseDestination(
          text
        );


      session.destination =
        destination.toString({

          bounceable:
            true,

          urlSafe:
            true
        });


      session.step =
        "amount";


      sessions.set(
        chatId,
        session
      );


      await sendMessage(

        env,
        chatId,

        "✅ Destination accepted.\n\n" +

        "Now send the PTN amount.\n\n" +

        "Example: 1000\n" +

        "Maximum 9 decimal places.\n\n" +

        "Send /cancel to cancel.",

        cancelKeyboard()
      );

    } catch {

      await sendMessage(

        env,
        chatId,

        "❌ Invalid TON wallet address.\n\n" +

        "Please send a valid TON address or /cancel."
      );
    }

    return;
  }


  // ----------------------------------------------
  // AMOUNT
  // ----------------------------------------------

  if (
    session.step ===
    "amount"
  ) {

    let amount;

    try {

      amount =
        parsePtnAmount(
          text
        );

    } catch (error) {

      await sendMessage(

        env,
        chatId,

        "❌ " +
        String(
          error?.message ||
          error
        )
      );

      return;
    }


    session.amount =
      amount.display;

    session.step =
      "confirm";


    sessions.set(
      chatId,
      session
    );


    await sendMessage(

      env,
      chatId,

      "⚠️ Confirm PTN transfer\n\n" +

      "Destination:\n" +

      session.destination +

      "\n\n" +

      "PTN amount:\n" +

      amount.display +

      " PTN\n\n" +

      "Press Confirm to send the transaction.",

      {

        inline_keyboard: [

          [
            {
              text:
                "✅ Confirm & Send",

              callback_data:
                "confirm_ptn"
            }
          ],

          [
            {
              text:
                "❌ Cancel",

              callback_data:
                "cancel_payment"
            }
          ]

        ]
      }
    );

    return;
  }
}


// ==================================================
// CONFIRM
// ==================================================

async function handleConfirm(
  env,
  callback
) {

  const fromId =
    String(
      callback.from?.id || ""
    );

  const chatId =
    String(
      callback.message?.chat?.id || ""
    );


  if (
    fromId !==
    ADMIN_TELEGRAM_ID
  ) {

    await answerCallback(
      env,
      callback.id
    );

    return;
  }


  await answerCallback(
    env,
    callback.id
  );


  const session =
    sessions.get(
      chatId
    );


  if (
    !session ||
    session.step !==
    "confirm"
  ) {

    await sendMessage(

      env,
      chatId,

      "❌ Payment session expired. Please start again."
    );

    return;
  }


  /*
   * Delete BEFORE sending.
   */

  sessions.delete(
    chatId
  );


  await sendMessage(

    env,
    chatId,

    "⏳ Checking sender wallet, PTN balance and network fee..."
  );


  try {

    const destination =
      parseDestination(
        session.destination
      );


    const amount =
      parsePtnAmount(
        session.amount
      );


    const result =
      await sendPtn(

        env,
        destination,
        amount
      );


    await sendMessage(

      env,
      chatId,

      "✅ PTN transfer submitted.\n\n" +

      "Amount: " +
      result.ptnAmount +
      " PTN\n\n" +

      "Destination:\n" +
      result.destination +
      "\n\n" +

      "Sender:\n" +
      result.sender +
      "\n\n" +

      "Seqno: " +
      result.seqno +
      "\n\n" +

      "The transaction has been submitted to the TON network."
    );


    await showMainMenu(
      env,
      chatId
    );

  } catch (error) {

    await sendMessage(

      env,
      chatId,

      "❌ PTN transfer failed.\n\n" +

      String(
        error?.message ||
        error
      ) +

      "\n\n" +

      "No successful PTN transfer was confirmed by this bot."
    );


    await showMainMenu(
      env,
      chatId
    );
  }
}


// ==================================================
// UPDATE HANDLER
// ==================================================

async function handleTelegramUpdate(
  env,
  update
) {

  if (
    update?.callback_query
  ) {

    const callback =
      update.callback_query;


    if (
      callback.data ===
      "confirm_ptn"
    ) {

      await handleConfirm(
        env,
        callback
      );

      return;
    }


    await handleCallback(
      env,
      callback
    );

    return;
  }


  if (
    update?.message
  ) {

    await handleMessage(
      env,
      update.message
    );
  }
}


// ==================================================
// WORKER
// ==================================================

export default {

  async fetch(
    request,
    env
  ) {

    try {

      if (
        request.method ===
        "GET"
      ) {

        return new Response(

          "PAYTON PTN Sender is running.",

          {
            status:
              200,

            headers: {
              "cache-control":
                "no-store"
            }
          }
        );
      }


      if (
        request.method ===
        "POST"
      ) {

        const update =
          await request.json();


        await handleTelegramUpdate(
          env,
          update
        );


        return new Response(
          "OK",
          {
            status:
              200,

            headers: {
              "cache-control":
                "no-store"
            }
          }
        );
      }


      return new Response(

        "Method Not Allowed",

        {
          status:
            405
        }
      );

    } catch (error) {

      return new Response(

        JSON.stringify({

          ok:
            false,

          error:
            String(
              error?.message ||
              error
            )

        }),

        {
          status:
            500,

          headers: {
            "content-type":
              "application/json",

            "cache-control":
              "no-store"
          }
        }
      );
    }
  }
};
