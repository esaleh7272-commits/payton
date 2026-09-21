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


/* =========================================================
   ADMIN CONFIG
========================================================= */

/*
  Telegram ID of the only authorized administrator.
*/
const ADMIN_TELEGRAM_ID = "113074274";


const ADMIN_MENU = {
  inline_keyboard: [
    [
      { text: "📊 Dashboard", callback_data: "admin_dashboard" }
    ],
    [
      { text: "📋 All Orders", callback_data: "admin_orders" },
      { text: "⏳ Pending", callback_data: "admin_pending" }
    ],
    [
      { text: "👥 Users", callback_data: "admin_users" }
    ],
    [
      { text: "💰 Revenue", callback_data: "admin_revenue" }
    ],
    [
      { text: "🔄 Refresh", callback_data: "admin_dashboard" }
    ]
  ]
};


const ADMIN_BACK = {
  inline_keyboard: [
    [
      { text: "⬅️ Admin Panel", callback_data: "admin_home" }
    ]
  ]
};


/* =========================================================
   TOKEN / WALLET CONFIG
========================================================= */

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";


/*
  PTN sender wallet.
  PTN_MNEMONIC must derive this exact V5R1 address.
*/
const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";


/*
  GRAM receiving wallet.
*/
const GRAM_RECEIVING_WALLET =
  "UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";


const PTN_DECIMALS = 9;


/*
  1 GRAM = 1,000,000 PTN
*/
const PTN_PER_GRAM = 1000000n;


/*
  Payment verification lookback.
*/
const PAYMENT_LOOKBACK_SECONDS =
  24 * 60 * 60;


/*
  TON attached to Jetton transfer.
*/
const JETTON_TRANSFER_GRAM = "0.10";


/*
  Minimum native TON balance before payout.
*/
const MIN_SENDER_TON_BALANCE =
  toNano("0.20");


