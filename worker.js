import { Buffer } from "buffer";
import {
  Address,
  beginCell,
  internal,
  SendMode,
  toNano,
  Cell
} from "@ton/core";

import {
  TonClient,
  WalletContractV5R1,
  JettonMaster,
  JettonWallet
} from "@ton/ton";

import { mnemonicToPrivateKey } from "@ton/crypto";

globalThis.Buffer = Buffer;


/* =========================================================
   PAYTON CONFIG
========================================================= */

const WELCOME = `🦊 Welcome to PAYTON (PTN)

Welcome to the official PAYTON presale.

💰 Payment: GRAM

Presale Price:
1,000,000 PTN = 1 GRAM

Choose an option below:`;


const MENU = {
  inline_keyboard: [
    [{ text: "🪙 Buy PTN", callback_data: "buy" }],
    [{ text: "💰 Price", callback_data: "price" }],
    [{ text: "📋 My Orders", callback_data: "orders" }],
    [{ text: "💬 Support", callback_data: "support" }]
  ]
};


const BACK = {
  inline_keyboard: [
    [{ text: "⬅️ Back", callback_data: "home" }]
  ]
};


/*
  PTN Jetton Master
*/
const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";


/*
  PTN sender wallet.
  The mnemonic stored in PTN_MNEMONIC MUST derive this address.
*/
const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";


/*
  GRAM receiving wallet
*/
const GRAM_RECEIVING_WALLET =
  "UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";


const PTN_DECIMALS = 9;


/*
  1 GRAM = 1,000,000 PTN
*/
const PTN_PER_GRAM = 1000000n;


/*
  How far back payment verification searches.
*/
const PAYMENT_LOOKBACK_SECONDS = 24 * 60 * 60;


/*
  Amount of GRAM attached to the Jetton transfer
  to pay the PTN transfer execution.
*/
const JETTON_TRANSFER_GRAM = "0.10";


