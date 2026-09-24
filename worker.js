// ============================================================
// PAYTON PTN MANUAL SENDER
// Cloudflare Workers
// V5R1 Sender
// Cloudflare-safe TON RPC
// ============================================================


// ============================================================
// CLOUDFLARE / BROWSER COMPATIBILITY
// ============================================================
//
// IMPORTANT:
// @ton/crypto may expect a browser-like "window" object
// during module initialization.
//
// We MUST create it BEFORE dynamically importing TON libraries.
//
// Static imports are intentionally NOT used in this file.
// ============================================================

if (
  typeof globalThis.window === "undefined"
) {
  globalThis.window = globalThis;
}


// ============================================================
// GLOBAL STATE
// ============================================================

const sessions = new Map();


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

const JETTON_TRANSFER_VALUE =
  "0.05";

const MIN_SENDER_TON =
  "0.10";


// ============================================================
// DYNAMIC TON LIBRARY LOADING
// ============================================================
//
// These imports happen AFTER globalThis.window is prepared.
//
// This is the important fix for:
// "window is not defined"
// ============================================================

let tonCore;
let tonTon;
let tonCrypto;
let bufferModule;

let librariesPromise = null;


async function loadLibraries() {
  if (librariesPromise) {
    return librariesPromise;
  }

  librariesPromise =
    (async () => {

      const [
        core,
        ton,
        crypto,
        buffer
      ] = await Promise.all([
        import("@ton/core"),
        import("@ton/ton"),
        import("@ton/crypto"),
        import("buffer")
      ]);

      tonCore = core;
      tonTon = ton;
      tonCrypto = crypto;
      bufferModule = buffer;

      // Browser compatibility for TON libraries
      if (
        typeof globalThis.Buffer === "undefined"
      ) {
        globalThis.Buffer =
          bufferModule.Buffer;
      }

      return true;
    })();

  return librariesPromise;
}


// ============================================================
// CLOUDFLARE-SAFE HTTP ADAPTER
// ============================================================

async function cloudflareFetchAdapter(config) {

  const controller =
    new AbortController();

  let timeoutId = null;

  if (
    config.timeout &&
    config.timeout > 0
  ) {
    timeoutId = setTimeout(
      () => controller.abort(),
      config.timeout
    );
  }

  try {

    const headers =
      new Headers();

    if (config.headers) {

      if (
        typeof config.headers.forEach ===
        "function"
      ) {

        config.headers.forEach(
          (value, key) => {

            if (
              value !== undefined &&
              value !== null
            ) {
              headers.set(
                key,
                String(value)
              );
            }
          }
        );

      } else {

        for (
          const [key, value]
          of Object.entries(config.headers)
        ) {

          if (
            value !== undefined &&
            value !== null
          ) {
            headers.set(
              key,
              String(value)
            );
          }
        }
      }
    }

    let body =
      config.data;

    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string"
    ) {
      body =
        JSON.stringify(body);
    }

    const method =
      String(
        config.method || "get"
      ).toUpperCase();

    const response =
      await fetch(
        config.url,
        {
          method,
          headers,

          body:
            method === "GET" ||
            method === "HEAD"
              ? undefined
              : body,

          redirect: "follow",

          // Cloudflare Workers supported mode
          cache: "no-store",

          signal:
            controller.signal
        }
      );

    const text =
      await response.text();

    let data;

    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      data = text;
    }

    const responseHeaders = {};

    response.headers.forEach(
      (value, key) => {
        responseHeaders[key] =
          value;
      }
    );

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
      status:
        response.status,
      statusText:
        response.statusText,
      headers:
        responseHeaders,
      config,
      request: null
    };

  } catch (error) {

    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        "TON API request timed out."
      );
    }

    throw error;

  } finally {

    if (
      timeoutId !== null
    ) {
      clearTimeout(
        timeoutId
      );
    }
  }
}


// ============================================================
// TON CLIENT
// ============================================================

