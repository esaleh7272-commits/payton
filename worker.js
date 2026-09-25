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

globalThis.Buffer = Buffer;
globalThis.window = globalThis;

/* =========================================================
   PAYTON CONFIG
========================================================= */

const WELCOME = `🦊 Welcome to PAYTON (PTN)

Welcome to the official PAYTON presale.

💰 Payment: GRAM

Presale Price: 1,000,000 PTN = 1 GRAM

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
   ADMIN
========================================================= */

const ADMIN_TELEGRAM_ID = "113074274";

const ADMIN_MENU = {
  inline_keyboard: [
    [{ text: "📊 Dashboard", callback_data: "admin_dashboard" }],
    [
      { text: "📋 All Orders", callback_data: "admin_orders" },
      { text: "⏳ Pending", callback_data: "admin_pending" }
    ],
    [
      { text: "👥 Users", callback_data: "admin_users" },
      { text: "💬 Support", callback_data: "admin_support" }
    ],
    [
      { text: "🚨 Suspicious", callback_data: "admin_suspicious" },
      { text: "💰 Revenue", callback_data: "admin_revenue" }
    ],
    [{ text: "⚡ Reply Templates", callback_data: "admin_templates" }],
    [{ text: "🔄 Refresh", callback_data: "admin_dashboard" }]
  ]
};

const ADMIN_BACK = {
  inline_keyboard: [
    [{ text: "⬅️ Admin Panel", callback_data: "admin_home" }]
  ]
};

/* =========================================================
   PRESALE CONFIG
========================================================= */

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const GRAM_RECEIVING_WALLET =
  "UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";

const PTN_DECIMALS = 9;

/*
 * 1 GRAM = 1,000,000 whole PTN.
 *
 * We intentionally accept a maximum of 6 decimal places
 * for GRAM because the current orders.ptn_amount field
 * stores whole PTN amounts.
 */
const PTN_PER_GRAM = 1000000n;

const MAX_GRAM_DECIMALS = 6;

const MIN_SENDER_TON_BALANCE = toNano("0.10");

const PTN_TRANSFER_TON = toNano("0.05");

const PTN_FORWARD_TON = toNano("0.01");

/*
 * We don't retry an ambiguous broadcast immediately.
 * If sendTransfer() fails after the request may have reached
 * the TON node, we first reconcile the blockchain.
 */
const PAYOUT_UNKNOWN_RETRY_DELAY_MS = 30 * 60 * 1000;

/*
 * Search window for incoming payments.
 * The transaction API is queried starting slightly before
 * order creation to account for clock differences.
 */
const PAYMENT_LOOKBACK_SECONDS = 120;

/* =========================================================
   SUPPORT QUICK REPLIES
========================================================= */

const QUICK_REPLIES = [
  "⏳ Please wait while your transaction is being verified.",
  "🔍 Your transaction is currently under review.",
  "✅ Your payment has been verified successfully.",
  "❌ We could not verify this transaction.",
  "⚠️ This transaction has already been used.",
  "💰 We have not received your payment yet.",
  "🔄 Please wait for the blockchain confirmation.",
  "📋 Please send your transaction hash.",
  "💳 Please make sure you sent the correct amount.",
  "⚠️ The payment amount does not match your order.",
  "🕐 Your order is still being processed.",
  "✅ Your order has been completed successfully.",
  "📦 Your PTN tokens have been sent.",
  "❌ Your order could not be completed.",
  "🔎 We are checking the payment details now.",
  "⚠️ Please do not send another payment while your transaction is being checked.",
  "📩 Your message has been received. Support will respond shortly.",
  "🔐 Your request requires additional verification.",
  "⚠️ Please contact support if you believe this result is incorrect.",
  "🙏 Thank you for your patience."
];

/* =========================================================
   MAIN FETCH
========================================================= */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("PAYTON BOT OK", {
        status: 200
      });
    }

    try {
      await ensureExtraTables(env);
    } catch (error) {
      console.error("TABLE INITIALIZATION ERROR:", error);

      /*
       * Do not expose database errors to Telegram.
       * Telegram only needs a successful webhook response.
       */
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("OK", {
        status: 200
      });
    }

    try {
      await handleUpdate(update, env, ctx);
    } catch (error) {
      console.error("UPDATE ERROR:", error);
    }

    return new Response("OK", {
      status: 200
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureExtraTables(env);
          await processOrders(env);
        } catch (error) {
          console.error("CRON ERROR:", error);
        }
      })()
    );
  }
};

/* =========================================================
   EXTRA TABLES
========================================================= */

async function ensureExtraTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      username TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      admin_reply TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS suspicious_users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      reason TEXT,
      suspicious_count INTEGER DEFAULT 1,
      blocked_until TEXT,
      permanent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_states (
      telegram_id TEXT PRIMARY KEY,
      mode TEXT,
      target_id TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  /*
   * Permanently associates an incoming payment hash
   * with one order.
   *
   * This is stronger than only checking orders.transaction_hash
   * because two Workers can otherwise race between SELECT and UPDATE.
   */
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS used_payments (
      transaction_hash TEXT PRIMARY KEY,
      order_id INTEGER NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  /*
   * Persistent payout state.
   *
   * order_id is unique, therefore one order can have only
   * one payout attempt.
   */
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS payout_attempts (
      order_id INTEGER PRIMARY KEY,
      query_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'created',
      seqno INTEGER,
      tx_hash TEXT,
      tx_lt TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT
    )
  `).run();

  /*
   * Helpful indexes.
   *
   * These are intentionally non-unique because the existing
   * production database may already contain historical rows.
   */
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_orders_telegram_status
    ON orders(telegram_id, status)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_orders_transaction_hash
    ON orders(transaction_hash)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_payout_attempts_status
    ON payout_attempts(status)
  `).run();
}

/* =========================================================
   UPDATE HANDLER
========================================================= */

async function handleUpdate(update, env, ctx) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (!update.message) {
    return;
  }

  const message = update.message;

  const chatId = String(
    message.chat?.id || ""
  );

  const text = String(
    message.text || ""
  ).trim();

  if (!chatId) {
    return;
  }

  /*
   * ADMIN
   */

  if (chatId === ADMIN_TELEGRAM_ID) {
    if (text === "/admin") {
      await clearAdminState(env);

      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "🛠 PAYTON Admin Panel",
        reply_markup: ADMIN_MENU
      });

      return;
    }

    const handled = await handleAdminText(
      message,
      env
    );

    if (handled) {
      return;
    }
  }

  /*
   * USER RESTRICTION
   */

  if (chatId !== ADMIN_TELEGRAM_ID) {
    const restriction = await getUserRestriction(
      env,
      chatId
    );

    if (restriction) {
      await sendBlockedMessage(
        env,
        chatId,
        restriction
      );

      return;
    }
  }

  /*
   * START
   */

  if (text === "/start") {
    await upsertUser(
      env,
      message.from
    );

    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: WELCOME,
      reply_markup: MENU
    });

    return;
  }

  /*
   * SUPPORT
   */

  if (chatId !== ADMIN_TELEGRAM_ID) {
    const supportHandled =
      await handleSupportMessage(
        message,
        env
      );

    if (supportHandled) {
      return;
    }
  }

  /*
   * ACTIVE ORDER
   */

  if (chatId !== ADMIN_TELEGRAM_ID) {
    const state =
      await getPendingOrder(
        env,
        chatId
      );

    if (state) {
      await handleOrderText(
        message,
        state,
        env
      );

      return;
    }

    if (text) {
      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "Please use the menu below.",
        reply_markup: MENU
      });
    }
  }
}

/* =========================================================
   CALLBACK HANDLER
========================================================= */

async function handleCallback(query, env) {
  const data = String(
    query.data || ""
  );

  const chatId = String(
    query.message?.chat?.id || ""
  );

  if (!chatId) {
    return;
  }

  /*
   * ADMIN CALLBACKS
   */

  if (data.startsWith("admin_")) {
    if (chatId !== ADMIN_TELEGRAM_ID) {
      await telegram(
        env,
        "answerCallbackQuery",
        {
          callback_query_id: query.id,
          text: "Access denied."
        }
      );

      return;
    }

    await handleAdminCallback(
      query,
      env
    );

    return;
  }

  /*
   * USER RESTRICTION
   */

  const restriction =
    await getUserRestriction(
      env,
      chatId
    );

  if (restriction) {
    await telegram(
      env,
      "answerCallbackQuery",
      {
        callback_query_id: query.id,
        text:
          "Your access to this bot is currently restricted."
      }
    );

    await sendBlockedMessage(
      env,
      chatId,
      restriction
    );

    return;
  }

  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id: query.id
    }
  );

  /*
   * HOME
   */

  if (data === "home") {
    /*
     * Only cancel unfinished draft orders.
     * Never touch pending/paid/processing orders.
     */
    await env.DB.prepare(`
      UPDATE orders
      SET status='cancelled'
      WHERE telegram_id=?
      AND status IN (
        'awaiting_amount',
        'awaiting_wallet'
      )
    `)
      .bind(chatId)
      .run();

    await editMessage(
      env,
      query,
      WELCOME,
      MENU
    );

    return;
  }

  /*
   * BUY
   */

  if (data === "buy") {
    await upsertUser(
      env,
      query.from
    );

    /*
     * FIX:
     * The old code tried to UPDATE the latest order
     * without creating one first.
     *
     * We reuse an unfinished draft if one exists;
     * otherwise create a new order.
     */
    let draft =
      await env.DB.prepare(`
        SELECT *
        FROM orders
        WHERE telegram_id=?
        AND status IN (
          'awaiting_amount',
          'awaiting_wallet'
        )
        ORDER BY id DESC
        LIMIT 1
      `)
        .bind(chatId)
        .first();

    if (!draft) {
      const inserted =
        await env.DB.prepare(`
          INSERT INTO orders (
            telegram_id,
            gram_amount,
            ptn_amount,
            payment_address,
            status
          )
          VALUES (?, NULL, NULL, NULL, 'awaiting_amount')
        `)
          .bind(chatId)
          .run();

      const insertedId =
        Number(
          inserted?.meta?.last_row_id ??
          inserted?.last_row_id ??
          0
        );

      if (insertedId) {
        draft =
          await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE id=?
            LIMIT 1
          `)
            .bind(insertedId)
            .first();
      }
    }

    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🪙 Buy PTN\n\n" +
        "Please enter the amount of GRAM you want to pay.\n\n" +
        "Example:\n" +
        "10\n\n" +
        "You will receive 10,000,000 PTN.",
      reply_markup: BACK
    });

    return;
  }

  /*
   * PRICE
   */

  if (data === "price") {
    await editMessage(
      env,
      query,
      "💰 PAYTON (PTN) Presale Price\n\n1 GRAM = 1,000,000 PTN",
      BACK
    );

    return;
  }

  /*
   * ORDERS
   */

  if (data === "orders") {
    await showUserOrders(
      env,
      query
    );

    return;
  }

  /*
   * SUPPORT
   */

  if (data === "support") {
    await createSupportRequest(
      env,
      query.from
    );

    await editMessage(
      env,
      query,
      "💬 Support\n\n" +
        "Please send your message now.\n\n" +
        "Our support team will review your message and reply to you.",
      BACK
    );

    return;
  }
}

