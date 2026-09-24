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
  JettonMaster
} from "@ton/ton";
import { keyPairFromSeed } from "@ton/crypto";

globalThis.Buffer = Buffer;

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

const ADMIN_TELEGRAM_ID = "113074274";

const ADMIN_BACK = {
  inline_keyboard: [
    [{ text: "⬅️ Admin Panel", callback_data: "admin_home" }]
  ]
};

/* =========================================================
   TOKEN / WALLET CONFIG
========================================================= */

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const GRAM_RECEIVING_WALLET =
  "UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";

const PTN_DECIMALS = 9;
const PTN_PER_GRAM = 1000000n;

const MIN_SENDER_TON_BALANCE = toNano("0.20");

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
   WORKER
========================================================= */

export default {
  async fetch(request, env, ctx) {

    if (request.method !== "POST") {
      return new Response("PAYTON BOT OK", { status: 200 });
    }

    await ensureExtraTables(env);

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    try {
      await handleUpdate(update, env, ctx);
    } catch (error) {
      console.error("UPDATE ERROR:", error);
    }

    return new Response("OK", { status: 200 });
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
   DATABASE TABLES
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
}

/* =========================================================
   ADMIN MENU
========================================================= */

async function getAdminMenu(env) {

  let supportCount = 0;

  try {

    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM support_messages
      WHERE status='open'
    `).first();

    supportCount = Number(row?.count || 0);

  } catch (error) {

    console.error("SUPPORT COUNT ERROR:", error);
  }

  return {
    inline_keyboard: [
      [
        {
          text: "📊 Dashboard",
          callback_data: "admin_dashboard"
        }
      ],
      [
        {
          text: "📋 All Orders",
          callback_data: "admin_orders"
        },
        {
          text: "⏳ Pending",
          callback_data: "admin_pending"
        }
      ],
      [
        {
          text: "👥 Users",
          callback_data: "admin_users"
        },
        {
          text: `💬 Support${supportCount > 0 ? `(${supportCount})` : ""}`,
          callback_data: "admin_support"
        }
      ],
      [
        {
          text: "🚨 Suspicious",
          callback_data: "admin_suspicious"
        },
        {
          text: "💰 Revenue",
          callback_data: "admin_revenue"
        }
      ],
      [
        {
          text: "⚡ Reply Templates",
          callback_data: "admin_templates"
        }
      ],
      [
        {
          text: "🔄 Refresh",
          callback_data: "admin_dashboard"
        }
      ]
    ]
  };
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
  const chatId = String(message.chat?.id || "");
  const text = String(message.text || "").trim();

  if (!chatId) {
    return;
  }

  if (chatId === ADMIN_TELEGRAM_ID) {

    if (text === "/admin") {

      await clearAdminState(env);

      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "🛠 PAYTON Admin Panel",
        reply_markup: await getAdminMenu(env)
      });

      return;
    }

    const handled = await handleAdminText(message, env);

    if (handled) {
      return;
    }
  }

  if (chatId !== ADMIN_TELEGRAM_ID) {

    const restriction = await getUserRestriction(env, chatId);

    if (restriction) {
      await sendBlockedMessage(env, chatId, restriction);
      return;
    }
  }

  if (text === "/start") {

    await upsertUser(env, message.from);

    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: WELCOME,
      reply_markup: MENU
    });

    return;
  }

  if (chatId !== ADMIN_TELEGRAM_ID) {

    const supportHandled =
      await handleSupportMessage(message, env);

    if (supportHandled) {
      return;
    }
  }

  if (chatId !== ADMIN_TELEGRAM_ID) {

    const state = await getPendingOrder(env, chatId);

    if (state) {

      await handleOrderText(message, state, env);
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
   USER CALLBACKS
========================================================= */

async function handleCallback(query, env) {

  const data = String(query.data || "");
  const chatId = String(query.message?.chat?.id || "");

  if (!chatId) {
    return;
  }

  if (data.startsWith("admin_")) {

    if (chatId !== ADMIN_TELEGRAM_ID) {

      await telegram(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Access denied."
      });

      return;
    }

    await handleAdminCallback(query, env);
    return;
  }

  const restriction =
    await getUserRestriction(env, chatId);

  if (restriction) {

    await telegram(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Your access to this bot is currently restricted."
    });

    await sendBlockedMessage(env, chatId, restriction);
    return;
  }

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: query.id
  });

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

    await upsertUser(env, query.from);

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

    await createInitialOrder(env, chatId);
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

    await showUserOrders(env, query);
    return;
  }

  if (data === "support") {

    await createSupportRequest(env, query.from);

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
   ADMIN CALLBACKS
========================================================= */

async function handleAdminCallback(query, env) {

  const data = String(query.data || "");

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: query.id
  });

  if (data === "admin_home") {

    await editMessage(
      env,
      query,
      "🛠 PAYTON Admin Panel",
      await getAdminMenu(env)
    );

    return;
  }

  if (data === "admin_dashboard") {
    await showAdminDashboard(env, query);
    return;
  }

  if (data === "admin_orders") {
    await showAdminOrders(env, query);
    return;
  }

  if (data === "admin_pending") {
    await showAdminPending(env, query);
    return;
  }

  if (data === "admin_users") {
    await showAdminUsers(env, query);
    return;
  }

  if (data.startsWith("admin_user_")) {

    const telegramId =
      data.replace("admin_user_", "");

    if (telegramId) {
      await showAdminUser(env, query, telegramId);
    }

    return;
  }

  if (data.startsWith("admin_ub1_")) {
    await blockUser(
      env,
      query,
      data.slice("admin_ub1_".length),
      1
    );
    return;
  }

  if (data.startsWith("admin_ub3_")) {
    await blockUser(
      env,
      query,
      data.slice("admin_ub3_".length),
      3
    );
    return;
  }

  if (data.startsWith("admin_ub7_")) {
    await blockUser(
      env,
      query,
      data.slice("admin_ub7_".length),
      7
    );
    return;
  }

  if (data.startsWith("admin_ubp_")) {
    await blockUser(
      env,
      query,
      data.slice("admin_ubp_".length),
      "permanent"
    );
    return;
  }

  if (data.startsWith("admin_ubu_")) {
    await unblockUser(
      env,
      query,
      data.slice("admin_ubu_".length)
    );
    return;
  }

  if (data === "admin_revenue") {
    await showAdminRevenue(env, query);
    return;
  }

  if (data === "admin_support") {
    await showSupportInbox(env, query);
    return;
  }

  if (data.startsWith("admin_ticket_")) {

    const id =
      Number(data.replace("admin_ticket_", ""));

    if (Number.isInteger(id) && id > 0) {
      await showSupportTicket(env, query, id);
    }

    return;
  }

  if (data.startsWith("admin_reply_")) {

    const id =
      Number(data.replace("admin_reply_", ""));

    if (Number.isInteger(id) && id > 0) {

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
                callback_data: "admin_cancel_reply"
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
      await getAdminMenu(env)
    );

    return;
  }

  if (data.startsWith("admin_quick_")) {

    const parts = data.split("_");

    if (parts.length >= 4) {

      const ticketId = Number(parts[2]);
      const page = Number(parts[3] || 0);

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

    const parts = data.split("_");

    if (parts.length >= 4) {

      const ticketId = Number(parts[2]);
      const index = Number(parts[3]);

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

  if (data === "admin_suspicious") {
    await showSuspiciousUsers(env, query);
    return;
  }

  if (data.startsWith("admin_sus_")) {

    const telegramId =
      data.replace("admin_sus_", "");

    if (telegramId) {
      await showSuspiciousUser(
        env,
        query,
        telegramId
      );
    }

    return;
  }

  if (data.startsWith("admin_b1_")) {

    await blockSuspiciousUser(
      env,
      query,
      data.slice("admin_b1_".length),
      1
    );

    return;
  }

  if (data.startsWith("admin_b3_")) {

    await blockSuspiciousUser(
      env,
      query,
      data.slice("admin_b3_".length),
      3
    );

    return;
  }

  if (data.startsWith("admin_b7_")) {

    await blockSuspiciousUser(
      env,
      query,
      data.slice("admin_b7_".length),
      7
    );

    return;
  }

  if (data.startsWith("admin_bp_")) {

    await blockSuspiciousUser(
      env,
      query,
      data.slice("admin_bp_".length),
      "permanent"
    );

    return;
  }

  if (data.startsWith("admin_bu_")) {

    await unblockSuspiciousUser(
      env,
      query,
      data.slice("admin_bu_".length)
    );

    return;
  }

  if (data === "admin_templates") {

    await showTemplates(env, query);
    return;
  }
}

/* =========================================================
   ADMIN TEXT / SUPPORT
========================================================= */

async function handleAdminText(message, env) {

  const text =
    String(message.text || "").trim();

  if (!text) {
    return false;
  }

  if (text === "/cancel") {

    await clearAdminState(env);

    await telegram(env, "sendMessage", {
      chat_id: ADMIN_TELEGRAM_ID,
      text: "❌ Reply cancelled.",
      reply_markup: await getAdminMenu(env)
    });

    return true;
  }

  const state = await getAdminState(env);

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
        chat_id: ADMIN_TELEGRAM_ID,
        text: "❌ Support ticket not found.",
        reply_markup: await getAdminMenu(env)
      });

      return true;
    }

    await telegram(env, "sendMessage", {
      chat_id: ticket.telegram_id,
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
    .bind(text, ticketId)
    .run();

    await clearAdminState(env);

    await telegram(env, "sendMessage", {
      chat_id: ADMIN_TELEGRAM_ID,
      text: "✅ Reply sent successfully.",
      reply_markup: await getAdminMenu(env)
    });

    return true;
  }

  return false;
}

async function createSupportRequest(env, user) {

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

async function handleSupportMessage(message, env) {

  const telegramId =
    String(message.from?.id || "");

  const text =
    String(message.text || "").trim();

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

/* =========================================================
   SUPPORT ADMIN
========================================================= */

async function showSupportInbox(env, query) {

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

  for (const row of rows.results || []) {

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
      callback_data: "admin_home"
    }
  ]);

  const count =
    rows.results?.length || 0;

  const text =
    `💬 Support Inbox (${count})\n\n` +
    (
      count
        ? "Open support tickets:"
        : "No open support tickets."
    );

  await editMessage(
    env,
    query,
    text,
    { inline_keyboard: buttons }
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
    shortText(ticket.message, 3000);

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
            callback_data: "admin_support"
          }
        ]
      ]
    }
  );
}

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
      QUICK_REPLIES.length / pageSize
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

  for (let i = start; i < end; i++) {

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
    { inline_keyboard: buttons }
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
    chat_id: ticket.telegram_id,
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
  .bind(reply, ticketId)
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
            callback_data: "admin_support"
          }
        ],
        [
          {
            text: "🛠 Admin Panel",
            callback_data: "admin_home"
          }
        ]
      ]
    }
  );
}

async function showTemplates(env, query) {

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

async function showSuspiciousUsers(env, query) {

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      ORDER BY updated_at DESC
      LIMIT 30
    `)
    .all();

  const buttons = [];

  for (const row of rows.results || []) {

    let status = "⚠️";

    if (Number(row.permanent) === 1) {
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
          `${status} ${shortText(name, 25)}`,
        callback_data:
          `admin_sus_${row.telegram_id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Admin Panel",
      callback_data: "admin_home"
    }
  ]);

  await editMessage(
    env,
    query,
    "🚨 Suspicious Users",
    { inline_keyboard: buttons }
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
      "User not found.",
      ADMIN_BACK
    );

    return;
  }

  const buttons = [
    [
      {
        text: "⏳ Block 1 day",
        callback_data:
          `admin_b1_${telegramId}`
      }
    ],
    [
      {
        text: "⏳ Block 3 days",
        callback_data:
          `admin_b3_${telegramId}`
      }
    ],
    [
      {
        text: "⏳ Block 7 days",
        callback_data:
          `admin_b7_${telegramId}`
      }
    ],
    [
      {
        text: "🚫 Permanent",
        callback_data:
          `admin_bp_${telegramId}`
      }
    ],
    [
      {
        text: "🔓 Unblock",
        callback_data:
          `admin_bu_${telegramId}`
      }
    ],
    [
      {
        text: "⬅️ Suspicious",
        callback_data: "admin_suspicious"
      }
    ]
  ];

  const text =
    "🚨 Suspicious User\n\n" +
    `User: ${row.username || "No username"}\n` +
    `Telegram ID: ${telegramId}\n` +
    `Reason: ${row.reason || "Unknown"}\n` +
    `Count: ${row.suspicious_count}\n` +
    `Status: ${getBlockStatusText(row)}\n`;

  await editMessage(
    env,
    query,
    text,
    { inline_keyboard: buttons }
  );
}

/* =========================================================
   USER BLOCKING
========================================================= */

async function ensureUserBlockRecord(
  env,
  telegramId,
  username
) {

  await env.DB.prepare(`
    INSERT INTO suspicious_users
    (
      telegram_id,
      username,
      reason
    )
    VALUES (?, ?, 'Admin block')
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username=excluded.username,
      updated_at=CURRENT_TIMESTAMP
  `)
  .bind(
    String(telegramId),
    username || null
  )
  .run();
}

async function blockUser(
  env,
  query,
  telegramId,
  days
) {

  await ensureUserBlockRecord(
    env,
    telegramId,
    null
  );

  let blockedUntil;

  if (days === "permanent") {

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=1,
          blocked_until=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `)
    .bind(telegramId)
    .run();

  } else {

    blockedUntil =
      new Date(
        Date.now() +
        Number(days) * 86400000
      ).toISOString();

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=0,
          blocked_until=?,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `)
    .bind(
      blockedUntil,
      telegramId
    )
    .run();
  }

  await notifyBlock(
    env,
    telegramId,
    days
  );

  await editMessage(
    env,
    query,
    "✅ User restriction updated.",
    ADMIN_BACK
  );
}

async function unblockUser(
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
      "🔓 Your access to PAYTON has been restored.",
    reply_markup: MENU
  });

  await editMessage(
    env,
    query,
    "✅ User unblocked.",
    ADMIN_BACK
  );
}

async function blockSuspiciousUser(
  env,
  query,
  telegramId,
  days
) {
  await blockUser(
    env,
    query,
    telegramId,
    days
  );
}

async function unblockSuspiciousUser(
  env,
  query,
  telegramId
) {
  await unblockUser(
    env,
    query,
    telegramId
  );
}

async function notifyBlock(
  env,
  telegramId,
  days
) {

  const text =
    days === "permanent"
      ? "🚫 Your access to PAYTON has been permanently restricted."
      : `⏳ Your access to PAYTON has been restricted for ${days} day(s).`;

  await telegram(env, "sendMessage", {
    chat_id: telegramId,
    text
  });
}

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

  if (Number(row.permanent) === 1) {
    return row;
  }

  if (row.blocked_until) {

    const time =
      Date.parse(row.blocked_until);

    if (
      Number.isFinite(time) &&
      time > Date.now()
    ) {
      return row;
    }

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET blocked_until=NULL,
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
  telegramId,
  restriction
) {

  await telegram(env, "sendMessage", {
    chat_id: telegramId,
    text:
      "🚫 Your access to PAYTON is currently restricted.\n\n" +
      getBlockStatusText(restriction)
  });
}

function getBlockStatusText(row) {

  if (Number(row.permanent) === 1) {
    return "Permanent restriction.";
  }

  if (row.blocked_until) {
    return `Restricted until ${row.blocked_until}.`;
  }

  return "No active restriction.";
}

/* =========================================================
   ADMIN USERS
========================================================= */

async function showAdminUsers(env, query) {

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM users
      ORDER BY rowid DESC
      LIMIT 30
    `)
    .all();

  const buttons = [];

  for (const row of rows.results || []) {

    buttons.push([
      {
        text:
          `👤 ${shortText(
            row.username || row.telegram_id,
            30
          )}`,
        callback_data:
          `admin_user_${row.telegram_id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Admin Panel",
      callback_data: "admin_home"
    }
  ]);

  await editMessage(
    env,
    query,
    "👥 Users",
    { inline_keyboard: buttons }
  );
}

async function showAdminUser(
  env,
  query,
  telegramId
) {

  const user =
    await env.DB.prepare(`
      SELECT *
      FROM users
      WHERE telegram_id=?
      LIMIT 1
    `)
    .bind(telegramId)
    .first();

  const orders =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE telegram_id=?
      ORDER BY id DESC
      LIMIT 10
    `)
    .bind(telegramId)
    .all();

  const text =
    "👤 User\n\n" +
    `Username: ${user?.username || "No username"}\n` +
    `Telegram ID: ${telegramId}\n\n` +
    `Orders: ${orders.results?.length || 0}`;

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Users",
            callback_data: "admin_users"
          }
        ]
      ]
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
    `Users: ${stats.users}\n` +
    `Orders: ${stats.orders}\n` +
    `Pending: ${stats.pending}\n` +
    `Suspicious: ${stats.suspicious}\n` +
    `Blocked: ${stats.blocked}\n` +
    `Revenue: ${formatNumber(stats.revenue)} GRAM\n` +
    `PTN sold: ${formatNumber(stats.ptn)}`;

  await editMessage(
    env,
    query,
    text,
    await getAdminMenu(env)
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
        'payment_verified'
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
           AND blocked_until > CURRENT_TIMESTAMP
         )
    `)
    .first();

  const revenue =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(
            CAST(gram_amount AS REAL)
          ),
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
          SUM(
            CAST(ptn_amount AS REAL)
          ),
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
    suspicious: suspicious?.count || 0,
    blocked: blocked?.count || 0,
    revenue: revenue?.total || 0,
    ptn: ptn?.total || 0
  };
}

async function showAdminOrders(env, query) {

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

  for (const row of rows.results || []) {

    text +=
      `#${row.id} | ${row.telegram_id}\n` +
      `GRAM: ${row.gram_amount}\n` +
      `PTN: ${row.ptn_amount}\n` +
      `Status: ${displayStatus(row.status)}\n` +
      `Date: ${row.created_at}\n\n`;
  }

  if (!rows.results?.length) {
    text += "No orders found.";
  }

  await editMessage(
    env,
    query,
    shortText(text, 3900),
    ADMIN_BACK
  );
}

