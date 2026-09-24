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
  JettonMaster
} from "@ton/ton";

import { keyPairFromSeed } from "@ton/crypto";

globalThis.Buffer = Buffer;

/* =========================================================
   PAYTON - MANUAL PTN SENDER ONLY
========================================================= */

const ADMIN_TELEGRAM_ID = "113074274";

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const PTN_DECIMALS = 9;

const MIN_NATIVE_BALANCE = toNano("0.20");

const TONCENTER_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";


/* =========================================================
   BOT MENU
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
        callback_data: "cancel_manual_ptn"
      }
    ]
  ]
};


/* =========================================================
   ADMIN CHECK
========================================================= */

function isAdmin(message) {
  return String(
    message?.from?.id || ""
  ) === ADMIN_TELEGRAM_ID;
}


/* =========================================================
   TELEGRAM
========================================================= */

async function telegram(
  env,
  method,
  body
) {
  if (!env.BOT_TOKEN) {
    throw new Error(
      "BOT_TOKEN is missing"
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data =
    await response.json().catch(
      () => null
    );

  if (
    !response.ok ||
    data?.ok === false
  ) {
    throw new Error(
      data?.description ||
      `Telegram ${method} failed`
    );
  }

  return data;
}


/* =========================================================
   MENU
========================================================= */

async function sendMenu(
  env,
  chatId,
  text = "🛠 PAYTON Admin Panel"
) {
  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      reply_markup: MENU
    }
  );
}


async function editMenu(
  env,
  query,
  text
) {
  await telegram(
    env,
    "editMessageText",
    {
      chat_id:
        query.message.chat.id,

      message_id:
        query.message.message_id,

      text,

      reply_markup:
        MENU
    }
  );
}


/* =========================================================
   MANUAL PTN STATE TABLE
========================================================= */

async function ensureStateTable(
  env
) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS manual_ptn_state (
      telegram_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
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
      (telegram_id, mode, destination, updated_at)
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
  try {
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

  } catch {
    return null;
  }
}


async function clearState(
  env
) {
  try {
    await ensureStateTable(env);

    await env.DB.prepare(`
      DELETE FROM manual_ptn_state
      WHERE telegram_id=?
    `)
    .bind(
      ADMIN_TELEGRAM_ID
    )
    .run();

  } catch {}
}


/* =========================================================
   PTN AMOUNT
========================================================= */

function parsePtnAmount(
  input
) {
  const value =
    String(input || "")
      .trim();

  if (
    !/^\d+(?:\.\d{1,9})?$/.test(
      value
    )
  ) {
    throw new Error(
      "Enter a valid PTN amount. Maximum 9 decimal places."
    );
  }

  const [
    whole,
    fraction = ""
  ] = value.split(".");

  const units =
    BigInt(whole) *
      (10n **
        BigInt(PTN_DECIMALS)) +

    BigInt(
      (
        fraction +
        "0".repeat(
          PTN_DECIMALS
        )
      ).slice(
        0,
        PTN_DECIMALS
      )
    );

  if (units <= 0n) {
    throw new Error(
      "PTN amount must be greater than 0."
    );
  }

  return {
    display: value,
    units
  };
}


/* =========================================================
   DESTINATION ADDRESS
========================================================= */

function parseDestination(
  input
) {
  const value =
    String(input || "")
      .trim();

  if (!value) {
    throw new Error(
      "Wallet address is required."
    );
  }

  const address =
    Address.parse(value);

  if (
    address.workChain !== 0
  ) {
    throw new Error(
      "Only a TON basechain wallet address is allowed."
    );
  }

  return address;
}


/* =========================================================
   TON MNEMONIC -> KEY
========================================================= */

