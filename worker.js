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

import { mnemonicToPrivateKey } from "@ton/crypto";

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
    [
      {
        text: "🪙 Buy PTN",
        callback_data: "buy"
      }
    ],
    [
      {
        text: "💰 Price",
        callback_data: "price"
      }
    ],
    [
      {
        text: "📋 My Orders",
        callback_data: "orders"
      }
    ],
    [
      {
        text: "💬 Support",
        callback_data: "support"
      }
    ]
  ]
};

const BACK = {
  inline_keyboard: [
    [
      {
        text: "⬅️ Back",
        callback_data: "home"
      }
    ]
  ]
};

/* =========================================================
   ADMIN
========================================================= */

const ADMIN_TELEGRAM_ID = "113074274";

const ADMIN_BACK = {
  inline_keyboard: [
    [
      {
        text: "⬅️ Admin Panel",
        callback_data: "admin_home"
      }
    ]
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

/* 1 GRAM = 1,000,000 PTN */
const PTN_PER_GRAM = 1000000n;

/* Sender wallet must keep enough native GRAM for gas. */
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
   MAIN FETCH
========================================================= */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("PAYTON BOT OK", {
        status: 200
      });
    }

    await ensureExtraTables(env);

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
      console.error(
        "UPDATE ERROR:",
        error
      );
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
          console.error(
            "CRON ERROR:",
            error
          );
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
}

/* =========================================================
   DYNAMIC ADMIN MENU
========================================================= */