/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    if (request.method !== "POST") {
      return new Response("PAYTON Bot is running!");
    }

    try {

      const update = await request.json();


      /* =====================================================
         TELEGRAM MESSAGES
      ===================================================== */

      if (update.message) {

        const chatId = update.message.chat.id;
        const username =
          update.message.from?.username || null;

        const text =
          (update.message.text || "").trim();


        /* ---------------------------------------------
           /start
        --------------------------------------------- */

        if (text === "/start") {

          await env.DB.prepare(
            `INSERT OR IGNORE INTO users
             (telegram_id, username)
             VALUES (?, ?)`
          )
            .bind(String(chatId), username)
            .run();


          await env.DB.prepare(
            `UPDATE users
             SET username = ?
             WHERE telegram_id = ?`
          )
            .bind(username, String(chatId))
            .run();


          await env.DB.prepare(
            `DELETE FROM orders
             WHERE telegram_id = ?
             AND status IN ('awaiting_amount', 'awaiting_wallet')`
          )
            .bind(String(chatId))
            .run();


          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: WELCOME,
            reply_markup: MENU
          });


          return new Response("OK");
        }


        /* =====================================================
           CHECK CURRENT ORDER STATE
        ===================================================== */

        const pending = await env.DB.prepare(
          `SELECT *
           FROM orders
           WHERE telegram_id = ?
           AND status IN ('awaiting_amount', 'awaiting_wallet')
           ORDER BY id DESC
           LIMIT 1`
        )
          .bind(String(chatId))
          .first();


        if (pending) {


          /* ===============================================
             USER IS ENTERING GRAM AMOUNT
          =============================================== */

          if (pending.status === "awaiting_amount") {

            const gram = text.replace(",", ".");


            if (!/^\d+(\.\d{1,9})?$/.test(gram)) {

              await telegram(env, "sendMessage", {
                chat_id: chatId,
                text:
`❌ Invalid amount.

Please enter the GRAM amount using numbers only.

Example:
1.5`
              });

              return new Response("OK");
            }


            if (Number(gram) <= 0) {

              await telegram(env, "sendMessage", {
                chat_id: chatId,
                text:
                  "❌ The GRAM amount must be greater than 0."
              });

              return new Response("OK");
            }


            const ptn = gramToPTN(gram);


            await env.DB.prepare(
              `UPDATE orders
               SET gram_amount = ?,
                   ptn_amount = ?,
                   status = 'awaiting_wallet'
               WHERE id = ?`
            )
              .bind(
                gram,
                ptn,
                pending.id
              )
              .run();


            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text:
`✅ Order #${pending.id}

💰 Payment: ${gram} GRAM
🪙 You will receive: ${formatNumber(ptn)} PTN

Now send your TON wallet address.

⚠️ You must pay from this same wallet address.`
            });


            return new Response("OK");
          }


          /* ===============================================
             USER IS ENTERING THEIR WALLET ADDRESS
          =============================================== */

          if (pending.status === "awaiting_wallet") {

            let walletAddress;


            try {

              walletAddress = Address.parse(text);

            } catch {

              await telegram(env, "sendMessage", {
                chat_id: chatId,
                text:
`❌ Invalid wallet address.

Please send a valid TON wallet address.

Example:
UQ...`
              });

              return new Response("OK");
            }


            const normalizedWallet =
              walletAddress.toString({
                urlSafe: true,
                bounceable: false,
                testOnly: false
              });


            await env.DB.prepare(
              `UPDATE orders
               SET payment_address = ?,
                   status = 'pending'
               WHERE id = ?`
            )
              .bind(
                normalizedWallet,
                pending.id
              )
              .run();


            const paymentComment =
              `PAYTON-${pending.id}`;


            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text:
`🧾 Order #${pending.id}

💰 Amount: ${pending.gram_amount} GRAM
🪙 PTN: ${formatNumber(pending.ptn_amount)}

💳 Send exactly:
${pending.gram_amount} GRAM

📥 Payment address:
${GRAM_RECEIVING_WALLET}

📝 Payment comment:
${paymentComment}

⚠️ Important:
Send the payment from the wallet address you just provided.

After the payment is confirmed on the TON blockchain, your PTN will be sent automatically.`,
              reply_markup: BACK
            });


            return new Response("OK");
          }
        }


        /* ===============================================
           NORMAL TEXT
        =============================================== */

        await telegram(env, "sendMessage", {
          chat_id: chatId,
          text:
            "Please choose an option from the menu.",
          reply_markup: MENU
        });


        return new Response("OK");
      }


      /* =====================================================
         CALLBACK BUTTONS
      ===================================================== */

      if (update.callback_query) {

        const query = update.callback_query;

        const chatId =
          query.message.chat.id;

        const messageId =
          query.message.message_id;

        const action =
          query.data;


        await telegram(
          env,
          "answerCallbackQuery",
          {
            callback_query_id: query.id
          }
        );


        /* ===============================================
           HOME
        =============================================== */

        if (action === "home") {

          await env.DB.prepare(
            `DELETE FROM orders
             WHERE telegram_id = ?
             AND status IN ('awaiting_amount', 'awaiting_wallet')`
          )
            .bind(String(chatId))
            .run();


          await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: WELCOME,
            reply_markup: MENU
          });


          return new Response("OK");
        }


        /* ===============================================
           BUY
        =============================================== */

        if (action === "buy") {

          await env.DB.prepare(
            `DELETE FROM orders
             WHERE telegram_id = ?
             AND status IN ('awaiting_amount', 'awaiting_wallet')`
          )
            .bind(String(chatId))
            .run();


          const result = await env.DB.prepare(
            `INSERT INTO orders
             (telegram_id, gram_amount, ptn_amount, status)
             VALUES (?, '0', '0', 'awaiting_amount')
             RETURNING id`
          )
            .bind(String(chatId))
            .first();


          const orderId = result?.id;


          await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text:
`🪙 Buy PAYTON (PTN)

Enter the amount of GRAM you want to spend.

Example:
1.5

You will receive:
1,500,000 PTN`,
            reply_markup: BACK
          });


          return new Response("OK");
        }


        /* ===============================================
           PRICE
        =============================================== */

        if (action === "price") {

          await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text:
`💰 PAYTON Presale Price

1,000,000 PTN = 1 GRAM`,
            reply_markup: BACK
          });


          return new Response("OK");
        }


        /* ===============================================
           ORDERS
        =============================================== */

        if (action === "orders") {

          const result = await env.DB.prepare(
            `SELECT
               id,
               gram_amount,
               ptn_amount,
               status,
               created_at
             FROM orders
             WHERE telegram_id = ?
             AND status NOT IN ('awaiting_amount', 'awaiting_wallet')
             ORDER BY id DESC
             LIMIT 10`
          )
            .bind(String(chatId))
            .all();


          if (
            !result.results ||
            result.results.length === 0
          ) {

            await telegram(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text:
`📋 My Orders

You have no orders yet.`,
              reply_markup: BACK
            });


            return new Response("OK");
          }


          let ordersText =
            "📋 My Orders\n\n";


          for (const order of result.results) {

            ordersText +=
`🧾 Order #${order.id}

💰 ${order.gram_amount} GRAM
🪙 ${formatNumber(order.ptn_amount)} PTN
📌 Status: ${displayStatus(order.status)}

`;
          }


          await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: ordersText,
            reply_markup: BACK
          });


          return new Response("OK");
        }


        /* ===============================================
           SUPPORT
        =============================================== */

        if (action === "support") {

          await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text:
`💬 Support

Please send your message in this chat.

Our Support team will receive your message and respond as soon as possible.`,
            reply_markup: BACK
          });


          return new Response("OK");
        }
      }


      return new Response("OK");

    } catch (error) {

      console.error(
        "Telegram update error:",
        error
      );

      return new Response("OK");
    }
  },


  /* =========================================================
     CRON
  ========================================================= */

  async scheduled(controller, env) {

    try {

      await processOrders(env);

    } catch (error) {

      console.error(
        "Scheduled payment processor error:",
        error
      );
    }
  }
};