async function showAdminPending(env, query) {

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

  for (const row of rows.results || []) {

    text +=
      `#${row.id}\n` +
      `User: ${row.telegram_id}\n` +
      `GRAM: ${row.gram_amount}\n` +
      `PTN: ${row.ptn_amount}\n` +
      `Status: ${displayStatus(row.status)}\n\n`;
  }

  if (!rows.results?.length) {
    text += "No pending orders.";
  }

  await editMessage(
    env,
    query,
    shortText(text, 3900),
    ADMIN_BACK
  );
}

async function showAdminRevenue(env, query) {

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
   USERS / ORDERS
========================================================= */

async function upsertUser(env, user) {

  if (!user?.id) {
    return;
  }

  await env.DB.prepare(`
    INSERT INTO users
    (
      telegram_id,
      username
    )
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

async function createInitialOrder(
  env,
  telegramId
) {

  await env.DB.prepare(`
    INSERT INTO orders
    (
      telegram_id,
      gram_amount,
      ptn_amount,
      payment_address,
      transaction_hash,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  .bind(
    String(telegramId),
    "0",
    "0",
    null,
    null,
    "awaiting_amount"
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
  .bind(String(telegramId))
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
    String(message.text || "").trim();

  if (!text) {
    return;
  }

  if (order.status === "awaiting_amount") {

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
        "Please send your PTN receiving wallet address.",
      reply_markup: BACK
    });

    return;
  }

  if (order.status === "awaiting_wallet") {

    let wallet;

    try {

      wallet =
        Address.parse(text).toString();

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
        "Please send the exact GRAM amount to the payment address below:\n\n" +
        `${GRAM_RECEIVING_WALLET}\n\n` +
        "Payment comment:\n" +
        `PAYTON-${order.id}\n\n` +
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

    for (const row of rows.results) {

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
   ORDER PROCESSOR
========================================================= */

async function processOrders(env) {

  /*
    Only ONE order per Cron run.

    This is intentional because Cloudflare Workers Free
    allows only 10 ms CPU per Cron invocation.
  */

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE status IN (
        'pending',
        'payment_verified'
      )
      ORDER BY id ASC
      LIMIT 1
    `)
    .all();

  for (const order of rows.results || []) {

    try {

      if (order.status === "pending") {

        const payment =
          await findPayment(env, order);

        if (!payment) {
          continue;
        }

        const alreadyUsed =
          await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE transaction_hash=?
              AND id!=?
            LIMIT 1
          `)
          .bind(
            payment.hash,
            order.id
          )
          .first();

        if (alreadyUsed) {

          const user =
            await env.DB.prepare(`
              SELECT username
              FROM users
              WHERE telegram_id=?
              LIMIT 1
            `)
            .bind(order.telegram_id)
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
          `)
          .bind(
            payment.hash,
            order.id
          )
          .run();

          await telegram(env, "sendMessage", {
            chat_id: order.telegram_id,
            text:
              "⚠️ This transaction has already been used.\n\n" +
              "Your order has been flagged for review.\n\n" +
              "Please do not send another payment."
          });

          await telegram(env, "sendMessage", {
            chat_id: ADMIN_TELEGRAM_ID,
            text:
              "🚨 Suspicious activity detected.\n\n" +
              `User: ${order.telegram_id}\n` +
              `Order: #${order.id}\n` +
              "Reason: Reused transaction hash",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🚨 Review User",
                    callback_data:
                      `admin_sus_${order.telegram_id}`
                  }
                ]
              ]
            }
          });

          continue;
        }

        await env.DB.prepare(`
          UPDATE orders
          SET transaction_hash=?,
              status='payment_verified'
          WHERE id=?
        `)
        .bind(
          payment.hash,
          order.id
        )
        .run();

        await telegram(env, "sendMessage", {
          chat_id: order.telegram_id,
          text:
            "✅ Payment verified successfully.\n\n" +
            `Order #${order.id}\n` +
            `GRAM received: ${formatNumber(order.gram_amount)}\n` +
            `PTN amount: ${formatNumber(order.ptn_amount)}\n\n` +
            "Your PTN tokens are now being sent automatically."
        });
      }

      if (order.status === "payment_verified") {

        const freshOrder =
          await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE id=?
            LIMIT 1
          `)
          .bind(order.id)
          .first();

        if (!freshOrder) {
          continue;
        }

        const payout =
          await sendPTN(
            env,
            freshOrder
          );

        if (payout?.success) {

          await env.DB.prepare(`
            UPDATE orders
            SET status='payout_sent'
            WHERE id=?
          `)
          .bind(order.id)
          .run();

          await telegram(env, "sendMessage", {
            chat_id: order.telegram_id,
            text:
              "🎉 Order completed successfully!\n\n" +
              `Order #${order.id}\n` +
              `${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.\n\n` +
              "Transaction:\n" +
              (
                payout.hash ||
                "Submitted to blockchain"
              )
          });
        }
      }

    } catch (error) {

      console.error(
        `ORDER ${order.id} ERROR: ${
          error?.name || "Error"
        }: ${
          error?.message || String(error)
        }`
      );
    }
  }
}