async function getAdminMenu(env) {
  let supportCount = 0;

  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM support_messages
      WHERE status='open'
    `).first();

    supportCount = Number(
      row?.count || 0
    );
  } catch (error) {
    console.error(
      "SUPPORT COUNT ERROR:",
      error
    );
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
          text: `💬 Support${
            supportCount > 0
              ? ` (${supportCount})`
              : ""
          }`,
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
    await handleCallback(
      update.callback_query,
      env
    );
    return;
  }

  if (!update.message) return;

  const message = update.message;

  const chatId = String(
    message.chat?.id || ""
  );

  const text = String(
    message.text || ""
  ).trim();

  if (!chatId) return;

  /* ADMIN */

  if (chatId === ADMIN_TELEGRAM_ID) {
    if (text === "/admin") {
      await clearAdminState(env);

      await telegram(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text: "🛠 PAYTON Admin Panel",
          reply_markup:
            await getAdminMenu(env)
        }
      );

      return;
    }

    const handled =
      await handleAdminText(
        message,
        env
      );

    if (handled) return;
  }

  /* BLOCK CHECK */

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

  /* /start */

  if (text === "/start") {
    await upsertUser(
      env,
      message.from
    );

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text: WELCOME,
        reply_markup: MENU
      }
    );

    return;
  }

  /* SUPPORT */

  if (chatId !== ADMIN_TELEGRAM_ID) {
    const supportHandled =
      await handleSupportMessage(
        message,
        env
      );

    if (supportHandled) return;
  }

  /* ORDER */

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
      await telegram(
        env,
        "sendMessage",
        {
          chat_id: chatId,
          text:
            "Please use the menu below.",
          reply_markup: MENU
        }
      );
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

  if (!chatId) return;

  /* ADMIN */

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

  /* USER BLOCK CHECK */

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

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "🪙 Buy PTN\n\n" +
          "Please enter the amount of GRAM you want to pay.\n\n" +
          "Example:\n" +
          "10\n\n" +
          "You will receive 10,000,000 PTN.",
        reply_markup: BACK
      }
    );

    await createInitialOrder(
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

async function handleAdminCallback(query, env) {
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

  /* ADMIN HOME */

  if (data === "admin_home") {
    await editMessage(
      env,
      query,
      "🛠 PAYTON Admin Panel",
      await getAdminMenu(env)
    );

    return;
  }

  /* DASHBOARD */

  if (data === "admin_dashboard") {
    await showAdminDashboard(
      env,
      query
    );

    return;
  }

  /* ORDERS */

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

  /* USERS */

  if (data === "admin_users") {
    await showAdminUsers(
      env,
      query
    );

    return;
  }

  if (data.startsWith("admin_user_")) {
    const telegramId =
      data.replace(
        "admin_user_",
        ""
      );

    if (telegramId) {
      await showAdminUser(
        env,
        query,
        telegramId
      );
    }

    return;
  }

  /* USER BLOCKING */

  if (data.startsWith("admin_ub1_")) {
    await blockUser(
      env,
      query,
      data.slice(
        "admin_ub1_".length
      ),
      1
    );

    return;
  }

  if (data.startsWith("admin_ub3_")) {
    await blockUser(
      env,
      query,
      data.slice(
        "admin_ub3_".length
      ),
      3
    );

    return;
  }

  if (data.startsWith("admin_ub7_")) {
    await blockUser(
      env,
      query,
      data.slice(
        "admin_ub7_".length
      ),
      7
    );

    return;
  }

  if (data.startsWith("admin_ubp_")) {
    await blockUser(
      env,
      query,
      data.slice(
        "admin_ubp_".length
      ),
      "permanent"
    );

    return;
  }

  if (data.startsWith("admin_ubu_")) {
    await unblockUser(
      env,
      query,
      data.slice(
        "admin_ubu_".length
      )
    );

    return;
  }

  /* REVENUE */

  if (data === "admin_revenue") {
    await showAdminRevenue(
      env,
      query
    );

    return;
  }

  /* SUPPORT */

  if (data === "admin_support") {
    await showSupportInbox(
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

  if (
    data ===
    "admin_cancel_reply"
  ) {
    await clearAdminState(env);

    await editMessage(
      env,
      query,
      "🛠 PAYTON Admin Panel",
      await getAdminMenu(env)
    );

    return;
  }

  /* QUICK REPLIES */

  if (data.startsWith("admin_quick_")) {
    const parts =
      data.split("_");

    if (parts.length >= 4) {
      const ticketId =
        Number(parts[2]);

      const page =
        Number(parts[3] || 0);

      if (
        Number.isInteger(
          ticketId
        ) &&
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
        Number.isInteger(
          ticketId
        ) &&
        Number.isInteger(
          index
        ) &&
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

  /* SUSPICIOUS */

  if (data === "admin_suspicious") {
    await showSuspiciousUsers(
      env,
      query
    );

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

  /* SUSPICIOUS BLOCKING */

  if (data.startsWith("admin_b1_")) {
    await blockSuspiciousUser(
      env,
      query,
      data.slice(
        "admin_b1_".length
      ),
      1
    );

    return;
  }

  if (data.startsWith("admin_b3_")) {
    await blockSuspiciousUser(
      env,
      query,
      data.slice(
        "admin_b3_".length
      ),
      3
    );

    return;
  }

  if (data.startsWith("admin_b7_")) {
    await blockSuspiciousUser(
      env,
      query,
      data.slice(
        "admin_b7_".length
      ),
      7
    );

    return;
  }

  if (data.startsWith("admin_bp_")) {
    await blockSuspiciousUser(
      env,
      query,
      data.slice(
        "admin_bp_".length
      ),
      "permanent"
    );

    return;
  }

  if (data.startsWith("admin_bu_")) {
    await unblockSuspiciousUser(
      env,
      query,
      data.slice(
        "admin_bu_".length
      )
    );

    return;
  }

  /* TEMPLATES */

  if (
    data ===
    "admin_templates"
  ) {
    await showTemplates(
      env,
      query
    );

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
  const text = String(
    message.text || ""
  ).trim();

  if (!text) return false;

  if (text === "/cancel") {
    await clearAdminState(env);

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          ADMIN_TELEGRAM_ID,
        text:
          "❌ Reply cancelled.",
        reply_markup:
          await getAdminMenu(env)
      }
    );

    return true;
  }

  const state =
    await getAdminState(env);

  if (!state) return false;

  if (
    state.mode ===
    "reply"
  ) {
    const ticketId =
      Number(state.target_id);

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
      `).bind(
        ticketId
      ).first();

    if (!ticket) {
      await clearAdminState(
        env
      );

      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            ADMIN_TELEGRAM_ID,
          text:
            "❌ Support ticket not found.",
          reply_markup:
            await getAdminMenu(
              env
            )
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
        reply_markup: MENU
      }
    );

    await env.DB.prepare(`
      UPDATE support_messages
      SET status='replied',
          admin_reply=?
      WHERE id=?
    `).bind(
      text,
      ticketId
    ).run();

    await clearAdminState(
      env
    );

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          ADMIN_TELEGRAM_ID,
        text:
          "✅ Reply sent successfully.",
        reply_markup:
          await getAdminMenu(
            env
          )
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
    `).bind(
      telegramId
    ).first();

  if (existing) return;

  await env.DB.prepare(`
    INSERT INTO support_messages
    (
      telegram_id,
      username,
      message,
      status
    )
    VALUES (?, ?, ?, 'awaiting_message')
  `).bind(
    telegramId,
    username,
    "**AWAITING_MESSAGE**"
  ).run();
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

  if (
    !telegramId ||
    !text
  ) {
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
    `).bind(
      telegramId
    ).first();

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
  `).bind(
    username,
    text,
    ticket.id
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text:
        "📩 Your message has been received.\n\n" +
        "Support will respond shortly.",
      reply_markup: MENU
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
    const row of
      rows.results || []
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
      text:
        "⬅️ Admin Panel",
      callback_data:
        "admin_home"
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
    `).bind(
      ticketId
    ).first();

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
            text:
              "↩️ Manual Reply",
            callback_data:
              `admin_reply_${ticket.id}`
          }
        ],
        [
          {
            text:
              "⚡ Quick Replies",
            callback_data:
              `admin_quick_${ticket.id}_0`
          }
        ],
        [
          {
            text:
              "⬅️ Support Inbox",
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
    `).bind(
      ticketId
    ).first();

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

  if (
    page >= totalPages
  ) {
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
      text:
        "⬅️ Previous",
      callback_data:
        `admin_quick_${ticketId}_${page - 1}`
    });
  }

  if (
    page <
    totalPages - 1
  ) {
    navigation.push({
      text:
        "Next ➡️",
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
      text:
        "⬅️ Ticket",
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
    `).bind(
      ticketId
    ).first();

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
      reply_markup: MENU
    }
  );

  await env.DB.prepare(`
    UPDATE support_messages
    SET status='replied',
        admin_reply=?
    WHERE id=?
  `).bind(
    reply,
    ticketId
  ).run();

  await editMessage(
    env,
    query,
    "✅ Quick reply sent successfully.",
    {
      inline_keyboard: [
        [
          {
            text:
              "⬅️ Support Inbox",
            callback_data:
              "admin_support"
          }
        ],
        [
          {
            text:
              "🛠 Admin Panel",
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
   SUSPICIOUS SYSTEM
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
  `).bind(
    String(telegramId),
    username || null,
    reason
  ).run();
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
    const row of
      rows.results || []
  ) {
    let status = "⚠️";

    if (
      Number(row.permanent) ===
      1
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
          )} — Attempts: ${row.suspicious_count}`,
        callback_data:
          `admin_sus_${row.telegram_id}`
      }
    ]);
  }

  buttons.push([
    {
      text:
        "⬅️ Admin Panel",
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
    `).bind(
      telegramId
    ).first();

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

  const status =
    getBlockStatusText(row);

  const text =
    "🚨 Suspicious User\n\n" +
    `User: ${row.username || "No username"}\n` +
    `Telegram ID: ${row.telegram_id}\n` +
    `🔢 Suspicious Attempts: ${row.suspicious_count}\n` +
    `⚠️ Reason: ${row.reason || "Not specified"}\n` +
    `🚫 Status: ${status}`;

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard: [
        [
          {
            text:
              "🚫 Block 1 Day",
            callback_data:
              `admin_b1_${telegramId}`
          }
        ],
        [
          {
            text:
              "🚫 Block 3 Days",
            callback_data:
              `admin_b3_${telegramId}`
          }
        ],
        [
          {
            text:
              "🚫 Block 1 Week",
            callback_data:
              `admin_b7_${telegramId}`
          }
        ],
        [
          {
            text:
              "🔴 Permanent Block",
            callback_data:
              `admin_bp_${telegramId}`
          }
        ],
        [
          {
            text:
              "🔓 Unblock",
            callback_data:
              `admin_bu_${telegramId}`
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

/* =========================================================
   ALL USERS
========================================================= */

async function showAdminUsers(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT
        u.telegram_id,
        u.username,
        u.created_at,
        COALESCE(
          s.suspicious_count,
          0
        ) AS suspicious_count,
        s.blocked_until,
        COALESCE(
          s.permanent,
          0
        ) AS permanent
      FROM users u
      LEFT JOIN suspicious_users s
        ON s.telegram_id =
           u.telegram_id
      ORDER BY u.id DESC
      LIMIT 50
    `).all();

  const buttons = [];

  for (
    const row of
      rows.results || []
  ) {
    let icon = "👤";

    if (
      Number(row.permanent) ===
      1
    ) {
      icon = "🔴";
    } else if (
      row.blocked_until
    ) {
      icon = "⏳";
    }

    const name =
      row.username ||
      row.telegram_id;

    buttons.push([
      {
        text:
          `${icon} ${shortText(
            name,
            22
          )} | ⚠️ ${row.suspicious_count}`,
        callback_data:
          `admin_user_${row.telegram_id}`
      }
    ]);
  }

  buttons.push([
    {
      text:
        "⬅️ Admin Panel",
      callback_data:
        "admin_home"
    }
  ]);

  await editMessage(
    env,
    query,
    rows.results?.length
      ? "👥 All Users\n\n⚠️ number = Suspicious Attempts\n\nSelect a user:"
      : "👥 All Users\n\nNo users found.",
    {
      inline_keyboard:
        buttons
    }
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
    `).bind(
      telegramId
    ).first();

  if (!user) {
    await editMessage(
      env,
      query,
      "❌ User not found.",
      ADMIN_BACK
    );

    return;
  }

  const orderStats =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS orders,
        COALESCE(
          SUM(
            CAST(
              CASE
                WHEN status IN (
                  'payment_verified',
                  'processing',
                  'payout_sent',
                  'completed'
                )
                THEN gram_amount
                ELSE 0
              END AS REAL
            )
          ),
          0
        ) AS gram
      FROM orders
      WHERE telegram_id=?
    `).bind(
      telegramId
    ).first();

  const suspicious =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      WHERE telegram_id=?
      LIMIT 1
    `).bind(
      telegramId
    ).first();

  const attempts =
    Number(
      suspicious?.suspicious_count ||
      0
    );

  const blockStatus =
    suspicious
      ? getBlockStatusText(
          suspicious
        )
      : "Not blocked";

  const text =
    "👤 User Details\n\n" +
    `Username: ${user.username || "No username"}\n` +
    `Telegram ID: ${telegramId}\n` +
    `📦 Orders: ${orderStats?.orders || 0}\n` +
    `💰 Paid: ${formatNumber(orderStats?.gram || 0)} GRAM\n` +
    `⚠️ Suspicious Attempts: ${attempts}\n` +
    `🚫 Block Status: ${blockStatus}\n\n` +
    `📅 Joined: ${user.created_at}`;

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard: [
        [
          {
            text:
              "🚫 Block 1 Day",
            callback_data:
              `admin_ub1_${telegramId}`
          }
        ],
        [
          {
            text:
              "🚫 Block 3 Days",
            callback_data:
              `admin_ub3_${telegramId}`
          }
        ],
        [
          {
            text:
              "🚫 Block 1 Week",
            callback_data:
              `admin_ub7_${telegramId}`
          }
        ],
        [
          {
            text:
              "🔴 Permanent Block",
            callback_data:
              `admin_ubp_${telegramId}`
          }
        ],
        [
          {
            text:
              "🔓 Unblock",
            callback_data:
              `admin_ubu_${telegramId}`
          }
        ],
        [
          {
            text:
              "🚨 Suspicious Record",
            callback_data:
              `admin_sus_${telegramId}`
          }
        ],
        [
          {
            text:
              "⬅️ All Users",
            callback_data:
              "admin_users"
          }
        ]
      ]
    }
  );
}

/* =========================================================
   GENERIC USER BLOCK
========================================================= */

async function ensureUserBlockRecord(
  env,
  telegramId
) {
  const user =
    await env.DB.prepare(`
      SELECT username
      FROM users
      WHERE telegram_id=?
      LIMIT 1
    `).bind(
      telegramId
    ).first();

  const existing =
    await env.DB.prepare(`
      SELECT telegram_id
      FROM suspicious_users
      WHERE telegram_id=?
      LIMIT 1
    `).bind(
      telegramId
    ).first();

  if (!existing) {
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
      VALUES (?, ?, ?, 0, NULL, 0)
    `).bind(
      telegramId,
      user?.username || null,
      "Manual admin block record"
    ).run();
  }
}

