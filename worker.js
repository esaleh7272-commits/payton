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


// ==================================================
// CONFIG
// ==================================================

const ADMIN_TELEGRAM_ID = "113074274";

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const PTN_DECIMALS = 9;

const TONCENTER_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";

// TON sent to the PTN Jetton Wallet with the transfer.
// This is NOT PTN amount. It is network gas/value.
const JETTON_TRANSFER_VALUE =
  toNano("0.05");

const MIN_SENDER_TON =
  toNano("0.10");


// ==================================================
// TEMPORARY ADMIN SESSION
// ==================================================
//
// The admin flow is:
//
// Manual PTN Payment
//       ↓
// destination address
//       ↓
// PTN amount
//       ↓
// send
//
// No destination wallet V4/V5 detection is performed.
// The destination is simply a TON Address.
//

const sessions = new Map();


// ==================================================
// TELEGRAM HELPERS
// ==================================================

async function telegram(env, method, body) {

  const url =
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body: JSON.stringify(body)
    });

  return response.json();
}


async function sendMessage(
  env,
  chatId,
  text,
  keyboard = null
) {

  const body = {
    chat_id: chatId,
    text
  };

  if (keyboard) {
    body.reply_markup = keyboard;
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
      callback_query_id: callbackId
    }
  );
}


// ==================================================
// KEYBOARD
// ==================================================

function mainKeyboard() {

  return {
    inline_keyboard: [
      [
        {
          text: "💸 Manual PTN Payment",
          callback_data: "manual_ptn"
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
          text: "❌ Cancel",
          callback_data: "cancel_payment"
        }
      ]
    ]
  };
}


// ==================================================
// MNEMONIC
// ==================================================

function normalizeMnemonic(raw) {

  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
}


// ==================================================
// PTN AMOUNT PARSER
// ==================================================

