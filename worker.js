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
  WalletContractV4,
  WalletContractV5R1,
  JettonMaster
} from "@ton/ton";

globalThis.Buffer = Buffer;

/* =========================================================
   PAYTON - MANUAL PTN PAYMENT ONLY
========================================================= */

const ADMIN_TELEGRAM_ID = "113074274";

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const PTN_DECIMALS = 9;

const MIN_GAS_BALANCE =
  toNano("0.20");

const TONCENTER_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";


/* =========================================================
   MENU
========================================================= */

const MENU = {
  inline_keyboard: [
    [
      {
        text: "💸 Manual PTN Payment",
        callback_data: "manual_ptn"
      }
    ]
  ]
};

const CANCEL_MENU = {
  inline_keyboard: [
    [
      {
        text: "❌ Cancel",
        callback_data: "cancel"
      }
    ]
  ]
};


/* =========================================================
   TELEGRAM API
========================================================= */

async function telegram(
  env,
  method,
  body
) {
  if (!env.BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN is missing."
    );
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body:
          JSON.stringify(body)
      }
    );

  const data =
    await response.json()
      .catch(() => null);

  if (
    !response.ok ||
    data?.ok === false
  ) {
    throw new Error(
      data?.description ||
      `Telegram ${method} failed.`
    );
  }

  return data;
}


/* =========================================================
   DATABASE STATE
========================================================= */

async function ensureStateTable(
  env
) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manual_ptn_state (
      telegram_id TEXT PRIMARY KEY,
      mode TEXT,
      destination TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}


async function setState(
  env,
  mode,
  destination = null
) {
  await ensureStateTable(env);

  await env.DB.prepare(`
    INSERT INTO manual_ptn_state
      (
        telegram_id,
        mode,
        destination,
        updated_at
      )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)

    ON CONFLICT(telegram_id)
    DO UPDATE SET
      mode=excluded.mode,
      destination=excluded.destination,
      updated_at=CURRENT_TIMESTAMP
  `)
    .bind(
      ADMIN_TELEGRAM_ID,
      mode,
      destination
    )
    .run();
}


async function getState(
  env
) {
  await ensureStateTable(env);

  return await env.DB.prepare(`
    SELECT
      mode,
      destination
    FROM manual_ptn_state
    WHERE telegram_id=?
    LIMIT 1
  `)
    .bind(
      ADMIN_TELEGRAM_ID
    )
    .first();
}


async function clearState(
  env
) {
  await ensureStateTable(env);

  await env.DB.prepare(`
    DELETE FROM manual_ptn_state
    WHERE telegram_id=?
  `)
    .bind(
      ADMIN_TELEGRAM_ID
    )
    .run();
}


/* =========================================================
   PTN AMOUNT PARSER
========================================================= */

function parsePtnAmount(
  value
) {
  const input =
    String(value || "")
      .trim();

  if (
    !/^\d+(?:\.\d{1,9})?$/.test(
      input
    )
  ) {
    throw new Error(
      "Invalid PTN amount. Use a positive number with up to 9 decimal places."
    );
  }

  const parts =
    input.split(".");

  const whole =
    BigInt(parts[0]);

  const fraction =
    (parts[1] || "")
      .padEnd(
        PTN_DECIMALS,
        "0"
      );

  const amount =
    whole *
      (10n **
        BigInt(PTN_DECIMALS)) +
    BigInt(fraction);

  if (amount <= 0n) {
    throw new Error(
      "PTN amount must be greater than zero."
    );
  }

  return {
    units: amount,
    display: input
  };
}


/* =========================================================
   DESTINATION ADDRESS
========================================================= */

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
    IMPORTANT:

    The destination is ONLY parsed as a TON address.

    We do NOT determine whether the destination
    wallet is V4, V5, V3, or anything else.

    It is simply the Jetton recipient address.
  */

  return Address.parse(
    input
  );
}


/* =========================================================
   DERIVE TON KEY FROM MNEMONIC
========================================================= */

async function getKeyPair(
  env
) {
  const mnemonic =
    String(
      env.PTN_MNEMONIC || ""
    ).trim();

  if (!mnemonic) {
    throw new Error(
      "PTN_MNEMONIC is missing from Cloudflare Secrets."
    );
  }

  const words =
    mnemonic.split(/\s+/);

  if (
    words.length !== 12 &&
    words.length !== 24
  ) {
    throw new Error(
      `PTN_MNEMONIC must contain 12 or 24 words. Found ${words.length}.`
    );
  }

  /*
    @ton/crypto uses browser-style crypto
    internally for TON mnemonic derivation.

    In Cloudflare Workers we expose the Worker
    global as "window" before dynamically loading
    the module.
  */

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

  const keyPair =
    await cryptoModule.mnemonicToPrivateKey(
      words
    );

  return keyPair;
}