async function blockUser(
  env,
  query,
  telegramId,
  duration
) {
  if (!telegramId) return;

  await ensureUserBlockRecord(
    env,
    telegramId
  );

  if (
    duration ===
    "permanent"
  ) {
    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=1,
          blocked_until=NULL,
          reason=CASE
            WHEN reason IS NULL
              OR reason=''
            THEN 'Manual admin block'
            ELSE reason
          END,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `).bind(
      telegramId
    ).run();
  } else {
    const days =
      Number(duration);

    if (
      ![1, 3, 7].includes(
        days
      )
    ) {
      return;
    }

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=0,
          blocked_until=datetime(
            'now',
            ?
          ),
          reason=CASE
            WHEN reason IS NULL
              OR reason=''
            THEN 'Manual admin block'
            ELSE reason
          END,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `).bind(
      `+${days} day`,
      telegramId
    ).run();
  }

  await notifyBlock(
    env,
    telegramId,
    duration
  );

  await editMessage(
    env,
    query,
    "✅ User block status updated.",
    {
      inline_keyboard: [
        [
          {
            text:
              "⬅️ User",
            callback_data:
              `admin_user_${telegramId}`
          }
        ],
        [
          {
            text:
              "👥 All Users",
            callback_data:
              "admin_users"
          }
        ],
        [
          {
            text:
              "🛠 Admin Panel",
            callback_data:
              "admin_home"
          }
        ]
      ]
    }
  );
}