async function deriveSenderKey(
  env
) {
  const mnemonic =
    String(
      env.PTN_MNEMONIC || ""
    ).trim();

  if (!mnemonic) {
    throw new Error(
      "PTN_MNEMONIC is missing in Cloudflare Secrets."
    );
  }

  const words =
    mnemonic.split(/\s+/);

  if (
    words.length !== 24 &&
    words.length !== 12
  ) {
    throw new Error(
      `PTN_MNEMONIC must contain 12 or 24 words. Found ${words.length}.`
    );
  }

  /*
    TON mnemonic derivation:

    HMAC-SHA512(
      key = mnemonic text,
      data = empty
    )

    then:

    PBKDF2-HMAC-SHA512
      salt = "TON default seed"
      iterations = 100000

    first 32 bytes =
    Ed25519 seed
  */

  const encoder =
    new TextEncoder();

  const mnemonicText =
    words.join(" ");

  const hmacKey =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(
        mnemonicText
      ),
      {
        name: "HMAC",
        hash: "SHA-512"
      },
      false,
      ["sign"]
    );

  const entropy =
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new Uint8Array(0)
      )
    );

  const pbkdfKey =
    await crypto.subtle.importKey(
      "raw",
      entropy,
      "PBKDF2",
      false,
      ["deriveBits"]
    );

  const seed64 =
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-512",
          salt:
            encoder.encode(
              "TON default seed"
            ),
          iterations: 100000
        },
        pbkdfKey,
        512
      )
    );

  return keyPairFromSeed(
    Buffer.from(
      seed64.slice(0, 32)
    )
  );
}


/* =========================================================
   SEND MANUAL PTN
========================================================= */

async function sendManualPTN(
  env,
  destination,
  amountUnits
) {
  const client =
    new TonClient({
      endpoint:
        TONCENTER_ENDPOINT,
      apiKey:
        env.TONCENTER_API_KEY
    });


  /* DERIVE SIGNING KEY */

  const keyPair =
    await deriveSenderKey(env);


  /* CREATE V5 WALLET */

  const senderWallet =
    WalletContractV5R1.create({
      workchain: 0,
      publicKey:
        keyPair.publicKey
    });


  /* SECURITY CHECK */

  const derivedAddress =
    senderWallet.address.toString();

  if (
    derivedAddress !==
    PTN_SENDER_WALLET
  ) {
    throw new Error(
      "The configured mnemonic does not match the PTN sender wallet. No transaction was sent."
    );
  }


  /* CHECK WALLET */

  const deployed =
    await client.isContractDeployed(
      senderWallet.address
    );

  if (!deployed) {
    throw new Error(
      "PTN sender wallet is not initialized on mainnet."
    );
  }


  /* CHECK NATIVE GRAM FOR GAS */

  const nativeBalance =
    await client.getBalance(
      senderWallet.address
    );

  if (
    nativeBalance <
    MIN_NATIVE_BALANCE
  ) {
    throw new Error(
      "Insufficient native GRAM balance for network fees."
    );
  }


  /* PTN MASTER */

  const master =
    client.open(
      JettonMaster.create(
        Address.parse(
          PTN_MASTER
        )
      )
    );


  /* SENDER PTN WALLET */

  const senderJettonWallet =
    client.open(
      await master.getWalletAddress(
        senderWallet.address
      )
    );


  /* CHECK PTN BALANCE */

  const senderJettonBalance =
    await senderJettonWallet
      .getJettonBalance();

  if (
    senderJettonBalance <
    amountUnits
  ) {
    throw new Error(
      "Insufficient PTN balance in the sender wallet."
    );
  }


  /* DESTINATION PTN WALLET */

  const destinationJettonWallet =
    await master.getWalletAddress(
      destination
    );


  /* UNIQUE QUERY ID */

  const queryId =
    (BigInt(Date.now()) << 20n) |
    BigInt(
      crypto.getRandomValues(
        new Uint32Array(1)
      )[0] &
      0xFFFFF
    );


  /* JETTON TRANSFER BODY */

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
        amountUnits
      )

      .storeAddress(
        destination
      )

      .storeAddress(
        senderWallet.address
      )

      .storeBit(0)

      .storeCoins(
        toNano("0.05")
      )

      .storeBit(0)

      .endCell();


  /* SEND FROM V5 WALLET */

  const wallet =
    client.open(
      senderWallet
    );

  const seqno =
    await wallet.getSeqno();


  await wallet.sendTransfer({
    seqno,

    secretKey:
      keyPair.secretKey,

    sendMode:
      SendMode.PAY_GAS_SEPARATELY +
      SendMode.IGNORE_ERRORS,

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
    queryId:
      queryId.toString(),

    sender:
      derivedAddress,

    destination:
      destination.toString(),

    amountUnits
  };
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
    await editMenu(
      env,
      query,
      "❌ Access denied."
    );

    return;
  }


  /* MANUAL PTN */

  if (
    query.data ===
    "manual_ptn"
  ) {
    await setState(
      env,
      "manual_ptn_address"
    );

    await telegram(
      env,
      "editMessageText",
      {
        chat_id:
          query.message.chat.id,

        message_id:
          query.message.message_id,

        text:
          "💸 Manual PTN Payment\n\n" +
          "Send the destination TON wallet address.\n\n" +
          "Send /cancel to cancel.",

        reply_markup:
          CANCEL_MENU
      }
    );

    return;
  }


  /* CANCEL */

  if (
    query.data ===
    "cancel_manual_ptn"
  ) {
    await clearState(env);

    await editMenu(
      env,
      query,
      "🛠 PAYTON Admin Panel"
    );
  }
}