/* =========================================================
   PROCESS ORDERS
========================================================= */

async function processOrders(env) {

  const result = await env.DB.prepare(
    `SELECT *
     FROM orders
     WHERE status IN ('pending', 'payment_verified')
     ORDER BY id ASC
     LIMIT 20`
  ).all();


  if (
    !result.results ||
    result.results.length === 0
  ) {
    return;
  }


  for (const order of result.results) {

    try {

      /* -----------------------------------------------
         PAYMENT WAITING
      ----------------------------------------------- */

      if (order.status === "pending") {

        if (
          !order.payment_address ||
          !order.gram_amount ||
          order.gram_amount === "0"
        ) {
          continue;
        }


        const payment =
          await findPayment(
            env,
            order
          );


        if (!payment) {
          continue;
        }


        /*
          Unique transaction index prevents
          the same transaction from being used twice.
        */

        const claimed =
          await env.DB.prepare(
            `UPDATE orders
             SET transaction_hash = ?,
                 status = 'payment_verified'
             WHERE id = ?
             AND status = 'pending'`
          )
            .bind(
              payment.transactionHash,
              order.id
            )
            .run();


        if (
          !claimed.meta ||
          claimed.meta.changes !== 1
        ) {
          continue;
        }


        await telegram(env, "sendMessage", {
          chat_id: Number(order.telegram_id),
          text:
`✅ Payment Confirmed

🧾 Order #${order.id}

💰 ${order.gram_amount} GRAM received.

🪙 Your PTN transfer is now being processed automatically.`
        });


        /*
          Continue directly to payout.
        */

        order.status = "payment_verified";
        order.transaction_hash =
          payment.transactionHash;
      }


      /* -----------------------------------------------
         PAYOUT
      ----------------------------------------------- */

      if (order.status === "payment_verified") {

        await sendPTN(env, order);
      }

    } catch (error) {

      console.error(
        "Order processing failed:",
        order.id,
        error
      );
    }
  }
}


/* =========================================================
   FIND GRAM PAYMENT
========================================================= */