async function unblockUser(
  env,
  query,
  telegramId
) {
  if (!telegramId) return;

  await env.DB.prepare(`
    UPDATE suspicious_users
    SET permanent=0,
        blocked_until=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE telegram_id=?
  `).bind(
    telegramId
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text:
        "✅ Your access to the PAYTON bot has been restored.",
      reply_markup: MENU
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
            text:
              "⬅️ User",
            callback_data:
              `admin_user_${telegramId}`
          }
        ],
        [
          {
            text:
              "👥 All Users",
            callback_data:
              "admin_users"
          }
        ]
      ]
    }
  );
} 
/* =========================================================
   SUSPICIOUS BLOCK
========================================================= */

async function blockSuspiciousUser(
  env,
  query,
  telegramId,
  type
) {
  if (!telegramId) return;

  await ensureUserBlockRecord(
    env,
    telegramId
  );

  if (
    type ===
    "permanent"
  ) {
    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=1,
          blocked_until=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `).bind(
      telegramId
    ).run();
  } else {
    const days =
      Number(type);

    if (
      ![1, 3, 7].includes(
        days
      )
    ) {
      return;
    }

    await env.DB.prepare(`
      UPDATE suspicious_users
      SET permanent=0,
          blocked_until=datetime(
            'now',
            ?
          ),
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `).bind(
      `+${days} day`,
      telegramId
    ).run();
  }

  await notifyBlock(
    env,
    telegramId,
    type
  );

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
              "👥 Users",
            callback_data:
              "admin_users"
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
  `).bind(
    telegramId
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text:
        "✅ Your access to the PAYTON bot has been restored.",
      reply_markup: MENU
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
            text:
              "⬅️ Suspicious User",
            callback_data:
              `admin_sus_${telegramId}`
          }
        ],
        [
          {
            text:
              "👥 Users",
            callback_data:
              "admin_users"
          }
        ]
      ]
    }
  );
}