/* =========================================================
   ADMIN CALLBACK HANDLER
========================================================= */

async function handleAdminCallback(
  query,
  env
) {
  const data = String(
    query.data || ""
  );

  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id: query.id
    }
  );

  if (data === "admin_home") {
    await editMessage(
      env,
      query,
      "🛠 PAYTON Admin Panel",
      ADMIN_MENU
    );

    return;
  }

  if (data === "admin_dashboard") {
    await showAdminDashboard(
      env,
      query
    );

    return;
  }

  if (data === "admin_orders") {
    await showAdminOrders(
      env,
      query
    );

    return;
  }

  if (data === "admin_pending") {
    await showAdminPending(
      env,
      query
    );

    return;
  }

  if (data === "admin_users") {
    await showAdminUsers(
      env,
      query
    );

    return;
  }

  if (data === "admin_revenue") {
    await showAdminRevenue(
      env,
      query
    );

    return;
  }

  if (data === "admin_support") {
    await showSupportInbox(
      env,
      query
    );

    return;
  }

  if (data === "admin_suspicious") {
    await showSuspiciousUsers(
      env,
      query
    );

    return;
  }

  if (data === "admin_templates") {
    await showTemplates(
      env,
      query
    );

    return;
  }

  if (data.startsWith("admin_ticket_")) {
    const id = Number(
      data.replace(
        "admin_ticket_",
        ""
      )
    );

    if (
      Number.isInteger(id) &&
      id > 0
    ) {
      await showSupportTicket(
        env,
        query,
        id
      );
    }

    return;
  }

  if (data.startsWith("admin_reply_")) {
    const id = Number(
      data.replace(
        "admin_reply_",
        ""
      )
    );

    if (
      Number.isInteger(id) &&
      id > 0
    ) {
      await setAdminState(
        env,
        "reply",
        String(id)
      );

      await editMessage(
        env,
        query,
        "✍️ Manual Reply\n\n" +
          "Send the message you want to send to this user.\n\n" +
          "Send /cancel to cancel.",
        {
          inline_keyboard: [
            [
              {
                text: "❌ Cancel",
                callback_data:
                  "admin_cancel_reply"
              }
            ]
          ]
        }
      );
    }

    return;
  }

  if (data === "admin_cancel_reply") {
    await clearAdminState(
      env
    );

    await editMessage(
      env,
      query,
      "🛠 PAYTON Admin Panel",
      ADMIN_MENU
    );

    return;
  }

  if (data.startsWith("admin_quick_")) {
    const parts =
      data.split("_");

    if (parts.length >= 4) {
      const ticketId =
        Number(parts[2]);

      const page =
        Number(parts[3] || 0);

      if (
        Number.isInteger(ticketId) &&
        Number.isInteger(page)
      ) {
        await showQuickReplies(
          env,
          query,
          ticketId,
          page
        );
      }
    }

    return;
  }

  if (data.startsWith("admin_qsend_")) {
    const parts =
      data.split("_");

    if (parts.length >= 4) {
      const ticketId =
        Number(parts[2]);

      const index =
        Number(parts[3]);

      if (
        Number.isInteger(ticketId) &&
        Number.isInteger(index) &&
        QUICK_REPLIES[index]
      ) {
        await sendQuickReply(
          env,
          query,
          ticketId,
          index
        );
      }
    }

    return;
  }

  if (data.startsWith("admin_sus_")) {
    const telegramId =
      data.replace(
        "admin_sus_",
        ""
      );

    if (telegramId) {
      await showSuspiciousUser(
        env,
        query,
        telegramId
      );
    }

    return;
  }

  if (data.startsWith("admin_block_")) {
    const parts =
      data.split("_");

    const type = parts[2];

    const telegramId =
      parts
        .slice(3)
        .join("_");

    if (telegramId) {
      await blockSuspiciousUser(
        env,
        query,
        telegramId,
        type
      );
    }

    return;
  }

  if (data.startsWith("admin_unblock_")) {
    const telegramId =
      data.replace(
        "admin_unblock_",
        ""
      );

    if (telegramId) {
      await unblockSuspiciousUser(
        env,
        query,
        telegramId
      );
    }

    return;
  }
}

/* =========================================================
   ADMIN TEXT
========================================================= */

async function handleAdminText(
  message,
  env
) {
  const chatId =
    ADMIN_TELEGRAM_ID;

  const text =
    String(
      message.text || ""
    ).trim();

  if (!text) {
    return false;
  }

  if (text === "/cancel") {
    await clearAdminState(
      env
    );

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text: "❌ Reply cancelled.",
        reply_markup:
          ADMIN_MENU
      }
    );

    return true;
  }

  const state =
    await getAdminState(
      env
    );

  if (!state) {
    return false;
  }

  if (state.mode === "reply") {
    const ticketId =
      Number(
        state.target_id
      );

    if (!ticketId) {
      await clearAdminState(
        env
      );

      return true;
    }

    const ticket =
      await env.DB.prepare(`
        SELECT *
        FROM support_messages
        WHERE id=?
        LIMIT 1
      `)
        .bind(ticketId)
        .first();

    if (!ticket) {
      await clearAdminState(
        env
      );

      await telegram(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "❌ Support ticket not found.",
          reply_markup:
            ADMIN_MENU
        }
      );

      return true;
    }

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          ticket.telegram_id,
        text:
          "💬 Support\n\n" +
          text +
          "\n\nIf you need further assistance, please send another message.",
        reply_markup:
          MENU
      }
    );

    await env.DB.prepare(`
      UPDATE support_messages
      SET status='replied',
          admin_reply=?
      WHERE id=?
    `)
      .bind(
        text,
        ticketId
      )
      .run();

    await clearAdminState(
      env
    );

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "✅ Reply sent successfully.",
        reply_markup:
          ADMIN_MENU
      }
    );

    return true;
  }

  return false;
}

/* =========================================================
   SUPPORT
========================================================= */

async function createSupportRequest(
  env,
  user
) {
  const telegramId =
    String(user.id);

  const username =
    user.username
      ? `@${user.username}`
      : null;

  const existing =
    await env.DB.prepare(`
      SELECT id
      FROM support_messages
      WHERE telegram_id=?
      AND status='awaiting_message'
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(telegramId)
      .first();

  if (existing) {
    return;
  }

  await env.DB.prepare(`
    INSERT INTO support_messages
    (
      telegram_id,
      username,
      message,
      status
    )
    VALUES (?, ?, ?, 'awaiting_message')
  `)
    .bind(
      telegramId,
      username,
      "**AWAITING_MESSAGE**"
    )
    .run();
}

async function handleSupportMessage(
  message,
  env
) {
  const telegramId =
    String(
      message.from?.id || ""
    );

  const text =
    String(
      message.text || ""
    ).trim();

  if (!telegramId || !text) {
    return false;
  }

  const ticket =
    await env.DB.prepare(`
      SELECT *
      FROM support_messages
      WHERE telegram_id=?
      AND status='awaiting_message'
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(telegramId)
      .first();

  if (!ticket) {
    return false;
  }

  const username =
    message.from?.username
      ? `@${message.from.username}`
      : "No username";

  await env.DB.prepare(`
    UPDATE support_messages
    SET username=?,
        message=?,
        status='open'
    WHERE id=?
  `)
    .bind(
      username,
      text,
      ticket.id
    )
    .run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text:
        "📩 Your message has been received.\n\n" +
        "Support will respond shortly.",
      reply_markup:
        MENU
    }
  );

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        ADMIN_TELEGRAM_ID,
      text:
        "💬 New Support Message\n\n" +
        `Ticket: #${ticket.id}\n` +
        `User: ${username}\n` +
        `ID: ${telegramId}\n\n` +
        "Message:\n" +
        text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "↩️ Reply",
              callback_data:
                `admin_ticket_${ticket.id}`
            }
          ]
        ]
      }
    }
  );

  return true;
}

