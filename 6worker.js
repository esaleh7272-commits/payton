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
const PTN_PER_GRAM = 1000000n;

const MIN_SENDER_TON_BALANCE = toNano("0.10");
const PTN_TRANSFER_TON = toNano("0.05");
const PTN_FORWARD_TON = toNano("0.01");

/*
 * Only one payout should be processed at a time.
 * The Queue consumer should also be configured with
 * max_concurrency = 1.
 */

const TONCENTER_V2_ENDPOINT =
  "https://toncenter.com/api/v2/jsonRPC";

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
   RUNTIME CACHE
   ========================================================= */

/*
 * These values are cached inside a warm Worker isolate.
 *
 * They are only performance optimizations.
 * A new isolate will rebuild them automatically.
 */

let cachedPtnKeyPair = null;
let cachedPtnSenderWallet = null;
let cachedPtnClient = null;
let cachedPtnSenderJettonWalletAddress = null;

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

  /*
   * IMPORTANT:
   *
   * Cron no longer performs PTN payout.
   *
   * Cron only verifies incoming GRAM payments and
   * places verified orders into the payout queue.
   */
  async scheduled(event, env, ctx) {

    try {
      await processPaymentVerification(env);
    } catch (error) {
      console.error("CRON ERROR:", error);
    }
  },

  /*
   * Queue consumer.
   *
   * This is where the PTN blockchain transaction is sent.
   */
  async queue(batch, env, ctx) {

    for (const message of batch.messages) {

      try {

        const payload = message.body || {};
        const orderId = Number(payload.orderId);

        if (!Number.isInteger(orderId) || orderId <= 0) {
          console.error(
            "INVALID PAYOUT QUEUE MESSAGE:",
            JSON.stringify(payload)
          );

          message.ack();
          continue;
        }

        const result = await processQueuedPayout(
          env,
          orderId
        );

        if (result === "success" || result === "already_sent") {
          message.ack();
        } else if (result === "retry") {
          message.retry();
        } else {
          message.ack();
        }

      } catch (error) {

        console.error(
          "QUEUE PAYOUT ERROR:",
          error
        );

        /*
         * Do not send Telegram failure messages.
         * Cloudflare Queue will retry the message.
         */
        message.retry();
      }
    }
  }
};

/* =========================================================
   UPDATE HANDLER
   ========================================================= */