async function notifyBlock(
  env,
  telegramId,
  duration
) {
  let message;

  if (
    duration ===
    "permanent"
  ) {
    message =
      "🚫 Due to suspicious activity, you are permanently unable to use this bot.";
  } else {
    const days =
      Number(duration);

    message =
      `🚫 Your access to the PAYTON bot has been temporarily restricted for ${days} day${
        days === 1
          ? ""
          : "s"
      }.`;
  }

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: telegramId,
      text: message
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
    `).bind(
      String(telegramId)
    ).first();

  if (!row) return null;

  if (
    Number(row.permanent) ===
    1
  ) {
    return {
      permanent: true
    };
  }

  if (
    row.blocked_until
  ) {
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
    `).bind(
      String(telegramId)
    ).run();
  }

  return null;
}

async function sendBlockedMessage(
  env,
  chatId,
  restriction
) {
  if (
    restriction.permanent
  ) {
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
        "Access will be restored automatically after the block expires.\n\n" +
        `Block expiry: ${until} UTC`
    }
  );
}

function getBlockStatusText(
  row
) {
  if (
    Number(row?.permanent) ===
    1
  ) {
    return "🔴 Permanently blocked";
  }

  if (
    row?.blocked_until
  ) {
    return (
      "⏳ Temporarily blocked until " +
      `${row.blocked_until} UTC`
    );
  }

  return "⚠️ Not blocked";
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

  const supportCount =
    await getSupportCount(env);

  const text =
    "📊 PAYTON Dashboard\n\n" +
    `👥 Users: ${stats.users}\n` +
    `📋 Orders: ${stats.orders}\n` +
    `⏳ Pending: ${stats.pending}\n` +
    `🚨 Suspicious: ${stats.suspicious}\n` +
    `🚫 Blocked: ${stats.blocked}\n` +
    `💬 Open Support: ${supportCount}\n` +
    `💰 Revenue: ${formatNumber(stats.revenue)} GRAM\n` +
    `🪙 PTN Sold: ${formatNumber(stats.ptn)} PTN`;

  await editMessage(
    env,
    query,
    text,
    await getAdminMenu(env)
  );
}

async function getSupportCount(
  env
) {
  const row =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM support_messages
      WHERE status='open'
    `).first();

  return Number(
    row?.count || 0
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
          AND blocked_until >
              datetime('now')
        )
    `).first();

  const revenue =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(
            CAST(
              gram_amount AS REAL
            )
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
    `).first();

  const ptn =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(
            CAST(
              ptn_amount AS REAL
            )
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
    const row of
      rows.results || []
  ) {
    text +=
      `#${row.id} | ${row.telegram_id}\n` +
      `GRAM: ${row.gram_amount}\n` +
      `PTN: ${row.ptn_amount}\n` +
      `Status: ${displayStatus(row.status)}\n` +
      `Date: ${row.created_at}\n\n`;
  }

  if (
    !rows.results?.length
  ) {
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
    const row of
      rows.results || []
  ) {
    text +=
      `#${row.id}\n` +
      `User: ${row.telegram_id}\n` +
      `GRAM: ${row.gram_amount}\n` +
      `PTN: ${row.ptn_amount}\n` +
      `Status: ${displayStatus(row.status)}\n\n`;
  }

  if (
    !rows.results?.length
  ) {
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

async function showAdminRevenue(
  env,
  query
) {
  const row =
    await env.DB.prepare(`
      SELECT
        COALESCE(
          SUM(
            CAST(
              gram_amount AS REAL
            )
          ),
          0
        ) AS gram,
        COALESCE(
          SUM(
            CAST(
              ptn_amount AS REAL
            )
          ),
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
    `Orders: ${row?.orders || 0}\n` +
    `GRAM received: ${formatNumber(row?.gram || 0)} GRAM\n` +
    `PTN sold: ${formatNumber(row?.ptn || 0)} PTN\n\n` +
    "Only verified/processed orders are included.";

  await editMessage(
    env,
    query,
    text,
    ADMIN_BACK
  );
}

/* =========================================================
   USER DATABASE
========================================================= */

async function upsertUser(
  env,
  user
) {
  if (!user?.id) return;

  const telegramId =
    String(user.id);

  const username =
    user.username
      ? `@${user.username}`
      : null;

  await env.DB.prepare(`
    INSERT INTO users
    (
      telegram_id,
      username,
      created_at
    )
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username=excluded.username
  `).bind(
    telegramId,
    username
  ).run();
}

/* =========================================================
   ORDER CREATION
========================================================= */

async function createInitialOrder(
  env,
  telegramId
) {
  const existing =
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
    `).bind(
      telegramId
    ).first();

  if (existing) {
    return existing;
  }

  const result =
    await env.DB.prepare(`
      INSERT INTO orders
      (
        telegram_id,
        gram_amount,
        ptn_amount,
        payment_address,
        status,
        created_at
      )
      VALUES (?, NULL, NULL, NULL, 'awaiting_amount', CURRENT_TIMESTAMP)
    `).bind(
      telegramId
    ).run();

  return await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE id=?
    LIMIT 1
  `).bind(
    result.meta.last_row_id
  ).first();
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
  `).bind(
    telegramId
  ).first();
}