async function findPayment(env, order) {

  const receiving =
    Address.parse(GRAM_RECEIVING_WALLET);


  const expectedSource =
    Address.parse(order.payment_address);


  const expectedAmount =
    gramToNano(order.gram_amount);


  const orderCreated =
    parseSqliteDate(order.created_at);


  const startTime =
    Math.max(
      orderCreated - 60,
      Math.floor(Date.now() / 1000) -
        PAYMENT_LOOKBACK_SECONDS
    );


  const endTime =
    Math.floor(Date.now() / 1000) + 10;


  const url =
    new URL(
      "https://toncenter.com/api/v3/transactions"
    );


  url.searchParams.set(
    "account",
    receiving.toRawString()
  );


  url.searchParams.set(
    "start_utime",
    String(startTime)
  );


  url.searchParams.set(
    "end_utime",
    String(endTime)
  );


  url.searchParams.set(
    "limit",
    "100"
  );


  url.searchParams.set(
    "sort",
    "desc"
  );


  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          "X-API-Key":
            env.TONCENTER_API_KEY
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `TON Center transaction API error: ${response.status}`
    );
  }


  const data =
    await response.json();


  const transactions =
    data.transactions || [];


  const expectedComment =
    `PAYTON-${order.id}`;


  for (const tx of transactions) {

    if (
      tx.description?.aborted === true
    ) {
      continue;
    }


    if (!tx.in_msg) {
      continue;
    }


    const message =
      tx.in_msg;


    if (
      message.bounced === true
    ) {
      continue;
    }


    if (!message.source) {
      continue;
    }


    if (!message.destination) {
      continue;
    }


    let source;
    let destination;


    try {

      source =
        Address.parse(
          message.source
        );

      destination =
        Address.parse(
          message.destination
        );

    } catch {

      continue;
    }


    if (
      source.toRawString() !==
      expectedSource.toRawString()
    ) {
      continue;
    }


    if (
      destination.toRawString() !==
      receiving.toRawString()
    ) {
      continue;
    }


    if (
      BigInt(message.value || "0") !==
      expectedAmount
    ) {
      continue;
    }


    const txTime =
      Number(
        message.created_at ||
        tx.now ||
        0
      );


    if (
      txTime < orderCreated
    ) {
      continue;
    }


    const comment =
      decodeComment(
        message.message_content?.body
      );


    if (
      comment !== expectedComment
    ) {
      continue;
    }


    return {
      transactionHash:
        tx.hash
    };
  }


  return null;
}


/* =========================================================
   SEND PTN AUTOMATICALLY
========================================================= */

async function sendPTN(env, order) {

  /*
    Claim this order first.

    This prevents two cron executions from
    sending PTN simultaneously.
  */

  const claim =
    await env.DB.prepare(
      `UPDATE orders
       SET status = 'payout_processing'
       WHERE id = ?
       AND status = 'payment_verified'`
    )
      .bind(order.id)
      .run();


  if (
    !claim.meta ||
    claim.meta.changes !== 1
  ) {

    /*
      If already payout_processing or payout_sent,
      do not send again.
    */

    return;
  }


  try {

    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });


    /*
      Read mnemonic ONLY from Cloudflare Secret.
    */

    if (!env.PTN_MNEMONIC) {
      throw new Error(
        "PTN_MNEMONIC secret is missing."
      );
    }


    const mnemonic =
      env.PTN_MNEMONIC
        .trim()
        .split(/\s+/);


    const keyPair =
      await mnemonicToPrivateKey(
        mnemonic
      );


    /*
      IMPORTANT:
      Derive the V5R1 wallet from the mnemonic.
    */

    const wallet =
      WalletContractV5R1.create({
        walletId: {
          networkGlobalId: -239
        },
        publicKey:
          keyPair.publicKey,
        workchain: 0
      });


    /*
      SECURITY CHECK:
      The mnemonic MUST derive the expected
      PTN sender wallet.
    */

    const derivedAddress =
      wallet.address.toRawString();


    const expectedSenderAddress =
      Address
        .parse(PTN_SENDER_WALLET)
        .toRawString();


    if (
      derivedAddress !==
      expectedSenderAddress
    ) {

      throw new Error(
        "PTN_MNEMONIC does not match the configured PTN sender wallet."
      );
    }


    /*
      Destination wallet supplied by buyer.
    */

    const destination =
      Address.parse(
        order.payment_address
      );


    /*
      Open PTN Jetton Master.
    */

    const master =
      client.open(
        JettonMaster.create(
          Address.parse(PTN_MASTER)
        )
      );


    /*
      Derive sender's PTN Jetton wallet.
    */

    const senderJettonWalletAddress =
      await master.getWalletAddress(
        wallet.address
      );


    /*
      Verify current PTN balance.
    */

    const senderJettonWallet =
      client.open(
        JettonWallet.create(
          senderJettonWalletAddress
        )
      );


    const currentBalance =
      await senderJettonWallet.getBalance();


    const ptnUnits =
      ptnToUnits(
        order.ptn_amount
      );


    if (
      currentBalance < ptnUnits
    ) {

      throw new Error(
        "Insufficient PTN balance in sender Jetton wallet."
      );
    }


    /*
      Check if this exact order payout
      was already broadcast.

      query_id = order.id
      so each order has a unique Jetton transfer ID.
    */

    const alreadySent =
      await findExistingPayout(
        env,
        wallet.address,
        destination,
        ptnUnits,
        order.id
      );


    if (alreadySent) {

      await env.DB.prepare(
        `UPDATE orders
         SET status = 'payout_sent'
         WHERE id = ?
         AND status = 'payout_processing'`
      )
        .bind(order.id)
        .run();


      await telegram(env, "sendMessage", {
        chat_id: Number(order.telegram_id),
        text:
`🎉 Order Completed

🧾 Order #${order.id}

🪙 ${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.

Thank you for purchasing PAYTON (PTN).`
      });


      return;
    }


    /*
      Standard TEP-74 Jetton transfer body.
    */

    const transferBody =
      beginCell()

        // Jetton transfer opcode
        .storeUint(
          0x0f8a7ea5,
          32
        )

        // Unique query ID = order ID
        .storeUint(
          BigInt(order.id),
          64
        )

        // PTN amount in base units
        .storeCoins(
          ptnUnits
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

        // No forward GRAM
        .storeCoins(0n)

        // Empty forward payload
        .storeBit(0)

        .endCell();


    const transferMessage =
      internal({
        to:
          senderJettonWalletAddress,

        value:
          toNano(
            JETTON_TRANSFER_GRAM
          ),

        bounce: true,

        body:
          transferBody
      });


    const provider =
      client.provider(
        wallet.address
      );


    const seqno =
      await wallet.getSeqno(
        provider
      );


    /*
      Broadcast the real PTN transaction.
    */

    await wallet.sendTransfer(
      provider,
      {
        seqno,

        secretKey:
          keyPair.secretKey,

        messages: [
          transferMessage
        ],

        sendMode:
          SendMode.PAY_GAS_SEPARATELY
      }
    );


    /*
      Mark completed after successful broadcast.
    */

    await env.DB.prepare(
      `UPDATE orders
       SET status = 'payout_sent'
       WHERE id = ?
       AND status = 'payout_processing'`
    )
      .bind(order.id)
      .run();


    await telegram(env, "sendMessage", {
      chat_id:
        Number(order.telegram_id),

      text:
`🎉 Order Completed

🧾 Order #${order.id}

🪙 ${formatNumber(order.ptn_amount)} PTN has been sent automatically.

Thank you for purchasing PAYTON (PTN).`
    });


  } catch (error) {

    console.error(
      "PTN payout error:",
      order.id,
      error
    );


    /*
      Return to payment_verified so the next
      Cron run can retry.

      The query_id/order ID and on-chain lookup
      protect against repeating a completed payout.
    */

    await env.DB.prepare(
      `UPDATE orders
       SET status = 'payment_verified'
       WHERE id = ?
       AND status = 'payout_processing'`
    )
      .bind(order.id)
      .run();


    await telegram(env, "sendMessage", {
      chat_id:
        Number(order.telegram_id),

      text:
`⚠️ Payment was confirmed for Order #${order.id}, but the PTN transfer is still processing.

The system will retry automatically.`
    });
  }
}