async function handleUpdate(update, env, ctx) {

  if (update.callback_query) {
    await handleCallback(
      update.callback_query,
      env
    );

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

    const handled =
      await handleAdminText(
        message,
        env
      );

    if (handled) {
      return;
    }
  }

  if (chatId !== ADMIN_TELEGRAM_ID) {

    const restriction =
      await getUserRestriction(
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

async function handleCallback(
  query,
  env
) {

  const data =
    String(query.data || "");

  const chatId =
    String(
      query.message?.chat?.id || ""
    );

  if (!chatId) {
    return;
  }

  if (data.startsWith("admin_")) {

    if (
      chatId !==
      ADMIN_TELEGRAM_ID
    ) {

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

  if (data === "home") {

    await editMessage(
      env,
      query,
      WELCOME,
      MENU
    );

    return;
  }

  if (data === "buy") {

    await upsertUser(
      env,
      query.from
    );

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

    await createNewOrderState(
      env,
      chatId
    );

    return;
  }

  if (data === "price") {

    await editMessage(
      env,
      query,
      "💰 PAYTON (PTN) Presale Price\n\n1 GRAM = 1,000,000 PTN",
      BACK
    );

    return;
  }

  if (data === "orders") {

    await showUserOrders(
      env,
      query
    );

    return;
  }

  if (data === "support") {

    await createSupportRequest(
      env,
      query.from
    );

    await editMessage(
      env,
      query,
      "💬 Support\n\nPlease send your message now.\n\nOur support team will review your message and reply to you.",
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

  const data =
    String(query.data || "");

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

    const id =
      Number(
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

    const id =
      Number(
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
        "✍️ Manual Reply\n\nSend the message you want to send to this user.\n\nSend /cancel to cancel.",
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

    await clearAdminState(env);

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

    const type =
      parts[2];

    const telegramId =
      parts.slice(3).join("_");

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

    await clearAdminState(env);

    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Reply cancelled.",
      reply_markup: ADMIN_MENU
    });

    return true;
  }

  const state =
    await getAdminState(env);

  if (!state) {
    return false;
  }

  if (state.mode === "reply") {

    const ticketId =
      Number(state.target_id);

    if (!ticketId) {

      await clearAdminState(env);

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

      await clearAdminState(env);

      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text:
          "❌ Support ticket not found.",
        reply_markup: ADMIN_MENU
      });

      return true;
    }

    await telegram(env, "sendMessage", {
      chat_id:
        ticket.telegram_id,
      text:
        "💬 Support\n\n" +
        text +
        "\n\nIf you need further assistance, please send another message.",
      reply_markup: MENU
    });

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

    await clearAdminState(env);

    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text:
        "✅ Reply sent successfully.",
      reply_markup: ADMIN_MENU
    });

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
    (telegram_id, username, message, status)
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

  await telegram(env, "sendMessage", {
    chat_id: telegramId,
    text:
      "📩 Your message has been received.\n\n" +
      "Support will respond shortly.",
    reply_markup: MENU
  });

  await telegram(env, "sendMessage", {
    chat_id: ADMIN_TELEGRAM_ID,
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
  });

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
    `)
      .all();

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
          `💬 #${row.id} ${shortText(name, 30)}`,
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
    page =
      totalPages - 1;
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

  if (page < totalPages - 1) {

    navigation.push({
      text: "Next ➡️",
      callback_data:
        `admin_quick_${ticketId}_${page + 1}`
    });
  }

  if (navigation.length) {
    buttons.push(navigation);
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

  await telegram(env, "sendMessage", {
    chat_id:
      ticket.telegram_id,
    text:
      "💬 Support\n\n" +
      reply,
    reply_markup: MENU
  });

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
    shortText(text, 3900),
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
    `)
      .all();

  const buttons = [];

  for (
    const row of rows.results || []
  ) {

    let status = "⚠️";

    if (
      Number(row.permanent) === 1
    ) {
      status = "🚫";
    } else if (row.blocked_until) {
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
              text:
                "⬅️ Suspicious List",
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

  } else if (row.blocked_until) {

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
            text:
              "⬅️ Suspicious List",
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

  await telegram(env, "sendMessage", {
    chat_id: telegramId,
    text: message
  });

  await editMessage(
    env,
    query,
    "✅ Block status updated successfully.",
    {
      inline_keyboard: [
        [
          {
            text:
              "⬅️ Suspicious User",
            callback_data:
              `admin_sus_${telegramId}`
          }
        ],
        [
          {
            text:
              "🚨 Suspicious List",
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

  await telegram(env, "sendMessage", {
    chat_id: telegramId,
    text:
      "✅ Your access to the PAYTON bot has been restored.",
    reply_markup: MENU
  });

  await editMessage(
    env,
    query,
    "✅ User has been unblocked.",
    {
      inline_keyboard: [
        [
          {
            text:
              "⬅️ Suspicious User",
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
      .bind(String(telegramId))
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
      .bind(String(telegramId))
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

async function getAdminStats(env) {

  const users =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM users
    `)
      .first();

  const orders =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
    `)
      .first();

  const pending =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status IN (
        'pending',
        'payment_verified',
        'processing'
      )
    `)
      .first();

  const suspicious =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM suspicious_users
    `)
      .first();

  const blocked =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM suspicious_users
      WHERE permanent=1
      OR (
        blocked_until IS NOT NULL
        AND blocked_until > datetime('now')
      )
    `)
      .first();

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
    `)
      .first();

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
    `)
      .first();

  return {
    users: users?.count || 0,
    orders: orders?.count || 0,
    pending: pending?.count || 0,
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
    `)
      .all();

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
    shortText(text, 3900),
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
    `)
      .all();

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
    shortText(text, 3900),
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
    `)
      .all();

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
    shortText(text, 3900),
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
    `)
      .first();

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