/* =========================================================
   ORDER TEXT HANDLER
========================================================= */

async function handleOrderText(
  message,
  order,
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

  if (!text) return;

  if (
    order.status ===
    "awaiting_amount"
  ) {
    const gram =
      parseGramAmount(text);

    if (!gram) {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id: telegramId,
          text:
            "❌ Invalid amount.\n\nPlease enter a valid GRAM amount.\n\nExample: 1.5",
          reply_markup: BACK
        }
      );

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
    `).bind(
      gram,
      ptn,
      order.id
    ).run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: telegramId,
        text:
          "💰 Order Details\n\n" +
          `Amount: ${gram} GRAM\n` +
          `PTN: ${formatNumber(ptn)}\n\n` +
          "Please send your TON/GRAM wallet address.\n\n" +
          "This must be the wallet that will send the payment.",
        reply_markup: BACK
      }
    );

    return;
  }

  if (
    order.status ===
    "awaiting_wallet"
  ) {
    let walletAddress;

    try {
      walletAddress =
        Address.parse(
          text
        ).toString();
    } catch {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id: telegramId,
          text:
            "❌ Invalid wallet address.\n\nPlease send a valid TON/GRAM wallet address.",
          reply_markup: BACK
        }
      );

      return;
    }

    if (
      sameAddress(
        walletAddress,
        GRAM_RECEIVING_WALLET
      )
    ) {
      await flagSuspicious(
        env,
        telegramId,
        message.from?.username
          ? `@${message.from.username}`
          : null,
        "Payment sender address matches the presale receiving wallet."
      );

      await env.DB.prepare(`
        UPDATE orders
        SET payment_address=?,
            status='suspicious'
        WHERE id=?
      `).bind(
        walletAddress,
        order.id
      ).run();

      await telegram(
        env,
        "sendMessage",
        {
          chat_id: telegramId,
          text:
            "⚠️ This wallet address cannot be used for payment verification.\n\n" +
            "Please contact support if you believe this is an error.",
          reply_markup: MENU
        }
      );

      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            ADMIN_TELEGRAM_ID,
          text:
            "🚨 Suspicious Order\n\n" +
            `Order: #${order.id}\n` +
            `User: ${telegramId}\n` +
            "Reason: Payment sender address matches receiving wallet."
        }
      );

      return;
    }

    await env.DB.prepare(`
      UPDATE orders
      SET payment_address=?,
          status='pending'
      WHERE id=?
    `).bind(
      walletAddress,
      order.id
    ).run();

    const fresh =
      await env.DB.prepare(`
        SELECT *
        FROM orders
        WHERE id=?
        LIMIT 1
      `).bind(
        order.id
      ).first();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: telegramId,
        text:
          "💳 Payment Instructions\n\n" +
          `Amount: ${fresh.gram_amount} GRAM\n` +
          `PTN: ${formatNumber(fresh.ptn_amount)}\n\n` +
          `Send exactly ${fresh.gram_amount} GRAM to:\n` +
          `${GRAM_RECEIVING_WALLET}\n\n` +
          `Payment comment:\nPAYTON-${fresh.id}\n\n` +
          "After sending the payment, the system will automatically verify the transaction.",
        reply_markup: BACK
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
      query.from?.id || ""
    );

  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE telegram_id=?
      ORDER BY id DESC
      LIMIT 10
    `).bind(
      telegramId
    ).all();

  let text =
    "📋 My Orders\n\n";

  for (
    const row of
      rows.results || []
  ) {
    text +=
      `#${row.id}\n` +
      `GRAM: ${row.gram_amount || "-"}\n` +
      `PTN: ${formatNumber(row.ptn_amount || 0)}\n` +
      `Status: ${displayStatus(row.status)}\n\n`;
  }

  if (
    !rows.results?.length
  ) {
    text +=
      "You have no orders yet.";
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
   PAYMENT PROCESSING
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
        'payment_verified'
      )
      ORDER BY id ASC
      LIMIT 20
    `).all();

  for (
    const order of
      rows.results || []
  ) {
    try {
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

        const alreadyUsed =
          await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE transaction_hash=?
              AND id!=?
            LIMIT 1
          `).bind(
            payment.hash,
            order.id
          ).first();

        if (alreadyUsed) {
          await flagSuspicious(
            env,
            order.telegram_id,
            null,
            "The same blockchain transaction was submitted for another order."
          );

          await env.DB.prepare(`
            UPDATE orders
            SET status='suspicious'
            WHERE id=?
          `).bind(
            order.id
          ).run();

          await telegram(
            env,
            "sendMessage",
            {
              chat_id:
                order.telegram_id,
              text:
                "⚠️ This payment transaction has already been used for another order.\n\n" +
                "Your order has been placed under review."
            }
          );

          await telegram(
            env,
            "sendMessage",
            {
              chat_id:
                ADMIN_TELEGRAM_ID,
              text:
                "🚨 Duplicate Payment Detected\n\n" +
                `Order: #${order.id}\n` +
                `User: ${order.telegram_id}\n` +
                `Transaction: ${payment.hash}`
            }
          );

          continue;
        }

        await env.DB.prepare(`
          UPDATE orders
          SET transaction_hash=?,
              status='payment_verified'
          WHERE id=?
        `).bind(
          payment.hash,
          order.id
        ).run();

        await telegram(
          env,
          "sendMessage",
          {
            chat_id:
              order.telegram_id,
            text:
              "✅ Payment verified successfully.\n\n" +
              `${formatNumber(order.ptn_amount)} PTN tokens are now being sent automatically.`
          }
        );
      }

      const freshOrder =
        await env.DB.prepare(`
          SELECT *
          FROM orders
          WHERE id=?
          LIMIT 1
        `).bind(
          order.id
        ).first();

      if (
        freshOrder?.status ===
        "payment_verified"
      ) {
        const payout =
          await sendPTN(
            env,
            freshOrder
          );

        if (
          payout?.success
        ) {
          await env.DB.prepare(`
            UPDATE orders
            SET status='payout_sent'
            WHERE id=?
              AND status='payment_verified'
          `).bind(
            order.id
          ).run();

          await telegram(
            env,
            "sendMessage",
            {
              chat_id:
                order.telegram_id,
              text:
                "✅ Order completed successfully.\n\n" +
                `${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.\n\n` +
                `Transaction:\n${
                  payout.hash ||
                  "Submitted to blockchain"
                }`,
              reply_markup:
                MENU
            }
          );
        } else if (
          payout?.pending
        ) {
          await telegram(
            env,
            "sendMessage",
            {
              chat_id:
                order.telegram_id,
              text:
                "⏳ Your payment has been verified and your PTN transfer has been submitted.\n\n" +
                "The blockchain confirmation is still pending. The system will continue checking automatically."
            }
          );
        }
      }
    } catch (error) {
      console.error(
        `ORDER ${order.id} ERROR:`,
        error
      );
    }
  }
}