/* =========================================================
   PAYMENT CHECK
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

  const expectedAmount =
    BigInt(
      gramToNano(
        order.gram_amount
      )
    );

  const orderCreatedUtime =
    getOrderCreatedUtime(
      order.created_at
    );

  if (orderCreatedUtime === null) {

    console.error(
      `ORDER ${order.id}: invalid created_at`
    );

    return null;
  }

  const startUtime =
    Math.max(
      0,
      orderCreatedUtime - 30
    );

  const endUtime =
    Math.floor(Date.now() / 1000) + 60;

  const pageSize = 1000;
  let offset = 0;

  while (true) {

    const params =
      new URLSearchParams();

    params.set(
      "destination",
      GRAM_RECEIVING_WALLET
    );

    params.set(
      "source",
      order.payment_address
    );

    params.set(
      "direction",
      "in"
    );

    params.set(
      "exclude_externals",
      "true"
    );

    params.set(
      "start_utime",
      String(startUtime)
    );

    params.set(
      "end_utime",
      String(endUtime)
    );

    params.set(
      "limit",
      String(pageSize)
    );

    params.set(
      "offset",
      String(offset)
    );

    params.set(
      "sort",
      "asc"
    );

    const url =
      "https://toncenter.com/api/v3/messages?" +
      params.toString();

    let response;

    try {

      response =
        await fetch(
          url,
          {
            headers: {
              "X-API-Key": apiKey
            }
          }
        );

    } catch (error) {

      console.error(
        `TONCENTER FETCH ERROR ORDER ${order.id}:`,
        error
      );

      return null;
    }

    if (!response.ok) {

      console.error(
        `TONCENTER ERROR ORDER ${order.id}:`,
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
        `TONCENTER JSON ERROR ORDER ${order.id}:`,
        error
      );

      return null;
    }

    const messages =
      Array.isArray(data?.messages)
        ? data.messages
        : [];

    if (!messages.length) {
      return null;
    }

    for (const message of messages) {

      const source =
        message?.source || "";

      const destination =
        message?.destination || "";

      if (
        !sameAddress(
          source,
          order.payment_address
        )
      ) {
        continue;
      }

      if (
        !sameAddress(
          destination,
          GRAM_RECEIVING_WALLET
        )
      ) {
        continue;
      }

      if (
        message?.bounced === true ||
        message?.bounce === true
      ) {
        continue;
      }

      const value =
        String(
          message?.value ?? ""
        );

      if (!value) {
        continue;
      }

      let actualValue;

      try {

        actualValue =
          BigInt(value);

      } catch {

        continue;
      }

      if (
        actualValue !== expectedAmount
      ) {
        continue;
      }

      const hash =
        message?.in_msg_tx_hash ||
        message?.transaction_hash ||
        "";

      if (!hash) {
        continue;
      }

      const body =
        message?.message_content?.body ||
        message?.message_content?.body_boc ||
        message?.msg_data ||
        message?.message_data ||
        null;

      const comment =
        decodeComment(body);

      if (
        comment !==
        `PAYTON-${order.id}`
      ) {
        continue;
      }

      const messageUtime =
        Number(
          message?.created_at || 0
        );

      if (
        messageUtime &&
        messageUtime < startUtime
      ) {
        continue;
      }

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
        return {
          hash,
          duplicate: true
        };
      }

      console.log(
        `PAYMENT FOUND ORDER ${order.id}: ${hash}`
      );

      return { hash };
    }

    if (
      messages.length <
      pageSize
    ) {
      return null;
    }

    offset += pageSize;
  }
}

/* =========================================================
   TON MNEMONIC -> KEYPAIR
========================================================= */