async function showSupportInbox(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM support_messages
      WHERE status='open'
      ORDER BY id DESC
      LIMIT 20
    `).all();

  const buttons = [];

  for (
    const row of rows.results || []
  ) {
    const name =
      row.username ||
      row.telegram_id;

    buttons.push([
      {
        text:
          `💬 #${row.id} ${shortText(
            name,
            30
          )}`,
        callback_data:
          `admin_ticket_${row.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Admin Panel",
      callback_data:
        "admin_home"
    }
  ]);

  const text =
    "💬 Support Inbox\n\n" +
    (
      rows.results?.length
        ? "Open support tickets:"
        : "No open support tickets."
    );

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard:
        buttons
    }
  );
}

async function showSupportTicket(
  env,
  query,
  ticketId
) {
  const ticket =
    await env.DB.prepare(`
      SELECT *
      FROM support_messages
      WHERE id=?
      LIMIT 1
    `)
      .bind(ticketId)
      .first();

  if (!ticket) {
    await editMessage(
      env,
      query,
      "❌ Support ticket not found.",
      ADMIN_BACK
    );

    return;
  }

  const username =
    ticket.username ||
    "No username";

  const text =
    "💬 Support Ticket\n\n" +
    `Ticket: #${ticket.id}\n` +
    `User: ${username}\n` +
    `Telegram ID: ${ticket.telegram_id}\n` +
    `Status: ${ticket.status}\n\n` +
    "Message:\n" +
    shortText(
      ticket.message,
      3000
    );

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "↩️ Manual Reply",
            callback_data:
              `admin_reply_${ticket.id}`
          }
        ],
        [
          {
            text: "⚡ Quick Replies",
            callback_data:
              `admin_quick_${ticket.id}_0`
          }
        ],
        [
          {
            text: "⬅️ Support Inbox",
            callback_data:
              "admin_support"
          }
        ]
      ]
    }
  );
}

/* =========================================================
   QUICK REPLIES
========================================================= */

async function showQuickReplies(
  env,
  query,
  ticketId,
  page = 0
) {
  const ticket =
    await env.DB.prepare(`
      SELECT *
      FROM support_messages
      WHERE id=?
      LIMIT 1
    `)
      .bind(ticketId)
      .first();

  if (!ticket) {
    await editMessage(
      env,
      query,
      "❌ Support ticket not found.",
      ADMIN_BACK
    );

    return;
  }

  const pageSize = 5;

  const totalPages =
    Math.ceil(
      QUICK_REPLIES.length /
        pageSize
    );

  if (page < 0) {
    page = 0;
  }

  if (page >= totalPages) {
    page = totalPages - 1;
  }

  const start =
    page * pageSize;

  const end =
    Math.min(
      start + pageSize,
      QUICK_REPLIES.length
    );

  const buttons = [];

  for (
    let i = start;
    i < end;
    i++
  ) {
    buttons.push([
      {
        text:
          `${i + 1}. ${shortText(
            QUICK_REPLIES[i],
            42
          )}`,
        callback_data:
          `admin_qsend_${ticketId}_${i}`
      }
    ]);
  }

  const navigation = [];

  if (page > 0) {
    navigation.push({
      text: "⬅️ Previous",
      callback_data:
        `admin_quick_${ticketId}_${page - 1}`
    });
  }

  if (
    page <
    totalPages - 1
  ) {
    navigation.push({
      text: "Next ➡️",
      callback_data:
        `admin_quick_${ticketId}_${page + 1}`
    });
  }

  if (navigation.length) {
    buttons.push(
      navigation
    );
  }

  buttons.push([
    {
      text: "⬅️ Ticket",
      callback_data:
        `admin_ticket_${ticketId}`
    }
  ]);

  await editMessage(
    env,
    query,
    `⚡ Quick Replies\n\nTicket #${ticketId}\nPage ${page + 1}/${totalPages}`,
    {
      inline_keyboard:
        buttons
    }
  );
}

async function sendQuickReply(
  env,
  query,
  ticketId,
  index
) {
  const ticket =
    await env.DB.prepare(`
      SELECT *
      FROM support_messages
      WHERE id=?
      LIMIT 1
    `)
      .bind(ticketId)
      .first();

  if (!ticket) {
    await editMessage(
      env,
      query,
      "❌ Support ticket not found.",
      ADMIN_BACK
    );

    return;
  }

  const reply =
    QUICK_REPLIES[index];

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        ticket.telegram_id,
      text:
        "💬 Support\n\n" +
        reply,
      reply_markup:
        MENU
    }
  );

  await env.DB.prepare(`
    UPDATE support_messages
    SET status='replied',
        admin_reply=?
    WHERE id=?
  `)
    .bind(
      reply,
      ticketId
    )
    .run();

  await editMessage(
    env,
    query,
    "✅ Quick reply sent successfully.",
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Support Inbox",
            callback_data:
              "admin_support"
          }
        ],
        [
          {
            text: "🛠 Admin Panel",
            callback_data:
              "admin_home"
          }
        ]
      ]
    }
  );
}

async function showTemplates(
  env,
  query
) {
  let text =
    "⚡ Reply Templates\n\n";

  QUICK_REPLIES.forEach(
    (reply, index) => {
      text +=
        `${index + 1}. ${reply}\n\n`;
    }
  );

  await editMessage(
    env,
    query,
    shortText(
      text,
      3900
    ),
    ADMIN_BACK
  );
}

/* =========================================================
   SUSPICIOUS USERS
========================================================= */

async function flagSuspicious(
  env,
  telegramId,
  username,
  reason
) {
  await env.DB.prepare(`
    INSERT INTO suspicious_users
    (
      telegram_id,
      username,
      reason,
      suspicious_count,
      blocked_until,
      permanent
    )
    VALUES (?, ?, ?, 1, NULL, 0)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username=excluded.username,
      reason=excluded.reason,
      suspicious_count=
        suspicious_users.suspicious_count + 1,
      updated_at=CURRENT_TIMESTAMP
  `)
    .bind(
      String(telegramId),
      username || null,
      reason
    )
    .run();
}

async function showSuspiciousUsers(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      ORDER BY updated_at DESC
      LIMIT 30
    `).all();

  const buttons = [];

  for (
    const row of rows.results || []
  ) {
    let status = "⚠️";

    if (
      Number(row.permanent) === 1
    ) {
      status = "🚫";
    } else if (
      row.blocked_until
    ) {
      status = "⏳";
    }

    const name =
      row.username ||
      row.telegram_id;

    buttons.push([
      {
        text:
          `${status} ${shortText(
            name,
            25
          )} (${row.suspicious_count})`,
        callback_data:
          `admin_sus_${row.telegram_id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Admin Panel",
      callback_data:
        "admin_home"
    }
  ]);

  await editMessage(
    env,
    query,
    rows.results?.length
      ? "🚨 Suspicious Users\n\nSelect a user:"
      : "🚨 Suspicious Users\n\nNo suspicious users found.",
    {
      inline_keyboard:
        buttons
    }
  );
}