/* =========================================================
   FIND THE ACTUAL SENDER WALLET
========================================================= */

function getSenderWallet(
  keyPair
) {
  /*
    First check V4R2.

    TON official documentation:
    default V4R2 wallet_id =
    0x29a9a317
  */

  const v4 =
    WalletContractV4.create({
      workchain: 0,
      publicKey:
        keyPair.publicKey,
      walletId:
        0x29a9a317
    });

  if (
    v4.address.toString() ===
    PTN_SENDER_WALLET
  ) {
    return {
      type: "V4R2",
      wallet: v4
    };
  }


  /*
    Then check V5R1 mainnet.

    Mainnet networkGlobalId = -239
  */

  const v5 =
    WalletContractV5R1.create({
      workchain: 0,
      publicKey:
        keyPair.publicKey,
      walletId: {
        networkGlobalId:
          -239
      }
    });

  if (
    v5.address.toString() ===
    PTN_SENDER_WALLET
  ) {
    return {
      type: "V5R1",
      wallet: v5
    };
  }


  /*
    Never send if the mnemonic does not
    produce the configured sender address.
  */

  throw new Error(
    "The configured mnemonic does not match the PTN sender wallet in V4R2 or V5R1. No transaction was sent."
  );
}


/* =========================================================
   SEND MANUAL PTN
========================================================= */

async function sendManualPTN(
  env,
  destination,
  amount
) {
  try {

    /* -----------------------------------------
       KEY
    ----------------------------------------- */

    const keyPair =
      await getKeyPair(env);


    /* -----------------------------------------
       FIND REAL SENDER VERSION
    ----------------------------------------- */

    const sender =
      getSenderWallet(
        keyPair
      );

    const senderWallet =
      sender.wallet;


    console.log(
      `PTN SENDER VERSION: ${sender.type}`
    );

    console.log(
      `PTN SENDER ADDRESS: ${senderWallet.address.toString()}`
    );


    /* -----------------------------------------
       TON CLIENT
    ----------------------------------------- */

    const client =
      new TonClient({
        endpoint:
          TONCENTER_ENDPOINT,
        apiKey:
          env.TONCENTER_API_KEY
      });


    /* -----------------------------------------
       DEPLOYMENT
    ----------------------------------------- */

    const deployed =
      await client.isContractDeployed(
        senderWallet.address
      );

    if (!deployed) {
      throw new Error(
        "The PTN sender wallet is not deployed."
      );
    }


    /* -----------------------------------------
       NATIVE GRAM BALANCE
    ----------------------------------------- */

    const nativeBalance =
      await client.getBalance(
        senderWallet.address
      );

    if (
      nativeBalance <
      MIN_GAS_BALANCE
    ) {
      throw new Error(
        "Insufficient native GRAM balance for network fees."
      );
    }


    /* -----------------------------------------
       PTN MASTER
    ----------------------------------------- */

    const master =
      client.open(
        JettonMaster.create(
          Address.parse(
            PTN_MASTER
          )
        )
      );


    /* -----------------------------------------
       SENDER PTN WALLET
    ----------------------------------------- */

    const senderJettonWallet =
      client.open(
        await master.getWalletAddress(
          senderWallet.address
        )
      );


    /* -----------------------------------------
       PTN BALANCE
    ----------------------------------------- */

    const senderPtnBalance =
      await senderJettonWallet
        .getJettonBalance();

    if (
      senderPtnBalance <
      amount
    ) {
      throw new Error(
        "Insufficient PTN balance in the sender wallet."
      );
    }


    /* -----------------------------------------
       DESTINATION JETTON WALLET
       
       IMPORTANT:
       The destination is only an Address.
       No V4/V5 check is performed.
    ----------------------------------------- */

    const destinationJettonWallet =
      await master.getWalletAddress(
        destination
      );


    /* -----------------------------------------
       UNIQUE QUERY ID
    ----------------------------------------- */

    const random =
      crypto.getRandomValues(
        new Uint32Array(1)
      )[0];

    const queryId =
      (BigInt(Date.now()) <<
        20n) |
      BigInt(
        random & 0xFFFFF
      );


    /* -----------------------------------------
       JETTON TRANSFER BODY
    ----------------------------------------- */

    const body =
      beginCell()

        /*
          transfer opcode
        */
        .storeUint(
          0x0f8a7ea5,
          32
        )

        /*
          query_id
        */
        .storeUint(
          queryId,
          64
        )

        /*
          PTN amount in smallest units
        */
        .storeCoins(
          amount
        )

        /*
          DESTINATION ONLY

          No V4/V5 information here.
        */
        .storeAddress(
          destination
        )

        /*
          response destination
        */
        .storeAddress(
          senderWallet.address
        )

        /*
          no custom payload
        */
        .storeBit(0)

        /*
          forward TON amount
        */
        .storeCoins(
          toNano("0.05")
        )

        /*
          no forward payload
        */
        .storeBit(0)

        .endCell();


    /* -----------------------------------------
       OPEN WALLET
    ----------------------------------------- */

    const wallet =
      client.open(
        senderWallet
      );


    /* -----------------------------------------
       SEQNO
    ----------------------------------------- */

    const seqno =
      await wallet.getSeqno();


    /* -----------------------------------------
       SEND
    ----------------------------------------- */

    await wallet.sendTransfer({
      seqno,

      secretKey:
        keyPair.secretKey,

      sendMode:
        SendMode.PAY_GAS_SEPARATELY,

      messages: [
        internal({
          to:
            destinationJettonWallet,

          value:
            toNano("0.10"),

          body
        })
      ]
    });


    return {
      success: true,

      senderVersion:
        sender.type,

      senderAddress:
        senderWallet.address.toString(),

      destination:
        destination.toString(),

      queryId:
        queryId.toString()
    };

  } catch (error) {

    console.error(
      "MANUAL PTN SEND ERROR:",
      error?.message ||
      String(error)
    );

    return {
      success: false,

      error:
        error?.message ||
        String(error)
    };
  }
}