function createTonClient(env) {

  const {
    TonClient
  } = tonTon;

  return new TonClient({

    endpoint:
      TONCENTER_ENDPOINT,

    apiKey:
      env.TONCENTER_API_KEY,

    timeout:
      30000,

    httpAdapter:
      cloudflareFetchAdapter
  });
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(
  env,
  method,
  body
) {

  const response =
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        cache:
          "no-store",

        body:
          JSON.stringify(body)
      }
    );

  const data =
    await response.json();

  if (!data.ok) {

    throw new Error(
      `Telegram API error: ${
        data.description ||
        "Unknown error"
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

  return telegram(
    env,
    "sendMessage",
    {
      chat_id:
        chatId,

      text,

      ...extra
    }
  );
}


// ============================================================
// ADMIN
// ============================================================

function isAdmin(userId) {

  return (
    String(userId) ===
    ADMIN_TELEGRAM_ID
  );
}


// ============================================================
// SESSION
// ============================================================

function getSession(userId) {

  return sessions.get(
    String(userId)
  ) || null;
}


function setSession(
  userId,
  value
) {

  sessions.set(
    String(userId),
    value
  );
}


function clearSession(
  userId
) {

  sessions.delete(
    String(userId)
  );
}


// ============================================================
// DESTINATION ADDRESS
// ============================================================
//
// Destination is ONLY a TON address.
// No V4/V5 detection.
// No wallet-version logic.
// ============================================================

function parseDestination(
  value
) {

  const {
    Address
  } = tonCore;

  const input =
    String(value || "")
      .trim();

  if (!input) {

    throw new Error(
      "Wallet address is required."
    );
  }

  return Address.parse(
    input
  );
}


// ============================================================
// PTN AMOUNT
// ============================================================

function parsePtnAmount(
  value
) {

  const input =
    String(value || "")
      .trim()
      .replace(/,/g, "");

  if (
    !/^\d+(\.\d{1,9})?$/.test(
      input
    )
  ) {

    throw new Error(
      "Invalid PTN amount. Maximum 9 decimal places are allowed."
    );
  }

  const [
    whole,
    fraction = ""
  ] =
    input.split(".");

  const fractionPadded =
    fraction.padEnd(
      PTN_DECIMALS,
      "0"
    );

  const nanoString =
    whole +
    fractionPadded;

  const nano =
    BigInt(nanoString);

  if (nano <= 0n) {

    throw new Error(
      "PTN amount must be greater than zero."
    );
  }

  return {
    nano,
    display:
      input
  };
}


// ============================================================
// CREATE V5R1 SENDER
// ============================================================

async function createSenderWallet(
  env
) {

  const mnemonic =
    String(
      env.PTN_MNEMONIC ||
      ""
    ).trim();

  if (!mnemonic) {

    throw new Error(
      "PTN_MNEMONIC secret is not configured."
    );
  }

  const words =
    mnemonic
      .split(/\s+/)
      .filter(Boolean);

  const {
    mnemonicValidate,
    mnemonicToPrivateKey
  } = tonCrypto;

  const valid =
    await mnemonicValidate(
      words
    );

  if (!valid) {

    throw new Error(
      "The configured PTN mnemonic is invalid."
    );
  }

  const keyPair =
    await mnemonicToPrivateKey(
      words
    );

  const {
    WalletContractV5R1
  } = tonTon;

  const {
    Address
  } = tonCore;

  const wallet =
    WalletContractV5R1.create({

      workchain: 0,

      publicKey:
        keyPair.publicKey,

      walletId: {
        networkGlobalId:
          -239
      }
    });

  const configured =
    Address.parse(
      PTN_SENDER_WALLET
    );

  // ----------------------------------------------------------
  // SAFETY CHECK
  // ----------------------------------------------------------

  if (
    !wallet.address.equals(
      configured
    )
  ) {

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

  const {
    Address
  } = tonCore;

  const {
    JettonMaster,
    JettonWallet
  } = tonTon;

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


// ============================================================
// SEND PTN
// ============================================================

async function sendPtn(
  env,
  destination,
  ptnAmount
) {

  await loadLibraries();

  const {
    Address,
    beginCell,
    internal,
    SendMode,
    toNano
  } = tonCore;

  // ----------------------------------------------------------
  // TON CLIENT
  // ----------------------------------------------------------

  const client =
    createTonClient(env);

  // ----------------------------------------------------------
  // SENDER
  // ----------------------------------------------------------

  const {
    wallet,
    keyPair
  } =
    await createSenderWallet(
      env
    );

  // ----------------------------------------------------------
  // SAFETY CHECK
  // ----------------------------------------------------------

  if (
    !wallet.address.equals(
      Address.parse(
        PTN_SENDER_WALLET
      )
    )
  ) {

    throw new Error(
      "Sender wallet safety check failed."
    );
  }

  // ----------------------------------------------------------
  // OPEN SENDER
  // ----------------------------------------------------------

  const senderContract =
    client.open(
      wallet
    );

  // ----------------------------------------------------------
  // TON BALANCE
  // ----------------------------------------------------------

  const tonBalance =
    await senderContract.getBalance();

  if (
    tonBalance <
    toNano(
      MIN_SENDER_TON
    )
  ) {

    throw new Error(
      "Insufficient TON balance for network fees."
    );
  }

  // ----------------------------------------------------------
  // PTN JETTON WALLET
  // ----------------------------------------------------------

  const jettonWallet =
    await getPtnJettonWallet(
      client,
      wallet.address
    );

  // ----------------------------------------------------------
  // PTN BALANCE
  // ----------------------------------------------------------

  const ptnBalance =
    await jettonWallet.getBalance();

  if (
    ptnBalance <
    ptnAmount.nano
  ) {

    const available =
      Number(ptnBalance) /
      10 ** PTN_DECIMALS;

    throw new Error(
      `Insufficient PTN balance. Available: ${available} PTN.`
    );
  }

  // ----------------------------------------------------------
  // JETTON TRANSFER BODY
  // ----------------------------------------------------------

  const queryId =
    BigInt(
      Date.now()
    );

  const transferBody =
    beginCell()

      // Jetton transfer opcode
      .storeUint(
        0x0f8a7ea5,
        32
      )

      // Query ID
      .storeUint(
        queryId,
        64
      )

      // PTN amount
      .storeCoins(
        ptnAmount.nano
      )

      // Destination
      .storeAddress(
        destination
      )

      // Response destination
      .storeAddress(
        wallet.address
      )

      // No custom payload
      .storeBit(0)

      // Forward TON amount
      .storeCoins(
        toNano("0.01")
      )

      // No forward payload
      .storeBit(0)

      .endCell();

  // ----------------------------------------------------------
  // SEQNO
  // ----------------------------------------------------------

  const seqno =
    await senderContract.getSeqno();

  // ----------------------------------------------------------
  // SEND
  // ----------------------------------------------------------

  await senderContract.sendTransfer({

    seqno,

    secretKey:
      keyPair.secretKey,

    sendMode:
      SendMode.PAY_GAS_SEPARATELY,

    messages: [

      internal({

        to:
          jettonWallet.address,

        value:
          toNano(
            JETTON_TRANSFER_VALUE
          ),

        body:
          transferBody
      })

    ]
  });

  return {

    sender:
      wallet.address.toString({
        bounceable:
          false,
        urlSafe:
          true
      }),

    destination:
      destination.toString({
        bounceable:
          false,
        urlSafe:
          true
      }),

    amount:
      ptnAmount.display,

    seqno
  };
}


// ============================================================
// MENU
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
              text:
                "💸 Manual PTN Payment",

              callback_data:
                "manual_ptn"
            }
          ]

        ]
      }
    }
  );
}


// ============================================================
// CALLBACK HANDLER
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

  if (
    !isAdmin(userId)
  ) {
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

  // ----------------------------------------------------------
  // MANUAL PTN
  // ----------------------------------------------------------

  if (
    data === "manual_ptn"
  ) {

    setSession(
      userId,
      {
        step:
          "destination"
      }
    );

    await sendMessage(
      env,
      chatId,

      "Enter the destination TON wallet address:"
    );

    return;
  }

  // ----------------------------------------------------------
  // CANCEL
  // ----------------------------------------------------------

  if (
    data === "cancel_send"
  ) {

    clearSession(
      userId
    );

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

  // ----------------------------------------------------------
  // CONFIRM
  // ----------------------------------------------------------

  if (
    data === "confirm_send"
  ) {

    const session =
      getSession(
        userId
      );

    if (
      !session ||
      session.step !==
        "confirm"
    ) {

      await sendMessage(
        env,
        chatId,

        "This payment session has expired. Please start again."
      );

      return;
    }

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

      clearSession(
        userId
      );

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
}


// ============================================================
// MESSAGE HANDLER
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
    String(
      message.text || ""
    ).trim();

  if (
    !isAdmin(userId)
  ) {
    return;
  }

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  if (
    text === "/start"
  ) {

    clearSession(
      userId
    );

    await showMenu(
      env,
      chatId
    );

    return;
  }

  const session =
    getSession(
      userId
    );

  if (!session) {

    await showMenu(
      env,
      chatId
    );

    return;
  }

  // ----------------------------------------------------------
  // DESTINATION
  // ----------------------------------------------------------

  if (
    session.step ===
    "destination"
  ) {

    try {

      const destination =
        parseDestination(
          text
        );

      setSession(
        userId,
        {
          step:
            "amount",

          destination
        }
      );

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
  // AMOUNT
  // ----------------------------------------------------------

  if (
    session.step ===
    "amount"
  ) {

    try {

      const amount =
        parsePtnAmount(
          text
        );

      setSession(
        userId,
        {
          step:
            "confirm",

          destination:
            session.destination,

          amount
        }
      );

      const destinationText =
        session.destination.toString({
          bounceable:
            false,

          urlSafe:
            true
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
                  text:
                    "✅ Confirm & Send",

                  callback_data:
                    "confirm_send"
                }
              ],

              [
                {
                  text:
                    "❌ Cancel",

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
// WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    try {

      // Make sure the libraries are initialized
      // after the window compatibility layer.
      await loadLibraries();

      if (
        request.method !==
        "POST"
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

      const update =
        await request.json();

      if (
        update.callback_query
      ) {

        await handleCallback(
          env,
          update.callback_query
        );

      } else if (
        update.message
      ) {

        await handleMessage(
          env,
          update.message
        );
      }

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

    } catch (error) {

      console.error(
        "Worker error:",
        error
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
  }
};