async function showSuspiciousUser(
  env,
  query,
  telegramId
) {
  const row =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      WHERE telegram_id=?
      LIMIT 1
    `)
      .bind(telegramId)
      .first();

  if (!row) {
    await editMessage(
      env,
      query,
      "❌ Suspicious user not found.",
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ Suspicious List",
              callback_data:
                "admin_suspicious"
            }
          ]
        ]
      }
    );

    return;
  }

  let status =
    "⚠️ Suspicious - Not blocked";

  if (
    Number(row.permanent) === 1
  ) {
    status =
      "🚫 Permanently blocked";
  } else if (
    row.blocked_until
  ) {
    status =
      `⏳ Temporarily blocked until ${row.blocked_until} UTC`;
  }

  const text =
    "🚨 Suspicious User\n\n" +
    `User: ${row.username || "No username"}\n` +
    `Telegram ID: ${row.telegram_id}\n` +
    `Suspicious count: ${row.suspicious_count}\n` +
    `Reason: ${row.reason || "Not specified"}\n` +
    `Status: ${status}`;

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "🚫 Block 1 Day",
            callback_data:
              `admin_block_1_${telegramId}`
          }
        ],
        [
          {
            text: "🚫 Block 3 Days",
            callback_data:
              `admin_block_3_${telegramId}`
          }
        ],
        [
          {
            text: "🚫 Block 1 Week",
            callback_data:
              `admin_block_7_${telegramId}`
          }
        ],
        [
          {
            text: "🚫 Permanent Block",
            callback_data:
              `admin_block_permanent_${telegramId}`
          }
        ],
        [
          {
            text: "✅ Unblock",
            callback_data:
              `admin_unblock_${telegramId}`
          }
        ],
        [
          {
            text: "⬅️ Suspicious List",
            callback_data:
              "admin_suspicious"
          }
        ]
      ]
    }
  );
}

async function blockSuspiciousUser(
  env,
  query,
  telegramId,
  type
) {
  let message;

  if (type === "permanent") {
    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=1,
          blocked_until=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `)
      .bind(telegramId)
      .run();

    message =
      "🚫 Due to suspicious activity, you are permanently unable to use this bot.";
  } else {
    const days =
      Number(type);

    if (
      ![1, 3, 7].includes(days)
    ) {
      return;
    }

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=0,
          blocked_until=datetime('now', ?),
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `)
      .bind(
        `+${days} day`,
        telegramId
      )
      .run();

    message =
      `🚫 Due to suspicious activity, you are unable to use this bot for the next ${days} day${days === 1 ? "" : "s"}.`;
  }

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text: message
    }
  );

  await editMessage(
    env,
    query,
    "✅ Block status updated successfully.",
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Suspicious User",
            callback_data:
              `admin_sus_${telegramId}`
          }
        ],
        [
          {
            text: "🚨 Suspicious List",
            callback_data:
              "admin_suspicious"
          }
        ]
      ]
    }
  );
}

async function unblockSuspiciousUser(
  env,
  query,
  telegramId
) {
  await env.DB.prepare(`
    UPDATE suspicious_users
    SET permanent=0,
        blocked_until=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE telegram_id=?
  `)
    .bind(telegramId)
    .run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text:
        "✅ Your access to the PAYTON bot has been restored.",
      reply_markup:
        MENU
    }
  );

  await editMessage(
    env,
    query,
    "✅ User has been unblocked.",
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Suspicious User",
            callback_data:
              `admin_sus_${telegramId}`
          }
        ]
      ]
    }
  );
}

/* =========================================================
   BLOCK CHECK
========================================================= */

async function getUserRestriction(
  env,
  telegramId
) {
  const row =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      WHERE telegram_id=?
      LIMIT 1
    `)
      .bind(
        String(telegramId)
      )
      .first();

  if (!row) {
    return null;
  }

  if (
    Number(row.permanent) === 1
  ) {
    return {
      permanent: true
    };
  }

  if (row.blocked_until) {
    const until =
      parseSqlUtc(
        row.blocked_until
      );

    if (
      until &&
      until > Date.now()
    ) {
      return {
        permanent: false,
        blockedUntil:
          row.blocked_until
      };
    }

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET blocked_until=NULL,
          permanent=0,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `)
      .bind(
        String(telegramId)
      )
      .run();
  }

  return null;
}

async function sendBlockedMessage(
  env,
  chatId,
  restriction
) {
  if (restriction.permanent) {
    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🚫 Due to suspicious activity, you are permanently unable to use this bot."
      }
    );

    return;
  }

  const until =
    restriction.blockedUntil
      ? formatUtcDate(
          restriction.blockedUntil
        )
      : "";

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text:
        "🚫 Due to suspicious activity, you are unable to use this bot temporarily.\n\n" +
        "Access will be restored after the block expires.\n\n" +
        `Block expiry: ${until} UTC`
    }
  );
}

/* =========================================================
   ADMIN DASHBOARD
========================================================= */

async function showAdminDashboard(
  env,
  query
) {
  const stats =
    await getAdminStats(env);

  const text =
    "📊 PAYTON Dashboard\n\n" +
    `👥 Users: ${stats.users}\n` +
    `📋 Orders: ${stats.orders}\n` +
    `⏳ Pending: ${stats.pending}\n` +
    `🚨 Suspicious: ${stats.suspicious}\n` +
    `🚫 Blocked: ${stats.blocked}\n` +
    `💰 Revenue: ${formatNumber(stats.revenue)} GRAM\n` +
    `🪙 PTN Sold: ${formatNumber(stats.ptn)} PTN`;

  await editMessage(
    env,
    query,
    text,
    ADMIN_MENU
  );
}

async function getAdminStats(
  env
) {
  const users =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM users
    `).first();

  const orders =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
    `).first();

  const pending =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status IN (
        'pending',
        'payment_verified',
        'processing'
      )
    `).first();

  const suspicious =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM suspicious_users
    `).first();

  const blocked =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM suspicious_users
      WHERE permanent=1
      OR (
        blocked_until IS NOT NULL
        AND blocked_until > datetime('now')
      )
    `).first();

  const revenue =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(CAST(gram_amount AS REAL)),
          0
        ) AS total
      FROM orders
      WHERE status IN (
        'payment_verified',
        'processing',
        'payout_sent',
        'completed'
      )
    `).first();

  const ptn =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(CAST(ptn_amount AS REAL)),
          0
        ) AS total
      FROM orders
      WHERE status IN (
        'payment_verified',
        'processing',
        'payout_sent',
        'completed'
      )
    `).first();

  return {
    users:
      users?.count || 0,

    orders:
      orders?.count || 0,

    pending:
      pending?.count || 0,

    suspicious:
      suspicious?.count || 0,

    blocked:
      blocked?.count || 0,

    revenue:
      revenue?.total || 0,

    ptn:
      ptn?.total || 0
  };
}

/* =========================================================
   ADMIN ORDERS
========================================================= */

async function showAdminOrders(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      ORDER BY id DESC
      LIMIT 25
    `).all();

  let text =
    "📋 Recent Orders\n\n";

  for (
    const row of rows.results || []
  ) {
    text +=
      `#${row.id} | ${row.telegram_id}\n` +
      `GRAM: ${row.gram_amount}\n` +
      `PTN: ${row.ptn_amount}\n` +
      `Status: ${displayStatus(row.status)}\n` +
      `Date: ${row.created_at}\n\n`;
  }

  if (!rows.results?.length) {
    text +=
      "No orders found.";
  }

  await editMessage(
    env,
    query,
    shortText(
      text,
      3900
    ),
    ADMIN_BACK
  );
}

async function showAdminPending(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE status IN (
        'pending',
        'payment_verified',
        'processing',
        'suspicious'
      )
      ORDER BY id ASC
      LIMIT 25
    `).all();

  let text =
    "⏳ Pending / Under Review\n\n";

  for (
    const row of rows.results || []
  ) {
    text +=
      `#${row.id}\n` +
      `User: ${row.telegram_id}\n` +
      `GRAM: ${row.gram_amount}\n` +
      `PTN: ${row.ptn_amount}\n` +
      `Status: ${displayStatus(row.status)}\n\n`;
  }

  if (!rows.results?.length) {
    text +=
      "No pending orders.";
  }

  await editMessage(
    env,
    query,
    shortText(
      text,
      3900
    ),
    ADMIN_BACK
  );
}

async function showAdminUsers(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM users
      ORDER BY id DESC
      LIMIT 30
    `).all();

  let text =
    "👥 Users\n\n";

  for (
    const row of rows.results || []
  ) {
    text +=
      `ID: ${row.telegram_id}\n` +
      `Username: ${row.username || "No username"}\n` +
      `Joined: ${row.created_at}\n\n`;
  }

  if (!rows.results?.length) {
    text +=
      "No users found.";
  }

  await editMessage(
    env,
    query,
    shortText(
      text,
      3900
    ),
    ADMIN_BACK
  );
}

async function showAdminRevenue(
  env,
  query
) {
  const row =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(CAST(gram_amount AS REAL)),
          0
        ) AS gram,
        COALESCE(
          SUM(CAST(ptn_amount AS REAL)),
          0
        ) AS ptn,
        COUNT(*) AS orders
      FROM orders
      WHERE status IN (
        'payment_verified',
        'processing',
        'payout_sent',
        'completed'
      )
    `).first();

  const text =
    "💰 Revenue\n\n" +
    `Completed/verified orders: ${row?.orders || 0}\n\n` +
    `GRAM received: ${formatNumber(row?.gram || 0)}\n` +
    `PTN sold: ${formatNumber(row?.ptn || 0)}`;

  await editMessage(
    env,
    query,
    text,
    ADMIN_BACK
  );
}

/* =========================================================
   USERS
========================================================= */

async function upsertUser(
  env,
  user
) {
  if (!user?.id) {
    return;
  }

  await env.DB.prepare(`
    INSERT INTO users
    (telegram_id, username)
    VALUES (?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username=excluded.username
  `)
    .bind(
      String(user.id),
      user.username
        ? `@${user.username}`
        : null
    )
    .run();
}

/* =========================================================
   ORDER STATE
========================================================= */

async function getPendingOrder(
  env,
  telegramId
) {
  return await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE telegram_id=?
    AND status IN (
      'awaiting_amount',
      'awaiting_wallet'
    )
    ORDER BY id DESC
    LIMIT 1
  `)
    .bind(
      String(telegramId)
    )
    .first();
}

/* =========================================================
   ORDER INPUT
========================================================= */

async function handleOrderText(
  message,
  order,
  env
) {
  const telegramId =
    String(
      message.from.id
    );

  const text =
    String(
      message.text || ""
    ).trim();

  if (!text) {
    return;
  }

  /*
   * AMOUNT
   */

  if (
    order.status ===
    "awaiting_amount"
  ) {
    const gram =
      parseGramAmount(
        text
      );

    if (gram === null) {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            telegramId,
          text:
            "❌ Invalid GRAM amount.\n\n" +
            "Enter a positive number with up to 6 decimal places.\n\n" +
            "Examples:\n" +
            "10\n" +
            "10.5\n" +
            "0.123456",
          reply_markup:
            BACK
        }
      );

      return;
    }

    const ptn =
      gramToPtn(
        gram
      );

    if (
      ptn === null ||
      BigInt(ptn) <= 0n
    ) {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            telegramId,
          text:
            "❌ The amount is too small.",
          reply_markup:
            BACK
        }
      );

      return;
    }

    await env.DB.prepare(`
      UPDATE orders
      SET gram_amount=?,
          ptn_amount=?,
          status='awaiting_wallet'
      WHERE id=?
      AND status='awaiting_amount'
    `)
      .bind(
        gram,
        ptn,
        order.id
      )
      .run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          telegramId,
        text:
          "✅ Order created.\n\n" +
          `Payment: ${formatNumber(gram)} GRAM\n` +
          `You receive: ${formatNumber(ptn)} PTN\n\n` +
          "Please send your PTN receiving wallet address.\n\n" +
          "This wallet must also be the wallet you use to send the GRAM payment.",
        reply_markup:
          BACK
      }
    );

    return;
  }

  /*
   * WALLET
   */

  if (
    order.status ===
    "awaiting_wallet"
  ) {
    let wallet;

    try {
      wallet =
        Address.parse(
          text
        ).toString();
    } catch {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            telegramId,
          text:
            "❌ Invalid TON wallet address.\n\n" +
            "Please send a valid TON wallet address.",
          reply_markup:
            BACK
        }
      );

      return;
    }

    /*
     * The receiving wallet must be basechain
     * because sendPTN currently requires workchain 0.
     */
    try {
      const parsed =
        Address.parse(
          wallet
        );

      if (
        parsed.workChain !== 0
      ) {
        await telegram(
          env,
          "sendMessage",
          {
            chat_id:
              telegramId,
            text:
              "❌ Please use a TON basechain wallet (workchain 0).",
            reply_markup:
              BACK
          }
        );

        return;
      }
    } catch {
      return;
    }

    /*
     * Prevent multiple active orders from the
     * same wallet at the same time.
     *
     * This is especially important because there is
     * no payment memo/order ID in native GRAM transfers.
     */
    const active =
      await env.DB.prepare(`
        SELECT id
        FROM orders
        WHERE payment_address=?
        AND id<>?
        AND status IN (
          'pending',
          'payment_verified',
          'processing'
        )
        ORDER BY id DESC
        LIMIT 1
      `)
        .bind(
          wallet,
          order.id
        )
        .first();

    if (active) {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            telegramId,
          text:
            "⚠️ This wallet already has an active order.\n\n" +
            `Active order: #${active.id}\n\n` +
            "Please complete that order before creating another payment from the same wallet.",
          reply_markup:
            MENU
        }
      );

      await env.DB.prepare(`
        UPDATE orders
        SET status='cancelled'
        WHERE id=?
        AND status='awaiting_wallet'
      `)
        .bind(order.id)
        .run();

      return;
    }

    const result =
      await env.DB.prepare(`
        UPDATE orders
        SET payment_address=?,
            status='pending'
        WHERE id=?
        AND status='awaiting_wallet'
      `)
        .bind(
          wallet,
          order.id
        )
        .run();

    if (
      changedRows(result) !== 1
    ) {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            telegramId,
          text:
            "⚠️ This order is no longer active.",
          reply_markup:
            MENU
        }
      );

      return;
    }

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          telegramId,
        text:
          "✅ Wallet saved.\n\n" +
          `Order #${order.id}\n` +
          `Payment amount: ${formatNumber(order.gram_amount)} GRAM\n` +
          `PTN amount: ${formatNumber(order.ptn_amount)} PTN\n\n` +
          "Send the exact GRAM amount from this registered wallet:\n\n" +
          `${wallet}\n\n` +
          "To the following payment address:\n\n" +
          `${GRAM_RECEIVING_WALLET}\n\n` +
          "No payment comment is required.\n\n" +
          "After sending the payment, the bot will automatically check the blockchain.",
        reply_markup:
          BACK
      }
    );

    return;
  }
}