/* =========================================================
   ADMIN MENU
========================================================= */

async function sendAdminMenu(
  env,
  chatId,
  text =
    "🛠 PAYTON Admin Panel"
) {
  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        chatId,

      text,

      reply_markup:
        MENU
    }
  );
}


/* =========================================================
   CALLBACK HANDLER
========================================================= */

async function handleCallback(
  env,
  query
) {
  const userId =
    String(
      query.from?.id || ""
    );

  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        query.id
    }
  ).catch(() => {});


  /* ONLY ADMIN */

  if (
    userId !==
    ADMIN_TELEGRAM_ID
  ) {
    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          query.message.chat.id,

        text:
          "❌ Access denied."
      }
    );

    return;
  }


  /* -----------------------------------------
     MANUAL PTN
  ----------------------------------------- */

  if (
    query.data ===
    "manual_ptn"
  ) {
    await setState(
      env,
      "destination"
    );

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          query.message.chat.id,

        text:
          "💸 Manual PTN Payment\n\n" +
          "Send the destination TON wallet address.\n\n" +
          "The destination wallet version does not matter.\n\n" +
          "Send /cancel to cancel.",

        reply_markup:
          CANCEL_MENU
      }
    );

    return;
  }


  /* -----------------------------------------
     CANCEL
  ----------------------------------------- */

  if (
    query.data ===
    "cancel"
  ) {
    await clearState(
      env
    );

    await sendAdminMenu(
      env,
      query.message.chat.id,
      "❌ Cancelled.\n\n🛠 PAYTON Admin Panel"
    );

    return;
  }
}


/* =========================================================
   ADMIN MESSAGE HANDLER
========================================================= */