/* =========================================================
   CHECK EXISTING PTN PAYOUT
========================================================= */

async function findExistingPayout(
  env,
  senderAddress,
  destination,
  expectedAmount,
  orderId
) {

  const url =
    new URL(
      "https://toncenter.com/api/v3/jetton/transfers"
    );


  url.searchParams.set(
    "owner_address",
    senderAddress.toRawString()
  );


  url.searchParams.set(
    "jetton_master",
    Address.parse(
      PTN_MASTER
    ).toRawString()
  );


  url.searchParams.set(
    "direction",
    "out"
  );


  url.searchParams.set(
    "start_utime",
    String(
      Math.floor(Date.now() / 1000) -
        PAYMENT_LOOKBACK_SECONDS
    )
  );


  url.searchParams.set(
    "limit",
    "100"
  );


  url.searchParams.set(
    "sort",
    "desc"
  );


  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          "X-API-Key":
            env.TONCENTER_API_KEY
        }
      }
    );


  if (!response.ok) {
    return false;
  }


  const data =
    await response.json();


  const transfers =
    data.jetton_transfers || [];


  for (const transfer of transfers) {

    if (
      transfer.transaction_aborted === true
    ) {
      continue;
    }


    if (
      String(transfer.query_id) !==
      String(orderId)
    ) {
      continue;
    }


    if (
      BigInt(transfer.amount || "0") !==
      expectedAmount
    ) {
      continue;
    }


    if (!transfer.destination) {
      continue;
    }


    try {

      const transferDestination =
        Address.parse(
          transfer.destination
        );


      if (
        transferDestination.toRawString() !==
        destination.toRawString()
      ) {
        continue;
      }

    } catch {

      continue;
    }


    return true;
  }


  return false;
}