function parsePtnAmount(value) {

  const input =
    String(value || "")
      .trim()
      .replace(/,/g, "");

  if (!input) {
    throw new Error(
      "PTN amount is required."
    );
  }


  if (!/^\d+(\.\d{1,9})?$/.test(input)) {

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

  const nanoString =
    whole + padded;

  const amount =
    BigInt(nanoString);

  if (amount <= 0n) {
    throw new Error(
      "PTN amount must be greater than zero."
    );
  }

  return {
    display: input,
    nano: amount
  };
}


// ==================================================
// ADDRESS
// ==================================================

function parseDestination(value) {

  const input =
    String(value || "").trim();

  if (!input) {
    throw new Error(
      "Wallet address is required."
    );
  }


  /*
   * IMPORTANT:
   *
   * The destination is ONLY an Address.
   *
   * We do NOT determine whether the destination
   * wallet is V4, V5, V3, etc.
   */

  return Address.parse(input);
}


// ==================================================
// CLIENT
// ==================================================

function createClient(env) {

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

async function createSenderWallet(env) {

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


  /*
   * Cloudflare Workers compatibility.
   */

  if (
    typeof globalThis.window ===
    "undefined"
  ) {
    globalThis.window =
      globalThis;
  }


  const cryptoModule =
    await import("@ton/crypto");


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
   * IMPORTANT:
   *
   * This is the wallet type confirmed by
   * the diagnostic test.
   */

  const wallet =
    WalletContractV5R1.create({

      workchain: 0,

      publicKey:
        keyPair.publicKey,

      walletId: {
        networkGlobalId: -239
      }
    });


  /*
   * Absolute safety check.
   *
   * Do not sign anything unless the derived wallet
   * is exactly the configured sender wallet.
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
    wallet,
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
// GET PTN JETTON WALLET
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
    createClient(env);


  // ----------------------------------------------
  // Create V5R1 sender from mnemonic
  // ----------------------------------------------

  const {
    wallet,
    keyPair
  } =
    await createSenderWallet(env);


  // ----------------------------------------------
  // Check TON balance
  // ----------------------------------------------

  const tonBalance =
    await checkTonBalance(
      client,
      wallet
    );


  // ----------------------------------------------
  // Get sender PTN Jetton Wallet
  // ----------------------------------------------

  const ptnWallet =
    await getPtnJettonWallet(
      client,
      wallet.address
    );


  // ----------------------------------------------
  // Check PTN balance
  // ----------------------------------------------

  const ptnBalance =
    await checkPtnBalance(
      ptnWallet,
      amount.nano
    );


  // ----------------------------------------------
  // Build Jetton transfer
  // ----------------------------------------------

  const queryId =
    BigInt(
      Date.now()
    );


  /*
   * Standard Jetton transfer body:
   *
   * opcode
   * query_id
   * amount
   * destination
   * response_destination
   * custom_payload
   * forward_ton_amount
   * forward_payload
   *
   * Destination is simply a TON Address.
   */

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

      .storeAddress(
        destination
      )

      .storeAddress(
        wallet.address
      )

      .storeBit(0)

      /*
       * TON attached to the Jetton transfer.
       * This pays the Jetton-wallet processing/forwarding
       * costs.
       */

      .storeCoins(
        toNano("0.01")
      )

      /*
       * No forward payload.
       */

      .storeBit(0)

      .endCell();


  const message =
    internal({

      to:
        ptnWallet.address,

      value:
        JETTON_TRANSFER_VALUE,

      bounce:
        true,

      body
    });


  // ----------------------------------------------
  // Open V5 wallet
  // ----------------------------------------------

  const senderContract =
    client.open(
      wallet
    );


  // ----------------------------------------------
  // Get current seqno
  // ----------------------------------------------

  const seqno =
    await senderContract.getSeqno();


  // ----------------------------------------------
  // Create and send V5R1 signed transfer
  // ----------------------------------------------

  await senderContract.sendTransfer({

    seqno,

    secretKey:
      keyPair.secretKey,

    messages: [
      message
    ],

    sendMode:
      SendMode.PAY_GAS_SEPARATELY,

    /*
     * V5 signed message validity.
     */

    timeout:
      Math.floor(
        Date.now() / 1000
      ) + 300
  });


  return {

    sender:
      wallet.address.toString({
        bounceable: true,
        urlSafe: true
      }),

    jettonWallet:
      ptnWallet.address.toString({
        bounceable: true,
        urlSafe: true
      }),

    destination:
      destination.toString({
        bounceable: true,
        urlSafe: true
      }),

    ptnAmount:
      amount.display,

    ptnAmountNano:
      amount.nano.toString(),

    queryId:
      queryId.toString(),

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
  // CANCEL COMMAND
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
  // MAIN MENU
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
  // STEP 1 - DESTINATION
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
          bounceable: true,
          urlSafe: true
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

    } catch (error) {

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
  // STEP 2 - PTN AMOUNT
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


    // --------------------------------------------
    // Confirmation
    // --------------------------------------------

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
              text: "✅ Confirm & Send",
              callback_data:
                "confirm_ptn"
            }
          ],
          [
            {
              text: "❌ Cancel",
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
// CONFIRM CALLBACK
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
   * Delete the session BEFORE sending.
   *
   * This prevents an accidental second click
   * from using the same session twice.
   */

  sessions.delete(
    chatId
  );


  await sendMessage(
    env,
    chatId,

    "⏳ Checking sender wallet, PTN balance and network fee...\n\n" +
    "No destination wallet version detection is used."
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
// TELEGRAM UPDATE
// ==================================================

async function handleTelegramUpdate(
  env,
  update
) {

  // ----------------------------------------------
  // Callback query
  // ----------------------------------------------

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


  // ----------------------------------------------
  // Message
  // ----------------------------------------------

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

      // --------------------------------------------
      // GET
      // --------------------------------------------

      if (
        request.method ===
        "GET"
      ) {

        return new Response(
          "PAYTON PTN Sender is running.",
          {
            status: 200
          }
        );
      }


      // --------------------------------------------
      // POST
      // --------------------------------------------

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
            status: 200
          }
        );
      }


      return new Response(
        "Method Not Allowed",
        {
          status: 405
        }
      );

    } catch (error) {

      return new Response(
        JSON.stringify({
          ok: false,

          error:
            String(
              error?.message ||
              error
            )
        }),
        {
          status: 500,

          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    }
  }
};
