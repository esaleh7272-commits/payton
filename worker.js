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

import {
  mnemonicToPrivateKey,
  mnemonicValidate
} from "@ton/crypto";

globalThis.Buffer = Buffer;


// ============================================================
// CONFIG
// ============================================================

const ADMIN_TELEGRAM_ID = "113074274";

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const PTN_DECIMALS = 9;

const TONCENTER_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";

const JETTON_TRANSFER_VALUE = toNano("0.05");

const MIN_SENDER_TON = toNano("0.10");


// ============================================================
// CLOUDFLARE-SAFE AXIOS ADAPTER
// ============================================================
//
// @ton/ton uses Axios internally.
//
// Axios 1.20.x can explicitly send:
//
//     cache: "default"
//
// Cloudflare Workers rejects that value.
//
// This adapter bypasses Axios' Fetch adapter and uses the
// Cloudflare fetch API directly with:
//
//     cache: "no-store"
//
// ============================================================

async function cloudflareFetchAdapter(config) {
  const controller = new AbortController();

  let timeoutId = null;

  if (config.timeout && config.timeout > 0) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, config.timeout);
  }

  try {
    const headers = new Headers();

    if (config.headers) {
      if (typeof config.headers.forEach === "function") {
        config.headers.forEach((value, key) => {
          if (value !== undefined && value !== null) {
            headers.set(key, String(value));
          }
        });
      } else {
        for (const [key, value] of Object.entries(config.headers)) {
          if (value !== undefined && value !== null) {
            headers.set(key, String(value));
          }
        }
      }
    }

    let body = config.data;

    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string"
    ) {
      body = JSON.stringify(body);
    }

    const method = String(config.method || "get").toUpperCase();

    const response = await fetch(config.url, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : body,
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal
    });

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    const responseHeaders = {};

    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (!response.ok) {
      throw new Error(
        `TON API HTTP ${response.status}: ${
          typeof data === "string"
            ? data
            : JSON.stringify(data)
        }`
      );
    }

    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      config,
      request: null
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("TON API request timed out.");
    }

    throw error;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}


// ============================================================
// TON CLIENT
// ============================================================

function createTonClient(env) {
  return new TonClient({
    endpoint: TONCENTER_ENDPOINT,
    apiKey: env.TONCENTER_API_KEY,
    timeout: 30000,
    httpAdapter: cloudflareFetchAdapter
  });
}


// ============================================================
// TELEGRAM
// ============================================================