/* =========================================================
   GRAM → PTN
========================================================= */

function gramToPTN(value) {

  const parts =
    value.split(".");


  const whole =
    parts[0] || "0";


  const decimal =
    (parts[1] || "")
      .padEnd(9, "0");


  const gramUnits =
    BigInt(whole) *
      1000000000n +
    BigInt(decimal);


  const ptnUnits =
    gramUnits *
    PTN_PER_GRAM;


  const ptnWhole =
    ptnUnits /
    1000000000n;


  const ptnDecimal =
    ptnUnits %
    1000000000n;


  if (
    ptnDecimal === 0n
  ) {

    return ptnWhole.toString();
  }


  return (
    ptnWhole.toString() +
    "." +
    ptnDecimal
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "")
  );
}


/* =========================================================
   GRAM → NANO GRAM
========================================================= */

function gramToNano(value) {

  const parts =
    String(value).split(".");


  const whole =
    parts[0] || "0";


  const decimal =
    (parts[1] || "")
      .padEnd(9, "0");


  return (
    BigInt(whole) *
      1000000000n +
    BigInt(decimal)
  );
}


/* =========================================================
   PTN HUMAN AMOUNT → BASE UNITS
========================================================= */

function ptnToUnits(value) {

  const parts =
    String(value).split(".");


  const whole =
    parts[0] || "0";


  const decimal =
    (parts[1] || "")
      .padEnd(PTN_DECIMALS, "0");


  if (
    decimal.length >
    PTN_DECIMALS
  ) {

    throw new Error(
      "Invalid PTN decimals."
    );
  }


  return (
    BigInt(whole) *
      1000000000n +
    BigInt(decimal)
  );
}


/* =========================================================
   FORMAT NUMBER
========================================================= */

function formatNumber(value) {

  const parts =
    String(value).split(".");


  parts[0] =
    Number(
      parts[0]
    ).toLocaleString(
      "en-US"
    );


  return parts.join(".");
}


/* =========================================================
   STATUS DISPLAY
========================================================= */

function displayStatus(status) {

  switch (status) {

    case "pending":
      return "Waiting for payment";

    case "payment_verified":
      return "Payment verified";

    case "payout_processing":
      return "Sending PTN";

    case "payout_sent":
      return "Completed";

    default:
      return status;
  }
}


/* =========================================================
   PARSE SQLITE UTC DATE
========================================================= */

function parseSqliteDate(value) {

  if (!value) {
    return Math.floor(
      Date.now() / 1000
    );
  }


  const parsed =
    Date.parse(
      String(value)
        .replace(" ", "T") +
        "Z"
    );


  if (
    Number.isNaN(parsed)
  ) {

    return Math.floor(
      Date.now() / 1000
    );
  }


  return Math.floor(
    parsed / 1000
  );
}


/* =========================================================
   DECODE TON COMMENT
========================================================= */

function decodeComment(body) {

  if (!body) {
    return null;
  }


  try {

    const cells =
      Cell.fromBoc(
        Buffer.from(
          body,
          "base64"
        )
      );


    if (
      !cells ||
      cells.length === 0
    ) {
      return null;
    }


    let cell =
      cells[0];


    const chunks = [];


    while (cell) {

      const slice =
        cell.beginParse();


      if (
        slice.remainingBits < 32
      ) {
        return null;
      }


      const opcode =
        slice.loadUint(32);


      /*
        0x00000000 = standard
        wallet comment
      */

      if (
        opcode !== 0
      ) {
        return null;
      }


      if (
        slice.remainingBits > 0
      ) {

        const byteCount =
          Math.floor(
            slice.remainingBits / 8
          );


        if (
          byteCount > 0
        ) {

          chunks.push(
            slice.loadBuffer(
              byteCount
            )
          );
        }
      }


      if (
        slice.remainingRefs === 0
      ) {
        break;
      }


      cell =
        slice.loadRef();
    }


    return Buffer
      .concat(chunks)
      .toString("utf8");

  } catch (error) {

    console.error(
      "Comment decode error:",
      error
    );

    return null;
  }
}


/* =========================================================
   TELEGRAM API
========================================================= */

async function telegram(
  env,
  method,
  data
) {

  const response =
    await fetch(
      "https://api.telegram.org/bot" +
      env.BOT_TOKEN +
      "/" +
      method,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(data)
      }
    );


  return response;
}