/* =========================================================
   ADMIN TEXT
========================================================= */

async function handleAdminText(
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


  /* CANCEL */

  if (
    text === "/cancel"
  ) {
    await clearState(env);

    await sendMenu(
      env,
      message.chat.id,
      "❌ Cancelled.\n\n" +
      "🛠 PAYTON Admin Panel"
    );

    return;
  }


  const state =
    await getState(env);


  /* =======================================================
     STEP 1 - DESTINATION
  ======================================================= */

  if (
    state?.mode ===
    "manual_ptn_address"
  ) {
    try {
      const destination =
        parseDestination(text);

      await setState(
        env,
        "manual_ptn_amount",
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
            "Maximum 9 decimal places.\n" +
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
            `❌ ${
              error.message ||
              "Invalid wallet address."
            }\n\n` +
            "Please send the destination wallet address again.",

          reply_markup:
            CANCEL_MENU
        }
      );
    }

    return;
  }


  /* =======================================================
     STEP 2 - PTN AMOUNT
  ======================================================= */

  if (
    state?.mode ===
    "manual_ptn_amount"
  ) {
    try {
      const amount =
        parsePtnAmount(text);

      if (
        !state.destination
      ) {
        throw new Error(
          "Destination address is missing. Start again."
        );
      }

      const destination =
        Address.parse(
          state.destination
        );


      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            message.chat.id,

          text:
            "⏳ Checking sender wallet, PTN balance and network fee, then sending PTN..."
        }
      );


      const result =
        await sendManualPTN(
          env,
          destination,
          amount.units
        );


      await clearState(env);


      await sendMenu(
        env,
        message.chat.id,

        "✅ PTN transfer submitted successfully.\n\n" +

        `Amount: ${amount.display} PTN\n` +

        `Destination: ${
          destination.toString()
        }\n` +

        `Query ID: ${
          result.queryId
        }\n\n` +

        "🛠 PAYTON Admin Panel"
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
              error.message ||
              "PTN transfer failed."
            }\n\n` +

            "No PTN transfer was submitted.\n\n" +

            "Send another PTN amount to try again, or /cancel to cancel.",

          reply_markup:
            CANCEL_MENU
        }
      );
    }

    return;
  }


  /* DEFAULT */

  await sendMenu(
    env,
    message.chat.id
  );
}


/* =========================================================
   UPDATE HANDLER
========================================================= */

async function handleUpdate(
  env,
  update
) {
  /* CALLBACK */

  if (
    update.callback_query
  ) {
    await handleCallback(
      env,
      update.callback_query
    );

    return;
  }


  const message =
    update.message;

  if (!message) {
    return;
  }


  /* ONLY ADMIN */

  if (
    !isAdmin(message)
  ) {
    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          message.chat.id,

        text:
          "❌ Access denied."
      }
    );

    return;
  }


  /* START */

  if (
    message.text ===
      "/start" ||

    message.text ===
      "/menu"
  ) {
    await clearState(env);

    await sendMenu(
      env,
      message.chat.id
    );

    return;
  }


  await handleAdminText(
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

      return new Response(
        "OK",
        {
          status: 200
        }
      );

    } catch (error) {

      console.error(
        `WORKER ERROR: ${
          error?.message ||
          String(error)
        }\n${
          error?.stack || ""
        }`
      );

      return new Response(
        "OK",
        {
          status: 200
        }
      );
    }
  },


  async scheduled() {
    /* Intentionally empty. */
  }

};