/* =========================================================
   FIND PAYMENT
========================================================= */

async function findPayment(
  env,
  order
) {
  if (
    !order.payment_address ||
    !order.gram_amount
  ) {
    return null;
  }

  try {
    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });

    const sender =
      Address.parse(
        String(
          order.payment_address
        ).trim()
      );

    const receiver =
      Address.parse(
        GRAM_RECEIVING_WALLET
      );

    const expectedNano =
      BigInt(
        gramToNano(
          order.gram_amount
        )
      );

    const createdUtime =
      getOrderCreatedUtime(
        order.created_at
      );

    let lt = undefined;

    for (
      let page = 0;
      page < 10;
      page++
    ) {
      const options = {
        limit: 100
      };

      if (lt) {
        options.lt = lt;
      }

      const transactions =
        await client.getTransactions(
          receiver,
          options
        );

      if (
        !transactions.length
      ) {
        break;
      }

      for (
        const tx of
          transactions
      ) {
        if (
          tx.now &&
          createdUtime &&
          tx.now <
            createdUtime
        ) {
          continue;
        }

        if (
          tx.description?.type ===
            "generic" &&
          tx.description?.compute_ph?.exit_code !==
            undefined &&
          tx.description?.compute_ph?.exit_code !==
            0
        ) {
          continue;
        }

        const inMsg =
          tx.inMessage;

        if (!inMsg) continue;

        let source;
        let destination;
        let value;

        try {
          source =
            inMsg.info?.src;

          destination =
            inMsg.info?.dest;

          value =
            inMsg.info?.value?.coins;
        } catch {
          continue;
        }

        if (
          !source ||
          !destination
        ) {
          continue;
        }

        if (
          !source.equals(sender)
        ) {
          continue;
        }

        if (
          !destination.equals(
            receiver
          )
        ) {
          continue;
        }

        if (
          BigInt(
            value || 0
          ) !== expectedNano
        ) {
          continue;
        }

        const hash =
          tx.hash()
            .toString(
              "base64url"
            );

        const used =
          await env.DB.prepare(`
            SELECT id
            FROM orders
            WHERE transaction_hash=?
            LIMIT 1
          `).bind(
            hash
          ).first();

        if (used) {
          continue;
        }

        let comment = "";

        try {
          const body =
            inMsg.body;

          if (body) {
            const boc =
              body.toBoc()
                .toString(
                  "base64"
                );

            comment =
              decodeComment(
                boc
              );
          }
        } catch {
          comment = "";
        }

        const expectedComment =
          `PAYTON-${order.id}`;

        if (
          comment !==
          expectedComment
        ) {
          continue;
        }

        return {
          hash,
          utime:
            tx.now || null
        };
      }

      const last =
        transactions[
          transactions.length - 1
        ];

      if (
        !last ||
        !last.lt
      ) {
        break;
      }

      lt =
        String(last.lt);
    }
  } catch (error) {
    console.error(
      "PAYMENT SEARCH ERROR:",
      error
    );
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
  try {
    const mnemonic =
      env.PTN_MNEMONIC;

    if (!mnemonic) {
      throw new Error(
        "PTN_MNEMONIC missing"
      );
    }

    if (
      !env.TONCENTER_API_KEY
    ) {
      throw new Error(
        "TONCENTER_API_KEY missing"
      );
    }

    const words =
      mnemonic
        .trim()
        .split(/\s+/);

    const keyPair =
      await mnemonicToPrivateKey(
        words
      );

    /*
      PAYTON sender is V5R1.
      networkGlobalId -239 =
      TON mainnet.
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

    const configuredSender =
      Address.parse(
        PTN_SENDER_WALLET
      );

    if (
      !senderWallet.address.equals(
        configuredSender
      )
    ) {
      throw new Error(
        "Derived sender wallet does not match configured PTN sender wallet"
      );
    }

    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });

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
        "Insufficient native GRAM balance for payout"
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

    const senderJettonAddress =
      await master.getWalletAddress(
        senderWallet.address
      );

    const senderJettonWallet =
      client.open(
        senderJettonAddress
      );

    const senderJettonBalance =
      await senderJettonWallet.getJettonBalance();

    const ptnAmount =
      BigInt(
        String(
          order.ptn_amount
        )
      );

    const amount =
      ptnAmount *
      10n **
        BigInt(
          PTN_DECIMALS
        );

    if (
      senderJettonBalance <
      amount
    ) {
      throw new Error(
        "Insufficient PTN balance"
      );
    }

    /*
      Idempotency:
      query_id = order.id
    */

    const existing =
      await findExistingPayout(
        client,
        senderWallet.address,
        BigInt(
          order.id
        )
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

    /*
      The previous code returned a fake hash here.
      We do not present a fake blockchain hash as real.

      The payout is submitted and the order will be
      checked again by findExistingPayout().
    */

    return {
      success: true,
      hash: null
    };
  } catch (error) {
    console.error(
      `PTN PAYOUT ERROR ORDER ${order.id}:`,
      error
    );

    /*
      Keep payment_verified so Cron
      can retry payout.
    */

    await env.DB.prepare(`
      UPDATE orders
      SET status='payment_verified'
      WHERE id=?
        AND status='payment_verified'
    `).bind(
      order.id
    ).run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          order.telegram_id,
        text:
          "⚠️ Your payment has been verified, but the PTN transfer could not be completed yet.\n\n" +
          "Your payment is safe and the system will retry the PTN transfer automatically."
      }
    );

    return {
      success: false,
      error:
        String(error)
    };
  }
}