async function createNewOrderState(
  env,
  telegramId
) {

  await env.DB.prepare(`
    INSERT INTO orders
    (
      telegram_id,
      status
    )
    VALUES (?, 'awaiting_amount')
  `)
    .bind(
      String(telegramId)
    )
    .run();
}

async function setOrderState(
  env,
  telegramId,
  state
) {

  await env.DB.prepare(`
    UPDATE orders
    SET status=?
    WHERE id=(
      SELECT id
      FROM orders
      WHERE telegram_id=?
      ORDER BY id DESC
      LIMIT 1
    )
  `)
    .bind(
      state,
      String(telegramId)
    )
    .run();
}

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
    String(message.from.id);

  const text =
    String(
      message.text || ""
    ).trim();

  if (!text) {
    return;
  }

  if (
    order.status ===
    "awaiting_amount"
  ) {

    const gram =
      parseGramAmount(text);

    if (
      gram === null ||
      Number(gram) <= 0
    ) {

      await telegram(env, "sendMessage", {
        chat_id: telegramId,
        text:
          "❌ Invalid GRAM amount.\n\n" +
          "Please enter a valid number, for example:\n10",
        reply_markup: BACK
      });

      return;
    }

    const ptn =
      gramToPtn(gram);

    await env.DB.prepare(`
      UPDATE orders
      SET gram_amount=?,
          ptn_amount=?,
          status='awaiting_wallet'
      WHERE id=?
    `)
      .bind(
        gram,
        ptn,
        order.id
      )
      .run();

    await telegram(env, "sendMessage", {
      chat_id: telegramId,
      text:
        "✅ Order created.\n\n" +
        `Payment: ${formatNumber(gram)} GRAM\n` +
        `You receive: ${formatNumber(ptn)} PTN\n\n` +
        "Please send your PTN receiving wallet address.\n\n" +
        "This wallet must also be the wallet you use to send the GRAM payment.",
      reply_markup: BACK
    });

    return;
  }

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

      await telegram(env, "sendMessage", {
        chat_id: telegramId,
        text:
          "❌ Invalid TON wallet address.\n\n" +
          "Please send a valid TON wallet address.",
        reply_markup: BACK
      });

      return;
    }

    await env.DB.prepare(`
      UPDATE orders
      SET payment_address=?,
          status='pending'
      WHERE id=?
    `)
      .bind(
        wallet,
        order.id
      )
      .run();

    await telegram(env, "sendMessage", {
      chat_id: telegramId,
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
      reply_markup: BACK
    });

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
    String(query.from.id);

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE telegram_id=?
      ORDER BY id DESC
      LIMIT 10
    `)
      .bind(telegramId)
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
    text,
    BACK
  );
}

/* =========================================================
   PAYMENT VERIFICATION
   ========================================================= */

/*
 * Cron only handles payment verification.
 *
 * This is intentionally lightweight compared with the old
 * version because PTN cryptography and blockchain payout
 * are no longer executed inside the Cron invocation.
 */

async function processPaymentVerification(
  env
) {

  /*
   * Process only one order per Cron invocation.
   *
   * This greatly reduces CPU usage and subrequests.
   */

  const order =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE status='pending'
      ORDER BY id ASC
      LIMIT 1
    `)
      .first();

  if (!order) {
    return;
  }

  try {

    const payment =
      await findPayment(
        env,
        order
      );

    if (!payment) {
      return;
    }

    if (payment.duplicate) {

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
        user?.username || null,
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

      return;
    }

    /*
     * Associate the incoming transaction with
     * the order before putting it into the queue.
     */
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

    /*
     * If another invocation already changed the order,
     * do not enqueue another payout.
     */
    if (
      updated?.meta?.changes === 0
    ) {
      return;
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

    /*
     * Send only the order ID to the Queue.
     *
     * The Queue consumer reloads the order from D1.
     */
    if (!env.PTN_PAYOUT_QUEUE) {
      throw new Error(
        "PTN_PAYOUT_QUEUE binding is missing"
      );
    }

    await env.PTN_PAYOUT_QUEUE.send({
      orderId:
        Number(order.id)
    });

    /*
     * The order is now waiting for the payout worker.
     */
    await env.DB.prepare(`
      UPDATE orders
      SET status='processing'
      WHERE id=?
      AND status='payment_verified'
    `)
      .bind(order.id)
      .run();

  } catch (error) {

    console.error(
      `PAYMENT VERIFICATION ERROR ORDER ${order.id}:`,
      error
    );
  }
}