async function derivePTNKeyPair(env) {

  const mnemonic =
    String(
      env.PTN_MNEMONIC || ""
    ).trim();

  if (!mnemonic) {
    throw new Error(
      "PTN_MNEMONIC missing"
    );
  }

  const words =
    mnemonic.split(/\s+/);

  if (
    words.length !== 12 &&
    words.length !== 24
  ) {
    throw new Error(
      `PTN_MNEMONIC has invalid word count: ${words.length}`
    );
  }

  const encoder =
    new TextEncoder();

  /*
    TON mnemonic derivation:

    1. HMAC-SHA512(
         key = mnemonic,
         data = empty
       )

    2. PBKDF2-HMAC-SHA512(
         password = HMAC result,
         salt = "TON default seed",
         iterations = 100000
       )

    3. First 32 bytes -> Ed25519 seed.
  */

  const hmacKey =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(mnemonic),
      {
        name: "HMAC",
        hash: "SHA-512"
      },
      false,
      ["sign"]
    );

  const mnemonicSeed =
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
      mnemonicSeed,
      {
        name: "PBKDF2"
      },
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
      seed64.subarray(0, 32)
    )
  );
}

/* =========================================================
   PTN PAYOUT
========================================================= */

async function sendPTN(
  env,
  order
) {

  try {

    const keyPair =
      await derivePTNKeyPair(env);

    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });

    const senderWallet =
      WalletContractV5R1.create({
        workchain: 0,
        publicKey:
          keyPair.publicKey
      });

    /*
      Critical safety check:
      the mnemonic MUST derive the configured
      PTN sender wallet.
    */

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

    const wallet =
      client.open(
        senderWallet
      );

    const deployed =
      await client.isContractDeployed(
        senderWallet.address
      );

    if (!deployed) {

      throw new Error(
        "PTN sender wallet is not initialized/deployed"
      );
    }

    const balance =
      await client.getBalance(
        senderWallet.address
      );

    if (
      balance <
      MIN_SENDER_TON_BALANCE
    ) {

      throw new Error(
        "Insufficient native TON balance for payout"
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

    const senderJettonWallet =
      client.open(
        await master.getWalletAddress(
          senderWallet.address
        )
      );

    const senderJettonBalance =
      await senderJettonWallet.getJettonBalance();

    const amount =
      BigInt(order.ptn_amount) *
      10n ** BigInt(PTN_DECIMALS);

    if (
      senderJettonBalance <
      amount
    ) {

      throw new Error(
        "Insufficient PTN balance"
      );
    }

    /*
      Duplicate payout protection.
      The order ID is used as query_id.
    */

    const existing =
      await findExistingPayout(
        client,
        senderWallet.address,
        BigInt(order.id)
      );

    if (existing) {

      return {
        success: true,
        hash: existing
      };
    }

    const destination =
      Address.parse(
        order.payment_address
      );

    const destinationJettonWallet =
      await master.getWalletAddress(
        destination
      );

    const body =
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
          toNano("0.05")
        )
        .storeBit(0)
        .endCell();

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
      success: true,
      hash: null
    };

  } catch (error) {

    console.error(
      `PTN PAYOUT ERROR ORDER ${order.id}: ${
        error?.name || "Error"
      }: ${
        error?.message ||
        String(error)
      }`
    );

    /*
      Payment stays verified.
      Cron will retry automatically.
    */

    await env.DB.prepare(`
      UPDATE orders
      SET status='payment_verified'
      WHERE id=?
        AND status='payment_verified'
    `)
    .bind(order.id)
    .run();

    await telegram(env, "sendMessage", {
      chat_id:
        order.telegram_id,
      text:
        "⚠️ Your payment has been verified, but the PTN transfer could not be completed yet.\n\n" +
        "Your payment is safe and the system will retry the PTN transfer automatically."
    });

    return {
      success: false,
      error:
        String(error)
    };
  }
}