/* =========================================================
   PAYOUT IDEMPOTENCY
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

    for (
      const tx of
        transactions
    ) {
      const inMsg =
        tx.inMessage;

      if (!inMsg) continue;

      const body =
        inMsg.body;

      if (!body) continue;

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
          slice.loadUint(
            32
          );

        if (
          opcode !==
          0x0f8a7ea5
        ) {
          continue;
        }

        const id =
          slice.loadUintBig(
            64
          );

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
  `).bind(
    ADMIN_TELEGRAM_ID,
    mode,
    targetId
  ).run();
}

async function getAdminState(
  env
) {
  return await env.DB.prepare(`
    SELECT *
    FROM admin_states
    WHERE telegram_id=?
    LIMIT 1
  `).bind(
    ADMIN_TELEGRAM_ID
  ).first();
}

async function clearAdminState(
  env
) {
  await env.DB.prepare(`
    DELETE FROM admin_states
    WHERE telegram_id=?
  `).bind(
    ADMIN_TELEGRAM_ID
  ).run();
}

/* =========================================================
   HELPERS
========================================================= */

function parseGramAmount(
  value
) {
  const input =
    String(value)
      .trim()
      .replace(",", ".");

  /*
    Fixed:
    Previous regex used "." instead of "\."
  */

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

function gramToPtn(
  gram
) {
  const [
    whole,
    decimal = ""
  ] =
    String(gram)
      .split(".");

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

function gramToNano(
  gram
) {
  const [
    whole,
    decimal = ""
  ] =
    String(gram)
      .split(".");

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

function formatNumber(
  value
) {
  const [
    whole,
    decimal
  ] =
    String(value)
      .split(".");

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

/*
  Convert a SQL CURRENT_TIMESTAMP value
  into Unix seconds.
*/

function getOrderCreatedUtime(
  value
) {
  if (!value) {
    return null;
  }

  const normalized =
    String(value)
      .replace(" ", "T");

  const time =
    Date.parse(
      normalized +
        (normalized.endsWith("Z")
          ? ""
          : "Z")
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

function parseSqlUtc(
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
      ) + "Z";

  const time =
    Date.parse(
      normalized
    );

  return Number.isNaN(time)
    ? null
    : time;
}

function formatUtcDate(
  value
) {
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
   COMMENT DECODER
=========================================================

   Standard TON text comment:

   32-bit opcode = 0
   followed by UTF-8 text.

   The important change is that findPayment()
   now passes message_content.body into this function.
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
      slice.loadUint(
        32
      );

    /*
      Text comment opcode.
    */

    if (
      opcode !== 0
    ) {
      return "";
    }

    const bytes = [];

    while (
      slice.remainingBits >=
      8
    ) {
      bytes.push(
        slice.loadUint(
          8
        )
      );
    }

    return new TextDecoder()
      .decode(
        new Uint8Array(
          bytes
        )
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