/* =========================================================
   QUEUE PAYOUT PROCESSOR
   ========================================================= */

async function processQueuedPayout(
  env,
  orderId
) {

  const order =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE id=?
      LIMIT 1
    `)
      .bind(orderId)
      .first();

  if (!order) {
    console.error(
      `QUEUE ORDER NOT FOUND: ${orderId}`
    );

    return "drop";
  }

  /*
   * A payout that has already completed must
   * never be submitted again.
   */
  if (
    order.status ===
      "payout_sent" ||
    order.status ===
      "completed"
  ) {

    return "already_sent";
  }

  /*
   * Queue messages can be retried.
   *
   * Only these states are allowed to reach
   * the blockchain payout function.
   */
  if (
    order.status !==
      "processing" &&
    order.status !==
      "payment_verified"
  ) {

    return "drop";
  }

  /*
   * Before sending PTN, check whether the same
   * deterministic query ID was already broadcast.
   *
   * This protects against a Queue retry after a
   * successful blockchain broadcast.
   */
  const existingPayout =
    await findExistingPayoutForOrder(
      env,
      order
    );

  if (existingPayout) {

    await env.DB.prepare(`
      UPDATE orders
      SET status='payout_sent'
      WHERE id=?
      AND status IN (
        'payment_verified',
        'processing'
      )
    `)
      .bind(order.id)
      .run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          order.telegram_id,
        text:
          "🎉 Order completed successfully!\n\n" +
          `Order #${order.id}\n` +
          `${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.\n\n` +
          "The PTN transfer has already been submitted to the blockchain."
      }
    );

    return "already_sent";
  }

  /*
   * Make sure the order is explicitly marked as processing.
   */
  await env.DB.prepare(`
    UPDATE orders
    SET status='processing'
    WHERE id=?
    AND status='payment_verified'
  `)
    .bind(order.id)
    .run();

  const processingOrder =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE id=?
      LIMIT 1
    `)
      .bind(order.id)
      .first();

  if (!processingOrder) {
    return "drop";
  }

  if (
    processingOrder.status !==
    "processing"
  ) {
    return "drop";
  }

  /*
   * Send PTN.
   */
  const payout =
    await sendPTN(
      env,
      processingOrder
    );

  if (payout?.success) {

    await env.DB.prepare(`
      UPDATE orders
      SET status='payout_sent'
      WHERE id=?
      AND status='processing'
    `)
      .bind(
        processingOrder.id
      )
      .run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          processingOrder.telegram_id,
        text:
          "🎉 Order completed successfully!\n\n" +
          `Order #${processingOrder.id}\n` +
          `${formatNumber(processingOrder.ptn_amount)} PTN has been sent to your wallet.\n\n` +
          "The PTN transfer has been submitted to the blockchain."
      }
    );

    return "success";
  }

  /*
   * Silent retry.
   *
   * No failure message is sent to the user.
   */
  await env.DB.prepare(`
    UPDATE orders
    SET status='payment_verified'
    WHERE id=?
    AND status='processing'
  `)
    .bind(
      processingOrder.id
    )
    .run();

  console.error(
    `PTN payout failed for order ${processingOrder.id}:`,
    payout?.error ||
      "Unknown error"
  );

  return "retry";
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
          ) - 120
        )
      : null;

  const url =
    new URL(
      "https://toncenter.com/api/v3/transactions"
    );

  url.searchParams.set(
    "account",
    GRAM_RECEIVING_WALLET
  );

  /*
   * 100 transactions is unnecessary for the
   * one-minute verification loop.
   *
   * 20 is enough for the normal case and
   * reduces JSON parsing CPU.
   */
  url.searchParams.set(
    "limit",
    "20"
  );

  url.searchParams.set(
    "sort",
    "desc"
  );

  if (startUtime !== null) {

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
     * Payment must originate from the wallet
     * registered by the user.
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
     * Verify destination when TON Center provides it.
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

    try {

      if (
        String(rawValue) === ""
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
     * Verify transaction timing.
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
     * Prevent transaction reuse.
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
   PTN SENDER INITIALIZATION
   ========================================================= */

async function getPtnSender(
  env
) {

  if (
    cachedPtnKeyPair &&
    cachedPtnSenderWallet &&
    cachedPtnClient
  ) {

    return {
      keyPair:
        cachedPtnKeyPair,
      senderWallet:
        cachedPtnSenderWallet,
      client:
        cachedPtnClient
    };
  }

  const mnemonic =
    env.PTN_MNEMONIC;

  if (!mnemonic) {
    throw new Error(
      "PTN_MNEMONIC missing"
    );
  }

  const words =
    mnemonic
      .trim()
      .split(/\s+/);

  /*
   * Import crypto only when a payout
   * actually needs to be processed.
   */
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
    throw new Error(
      "Invalid PTN sender mnemonic"
    );
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

  const derivedAddress =
    senderWallet.address.toString();

  if (
    derivedAddress !==
    PTN_SENDER_WALLET
  ) {
    throw new Error(
      "Derived sender wallet does not match configured PTN sender wallet"
    );
  }

  const client =
    new TonClient({
      endpoint:
        TONCENTER_V2_ENDPOINT,
      apiKey:
        env.TONCENTER_API_KEY
    });

  cachedPtnKeyPair =
    keyPair;

  cachedPtnSenderWallet =
    senderWallet;

  cachedPtnClient =
    client;

  return {
    keyPair,
    senderWallet,
    client
  };
}

/* =========================================================
   SEND PTN
   ========================================================= */

async function sendPTN(
  env,
  order
) {

  try {

    const {
      keyPair,
      senderWallet,
      client
    } =
      await getPtnSender(env);

    const senderContract =
      client.open(
        senderWallet
      );

    /*
     * Verify sender wallet is deployed.
     */
    const deployed =
      await client.isContractDeployed(
        senderWallet.address
      );

    if (!deployed) {

      throw new Error(
        "PTN sender wallet is not initialized/deployed"
      );
    }

    /*
     * Check native TON balance.
     */
    const tonBalance =
      await client.getBalance(
        senderWallet.address
      );

    if (
      tonBalance <
      MIN_SENDER_TON_BALANCE
    ) {

      throw new Error(
        `Insufficient TON balance. Current balance: ${tonBalance.toString()} nanoTON`
      );
    }

    /*
     * Get PTN Jetton master.
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
     * Get the sender's PTN Jetton Wallet.
     */
    let senderJettonWalletAddress =
      cachedPtnSenderJettonWalletAddress;

    if (
      !senderJettonWalletAddress
    ) {

      senderJettonWalletAddress =
        await master.getWalletAddress(
          senderWallet.address
        );

      cachedPtnSenderJettonWalletAddress =
        senderJettonWalletAddress;
    }

    const senderJettonWallet =
      client.open(
        senderJettonWalletAddress
      );

    /*
     * Calculate PTN amount in smallest units.
     */
    const amount =
      BigInt(
        order.ptn_amount
      ) *
      10n **
      BigInt(
        PTN_DECIMALS
      );

    if (
      amount <= 0n
    ) {

      throw new Error(
        "Invalid PTN payout amount"
      );
    }

    /*
     * Check PTN balance.
     */
    const senderJettonBalance =
      await senderJettonWallet
        .getJettonBalance();

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

      throw new Error(
        `Insufficient PTN balance. Available: ${senderJettonBalance.toString()}, required: ${amount.toString()}`
      );
    }

    if (!order.payment_address) {

      throw new Error(
        "Order payment wallet is missing"
      );
    }

    /*
     * PTN is sent to the same wallet that
     * the user registered for the GRAM payment.
     */
    const destination =
      Address.parse(
        order.payment_address
      );

    if (
      destination.workChain !== 0
    ) {

      throw new Error(
        "PTN destination must be a basechain wallet"
      );
    }

    /*
     * Deterministic query ID.
     *
     * This is important for payout idempotency.
     */
    const queryId =
      BigInt(order.id);

    /*
     * Standard TEP-74 Jetton transfer body.
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
     * The TON sender wallet sends the Jetton
     * transfer message to the SENDER'S Jetton Wallet.
     *
     * The sender Jetton Wallet then performs
     * the actual PTN transfer to the user.
     */
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

    console.log(
      `PTN payout submitted successfully for order ${order.id}, seqno ${seqno}`
    );

    return {
      success: true,
      hash: null,
      seqno
    };

  } catch (error) {

    console.error(
      `PTN PAYOUT ERROR ORDER ${order.id}:`,
      error
    );

    /*
     * No Telegram failure message is sent.
     */
    return {
      success: false,
      error:
        String(
          error?.message ||
          error
        )
    };
  }
}

/* =========================================================
   PAYOUT IDEMPOTENCY
   ========================================================= */

async function findExistingPayoutForOrder(
  env,
  order
) {

  try {

    const {
      client,
      senderWallet
    } =
      await getPtnSender(env);

    return await findExistingPayout(
      client,
      senderWallet.address,
      BigInt(order.id)
    );

  } catch (error) {

    console.error(
      "PAYOUT IDEMPOTENCY ERROR:",
      error
    );

    return null;
  }
}

function getOutgoingMessages(tx) {

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

  try {

    const transactions =
      await client.getTransactions(
        senderAddress,
        {
          limit: 20
        }
      );

    for (
      const tx of transactions
    ) {

      const outgoing =
        getOutgoingMessages(tx);

      for (
        const message of outgoing
      ) {

        if (!message?.body) {
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
              tx.hash().toString(
                "base64url"
              );

          } catch {
            hash = null;
          }

          return {
            hash,
            seqno:
              tx.lt || null
          };

        } catch {
          continue;
        }
      }
    }

  } catch (error) {

    console.error(
      "PAYOUT SEARCH ERROR:",
      error
    );
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
    (telegram_id, mode, target_id)
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

async function getAdminState(env) {

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

async function clearAdminState(env) {

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

function parseGramAmount(value) {

  const input =
    String(value)
      .trim()
      .replace(",", ".");

  /*
   * The original regex was corrected.
   * The decimal point must be escaped.
   */
  if (
    !/^\d+(\.\d{1,9})?$/.test(
      input
    )
  ) {
    return null;
  }

  const number =
    Number(input);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return null;
  }

  return input;
}

function gramToPtn(gram) {

  const [
    whole,
    decimal = ""
  ] =
    String(gram).split(".");

  const padded =
    decimal
      .padEnd(6, "0")
      .slice(0, 6);

  const micro =
    BigInt(whole) *
      1000000n +
    BigInt(
      padded || "0"
    );

  return (
    micro *
    PTN_PER_GRAM /
    1000000n
  ).toString();
}

function gramToNano(gram) {

  const [
    whole,
    decimal = ""
  ] =
    String(gram).split(".");

  const padded =
    decimal
      .padEnd(9, "0")
      .slice(0, 9);

  return (
    BigInt(whole) *
      1000000000n +
    BigInt(
      padded || "0"
    )
  ).toString();
}

function formatNumber(value) {

  const [
    whole,
    decimal
  ] =
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

function displayStatus(status) {

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
      "Processing payout",

    payout_sent:
      "PTN sent",

    completed:
      "Completed",

    suspicious:
      "Under review"
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
    String(text || "");

  if (
    value.length <= max
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
      Address.parse(a)
        .toString() ===
      Address.parse(b)
        .toString()
    );

  } catch {

    return (
      String(a).trim() ===
      String(b).trim()
    );
  }
}

function parseSqlUtc(value) {

  if (!value) {
    return null;
  }

  const raw =
    String(value).trim();

  if (!raw) {
    return null;
  }

  let normalized;

  if (
    raw.endsWith("Z")
  ) {

    normalized = raw;

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

  return Number.isNaN(time)
    ? null
    : time;
}

function formatUtcDate(value) {

  const time =
    parseSqlUtc(value);

  if (!time) {
    return String(value);
  }

  return new Date(time)
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
          JSON.stringify(body)
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