/* =========================================================
   EXISTING PAYOUT CHECK
========================================================= */

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

    for (const tx of transactions) {

      const inMsg =
        tx.inMessage;

      if (!inMsg) {
        continue;
      }

      const body =
        inMsg.body;

      if (!body) {
        continue;
      }

      try {

        const slice =
          body.beginParse();

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
          id === queryId
        ) {

          return tx
            .hash()
            .toString(
              "base64url"
            );
        }

      } catch {
        continue;
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

  if (
    !/^\d+(?:\.\d{1,9})?$/.test(
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
    BigInt(padded || "0");

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
    BigInt(padded || "0")
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
    pending: "Pending payment",
    awaiting_amount: "Awaiting amount",
    awaiting_wallet: "Awaiting wallet",
    payment_verified: "Payment verified",
    processing: "Processing",
    payout_sent: "PTN sent",
    completed: "Completed",
    suspicious: "Under review"
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

function getOrderCreatedUtime(
  value
) {

  if (!value) {
    return null;
  }

  const normalized =
    String(value)
      .replace(
        " ",
        "T"
      );

  const time =
    Date.parse(
      normalized +
      (
        normalized.endsWith("Z")
          ? ""
          : "Z"
      )
    );

  if (
    Number.isNaN(time)
  ) {
    return null;
  }

  return Math.floor(
    time / 1000
  );
}

/* =========================================================
   COMMENT DECODER
========================================================= */

function decodeComment(
  msgData
) {

  if (!msgData) {
    return "";
  }

  try {

    let cell;

    if (
      typeof msgData ===
      "string"
    ) {

      cell =
        Cell.fromBase64(
          msgData
        );

    } else {

      return "";
    }

    const slice =
      cell.beginParse();

    if (
      slice.remainingBits <
      32
    ) {
      return "";
    }

    const opcode =
      slice.loadUint(32);

    if (opcode !== 0) {
      return "";
    }

    const bytes = [];

    while (
      slice.remainingBits >=
      8
    ) {

      bytes.push(
        slice.loadUint(8)
      );
    }

    return new TextDecoder()
      .decode(
        new Uint8Array(bytes)
      )
      .replace(
        /\0+$/,
        ""
      );

  } catch {

    return "";
  }
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