/* =========================================================
   USER ORDERS
========================================================= */

async function showUserOrders(
  env,
  query
) {
  const telegramId =
    String(
      query.from.id
    );

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE telegram_id=?
      ORDER BY id DESC
      LIMIT 10
    `)
      .bind(
        telegramId
      )
      .all();

  let text =
    "📋 My Orders\n\n";

  if (!rows.results?.length) {
    text +=
      "You do not have any orders yet.";
  } else {
    for (
      const row of rows.results
    ) {
      text +=
        `Order #${row.id}\n` +
        `GRAM: ${formatNumber(row.gram_amount)}\n` +
        `PTN: ${formatNumber(row.ptn_amount)}\n` +
        `Status: ${displayStatus(row.status)}\n` +
        `Date: ${row.created_at}\n\n`;
    }
  }

  await editMessage(
    env,
    query,
    shortText(
      text,
      3900
    ),
    BACK
  );
}

/* =========================================================
   ORDER PROCESSOR
========================================================= */

async function processOrders(
  env
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE status IN (
        'pending',
        'payment_verified',
        'processing'
      )
      ORDER BY id ASC
      LIMIT 20
    `).all();

  for (
    const order of rows.results || []
  ) {
    try {
      /*
       * =====================================================
       * STEP 1
       * Verify incoming GRAM payment.
       * =====================================================
       */

      if (
        order.status ===
        "pending"
      ) {
        const payment =
          await findPayment(
            env,
            order
          );

        if (!payment) {
          continue;
        }

        /*
         * A transaction already assigned to another order
         * is suspicious.
         */
        if (
          payment.duplicate
        ) {
          const user =
            await env.DB.prepare(`
              SELECT username
              FROM users
              WHERE telegram_id=?
              LIMIT 1
            `)
              .bind(
                order.telegram_id
              )
              .first();

          await flagSuspicious(
            env,
            order.telegram_id,
            user?.username ||
              null,
            "Reused transaction hash on another order"
          );

          await env.DB.prepare(`
            UPDATE orders
            SET transaction_hash=?,
                status='suspicious'
            WHERE id=?
            AND status='pending'
          `)
            .bind(
              payment.hash,
              order.id
            )
            .run();

          await telegram(
            env,
            "sendMessage",
            {
              chat_id:
                order.telegram_id,
              text:
                "⚠️ This transaction has already been used.\n\n" +
                "Your order has been flagged for review.\n\n" +
                "Please do not send another payment."
            }
          );

          await telegram(
            env,
            "sendMessage",
            {
              chat_id:
                ADMIN_TELEGRAM_ID,
              text:
                "🚨 Suspicious activity detected.\n\n" +
                `User: ${order.telegram_id}\n` +
                `Order: #${order.id}\n` +
                "Reason: Reused transaction hash",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🚨 Review User",
                      callback_data:
                        `admin_sus_${order.telegram_id}`
                    }
                  ]
                ]
              }
            }
          );

          continue;
        }

        /*
         * ===================================================
         * ATOMIC PAYMENT CLAIM
         * ===================================================
         *
         * First claim the transaction hash in used_payments.
         *
         * INSERT OR IGNORE gives us a single owner even if
         * two scheduled Worker executions see the same payment.
         */
        const claim =
          await env.DB.prepare(`
            INSERT OR IGNORE INTO used_payments
            (
              transaction_hash,
              order_id
            )
            VALUES (?, ?)
          `)
            .bind(
              payment.hash,
              order.id
            )
            .run();

        if (
          changedRows(claim) !== 1
        ) {
          const owner =
            await env.DB.prepare(`
              SELECT order_id
              FROM used_payments
              WHERE transaction_hash=?
              LIMIT 1
            `)
              .bind(
                payment.hash
              )
              .first();

          /*
           * If this same order already owns the hash,
           * continue safely.
           */
          if (
            Number(owner?.order_id) ===
            Number(order.id)
          ) {
            await env.DB.prepare(`
              UPDATE orders
              SET transaction_hash=?,
                  status='payment_verified'
              WHERE id=?
              AND status='pending'
            `)
              .bind(
                payment.hash,
                order.id
              )
              .run();
          } else {
            await flagSuspicious(
              env,
              order.telegram_id,
              null,
              "Transaction hash was claimed by another order"
            );

            await env.DB.prepare(`
              UPDATE orders
              SET transaction_hash=?,
                  status='suspicious'
              WHERE id=?
              AND status='pending'
            `)
              .bind(
                payment.hash,
                order.id
              )
              .run();

            continue;
          }
        } else {
          const updated =
            await env.DB.prepare(`
              UPDATE orders
              SET transaction_hash=?,
                  status='payment_verified'
              WHERE id=?
              AND status='pending'
            `)
              .bind(
                payment.hash,
                order.id
              )
              .run();

          if (
            changedRows(updated) !== 1
          ) {
            /*
             * The payment has already been claimed by this order,
             * but its status may have changed in a concurrent run.
             */
            console.log(
              `PAYMENT CLAIMED BUT ORDER STATE CHANGED: ${order.id}`
            );
          }
        }

        await telegram(
          env,
          "sendMessage",
          {
            chat_id:
              order.telegram_id,
            text:
              "✅ Payment verified successfully.\n\n" +
              `Order #${order.id}\n` +
              `GRAM received: ${formatNumber(order.gram_amount)}\n` +
              `PTN amount: ${formatNumber(order.ptn_amount)}\n\n` +
              "Your PTN tokens are now being sent automatically."
          }
        );
      }

      /*
       * =====================================================
       * STEP 2
       * Reload order.
       * =====================================================
       */

      let latestOrder =
        await env.DB.prepare(`
          SELECT *
          FROM orders
          WHERE id=?
          LIMIT 1
        `)
          .bind(order.id)
          .first();

      if (!latestOrder) {
        continue;
      }

      if (
        latestOrder.status !==
          "payment_verified" &&
        latestOrder.status !==
          "processing"
      ) {
        continue;
      }

      /*
       * =====================================================
       * STEP 3
       * Persistent payout attempt.
       * =====================================================
       */

      let attempt =
        await getPayoutAttempt(
          env,
          latestOrder.id
        );

      /*
       * =====================================================
       * STEP 4
       * ALWAYS reconcile the blockchain before sending again.
       *
       * This is the most important duplicate-payout protection.
       * =====================================================
       */

      const existingPayout =
        await findExistingPayoutForOrder(
          env,
          latestOrder
        );

      if (existingPayout) {
        await upsertSubmittedPayout(
          env,
          latestOrder.id,
          existingPayout
        );

        await env.DB.prepare(`
          UPDATE orders
          SET status='completed'
          WHERE id=?
          AND status IN (
            'payment_verified',
            'processing'
          )
        `)
          .bind(
            latestOrder.id
          )
          .run();

        await telegram(
          env,
          "sendMessage",
          {
            chat_id:
              latestOrder.telegram_id,
            text:
              "🎉 Order completed successfully!\n\n" +
              `Order #${latestOrder.id}\n` +
              `${formatNumber(latestOrder.ptn_amount)} PTN has been sent to your wallet.\n\n` +
              "The PTN transfer was found on the blockchain."
          }
        );

        continue;
      }

      /*
       * If blockchain reconciliation itself fails,
       * do NOT send another payout.
       *
       * null means "not found OR unable to check".
       * To distinguish these cases, findExistingPayoutForOrder
       * returns a special checkFailed flag.
       */
      const payoutCheck =
        await reconcilePayout(
          env,
          latestOrder
        );

      if (
        payoutCheck.checkFailed
      ) {
        console.error(
          `PAYOUT RECONCILIATION FAILED FOR ORDER ${latestOrder.id}`
        );

        /*
         * Keep processing state.
         * Never blindly resend when the blockchain cannot be checked.
         */
        continue;
      }

      if (
        payoutCheck.found
      ) {
        await upsertSubmittedPayout(
          env,
          latestOrder.id,
          payoutCheck.payout
        );

        await env.DB.prepare(`
          UPDATE orders
          SET status='completed'
          WHERE id=?
          AND status IN (
            'payment_verified',
            'processing'
          )
        `)
          .bind(
            latestOrder.id
          )
          .run();

        await telegram(
          env,
          "sendMessage",
          {
            chat_id:
              latestOrder.telegram_id,
            text:
              "🎉 Order completed successfully!\n\n" +
              `Order #${latestOrder.id}\n` +
              `${formatNumber(latestOrder.ptn_amount)} PTN has been sent to your wallet.\n\n` +
              "The PTN transfer was found on the blockchain."
          }
        );

        continue;
      }

      /*
       * =====================================================
       * STEP 5
       * Atomically claim payout.
       * =====================================================
       */

      if (
        latestOrder.status ===
        "payment_verified"
      ) {
        const claim =
          await env.DB.prepare(`
            UPDATE orders
            SET status='processing'
            WHERE id=?
            AND status='payment_verified'
          `)
            .bind(
              latestOrder.id
            )
            .run();

        /*
         * If another Worker claimed it,
         * skip this order.
         */
        if (
          changedRows(claim) !== 1
        ) {
          continue;
        }

        latestOrder =
          await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE id=?
            LIMIT 1
          `)
            .bind(
              latestOrder.id
            )
            .first();
      }

      if (
        !latestOrder ||
        latestOrder.status !==
          "processing"
      ) {
        continue;
      }

      /*
       * =====================================================
       * STEP 6
       * Get/create persistent payout attempt.
       * =====================================================
       */

      attempt =
        await getPayoutAttempt(
          env,
          latestOrder.id
        );

      if (!attempt) {
        const created =
          await env.DB.prepare(`
            INSERT OR IGNORE INTO payout_attempts
            (
              order_id,
              query_id,
              status
            )
            VALUES (?, ?, 'created')
          `)
            .bind(
              latestOrder.id,
              String(latestOrder.id)
            )
            .run();

        attempt =
          await getPayoutAttempt(
            env,
            latestOrder.id
          );

        if (!attempt) {
          console.error(
            `FAILED TO CREATE PAYOUT ATTEMPT ${latestOrder.id}`,
            created
          );

          continue;
        }
      }

      /*
       * A submitted/unknown attempt must never be blindly resent.
       */

      if (
        attempt.status ===
          "submitted" ||
        attempt.status ===
          "confirmed"
      ) {
        /*
         * Reconciliation did not find the transaction yet.
         * Keep processing and let a later cron check again.
         */
        continue;
      }

      if (
        attempt.status ===
        "broadcast_unknown"
      ) {
        const age =
          payoutAttemptAge(
            attempt
          );

        /*
         * Even after the retry delay, reconcile first.
         * If still not found, we can safely try again only
         * because enough time has passed and the original attempt
         * has remained unresolved.
         */
        if (
          age <
          PAYOUT_UNKNOWN_RETRY_DELAY_MS
        ) {
          continue;
        }

        await env.DB.prepare(`
          UPDATE payout_attempts
          SET status='created',
              last_error=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE order_id=?
          AND status='broadcast_unknown'
        `)
          .bind(
            "Retrying after broadcast reconciliation timeout",
            latestOrder.id
          )
          .run();

        attempt =
          await getPayoutAttempt(
            env,
            latestOrder.id
          );
      }

      /*
       * =====================================================
       * STEP 7
       * Send PTN.
       * =====================================================
       */

      const payout =
        await sendPTN(
          env,
          latestOrder
        );

      if (
        payout?.success
      ) {
        await env.DB.prepare(`
          UPDATE payout_attempts
          SET status='submitted',
              seqno=?,
              tx_hash=?,
              tx_lt=?,
              updated_at=CURRENT_TIMESTAMP,
              last_error=NULL
          WHERE order_id=?
        `)
          .bind(
            payout.seqno ?? null,
            payout.hash ?? null,
            payout.lt ?? null,
            latestOrder.id
          )
          .run();

        /*
         * IMPORTANT:
         * We do NOT tell the user "completed" here.
         *
         * The next reconciliation confirms that the sender wallet
         * transaction containing this query ID actually exists.
         */
        console.log(
          `PTN BROADCASTED ORDER ${latestOrder.id}`
        );

        continue;
      }

      /*
       * Pre-broadcast validation failures are safe to retry.
       */
      if (
        payout?.retryable === true
      ) {
        await env.DB.prepare(`
          UPDATE payout_attempts
          SET status='failed',
              last_error=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE order_id=?
        `)
          .bind(
            payout.error ||
              "Retryable payout error",
            latestOrder.id
          )
          .run();

        await env.DB.prepare(`
          UPDATE orders
          SET status='payment_verified'
          WHERE id=?
          AND status='processing'
        `)
          .bind(
            latestOrder.id
          )
          .run();

        console.error(
          `RETRYABLE PTN PAYOUT FAILURE ${latestOrder.id}:`,
          payout.error
        );

        continue;
      }

      /*
       * sendTransfer() errors are potentially ambiguous:
       * the message may have reached the node even if the request
       * returned an error.
       *
       * Therefore NEVER immediately resend.
       */
      await env.DB.prepare(`
        UPDATE payout_attempts
        SET status='broadcast_unknown',
            last_error=?,
            updated_at=CURRENT_TIMESTAMP
        WHERE order_id=?
      `)
        .bind(
          payout?.error ||
            "Unknown broadcast result",
          latestOrder.id
        )
        .run();

      console.error(
        `UNKNOWN PTN PAYOUT STATE ${latestOrder.id}:`,
        payout?.error
      );
    } catch (error) {
      console.error(
        `ORDER ${order.id} ERROR:`,
        error
      );

      /*
       * Do NOT automatically turn processing into payment_verified.
       *
       * If a blockchain request already happened, doing so could
       * cause a second payout.
       */
    }
  }
}

/* =========================================================
   PAYMENT SEARCH
========================================================= */

async function findPayment(
  env,
  order
) {
  if (!order.payment_address) {
    return null;
  }

  const apiKey =
    env.TONCENTER_API_KEY;

  if (!apiKey) {
    console.error(
      "TONCENTER_API_KEY missing"
    );

    return null;
  }

  const createdAt =
    parseSqlUtc(
      order.created_at
    );

  const startUtime =
    createdAt
      ? Math.max(
          0,
          Math.floor(
            createdAt / 1000
          ) -
            PAYMENT_LOOKBACK_SECONDS
        )
      : null;

  const url = new URL(
    "https://toncenter.com/api/v3/transactions"
  );

  url.searchParams.set(
    "account",
    GRAM_RECEIVING_WALLET
  );

  url.searchParams.set(
    "limit",
    "100"
  );

  url.searchParams.set(
    "sort",
    "desc"
  );

  if (
    startUtime !== null
  ) {
    url.searchParams.set(
      "start_utime",
      String(startUtime)
    );
  }

  let response;

  try {
    response =
      await fetch(
        url.toString(),
        {
          headers: {
            "X-API-Key":
              apiKey
          }
        }
      );
  } catch (error) {
    console.error(
      "TONCENTER FETCH ERROR:",
      error
    );

    return null;
  }

  if (!response.ok) {
    console.error(
      "TONCENTER ERROR:",
      response.status
    );

    return null;
  }

  let data;

  try {
    data =
      await response.json();
  } catch (error) {
    console.error(
      "TONCENTER JSON ERROR:",
      error
    );

    return null;
  }

  const transactions =
    Array.isArray(data)
      ? data
      : Array.isArray(
          data.transactions
        )
      ? data.transactions
      : [];

  const expectedAmount =
    gramToNano(
      order.gram_amount
    );

  const registeredWallet =
    String(
      order.payment_address
    ).trim();

  for (
    const tx of transactions
  ) {
    const hash =
      tx.hash ||
      tx.transaction_hash ||
      "";

    if (!hash) {
      continue;
    }

    /*
     * Skip obviously bounced/failed transactions when
     * TON Center exposes these fields.
     */
    if (
      tx.success === false ||
      tx.aborted === true
    ) {
      continue;
    }

    const inMsg =
      tx.in_msg ||
      tx.inMessage ||
      {};

    const source =
      inMsg.source ||
      inMsg.source_address ||
      "";

    const destination =
      inMsg.destination ||
      inMsg.destination_address ||
      "";

    const rawValue =
      inMsg.value ??
      inMsg.amount ??
      "";

    if (!source) {
      continue;
    }

    /*
     * Match exact registered sender wallet.
     */
    if (
      !sameAddress(
        source,
        registeredWallet
      )
    ) {
      continue;
    }

    /*
     * Match payment receiving wallet.
     */
    if (
      destination &&
      !sameAddress(
        destination,
        GRAM_RECEIVING_WALLET
      )
    ) {
      continue;
    }

    /*
     * Exact native TON/GRAM amount.
     */
    try {
      if (
        String(rawValue) ===
        ""
      ) {
        continue;
      }

      if (
        BigInt(
          String(rawValue)
        ) !==
        BigInt(
          expectedAmount
        )
      ) {
        continue;
      }
    } catch {
      continue;
    }

    /*
     * Transaction must not predate the order.
     */
    if (createdAt) {
      const txUtime =
        Number(
          tx.utime ||
          tx.now ||
          0
        );

      if (
        Number.isFinite(
          txUtime
        ) &&
        txUtime > 0
      ) {
        const txTime =
          txUtime * 1000;

        if (
          txTime <
          createdAt - 120000
        ) {
          continue;
        }
      }
    }

    /*
     * Check existing D1 ownership.
     */
    const existing =
      await env.DB.prepare(`
        SELECT id
        FROM orders
        WHERE transaction_hash=?
        LIMIT 1
      `)
        .bind(hash)
        .first();

    if (existing) {
      if (
        Number(existing.id) ===
        Number(order.id)
      ) {
        return {
          hash
        };
      }

      return {
        hash,
        duplicate: true
      };
    }

    /*
     * Also check the persistent payment-claim table.
     */
    const claimed =
      await env.DB.prepare(`
        SELECT order_id
        FROM used_payments
        WHERE transaction_hash=?
        LIMIT 1
      `)
        .bind(hash)
        .first();

    if (claimed) {
      if (
        Number(
          claimed.order_id
        ) ===
        Number(order.id)
      ) {
        return {
          hash
        };
      }

      return {
        hash,
        duplicate: true
      };
    }

    console.log(
      "PAYMENT MATCHED:",
      JSON.stringify({
        orderId:
          order.id,
        source,
        destination,
        value:
          String(rawValue),
        hash
      })
    );

    return {
      hash
    };
  }

  return null;
}

/* =========================================================
   SEND PTN
========================================================= */

async function sendPTN(
  env,
  order
) {
  /*
   * retryable=true means we know the transaction has NOT
   * reached sendTransfer() yet.
   *
   * retryable=false means the error happened during/after
   * broadcast and must be reconciled before another send.
   */

  try {
    const mnemonic =
      env.PTN_MNEMONIC;

    if (!mnemonic) {
      return {
        success: false,
        retryable: true,
        error:
          "PTN_MNEMONIC missing"
      };
    }

    const words =
      mnemonic
        .trim()
        .split(/\s+/);

    const {
      mnemonicToPrivateKey,
      mnemonicValidate
    } = await import(
      "@ton/crypto"
    );

    const validMnemonic =
      await mnemonicValidate(
        words
      );

    if (!validMnemonic) {
      return {
        success: false,
        retryable: true,
        error:
          "Invalid PTN sender mnemonic"
      };
    }

    const keyPair =
      await mnemonicToPrivateKey(
        words
      );

    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });

    /*
     * Create exact V5R1 sender wallet.
     */
    const senderWallet =
      WalletContractV5R1.create({
        workchain: 0,
        publicKey:
          keyPair.publicKey,
        walletId: {
          networkGlobalId: -239
        }
      });

    /*
     * SECURITY CHECK.
     */
    const derivedAddress =
      senderWallet.address.toString();

    if (
      derivedAddress !==
      PTN_SENDER_WALLET
    ) {
      return {
        success: false,
        retryable: true,
        error:
          "Derived sender wallet does not match configured PTN sender wallet"
      };
    }

    const senderContract =
      client.open(
        senderWallet
      );

    /*
     * Wallet deployment.
     */
    const deployed =
      await client.isContractDeployed(
        senderWallet.address
      );

    if (!deployed) {
      return {
        success: false,
        retryable: true,
        error:
          "PTN sender wallet is not initialized/deployed"
      };
    }

    /*
     * TON balance.
     */
    const tonBalance =
      await client.getBalance(
        senderWallet.address
      );

    if (
      tonBalance <
      MIN_SENDER_TON_BALANCE
    ) {
      return {
        success: false,
        retryable: true,
        error:
          `Insufficient TON balance. Current balance: ${tonBalance.toString()} nanoTON`
      };
    }

    /*
     * PTN Jetton master.
     */
    const master =
      client.open(
        JettonMaster.create(
          Address.parse(
            PTN_MASTER
          )
        )
      );

    /*
     * Sender's PTN Jetton wallet.
     */
    const senderJettonWalletAddress =
      await master.getWalletAddress(
        senderWallet.address
      );

    const senderJettonWallet =
      client.open(
        senderJettonWalletAddress
      );

    /*
     * Whole PTN amount.
     */
    let amount;

    try {
      amount =
        BigInt(
          String(
            order.ptn_amount
          )
        ) *
        10n **
          BigInt(
            PTN_DECIMALS
          );
    } catch {
      return {
        success: false,
        retryable: true,
        error:
          "Invalid PTN payout amount"
      };
    }

    if (
      amount <= 0n
    ) {
      return {
        success: false,
        retryable: true,
        error:
          "Invalid PTN payout amount"
      };
    }

    /*
     * PTN balance.
     */
    const senderJettonBalance =
      await senderJettonWallet.getJettonBalance();

    console.log(
      "PTN BALANCE CHECK:",
      JSON.stringify({
        orderId:
          order.id,
        balance:
          senderJettonBalance.toString(),
        required:
          amount.toString()
      })
    );

    if (
      senderJettonBalance <
      amount
    ) {
      return {
        success: false,
        retryable: true,
        error:
          `Insufficient PTN balance. Available: ${senderJettonBalance.toString()}, required: ${amount.toString()}`
      };
    }

    /*
     * Destination.
     */
    if (
      !order.payment_address
    ) {
      return {
        success: false,
        retryable: true,
        error:
          "Order payment wallet is missing"
      };
    }

    let destination;

    try {
      destination =
        Address.parse(
          order.payment_address
        );
    } catch {
      return {
        success: false,
        retryable: true,
        error:
          "Invalid PTN destination wallet"
      };
    }

    if (
      destination.workChain !== 0
    ) {
      return {
        success: false,
        retryable: true,
        error:
          "PTN destination must be a basechain wallet"
      };
    }

    /*
     * Order ID = unique Jetton transfer query ID.
     */
    const queryId =
      BigInt(
        order.id
      );

    /*
     * Standard Jetton transfer body.
     */
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
          amount
        )
        .storeAddress(
          destination
        )
        .storeAddress(
          senderWallet.address
        )
        .storeBit(0)
        .storeCoins(
          PTN_FORWARD_TON
        )
        .storeBit(0)
        .endCell();

    const seqno =
      await senderContract.getSeqno();

    console.log(
      "PTN TRANSFER PREPARED:",
      JSON.stringify({
        orderId:
          order.id,
        seqno,
        sender:
          senderWallet.address.toString(),
        senderJettonWallet:
          senderJettonWalletAddress.toString(),
        destination:
          destination.toString(),
        amount:
          amount.toString(),
        queryId:
          queryId.toString()
      })
    );

    /*
     * IMPORTANT:
     *
     * The TON wallet sends the Jetton transfer message
     * to the sender's PTN Jetton wallet.
     */
    try {
      await senderContract.sendTransfer({
        seqno,
        secretKey:
          keyPair.secretKey,
        sendMode:
          SendMode.PAY_GAS_SEPARATELY,
        messages: [
          internal({
            to:
              senderJettonWalletAddress,
            value:
              PTN_TRANSFER_TON,
            body:
              transferBody
          })
        ]
      });
    } catch (broadcastError) {
      /*
       * This is intentionally NOT retryable.
       *
       * sendTransfer may fail after the node has received
       * the request. Reconciliation must happen first.
       */
      return {
        success: false,
        retryable: false,
        error:
          String(
            broadcastError?.message ||
            broadcastError
          )
      };
    }

    console.log(
      `PTN payout submitted successfully for order ${order.id}, seqno ${seqno}`
    );

    return {
      success: true,
      hash: null,
      lt: null,
      seqno
    };
  } catch (error) {
    console.error(
      `PTN PAYOUT ERROR ORDER ${order.id}:`,
      error
    );

    /*
     * Errors before sendTransfer are safe to retry.
     * Errors from the sendTransfer block above are handled separately.
     */
    return {
      success: false,
      retryable: true,
      error:
        String(
          error?.message ||
          error
        )
    };
  }
}

/* =========================================================
   PAYOUT ATTEMPTS
========================================================= */

async function getPayoutAttempt(
  env,
  orderId
) {
  return await env.DB.prepare(`
    SELECT *
    FROM payout_attempts
    WHERE order_id=?
    LIMIT 1
  `)
    .bind(
      orderId
    )
    .first();
}

async function upsertSubmittedPayout(
  env,
  orderId,
  payout
) {
  await env.DB.prepare(`
    INSERT INTO payout_attempts
    (
      order_id,
      query_id,
      status,
      seqno,
      tx_hash,
      tx_lt
    )
    VALUES (?, ?, 'confirmed', ?, ?, ?)
    ON CONFLICT(order_id)
    DO UPDATE SET
      status='confirmed',
      seqno=excluded.seqno,
      tx_hash=excluded.tx_hash,
      tx_lt=excluded.tx_lt,
      updated_at=CURRENT_TIMESTAMP,
      last_error=NULL
  `)
    .bind(
      orderId,
      String(orderId),
      payout?.seqno ??
        null,
      payout?.hash ??
        null,
      payout?.lt ??
        null
    )
    .run();
}

function payoutAttemptAge(
  attempt
) {
  const time =
    parseSqlUtc(
      attempt?.updated_at ||
      attempt?.created_at
    );

  if (!time) {
    return Number.MAX_SAFE_INTEGER;
  }

  return (
    Date.now() -
    time
  );
}

/* =========================================================
   PAYOUT RECONCILIATION
========================================================= */

async function reconcilePayout(
  env,
  order
) {
  try {
    const mnemonic =
      env.PTN_MNEMONIC;

    if (!mnemonic) {
      return {
        found: false,
        checkFailed: true
      };
    }

    const words =
      mnemonic
        .trim()
        .split(/\s+/);

    const {
      mnemonicToPrivateKey,
      mnemonicValidate
    } = await import(
      "@ton/crypto"
    );

    const valid =
      await mnemonicValidate(
        words
      );

    if (!valid) {
      return {
        found: false,
        checkFailed: true
      };
    }

    const keyPair =
      await mnemonicToPrivateKey(
        words
      );

    const senderWallet =
      WalletContractV5R1.create({
        workchain: 0,
        publicKey:
          keyPair.publicKey,
        walletId: {
          networkGlobalId: -239
        }
      });

    if (
      senderWallet.address.toString() !==
      PTN_SENDER_WALLET
    ) {
      return {
        found: false,
        checkFailed: true
      };
    }

    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });

    const payout =
      await findExistingPayout(
        client,
        senderWallet.address,
        BigInt(order.id)
      );

    if (payout) {
      return {
        found: true,
        checkFailed: false,
        payout
      };
    }

    return {
      found: false,
      checkFailed: false
    };
  } catch (error) {
    console.error(
      "PAYOUT RECONCILIATION ERROR:",
      error
    );

    return {
      found: false,
      checkFailed: true
    };
  }
}

/*
 * Kept as a compatibility helper.
 */
async function findExistingPayoutForOrder(
  env,
  order
) {
  const result =
    await reconcilePayout(
      env,
      order
    );

  if (
    result.found
  ) {
    return result.payout;
  }

  return null;
}

function getOutgoingMessages(
  tx
) {
  if (!tx) {
    return [];
  }

  if (
    tx.outMessages &&
    typeof tx.outMessages.values ===
      "function"
  ) {
    return Array.from(
      tx.outMessages.values()
    );
  }

  if (
    Array.isArray(
      tx.outMessages
    )
  ) {
    return tx.outMessages;
  }

  if (
    tx.outMessages &&
    typeof tx.outMessages ===
      "object"
  ) {
    return Object.values(
      tx.outMessages
    );
  }

  return [];
}

async function findExistingPayout(
  client,
  senderAddress,
  queryId
) {
  const transactions =
    await client.getTransactions(
      senderAddress,
      {
        limit: 100
      }
    );

  for (
    const tx of transactions
  ) {
    const outgoing =
      getOutgoingMessages(
        tx
      );

    for (
      const message of outgoing
    ) {
      if (
        !message?.body
      ) {
        continue;
      }

      try {
        const slice =
          message.body.beginParse();

        if (
          slice.remainingBits <
          96
        ) {
          continue;
        }

        const opcode =
          slice.loadUint(32);

        if (
          opcode !==
          0x0f8a7ea5
        ) {
          continue;
        }

        const id =
          slice.loadUintBig(64);

        if (
          id !== queryId
        ) {
          continue;
        }

        let hash = null;

        try {
          hash =
            tx
              .hash()
              .toString(
                "base64url"
              );
        } catch {
          hash = null;
        }

        return {
          hash,
          seqno:
            tx.lt ||
            null,
          lt:
            tx.lt ||
            null
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/* =========================================================
   ADMIN STATE
========================================================= */

async function setAdminState(
  env,
  mode,
  targetId
) {
  await env.DB.prepare(`
    INSERT INTO admin_states
    (
      telegram_id,
      mode,
      target_id
    )
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      mode=excluded.mode,
      target_id=excluded.target_id,
      updated_at=CURRENT_TIMESTAMP
  `)
    .bind(
      ADMIN_TELEGRAM_ID,
      mode,
      targetId
    )
    .run();
}

async function getAdminState(
  env
) {
  return await env.DB.prepare(`
    SELECT *
    FROM admin_states
    WHERE telegram_id=?
    LIMIT 1
  `)
    .bind(
      ADMIN_TELEGRAM_ID
    )
    .first();
}

async function clearAdminState(
  env
) {
  await env.DB.prepare(`
    DELETE FROM admin_states
    WHERE telegram_id=?
  `)
    .bind(
      ADMIN_TELEGRAM_ID
    )
    .run();
}

/* =========================================================
   HELPERS
========================================================= */

function changedRows(
  result
) {
  return Number(
    result?.meta?.changes ??
    result?.changes ??
    0
  );
}

/*
 * Exact GRAM parser.
 *
 * IMPORTANT:
 * The original regex had:
 *
 *   /^\d+(.\d{1,9})?$/
 *
 * The "." there means "any character", not a literal dot.
 *
 * This version:
 * - accepts only digits
 * - accepts "." or ","
 * - accepts max 6 decimals
 * - never uses floating point
 */
function parseGramAmount(
  value
) {
  let input =
    String(value)
      .trim()
      .replace(",", ".");

  if (
    !/^\d+(?:\.\d{1,6})?$/.test(
      input
    )
  ) {
    return null;
  }

  const parts =
    input.split(".");

  const whole =
    parts[0];

  const decimal =
    parts[1] || "";

  try {
    const wholeValue =
      BigInt(
        whole
      );

    const decimalValue =
      decimal
        .padEnd(
          MAX_GRAM_DECIMALS,
          "0"
        );

    const micro =
      wholeValue *
        1000000n +
      BigInt(
        decimalValue ||
          "0"
      );

    if (
      micro <= 0n
    ) {
      return null;
    }

    /*
     * Store normalized decimal string.
     *
     * Examples:
     * 10       -> "10"
     * 10.5     -> "10.5"
     * 0.123456 -> "0.123456"
     */
    if (
      micro %
        1000000n ===
      0n
    ) {
      return wholeValue.toString();
    }

    let normalizedDecimal =
      decimalValue.replace(
        /0+$/,
        ""
      );

    return (
      wholeValue.toString() +
      "." +
      normalizedDecimal
    );
  } catch {
    return null;
  }
}

/*
 * 1 GRAM = 1,000,000 PTN.
 *
 * Because GRAM is accepted to 6 decimals,
 * the resulting PTN amount is always a whole number.
 */
function gramToPtn(
  gram
) {
  try {
    const parts =
      String(
        gram
      ).split(".");

    const whole =
      BigInt(
        parts[0]
      );

    const decimal =
      (
        parts[1] ||
        ""
      )
        .padEnd(
          6,
          "0"
        );

    const micro =
      whole *
        1000000n +
      BigInt(
        decimal
      );

    const ptn =
      micro *
        PTN_PER_GRAM /
      1000000n;

    return ptn.toString();
  } catch {
    return null;
  }
}

/*
 * Convert GRAM to native TON-style nano units.
 */
function gramToNano(
  gram
) {
  const parts =
    String(
      gram
    ).split(".");

  const whole =
    BigInt(
      parts[0]
    );

  const decimal =
    (
      parts[1] ||
      ""
    )
      .padEnd(
        9,
        "0"
      )
      .slice(
        0,
        9
      );

  return (
    whole *
      1000000000n +
    BigInt(
      decimal ||
        "0"
    )
  ).toString();
}

function formatNumber(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "0";
  }

  const [whole, decimal] =
    String(value).split(".");

  const grouped =
    whole.replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ","
    );

  return decimal
    ? `${grouped}.${decimal}`
    : grouped;
}

function displayStatus(
  status
) {
  const map = {
    pending:
      "Pending payment",

    awaiting_amount:
      "Awaiting amount",

    awaiting_wallet:
      "Awaiting wallet",

    payment_verified:
      "Payment verified",

    processing:
      "Processing",

    payout_sent:
      "PTN sent",

    completed:
      "Completed",

    suspicious:
      "Under review",

    cancelled:
      "Cancelled"
  };

  return (
    map[status] ||
    status
  );
}

function shortText(
  text,
  max
) {
  const value =
    String(
      text || ""
    );

  if (
    value.length <=
    max
  ) {
    return value;
  }

  return (
    value.slice(
      0,
      max - 1
    ) + "…"
  );
}

function sameAddress(
  a,
  b
) {
  if (!a || !b) {
    return false;
  }

  try {
    return (
      Address.parse(
        a
      ).toString() ===
      Address.parse(
        b
      ).toString()
    );
  } catch {
    return (
      String(a).trim() ===
      String(b).trim()
    );
  }
}

function parseSqlUtc(
  value
) {
  if (!value) {
    return null;
  }

  const raw =
    String(
      value
    ).trim();

  if (!raw) {
    return null;
  }

  let normalized;

  if (
    raw.endsWith("Z")
  ) {
    normalized =
      raw;
  } else {
    normalized =
      raw.replace(
        " ",
        "T"
      ) + "Z";
  }

  const time =
    Date.parse(
      normalized
    );

  return Number.isNaN(
    time
  )
    ? null
    : time;
}

function formatUtcDate(
  value
) {
  const time =
    parseSqlUtc(
      value
    );

  if (!time) {
    return String(
      value
    );
  }

  return new Date(
    time
  )
    .toISOString()
    .replace(
      "T",
      " "
    )
    .replace(
      ".000Z",
      ""
    );
}

/* =========================================================
   TELEGRAM
========================================================= */

async function telegram(
  env,
  method,
  body
) {
  const token =
    env.BOT_TOKEN;

  if (!token) {
    console.error(
      "BOT_TOKEN missing"
    );

    return null;
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body:
          JSON.stringify(
            body
          )
      }
    );

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function editMessage(
  env,
  query,
  text,
  replyMarkup
) {
  const message =
    query.message;

  if (!message) {
    return;
  }

  await telegram(
    env,
    "editMessageText",
    {
      chat_id:
        message.chat.id,
      message_id:
        message.message_id,
      text,
      reply_markup:
        replyMarkup
    }
  );
}