async function telegram(env, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      cache: "no-store",
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram API error: ${
        data.description || "Unknown error"
      }`
    );
  }

  return data.result;
}


async function sendMessage(
  env,
  chatId,
  text,
  extra = {}
) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}


// ============================================================
// SESSION
// ============================================================

const sessions = new Map();

function getSession(userId) {
  return sessions.get(String(userId)) || null;
}

function setSession(userId, value) {
  sessions.set(String(userId), value);
}

function clearSession(userId) {
  sessions.delete(String(userId));
}


// ============================================================
// ADMIN CHECK
// ============================================================

function isAdmin(userId) {
  return String(userId) === ADMIN_TELEGRAM_ID;
}


// ============================================================
// ADDRESS
// ============================================================
//
// Destination is ONLY a TON MsgAddress.
//
// No V4/V5 detection is performed here.
// V4/V5 matters only for the sender wallet contract.
//

function parseDestination(value) {
  const input = String(value || "").trim();

  if (!input) {
    throw new Error("Wallet address is required.");
  }

  return Address.parse(input);
}


// ============================================================
// PTN AMOUNT
// ============================================================

function parsePtnAmount(value) {
  const input = String(value || "")
    .trim()
    .replace(/,/g, "");

  if (!/^\d+(\.\d{1,9})?$/.test(input)) {
    throw new Error(
      "Invalid PTN amount. Maximum 9 decimal places are allowed."
    );
  }

  const [whole, fraction = ""] = input.split(".");

  const fractionPadded = fraction
    .padEnd(PTN_DECIMALS, "0");

  const nanoString =
    whole + fractionPadded;

  const amount = BigInt(nanoString);

  if (amount <= 0n) {
    throw new Error("PTN amount must be greater than zero.");
  }

  return {
    nano: amount,
    display: input
  };
}


// ============================================================
// V5R1 SENDER WALLET
// ============================================================

async function createSenderWallet(env) {
  const mnemonic = String(
    env.PTN_MNEMONIC || ""
  ).trim();

  if (!mnemonic) {
    throw new Error(
      "PTN_MNEMONIC secret is not configured."
    );
  }

  const words = mnemonic
    .split(/\s+/)
    .filter(Boolean);

  if (!mnemonicValidate(words)) {
    throw new Error(
      "The configured PTN mnemonic is invalid."
    );
  }

  const keyPair =
    await mnemonicToPrivateKey(words);

  const wallet =
    WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
      walletId: {
        networkGlobalId: -239
      }
    });

  const configured =
    Address.parse(PTN_SENDER_WALLET);

  if (!wallet.address.equals(configured)) {
    throw new Error(
      "The configured mnemonic does not match the PTN sender wallet."
    );
  }

  return {
    wallet,
    keyPair
  };
}


// ============================================================
// PTN JETTON WALLET
// ============================================================

async function getPtnJettonWallet(
  client,
  senderAddress
) {
  const master =
    client.open(
      JettonMaster.create(
        Address.parse(PTN_MASTER)
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


// ============================================================
// SEND PTN
// ============================================================

async function sendPtn(
  env,
  destination,
  ptnAmount
) {
  const client = createTonClient(env);

  // ----------------------------------------------------------
  // Create and verify V5R1 sender
  // ----------------------------------------------------------

  const {
    wallet,
    keyPair
  } = await createSenderWallet(env);

  // ----------------------------------------------------------
  // Verify sender address
  // ----------------------------------------------------------

  if (
    !wallet.address.equals(
      Address.parse(PTN_SENDER_WALLET)
    )
  ) {
    throw new Error(
      "Sender wallet safety check failed."
    );
  }

  // ----------------------------------------------------------
  // Open sender wallet
  // ----------------------------------------------------------

  const senderContract =
    client.open(wallet);

  // ----------------------------------------------------------
  // Check TON balance
  // ----------------------------------------------------------

  const tonBalance =
    await senderContract.getBalance();

  if (tonBalance < MIN_SENDER_TON) {
    throw new Error(
      "Insufficient TON balance for network fees."
    );
  }

  // ----------------------------------------------------------
  // Find sender PTN Jetton wallet
  // ----------------------------------------------------------

  const jettonWallet =
    await getPtnJettonWallet(
      client,
      wallet.address
    );

  // ----------------------------------------------------------
  // Check PTN balance
  // ----------------------------------------------------------

  const ptnBalance =
    await jettonWallet.getBalance();

  if (ptnBalance < ptnAmount.nano) {
    const available =
      Number(ptnBalance) /
      10 ** PTN_DECIMALS;

    throw new Error(
      `Insufficient PTN balance. Available: ${available} PTN.`
    );
  }

  // ----------------------------------------------------------
  // Create Jetton transfer payload
  // ----------------------------------------------------------

  const queryId =
    BigInt(Date.now());

  const transferBody =
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
        ptnAmount.nano
      )
      .storeAddress(
        destination
      )
      .storeAddress(
        wallet.address
      )
      .storeBit(0)
      .storeCoins(
        toNano("0.01")
      )
      .storeBit(0)
      .endCell();

  // ----------------------------------------------------------
  // Get current seqno
  // ----------------------------------------------------------

  const seqno =
    await senderContract.getSeqno();

  // ----------------------------------------------------------
  // Send V5R1 transaction
  // ----------------------------------------------------------

  await senderContract.sendTransfer({
    seqno,

    secretKey:
      keyPair.secretKey,

    sendMode:
      SendMode.PAY_GAS_SEPARATELY,

    messages: [
      internal({
        to: jettonWallet.address,

        value:
          JETTON_TRANSFER_VALUE,

        body:
          transferBody
      })
    ]
  });

  return {
    sender: wallet.address.toString({
      bounceable: false,
      urlSafe: true
    }),

    destination:
      destination.toString({
        bounceable: false,
        urlSafe: true
      }),

    amount:
      ptnAmount.display,

    seqno
  };
}


// ============================================================
// START MENU
// ============================================================

async function showMenu(
  env,
  chatId
) {
  return sendMessage(
    env,
    chatId,
    "PAYTON PTN Sender\n\nChoose an action:",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💸 Manual PTN Payment",
              callback_data: "manual_ptn"
            }
          ]
        ]
      }
    }
  );
}


// ============================================================
// HANDLE CALLBACK
// ============================================================

async function handleCallback(
  env,
  callback
) {
  const data =
    callback.data || "";

  const userId =
    callback.from?.id;

  const chatId =
    callback.message?.chat?.id;

  if (!isAdmin(userId)) {
    return;
  }

  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callback.id
    }
  );

  if (data === "manual_ptn") {
    setSession(userId, {
      step: "destination"
    });

    await sendMessage(
      env,
      chatId,
      "Enter the destination TON wallet address:"
    );

    return;
  }

  if (data === "confirm_send") {
    const session =
      getSession(userId);

    if (
      !session ||
      session.step !== "confirm"
    ) {
      await sendMessage(
        env,
        chatId,
        "This payment session has expired. Please start again."
      );

      return;
    }

    const statusMessage =
      await sendMessage(
        env,
        chatId,
        "⏳ Checking sender wallet, PTN balance and network fee..."
      );

    try {
      const result =
        await sendPtn(
          env,
          session.destination,
          session.amount
        );

      clearSession(userId);

      await sendMessage(
        env,
        chatId,
        [
          "✅ PTN transfer submitted successfully.",
          "",
          `Amount: ${result.amount} PTN`,
          `Destination: ${result.destination}`,
          `Seqno: ${result.seqno}`,
          "",
          "The transaction has been sent to the TON network."
        ].join("\n")
      );
    } catch (error) {
      console.error(
        "PTN transfer failed:",
        error
      );

      await sendMessage(
        env,
        chatId,
        [
          "❌ PTN transfer failed.",
          "",
          error?.message ||
            "Unknown transfer error.",
          "",
          "No successful PTN transfer was confirmed by this bot."
        ].join("\n")
      );
    }

    return;
  }

  if (data === "cancel_send") {
    clearSession(userId);

    await sendMessage(
      env,
      chatId,
      "❌ Payment cancelled."
    );

    await showMenu(
      env,
      chatId
    );

    return;
  }
}


// ============================================================
// HANDLE MESSAGE
// ============================================================

async function handleMessage(
  env,
  message
) {
  const userId =
    message.from?.id;

  const chatId =
    message.chat?.id;

  const text =
    String(message.text || "")
      .trim();

  if (!isAdmin(userId)) {
    return;
  }

  if (text === "/start") {
    clearSession(userId);

    await showMenu(
      env,
      chatId
    );

    return;
  }

  const session =
    getSession(userId);

  if (!session) {
    await showMenu(
      env,
      chatId
    );

    return;
  }

  // ----------------------------------------------------------
  // Destination
  // ----------------------------------------------------------

  if (
    session.step ===
    "destination"
  ) {
    try {
      const destination =
        parseDestination(text);

      setSession(userId, {
        step: "amount",
        destination
      });

      await sendMessage(
        env,
        chatId,
        "Enter the PTN amount to send:"
      );
    } catch (error) {
      await sendMessage(
        env,
        chatId,
        `❌ ${error.message}\n\nPlease enter a valid TON wallet address.`
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // Amount
  // ----------------------------------------------------------

  if (
    session.step ===
    "amount"
  ) {
    try {
      const amount =
        parsePtnAmount(text);

      setSession(userId, {
        step: "confirm",
        destination:
          session.destination,
        amount
      });

      const destinationText =
        session.destination.toString({
          bounceable: false,
          urlSafe: true
        });

      await sendMessage(
        env,
        chatId,
        [
          "Confirm PTN payment:",
          "",
          `Destination: ${destinationText}`,
          `PTN amount: ${amount.display} PTN`,
          "",
          "The PTN will be sent from the configured PAYTON sender wallet."
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm & Send",
                  callback_data:
                    "confirm_send"
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data:
                    "cancel_send"
                }
              ]
            ]
          }
        }
      );
    } catch (error) {
      await sendMessage(
        env,
        chatId,
        `❌ ${error.message}\n\nEnter the PTN amount again.`
      );
    }

    return;
  }
}


// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {
    try {
      if (request.method !== "POST") {
        return new Response(
          "PAYTON PTN Sender is running.",
          {
            status: 200,
            headers: {
              "cache-control":
                "no-store"
            }
          }
        );
      }

      const update =
        await request.json();

      if (update.callback_query) {
        await handleCallback(
          env,
          update.callback_query
        );
      } else if (update.message) {
        await handleMessage(
          env,
          update.message
        );
      }

      return new Response(
        "OK",
        {
          status: 200,
          headers: {
            "cache-control":
              "no-store"
          }
        }
      );
    } catch (error) {
      console.error(
        "Worker error:",
        error
      );

      return new Response(
        "OK",
        {
          status: 200,
          headers: {
            "cache-control":
              "no-store"
          }
        }
      );
    }
  }
};