async function handleAdminMessage(
  env,
  message
) {
  const text =
    String(
      message.text || ""
    ).trim();


  if (!text) {
    return;
  }


  /* -----------------------------------------
     CANCEL
  ----------------------------------------- */

  if (
    text ===
    "/cancel"
  ) {
    await clearState(
      env
    );

    await sendAdminMenu(
      env,
      message.chat.id,
      "❌ Cancelled.\n\n🛠 PAYTON Admin Panel"
    );

    return;
  }


  /* -----------------------------------------
     STATE
  ----------------------------------------- */

  const state =
    await getState(env);


  /* -----------------------------------------
     DESTINATION
  ----------------------------------------- */

  if (
    state?.mode ===
    "destination"
  ) {
    try {

      const destination =
        parseDestination(
          text
        );


      await setState(
        env,
        "amount",
        destination.toString()
      );


      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            message.chat.id,

          text:
            "✅ Destination address accepted.\n\n" +
            "Now send the PTN amount.\n\n" +
            "Example: 1000000\n\n" +
            "Maximum 9 decimal places.\n\n" +
            "Send /cancel to cancel.",

          reply_markup:
            CANCEL_MENU
        }
      );

    } catch (error) {

      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            message.chat.id,

          text:
            "❌ Invalid TON wallet address.\n\n" +
            "Please send the destination address again.\n\n" +
            "Send /cancel to cancel.",

          reply_markup:
            CANCEL_MENU
        }
      );
    }

    return;
  }


  /* -----------------------------------------
     AMOUNT
  ----------------------------------------- */

  if (
    state?.mode ===
    "amount"
  ) {

    let parsed;

    try {

      parsed =
        parsePtnAmount(
          text
        );

    } catch (error) {

      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            message.chat.id,

          text:
            `❌ ${
              error?.message ||
              "Invalid PTN amount."
            }\n\n` +
            "Send the PTN amount again or /cancel.",

          reply_markup:
            CANCEL_MENU
        }
      );

      return;
    }


    let destination;

    try {

      destination =
        Address.parse(
          state.destination
        );

    } catch {

      await clearState(
        env
      );

      await sendAdminMenu(
        env,
        message.chat.id,
        "❌ The destination address is invalid. Please start again."
      );

      return;
    }


    /* -----------------------------------------
       SHOW CHECKING
    ----------------------------------------- */

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          message.chat.id,

        text:
          "⏳ Checking sender wallet, PTN balance and network fee..."
      }
    );


    /* -----------------------------------------
       SEND
    ----------------------------------------- */

    const result =
      await sendManualPTN(
        env,
        destination,
        parsed.units
      );


    await clearState(
      env
    );


    /* -----------------------------------------
       SUCCESS
    ----------------------------------------- */

    if (
      result.success
    ) {

      await sendAdminMenu(
        env,
        message.chat.id,

        "✅ PTN transfer submitted successfully.\n\n" +

        `Amount: ${parsed.display} PTN\n` +

        `Destination:\n${destination.toString()}\n\n` +

        `Sender wallet:\n${result.senderAddress}\n\n` +

        `Sender wallet type: ${result.senderVersion}\n\n` +

        `Query ID:\n${result.queryId}\n\n` +

        "The PTN transfer has been submitted to the TON network."
      );

      return;
    }


    /* -----------------------------------------
       ERROR
    ----------------------------------------- */

    await sendAdminMenu(
      env,
      message.chat.id,

      "❌ PTN transfer failed.\n\n" +

      `${result.error}\n\n` +

      "No PTN transfer was submitted."
    );
  }
}


/* =========================================================
   UPDATE HANDLER
========================================================= */

async function handleUpdate(
  env,
  update
) {

  /* -----------------------------------------
     CALLBACK
  ----------------------------------------- */

  if (
    update.callback_query
  ) {
    await handleCallback(
      env,
      update.callback_query
    );

    return;
  }


  /* -----------------------------------------
     MESSAGE
  ----------------------------------------- */

  const message =
    update.message;

  if (!message) {
    return;
  }


  const chatId =
    String(
      message.chat?.id || ""
    );


  /* -----------------------------------------
     ONLY ADMIN
  ----------------------------------------- */

  if (
    chatId !==
    ADMIN_TELEGRAM_ID
  ) {

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          chatId,

        text:
          "❌ Access denied."
      }
    );

    return;
  }


  /* -----------------------------------------
     START / MENU
  ----------------------------------------- */

  if (
    message.text ===
      "/start" ||

    message.text ===
      "/menu" ||

    message.text ===
      "/admin"
  ) {

    await clearState(
      env
    );

    await sendAdminMenu(
      env,
      chatId
    );

    return;
  }


  /* -----------------------------------------
     ADMIN TEXT
  ----------------------------------------- */

  await handleAdminMessage(
    env,
    message
  );
}


/* =========================================================
   CLOUDFLARE WORKER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    if (
      request.method !==
      "POST"
    ) {
      return new Response(
        "PAYTON Manual PTN Bot",
        {
          status: 200
        }
      );
    }


    try {

      const update =
        await request.json();

      await handleUpdate(
        env,
        update
      );

    } catch (error) {

      console.error(
        "WORKER ERROR:",
        error?.message ||
        String(error)
      );
    }


    return new Response(
      "OK",
      {
        status: 200
      }
    );
  },


  async scheduled() {
    /*
      No automatic processing.
      This bot only performs manual PTN payments.
    */
  }

};