/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    if (request.method !== "POST") {
      return new Response(
        "PAYTON Bot is running!"
      );
    }

    try {

      const update =
        await request.json();


      /* =====================================================
         TELEGRAM MESSAGES
      ===================================================== */

      if (update.message) {

        const chatId =
          update.message.chat.id;

        const username =
          update.message.from?.username || null;

        const text =
          (update.message.text || "").trim();


        /* ===================================================
           /admin
        =================================================== */

        if (text === "/admin") {

          if (
            String(chatId) !==
            ADMIN_TELEGRAM_ID
          ) {

            await telegram(
              env,
              "sendMessage",
              {
                chat_id: chatId,
                text: "⛔ Unauthorized."
              }
            );

            return new Response("OK");
          }


          await telegram(
            env,
            "sendMessage",
            {
              chat_id: chatId,
              text:
`🔐 PAYTON ADMIN PANEL

Welcome, Administrator.

Choose an option below:`,
              reply_markup: ADMIN_MENU
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           /start
        =================================================== */

        if (text === "/start") {

          await env.DB.prepare(
            `INSERT OR IGNORE INTO users
             (telegram_id, username)
             VALUES (?, ?)`
          )
            .bind(
              String(chatId),
              username
            )
            .run();


          await env.DB.prepare(
            `UPDATE users
             SET username = ?
             WHERE telegram_id = ?`
          )
            .bind(
              username,
              String(chatId)
            )
            .run();


          await env.DB.prepare(
            `DELETE FROM orders
             WHERE telegram_id = ?
             AND status IN (
               'awaiting_amount',
               'awaiting_wallet'
             )`
          )
            .bind(
              String(chatId)
            )
            .run();


          await telegram(
            env,
            "sendMessage",
            {
              chat_id: chatId,
              text: WELCOME,
              reply_markup: MENU
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           CURRENT ORDER STATE
        =================================================== */

        const pending =
          await env.DB.prepare(
            `SELECT *
             FROM orders
             WHERE telegram_id = ?
             AND status IN (
               'awaiting_amount',
               'awaiting_wallet'
             )
             ORDER BY id DESC
             LIMIT 1`
          )
            .bind(
              String(chatId)
            )
            .first();


        if (pending) {

          /* ===============================================
             GRAM AMOUNT
          =============================================== */

          if (
            pending.status ===
            "awaiting_amount"
          ) {

            const gram =
              text.replace(",", ".");


            if (
              !/^\d+(\.\d{1,9})?$/.test(
                gram
              )
            ) {

              await telegram(
                env,
                "sendMessage",
                {
                  chat_id: chatId,
                  text:
`❌ Invalid amount.

Please enter the GRAM amount using numbers only.

Example:
1.5`
                }
              );

              return new Response("OK");
            }


            if (
              Number(gram) <= 0
            ) {

              await telegram(
                env,
                "sendMessage",
                {
                  chat_id: chatId,
                  text:
                    "❌ The GRAM amount must be greater than 0."
                }
              );

              return new Response("OK");
            }


            const ptn =
              gramToPTN(gram);


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


            await telegram(
              env,
              "sendMessage",
              {
                chat_id: chatId,
                text:
`✅ Order #${pending.id}

💰 Payment: ${gram} GRAM
🪙 You will receive: ${formatNumber(ptn)} PTN

Now send your TON wallet address.

⚠️ You must pay from this same wallet address.`
              }
            );


            return new Response("OK");
          }


          /* ===============================================
             BUYER WALLET ADDRESS
          =============================================== */

          if (
            pending.status ===
            "awaiting_wallet"
          ) {

            let walletAddress;


            try {

              walletAddress =
                Address.parse(text);

            } catch {

              await telegram(
                env,
                "sendMessage",
                {
                  chat_id: chatId,
                  text:
`❌ Invalid wallet address.

Please send a valid TON wallet address.

Example:
UQ...`
                }
              );

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


            await telegram(
              env,
              "sendMessage",
              {
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
              }
            );


            return new Response("OK");
          }
        }


        /* ===================================================
           NORMAL TEXT
        =================================================== */

        await telegram(
          env,
          "sendMessage",
          {
            chat_id: chatId,
            text:
              "Please choose an option from the menu.",
            reply_markup: MENU
          }
        );


        return new Response("OK");
      }


      /* =====================================================
         CALLBACK BUTTONS
      ===================================================== */

      if (update.callback_query) {

        const query =
          update.callback_query;

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
            callback_query_id:
              query.id
          }
        );


        /* ===================================================
           ADMIN SECURITY
        =================================================== */

        if (
          action.startsWith("admin_") &&
          String(chatId) !==
            ADMIN_TELEGRAM_ID
        ) {

          await telegram(
            env,
            "sendMessage",
            {
              chat_id: chatId,
              text: "⛔ Unauthorized."
            }
          );

          return new Response("OK");
        }


        /* ===================================================
           ADMIN HOME
        =================================================== */

        if (
          action ===
          "admin_home"
        ) {

          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text:
`🔐 PAYTON ADMIN PANEL

Choose an option below:`,
              reply_markup: ADMIN_MENU
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           ADMIN DASHBOARD
        =================================================== */

        if (
          action ===
          "admin_dashboard"
        ) {

          const stats =
            await getAdminStats(env);


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text:
`📊 PAYTON ADMIN DASHBOARD

👥 Total Users:
${stats.users}

🧾 Total Orders:
${stats.orders}

⏳ Pending:
${stats.pending}

🔎 Payment Verified:
${stats.paymentVerified}

🔄 Payout Processing:
${stats.payoutProcessing}

✅ Completed:
${stats.completed}

💰 Total GRAM Received:
${formatNumber(stats.revenue)}

🪙 PTN Sold:
${formatNumber(stats.ptnSold)}

Updated just now.`,
              reply_markup: ADMIN_MENU
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           ADMIN ALL ORDERS
        =================================================== */

        if (
          action ===
          "admin_orders"
        ) {

          const result =
            await env.DB.prepare(
              `SELECT
                 id,
                 telegram_id,
                 gram_amount,
                 ptn_amount,
                 payment_address,
                 transaction_hash,
                 status,
                 created_at
               FROM orders
               WHERE status NOT IN (
                 'awaiting_amount',
                 'awaiting_wallet'
               )
               ORDER BY id DESC
               LIMIT 15`
            )
              .all();


          let text =
            "📋 ALL ORDERS\n\n";


          if (
            !result.results ||
            result.results.length === 0
          ) {

            text +=
              "No orders found.";

          } else {

            for (
              const order
              of result.results
            ) {

              text +=
`🧾 #${order.id}
💰 ${order.gram_amount} GRAM
🪙 ${formatNumber(order.ptn_amount)} PTN
📌 ${displayStatus(order.status)}
👤 ${order.telegram_id}
${order.transaction_hash
  ? `🔗 TX: ${order.transaction_hash}`
  : "🔗 TX: Not yet confirmed"}

`;
            }
          }


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text,
              reply_markup: ADMIN_BACK
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           ADMIN PENDING
        =================================================== */

        if (
          action ===
          "admin_pending"
        ) {

          const result =
            await env.DB.prepare(
              `SELECT
                 id,
                 telegram_id,
                 gram_amount,
                 ptn_amount,
                 payment_address,
                 status,
                 created_at
               FROM orders
               WHERE status IN (
                 'pending',
                 'payment_verified',
                 'payout_processing'
               )
               ORDER BY id ASC
               LIMIT 15`
            )
              .all();


          let text =
            "⏳ PENDING ORDERS\n\n";


          if (
            !result.results ||
            result.results.length === 0
          ) {

            text +=
              "No pending orders.";

          } else {

            for (
              const order
              of result.results
            ) {

              text +=
`🧾 #${order.id}
💰 ${order.gram_amount} GRAM
🪙 ${formatNumber(order.ptn_amount)} PTN
📌 ${displayStatus(order.status)}
👤 ${order.telegram_id}

`;
            }
          }


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text,
              reply_markup: ADMIN_BACK
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           ADMIN USERS
        =================================================== */

        if (
          action ===
          "admin_users"
        ) {

          const userCount =
            await env.DB.prepare(
              `SELECT COUNT(*) AS count
               FROM users`
            )
              .first();


          const recentUsers =
            await env.DB.prepare(
              `SELECT
                 telegram_id,
                 username,
                 created_at
               FROM users
               ORDER BY id DESC
               LIMIT 15`
            )
              .all();


          let text =
`👥 USERS

Total users:
${userCount?.count || 0}

Recent users:

`;


          if (
            recentUsers.results &&
            recentUsers.results.length
          ) {

            for (
              const user
              of recentUsers.results
            ) {

              text +=
`👤 ${user.username
  ? "@" + user.username
  : "No username"}

ID: ${user.telegram_id}

`;
            }

          } else {

            text +=
              "No users found.";
          }


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text,
              reply_markup: ADMIN_BACK
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           ADMIN REVENUE
        =================================================== */

        if (
          action ===
          "admin_revenue"
        ) {

          const revenue =
            await env.DB.prepare(
              `SELECT
                 COALESCE(
                   SUM(
                     CAST(gram_amount AS REAL)
                   ),
                   0
                 ) AS gram_total,

                 COALESCE(
                   SUM(
                     CAST(ptn_amount AS REAL)
                   ),
                   0
                 ) AS ptn_total

               FROM orders
               WHERE status = 'payout_sent'`
            )
              .first();


          const completedOrders =
            await env.DB.prepare(
              `SELECT COUNT(*) AS count
               FROM orders
               WHERE status = 'payout_sent'`
            )
              .first();


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text:
`💰 REVENUE

Completed Orders:
${completedOrders?.count || 0}

💰 GRAM Received:
${formatNumber(
  revenue?.gram_total || 0
)} GRAM

🪙 PTN Sold:
${formatNumber(
  revenue?.ptn_total || 0
)} PTN`,
              reply_markup: ADMIN_BACK
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           HOME
        =================================================== */

        if (action === "home") {

          await env.DB.prepare(
            `DELETE FROM orders
             WHERE telegram_id = ?
             AND status IN (
               'awaiting_amount',
               'awaiting_wallet'
             )`
          )
            .bind(
              String(chatId)
            )
            .run();


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text: WELCOME,
              reply_markup: MENU
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           BUY
        =================================================== */

        if (action === "buy") {

          await env.DB.prepare(
            `DELETE FROM orders
             WHERE telegram_id = ?
             AND status IN (
               'awaiting_amount',
               'awaiting_wallet'
             )`
          )
            .bind(
              String(chatId)
            )
            .run();


          await env.DB.prepare(
            `INSERT INTO orders
             (telegram_id, gram_amount, ptn_amount, status)
             VALUES (?, '0', '0', 'awaiting_amount')`
          )
            .bind(
              String(chatId)
            )
            .run();


          await telegram(
            env,
            "editMessageText",
            {
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
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           PRICE
        =================================================== */

        if (action === "price") {

          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text:
`💰 PAYTON Presale Price

1,000,000 PTN = 1 GRAM`,
              reply_markup: BACK
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           ORDERS
        =================================================== */

        if (action === "orders") {

          const result =
            await env.DB.prepare(
              `SELECT
                 id,
                 gram_amount,
                 ptn_amount,
                 status,
                 created_at
               FROM orders
               WHERE telegram_id = ?
               AND status NOT IN (
                 'awaiting_amount',
                 'awaiting_wallet'
               )
               ORDER BY id DESC
               LIMIT 10`
            )
              .bind(
                String(chatId)
              )
              .all();


          if (
            !result.results ||
            result.results.length === 0
          ) {

            await telegram(
              env,
              "editMessageText",
              {
                chat_id: chatId,
                message_id: messageId,
                text:
`📋 My Orders

You have no orders yet.`,
                reply_markup: BACK
              }
            );


            return new Response("OK");
          }


          let ordersText =
            "📋 My Orders\n\n";


          for (
            const order
            of result.results
          ) {

            ordersText +=
`🧾 Order #${order.id}

💰 ${order.gram_amount} GRAM
🪙 ${formatNumber(order.ptn_amount)} PTN
📌 Status: ${displayStatus(order.status)}

`;
          }


          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text: ordersText,
              reply_markup: BACK
            }
          );


          return new Response("OK");
        }


        /* ===================================================
           SUPPORT
        =================================================== */

        if (action === "support") {

          await telegram(
            env,
            "editMessageText",
            {
              chat_id: chatId,
              message_id: messageId,
              text:
`💬 Support

Please send your message in this chat.

Our Support team will receive your message and respond as soon as possible.`,
              reply_markup: BACK
            }
          );


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
   ADMIN STATISTICS
========================================================= */

async function getAdminStats(env) {

  const users =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM users`
    )
      .first();


  const orders =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE status NOT IN (
         'awaiting_amount',
         'awaiting_wallet'
       )`
    )
      .first();


  const pending =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE status = 'pending'`
    )
      .first();


  const paymentVerified =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE status = 'payment_verified'`
    )
      .first();


  const payoutProcessing =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE status = 'payout_processing'`
    )
      .first();


  const completed =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE status = 'payout_sent'`
    )
      .first();


  const money =
    await env.DB.prepare(
      `SELECT
         COALESCE(
           SUM(
             CAST(gram_amount AS REAL)
           ),
           0
         ) AS revenue,

         COALESCE(
           SUM(
             CAST(ptn_amount AS REAL)
           ),
           0
         ) AS ptn_sold

       FROM orders
       WHERE status = 'payout_sent'`
    )
      .first();


  return {
    users:
      Number(users?.count || 0),

    orders:
      Number(orders?.count || 0),

    pending:
      Number(pending?.count || 0),

    paymentVerified:
      Number(paymentVerified?.count || 0),

    payoutProcessing:
      Number(payoutProcessing?.count || 0),

    completed:
      Number(completed?.count || 0),

    revenue:
      money?.revenue || 0,

    ptnSold:
      money?.ptn_sold || 0
  };
}


/* =========================================================
   PROCESS ORDERS
========================================================= */

async function processOrders(env) {

  const result =
    await env.DB.prepare(
      `SELECT *
       FROM orders
       WHERE status IN (
         'pending',
         'payment_verified'
       )
       ORDER BY id ASC
       LIMIT 20`
    )
      .all();


  if (
    !result.results ||
    result.results.length === 0
  ) {
    return;
  }


  for (
    const order
    of result.results
  ) {

    try {

      if (
        order.status ===
        "pending"
      ) {

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


        const alreadyUsed =
          await env.DB.prepare(
            `SELECT id
             FROM orders
             WHERE transaction_hash = ?
             AND id != ?
             LIMIT 1`
          )
            .bind(
              payment.transactionHash,
              order.id
            )
            .first();


        if (alreadyUsed) {

          console.error(
            "Payment transaction already used:",
            payment.transactionHash
          );

          continue;
        }


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


        await telegram(
          env,
          "sendMessage",
          {
            chat_id:
              Number(order.telegram_id),

            text:
`✅ Payment Confirmed

🧾 Order #${order.id}

💰 ${order.gram_amount} GRAM received.

🪙 Your PTN transfer is now being processed automatically.`
          }
        );


        order.status =
          "payment_verified";

        order.transaction_hash =
          payment.transactionHash;
      }


      if (
        order.status ===
        "payment_verified"
      ) {

        await sendPTN(
          env,
          order
        );
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

async function findPayment(
  env,
  order
) {

  const receiving =
    Address.parse(
      GRAM_RECEIVING_WALLET
    );


  const expectedSource =
    Address.parse(
      order.payment_address
    );


  const expectedAmount =
    gramToNano(
      order.gram_amount
    );


  const orderCreated =
    parseSqliteDate(
      order.created_at
    );


  const startTime =
    Math.max(
      orderCreated - 60,
      Math.floor(
        Date.now() / 1000
      ) -
        PAYMENT_LOOKBACK_SECONDS
    );


  const endTime =
    Math.floor(
      Date.now() / 1000
    ) + 10;


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


  for (
    const tx
    of transactions
  ) {

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


    if (
      !message.source ||
      !message.destination
    ) {
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
      BigInt(
        message.value || "0"
      ) !== expectedAmount
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


    if (!tx.hash) {
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

async function sendPTN(
  env,
  order
) {

  const claim =
    await env.DB.prepare(
      `UPDATE orders
       SET status = 'payout_processing'
       WHERE id = ?
       AND status = 'payment_verified'`
    )
      .bind(
        order.id
      )
      .run();


  if (
    !claim.meta ||
    claim.meta.changes !== 1
  ) {

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


    if (
      !env.PTN_MNEMONIC
    ) {

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


    const wallet =
      WalletContractV5R1.create({
        walletId: {
          networkGlobalId: -239
        },

        publicKey:
          keyPair.publicKey,

        workchain: 0
      });


    const derivedAddress =
      wallet.address.toRawString();


    const expectedSenderAddress =
      Address
        .parse(
          PTN_SENDER_WALLET
        )
        .toRawString();


    if (
      derivedAddress !==
      expectedSenderAddress
    ) {

      throw new Error(
        "PTN_MNEMONIC does not match the configured PTN sender wallet."
      );
    }


    const destination =
      Address.parse(
        order.payment_address
      );


    const deployed =
      await client.isContractDeployed(
        wallet.address
      );


    if (!deployed) {

      throw new Error(
        "PTN sender V5R1 wallet is not deployed. The payout wallet must be activated before automatic PTN payouts can be sent."
      );
    }


    const tonBalance =
      await client.getBalance(
        wallet.address
      );


    if (
      tonBalance <
      MIN_SENDER_TON_BALANCE
    ) {

      throw new Error(
        "Insufficient TON balance in PTN sender wallet for payout fees."
      );
    }


    const master =
      client.open(
        JettonMaster.create(
          Address.parse(
            PTN_MASTER
          )
        )
      );


    const senderJettonWalletAddress =
      await master.getWalletAddress(
        wallet.address
      );


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
      currentBalance <
      ptnUnits
    ) {

      throw new Error(
        "Insufficient PTN balance in sender Jetton wallet."
      );
    }


    const existingPayout =
      await findExistingPayout(
        env,
        wallet.address,
        destination,
        ptnUnits,
        order.id
      );


    if (
      existingPayout
    ) {

      await env.DB.prepare(
        `UPDATE orders
         SET status = 'payout_sent'
         WHERE id = ?
         AND status = 'payout_processing'`
      )
        .bind(
          order.id
        )
        .run();


      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            Number(order.telegram_id),

          text:
`🎉 Order Completed

🧾 Order #${order.id}

🪙 ${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.

Thank you for purchasing PAYTON (PTN).`
        }
      );


      return;
    }


    const transferBody =
      beginCell()

        .storeUint(
          0x0f8a7ea5,
          32
        )

        .storeUint(
          BigInt(order.id),
          64
        )

        .storeCoins(
          ptnUnits
        )

        .storeAddress(
          destination
        )

        .storeAddress(
          wallet.address
        )

        .storeBit(0)

        .storeCoins(
          0n
        )

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


    await env.DB.prepare(
      `UPDATE orders
       SET status = 'payout_sent'
       WHERE id = ?
       AND status = 'payout_processing'`
    )
      .bind(
        order.id
      )
      .run();


    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          Number(order.telegram_id),

        text:
`🎉 Order Completed

🧾 Order #${order.id}

🪙 ${formatNumber(order.ptn_amount)} PTN has been sent automatically.

Thank you for purchasing PAYTON (PTN).`
      }
    );


  } catch (error) {

    console.error(
      "PTN payout error:",
      order.id,
      error
    );


    await env.DB.prepare(
      `UPDATE orders
       SET status = 'payment_verified'
       WHERE id = ?
       AND status = 'payout_processing'`
    )
      .bind(
        order.id
      )
      .run();


    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          Number(order.telegram_id),

        text:
`⚠️ Payment was confirmed for Order #${order.id}, but the PTN transfer is still processing.

The system will retry automatically.`
      }
    );
  }
}


/* =========================================================
   FIND EXISTING PTN PAYOUT
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
    Address
      .parse(
        PTN_MASTER
      )
      .toRawString()
  );


  url.searchParams.set(
    "direction",
    "out"
  );


  url.searchParams.set(
    "start_utime",
    String(
      Math.floor(
        Date.now() / 1000
      ) -
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

    console.error(
      "Jetton transfer lookup failed:",
      response.status
    );

    return false;
  }


  const data =
    await response.json();


  const transfers =
    data.jetton_transfers || [];


  for (
    const transfer
    of transfers
  ) {

    if (
      transfer.transaction_aborted === true
    ) {
      continue;
    }


    if (
      String(
        transfer.query_id
      ) !==
      String(orderId)
    ) {
      continue;
    }


    if (
      BigInt(
        transfer.amount || "0"
      ) !==
      expectedAmount
    ) {
      continue;
    }


    if (
      !transfer.destination
    ) {
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


    return {
      transactionHash:
        transfer.transaction_hash || null
    };
  }


  return null;
}


/* =========================================================
   GRAM → PTN
========================================================= */

function gramToPTN(
  value
) {

  const parts =
    String(value)
      .split(".");


  const whole =
    parts[0] || "0";


  const decimal =
    (parts[1] || "")
      .padEnd(
        9,
        "0"
      );


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
      .padStart(
        9,
        "0"
      )
      .replace(
        /0+$/,
        ""
      )
  );
}


/* =========================================================
   GRAM → NANO
========================================================= */

function gramToNano(
  value
) {

  const parts =
    String(value)
      .split(".");


  const whole =
    parts[0] || "0";


  const decimal =
    (parts[1] || "")
      .padEnd(
        9,
        "0"
      );


  return (
    BigInt(whole) *
      1000000000n +
    BigInt(decimal)
  );
}


/* =========================================================
   PTN HUMAN AMOUNT → BASE UNITS
========================================================= */

function ptnToUnits(
  value
) {

  const parts =
    String(value)
      .split(".");


  const whole =
    parts[0] || "0";


  const decimal =
    (parts[1] || "")
      .padEnd(
        PTN_DECIMALS,
        "0"
      );


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

function formatNumber(
  value
) {

  const parts =
    String(value)
      .split(".");


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

function displayStatus(
  status
) {

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

function parseSqliteDate(
  value
) {

  if (!value) {

    return Math.floor(
      Date.now() / 1000
    );
  }


  const parsed =
    Date.parse(
      String(value)
        .replace(
          " ",
          "T"
        ) +
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

function decodeComment(
  body
) {

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


    const chunks =
      [];


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
      .toString(
        "utf8"
      );

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
          JSON.stringify(
            data
          )
      }
    );


  return response;
}
