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
import { mnemonicToPrivateKey } from "@ton/crypto";

globalThis.Buffer = Buffer;

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

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const GRAM_RECEIVING_WALLET =
  "UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";

const PTN_DECIMALS = 9;
const PTN_PER_GRAM = 1000000n;
const MIN_SENDER_TON_BALANCE = toNano("0.20");

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
      [{ text: "📊 Dashboard", callback_data: "admin_dashboard" }],
      [
        { text: "📋 All Orders", callback_data: "admin_orders" },
        { text: "⏳ Pending", callback_data: "admin_pending" }
      ],
      [
        { text: "👥 Users", callback_data: "admin_users" },
        {
          text: `💬 Support${supportCount > 0 ? ` (${supportCount})` : ""}`,
          callback_data: "admin_support"
        }
      ],
      [
        { text: "🚨 Suspicious", callback_data: "admin_suspicious" },
        { text: "💰 Revenue", callback_data: "admin_revenue" }
      ],
      [{ text: "⚡ Reply Templates", callback_data: "admin_templates" }],
      [{ text: "🔄 Refresh", callback_data: "admin_dashboard" }]
    ]
  };
}

async function handleUpdate(update, env, ctx) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (!update.message) return;

  const message = update.message;
  const chatId = String(message.chat?.id || "");
  const text = String(message.text || "").trim();

  if (!chatId) return;

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

    if (handled) return;
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
    const supportHandled = await handleSupportMessage(message, env);

    if (supportHandled) return;
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

async function handleCallback(query, env) {
  const data = String(query.data || "");
  const chatId = String(query.message?.chat?.id || "");

  if (!chatId) return;

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

  const restriction = await getUserRestriction(env, chatId);

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
    await editMessage(env, query, WELCOME, MENU);
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
      "💬 Support\n\nPlease send your message now.\n\nOur support team will review your message and reply to you.",
      BACK
    );

    return;
  }
}

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
    const telegramId = data.replace("admin_user_", "");

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
    const id = Number(
      data.replace("admin_ticket_", "")
    );

    if (Number.isInteger(id) && id > 0) {
      await showSupportTicket(env, query, id);
    }

    return;
  }

  if (data.startsWith("admin_reply_")) {
    const id = Number(
      data.replace("admin_reply_", "")
    );

    if (Number.isInteger(id) && id > 0) {
      await setAdminState(env, "reply", String(id));

      await editMessage(
        env,
        query,
        "✍️ Manual Reply\n\nSend the message you want to send to this user.\n\nSend /cancel to cancel.",
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
    const telegramId = data.replace(
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

async function telegram(env, method, body) {
  const token = env.BOT_TOKEN;

  if (!token) {
    console.error("BOT_TOKEN missing");
    return null;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
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
  const message = query.message;

  if (!message) return;

  await telegram(env, "editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text,
    reply_markup: replyMarkup
  });
}

async function upsertUser(env, user) {
  if (!user?.id) return;

  await env.DB.prepare(`
    INSERT INTO users (
      telegram_id,
      username
    )
    VALUES (?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET username=excluded.username
  `).bind(
    String(user.id),
    user.username || null
  ).run();
}

async function createInitialOrder(env, telegramId) {
  await env.DB.prepare(`
    DELETE FROM orders
    WHERE telegram_id=?
      AND status='awaiting_amount'
  `).bind(
    String(telegramId)
  ).run();

  await env.DB.prepare(`
    INSERT INTO orders (
      telegram_id,
      gram_amount,
      ptn_amount,
      payment_address,
      status
    )
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    String(telegramId),
    "0",
    "0",
    null,
    "awaiting_amount"
  ).run();
}

async function getPendingOrder(env, telegramId) {
  return await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE telegram_id=?
      AND status IN (
        'awaiting_amount',
        'pending',
        'payment_verified'
      )
    ORDER BY id DESC
    LIMIT 1
  `).bind(
    String(telegramId)
  ).first();
}

async function handleOrderText(
  message,
  order,
  env
) {
  const chatId = String(
    message.chat.id
  );

  const text = String(
    message.text || ""
  ).trim();

  if (!text) return;

  if (text === "/cancel") {
    await env.DB.prepare(`
      UPDATE orders
      SET status='cancelled'
      WHERE id=?
    `).bind(
      order.id
    ).run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text: "Order cancelled.",
        reply_markup: MENU
      }
    );

    return;
  }

  if (order.status !== "awaiting_amount") {
    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "Your current order is already being processed.\n\n" +
          "Please wait for payment verification.",
        reply_markup: MENU
      }
    );

    return;
  }

  const gramAmount =
    parseGramAmount(text);

  if (!gramAmount) {
    await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text:
          "❌ Invalid amount.\n\n" +
          "Please enter a valid GRAM amount.\n\n" +
          "Example: 1.5",
        reply_markup: BACK
      }
    );

    return;
  }

  const ptnAmount =
    gramToPtn(gramAmount);

  await env.DB.prepare(`
    UPDATE orders
    SET gram_amount=?,
        ptn_amount=?,
        payment_address=?,
        status='pending'
    WHERE id=?
  `).bind(
    gramAmount,
    ptnAmount,
    GRAM_RECEIVING_WALLET,
    order.id
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text:
        "🧾 Order Created\n\n" +
        `Order #${order.id}\n` +
        `Amount: ${formatNumber(gramAmount)} GRAM\n` +
        `PTN: ${formatNumber(ptnAmount)}\n\n` +
        `Send exactly ${formatNumber(gramAmount)} GRAM to:\n` +
        `${GRAM_RECEIVING_WALLET}\n\n` +
        "After sending the payment, please wait while the blockchain transaction is verified automatically.\n\n" +
        "⚠️ Do not send the payment more than once.",
      reply_markup: BACK
    }
  );
}

function parseGramAmount(value) {
  const text = String(value || "").trim();

  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) {
    return null;
  }

  try {
    const valueNano =
      BigInt(gramToNano(text));

    if (valueNano <= 0n) {
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

function gramToNano(gramAmount) {
  const text = String(gramAmount);

  const parts = text.split(".");
  const whole = parts[0] || "0";
  const fraction = (parts[1] || "")
    .padEnd(9, "0")
    .slice(0, 9);

  return (
    BigInt(whole) * 1000000000n +
    BigInt(fraction || "0")
  ).toString();
}

function gramToPtn(gramAmount) {
  const nano =
    BigInt(gramToNano(gramAmount));

  const ptn =
    nano * PTN_PER_GRAM /
    1000000000n;

  return ptn.toString();
}

function formatNumber(value) {
  const text = String(value ?? "");

  if (!text) return "0";

  if (text.includes(".")) {
    const [whole, fraction] =
      text.split(".");

    return (
      Number(whole).toLocaleString(
        "en-US"
      ) +
      "." +
      fraction
    );
  }

  try {
    return BigInt(text).toLocaleString(
      "en-US"
    );
  } catch {
    return text;
  }
}

function sameAddress(a, b) {
  try {
    return Address.parse(
      String(a)
    ).equals(
      Address.parse(
        String(b)
      )
    );
  } catch {
    return String(a) === String(b);
  }
}

function getOrderCreatedUtime(
  createdAt
) {
  if (!createdAt) return null;

  const date =
    parseSqlUtc(createdAt);

  if (!date) return null;

  return Math.floor(
    date.getTime() / 1000
  );
}

function parseSqlUtc(value) {
  if (!value) return null;

  const text =
    String(value).trim();

  const normalized =
    text.includes("T")
      ? text
      : text.replace(
          " ",
          "T"
        );

  const withUtc =
    normalized.endsWith("Z")
      ? normalized
      : normalized + "Z";

  const date =
    new Date(withUtc);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date;
}

function formatUtcDate(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toISOString();
}

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

  if (
    orderCreatedUtime === null
  ) {
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
    Math.floor(
      Date.now() / 1000
    ) + 60;

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
              "X-API-Key":
                apiKey
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
      Array.isArray(
        data?.messages
      )
        ? data.messages
        : [];

    if (!messages.length) {
      return null;
    }

    for (
      const message of messages
    ) {
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
        actualValue !==
        expectedAmount
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

      const messageUtime =
        Number(
          message?.created_at ||
          0
        );

      if (
        messageUtime &&
        messageUtime <
          startUtime
      ) {
        continue;
      }

      const existing =
        await env.DB.prepare(`
          SELECT id
          FROM orders
          WHERE transaction_hash=?
          LIMIT 1
        `).bind(
          hash
        ).first();

      if (existing) {
        return {
          hash,
          duplicate: true
        };
      }

      console.log(
        `PAYMENT FOUND ORDER ${order.id}: ${hash}`
      );

      return {
        hash
      };
    }

    if (
      messages.length <
      pageSize
    ) {
      return null;
    }

    offset +=
      messages.length;
  }
}

async function processOrders(env) {
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
          const user =
            await env.DB.prepare(`
              SELECT username
              FROM users
              WHERE telegram_id=?
              LIMIT 1
            `).bind(
              order.telegram_id
            ).first();

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
              `Order #${order.id}\n` +
              `GRAM received: ${formatNumber(order.gram_amount)}\n` +
              `PTN amount: ${formatNumber(order.ptn_amount)}\n\n` +
              "Your PTN tokens are now being sent automatically."
          }
        );
      }

      if (
        order.status ===
        "payment_verified"
      ) {
        const freshOrder =
          await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE id=?
            LIMIT 1
          `).bind(
            order.id
          ).first();

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
                "🎉 Order completed successfully!\n\n" +
                `Order #${order.id}\n` +
                `${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.\n\n` +
                `Transaction:\n${
                  payout.hash ||
                  "Submitted to blockchain"
                }`
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

async function sendPTN(
  env,
  order
) {
  try {
    const existing =
      await findExistingPayout(
        env,
        order
      );

    if (existing) {
      return {
        success: true,
        hash: existing
      };
    }

    const mnemonic =
      env.PTN_MNEMONIC;

    if (!mnemonic) {
      console.error(
        "PTN_MNEMONIC missing"
      );

      return {
        success: false
      };
    }

    const client =
      new TonClient({
        endpoint:
          "https://toncenter.com/api/v2/jsonRPC",
        apiKey:
          env.TONCENTER_API_KEY
      });

    const keyPair =
      await mnemonicToPrivateKey(
        mnemonic
          .trim()
          .split(/\s+/)
      );

    const wallet =
      WalletContractV5R1.create({
        workchain: 0,
        publicKey:
          keyPair.publicKey
      });

    const contract =
      client.open(wallet);

    const balance =
      await contract.getBalance();

    if (
      balance <
      MIN_SENDER_TON_BALANCE
    ) {
      console.error(
        "PTN sender wallet does not have enough TON for gas."
      );

      return {
        success: false
      };
    }

    const jettonMaster =
      client.open(
        JettonMaster.create(
          Address.parse(
            PTN_MASTER
          )
        )
      );

    const senderAddress =
      wallet.address;

    const senderJettonWallet =
      await jettonMaster.getWalletAddress(
        senderAddress
      );

    const destination =
      await getBuyerWallet(
        env,
        order.telegram_id
      );

    if (!destination) {
      console.error(
        `NO BUYER WALLET FOR ORDER ${order.id}`
      );

      return {
        success: false
      };
    }

    const jettonWallet =
      client.open(
        JettonWallet.create(
          Address.parse(
            senderJettonWallet
          )
        )
      );

    const seqno =
      await contract.getSeqno();

    const queryId =
      BigInt(order.id);

    const amount =
      BigInt(order.ptn_amount) *
      10n ** BigInt(
        PTN_DECIMALS
      );

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
          amount
        )
        .storeAddress(
          Address.parse(
            destination
          )
        )
        .storeAddress(
          Address.parse(
            senderAddress
          )
        )
        .storeBit(
          0
        )
        .storeCoins(
          toNano("0.05")
        )
        .storeBit(
          0
        )
        .endCell();

    await contract.sendTransfer({
      seqno,
      secretKey:
        keyPair.secretKey,
      messages: [
        internal({
          to:
            senderJettonWallet,
          value:
            toNano("0.08"),
          body,
          bounce:
            true
        })
      ],
      sendMode:
        SendMode.PAY_GAS_SEPARATELY |
        SendMode.IGNORE_ERRORS
    });

    return {
      success: true,
      hash: null
    };
  } catch (error) {
    console.error(
      `PTN SEND ERROR ORDER ${order.id}:`,
      error
    );

    return {
      success: false
    };
  }
}

async function findExistingPayout(
  env,
  order
) {
  try {
    const apiKey =
      env.TONCENTER_API_KEY;

    if (!apiKey) return null;

    const url =
      "https://toncenter.com/api/v3/transactions?" +
      new URLSearchParams({
        account:
          PTN_SENDER_WALLET,
        limit:
          "20",
        sort:
          "desc"
      }).toString();

    const response =
      await fetch(
        url,
        {
          headers: {
            "X-API-Key":
              apiKey
          }
        }
      );

    if (!response.ok) {
      return null;
    }

    const data =
      await response.json();

    const transactions =
      Array.isArray(
        data?.transactions
      )
        ? data.transactions
        : [];

    const queryId =
      String(order.id);

    for (
      const tx of
        transactions
    ) {
      const txText =
        JSON.stringify(tx);

      if (
        txText.includes(
          queryId
        )
      ) {
        return (
          tx?.hash ||
          tx?.transaction_hash ||
          null
        );
      }
    }

    return null;
  } catch (error) {
    console.error(
      "EXISTING PAYOUT CHECK ERROR:",
      error
    );

    return null;
  }
}

async function getBuyerWallet(
  env,
  telegramId
) {
  const row =
    await env.DB.prepare(`
      SELECT payment_address
      FROM orders
      WHERE telegram_id=?
        AND payment_address IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `).bind(
      String(telegramId)
    ).first();

  return row?.payment_address || null;
}

async function showUserOrders(
  env,
  query
) {
  const telegramId =
    String(
      query.from?.id ||
      query.message?.chat?.id ||
      ""
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

  const orders =
    rows.results || [];

  if (!orders.length) {
    await editMessage(
      env,
      query,
      "📋 My Orders\n\nYou do not have any orders yet.",
      BACK
    );

    return;
  }

  let text =
    "📋 My Orders\n\n";

  for (
    const order of orders
  ) {
    text +=
      `#${order.id} — ${formatNumber(order.gram_amount)} GRAM\n` +
      `PTN: ${formatNumber(order.ptn_amount)}\n` +
      `Status: ${formatStatus(order.status)}\n\n`;
  }

  await editMessage(
    env,
    query,
    text,
    BACK
  );
}

function formatStatus(status) {
  const map = {
    awaiting_amount:
      "Waiting for amount",
    pending:
      "Waiting for payment",
    payment_verified:
      "Payment verified",
    payout_sent:
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

async function createSupportRequest(
  env,
  user
) {
  await env.DB.prepare(`
    INSERT INTO support_messages (
      telegram_id,
      username,
      message,
      status
    )
    VALUES (?, ?, ?, ?)
  `).bind(
    String(user.id),
    user.username || null,
    "Waiting for user message.",
    "awaiting_message"
  ).run();
}

async function handleSupportMessage(
  message,
  env
) {
  const telegramId =
    String(
      message.chat?.id ||
      ""
    );

  const text =
    String(
      message.text ||
      ""
    ).trim();

  if (
    !telegramId ||
    !text
  ) {
    return false;
  }

  const state =
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

  if (!state) {
    return false;
  }

  if (text === "/cancel") {
    await env.DB.prepare(`
      UPDATE support_messages
      SET status='replied'
      WHERE id=?
    `).bind(
      state.id
    ).run();

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          telegramId,
        text:
          "Support request cancelled.",
        reply_markup:
          MENU
      }
    );

    return true;
  }

  await env.DB.prepare(`
    UPDATE support_messages
    SET message=?,
        status='open'
    WHERE id=?
  `).bind(
    text,
    state.id
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        telegramId,
      text:
        "📩 Your message has been received. Support will respond shortly.",
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
        `Ticket #${state.id}\n` +
        `User: ${telegramId}\n\n` +
        text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "✍️ Reply",
              callback_data:
                `admin_reply_${state.id}`
            }
          ],
          [
            {
              text:
                "⚡ Quick Replies",
              callback_data:
                `admin_quick_${state.id}_0`
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
      LIMIT 50
    `).all();

  const tickets =
    rows.results || [];

  if (!tickets.length) {
    await editMessage(
      env,
      query,
      "💬 Support\n\nNo open support messages.",
      ADMIN_BACK
    );

    return;
  }

  const keyboard = [];

  for (
    const ticket of tickets
  ) {
    keyboard.push([
      {
        text:
          `#${ticket.id} — ${ticket.username ? "@" + ticket.username : ticket.telegram_id}`,
        callback_data:
          `admin_ticket_${ticket.id}`
      }
    ]);
  }

  keyboard.push([
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
    `💬 Support\n\nOpen tickets: ${tickets.length}`,
    {
      inline_keyboard:
        keyboard
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
      "Ticket not found.",
      ADMIN_BACK
    );

    return;
  }

  const text =
    "💬 Support Ticket\n\n" +
    `Ticket: #${ticket.id}\n` +
    `User: ${ticket.telegram_id}\n` +
    `Username: ${ticket.username ? "@" + ticket.username : "Not available"}\n` +
    `Status: ${ticket.status}\n\n` +
    "Message:\n" +
    ticket.message;

  await editMessage(
    env,
    query,
    text,
    {
      inline_keyboard: [
        [
          {
            text:
              "✍️ Manual Reply",
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
              "⬅️ Support",
            callback_data:
              "admin_support"
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
  page
) {
  const perPage = 5;

  const start =
    page * perPage;

  const end =
    Math.min(
      start + perPage,
      QUICK_REPLIES.length
    );

  const keyboard = [];

  for (
    let i = start;
    i < end;
    i++
  ) {
    keyboard.push([
      {
        text:
          QUICK_REPLIES[i],
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
    end <
    QUICK_REPLIES.length
  ) {
    navigation.push({
      text:
        "Next ➡️",
      callback_data:
        `admin_quick_${ticketId}_${page + 1}`
    });
  }

  if (navigation.length) {
    keyboard.push(
      navigation
    );
  }

  keyboard.push([
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
    "⚡ Quick Replies",
    {
      inline_keyboard:
        keyboard
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

  if (!ticket) return;

  const reply =
    QUICK_REPLIES[index];

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        ticket.telegram_id,
      text:
        reply
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
    "✅ Quick reply sent.",
    ADMIN_BACK
  );
}

async function setAdminState(
  env,
  mode,
  targetId
) {
  await env.DB.prepare(`
    INSERT INTO admin_states (
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

async function getAdminState(env) {
  return await env.DB.prepare(`
    SELECT *
    FROM admin_states
    WHERE telegram_id=?
    LIMIT 1
  `).bind(
    ADMIN_TELEGRAM_ID
  ).first();
}

async function clearAdminState(env) {
  await env.DB.prepare(`
    DELETE FROM admin_states
    WHERE telegram_id=?
  `).bind(
    ADMIN_TELEGRAM_ID
  ).run();
}

async function handleAdminText(
  message,
  env
) {
  const text =
    String(
      message.text ||
      ""
    ).trim();

  if (!text) {
    return false;
  }

  if (
    text === "/cancel"
  ) {
    await clearAdminState(env);

    await telegram(
      env,
      "sendMessage",
      {
        chat_id:
          ADMIN_TELEGRAM_ID,
        text:
          "Cancelled.",
        reply_markup:
          await getAdminMenu(env)
      }
    );

    return true;
  }

  const state =
    await getAdminState(env);

  if (!state) {
    return false;
  }

  if (
    state.mode ===
    "reply"
  ) {
    const ticketId =
      Number(
        state.target_id
      );

    if (
      !Number.isInteger(
        ticketId
      )
    ) {
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
            "Ticket not found.",
          reply_markup:
            await getAdminMenu(env)
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
        text
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
          "✅ Reply sent.",
        reply_markup:
          await getAdminMenu(env)
      }
    );

    return true;
  }

  return false;
}

async function showAdminDashboard(
  env,
  query
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

  const completed =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status='payout_sent'
    `).first();

  const pending =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status IN (
        'pending',
        'payment_verified'
      )
    `).first();

  const revenue =
    await env.DB.prepare(`
      SELECT COALESCE(
        SUM(
          CAST(
            gram_amount AS REAL
          )
        ),
        0
      ) AS total
      FROM orders
      WHERE status='payout_sent'
    `).first();

  const text =
    "📊 PAYTON Dashboard\n\n" +
    `👥 Users: ${Number(users?.count || 0)}\n` +
    `📋 Orders: ${Number(orders?.count || 0)}\n` +
    `⏳ Pending: ${Number(pending?.count || 0)}\n` +
    `✅ Completed: ${Number(completed?.count || 0)}\n` +
    `💰 Revenue: ${Number(revenue?.total || 0).toLocaleString("en-US")} GRAM`;

  await editMessage(
    env,
    query,
    text,
    ADMIN_BACK
  );
}

async function showAdminOrders(
  env,
  query
) {
  const rows =
    await env.DB.prepare(`
      SELECT *
      FROM orders
      ORDER BY id DESC
      LIMIT 50
    `).all();

  const orders =
    rows.results || [];

  if (!orders.length) {
    await editMessage(
      env,
      query,
      "📋 All Orders\n\nNo orders found.",
      ADMIN_BACK
    );

    return;
  }

  let text =
    "📋 All Orders\n\n";

  for (
    const order of orders
  ) {
    text +=
      `#${order.id} | ${order.telegram_id}\n` +
      `${formatNumber(order.gram_amount)} GRAM → ${formatNumber(order.ptn_amount)} PTN\n` +
      `Status: ${formatStatus(order.status)}\n\n`;
  }

  await editMessage(
    env,
    query,
    text,
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
        'payment_verified'
      )
      ORDER BY id ASC
      LIMIT 50
    `).all();

  const orders =
    rows.results || [];

  if (!orders.length) {
    await editMessage(
      env,
      query,
      "⏳ Pending Orders\n\nNo pending orders.",
      ADMIN_BACK
    );

    return;
  }

  let text =
    "⏳ Pending Orders\n\n";

  for (
    const order of orders
  ) {
    text +=
      `#${order.id}\n` +
      `User: ${order.telegram_id}\n` +
      `Amount: ${formatNumber(order.gram_amount)} GRAM\n` +
      `Status: ${formatStatus(order.status)}\n\n`;
  }

  await editMessage(
    env,
    query,
    text,
    ADMIN_BACK
  );
}

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
        ) AS suspicious_count
      FROM users u
      LEFT JOIN suspicious_users s
        ON s.telegram_id=u.telegram_id
      ORDER BY u.id DESC
      LIMIT 50
    `).all();

  const users =
    rows.results || [];

  if (!users.length) {
    await editMessage(
      env,
      query,
      "👥 Users\n\nNo users found.",
      ADMIN_BACK
    );

    return;
  }

  const keyboard = [];

  for (
    const user of users
  ) {
    const label =
      user.username
        ? `@${user.username}`
        : user.telegram_id;

    const suspicious =
      Number(
        user.suspicious_count ||
        0
      );

    keyboard.push([
      {
        text:
          `${label}${suspicious > 0 ? ` 🚨${suspicious}` : ""}`,
        callback_data:
          `admin_user_${user.telegram_id}`
      }
    ]);
  }

  keyboard.push([
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
    `👥 Users\n\nTotal shown: ${users.length}`,
    {
      inline_keyboard:
        keyboard
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
      "User not found.",
      ADMIN_BACK
    );

    return;
  }

  const suspicious =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      WHERE telegram_id=?
      LIMIT 1
    `).bind(
      telegramId
    ).first();

  const orders =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE telegram_id=?
    `).bind(
      telegramId
    ).first();

  const text =
    "👤 User\n\n" +
    `Telegram ID: ${telegramId}\n` +
    `Username: ${user.username ? "@" + user.username : "Not available"}\n` +
    `Orders: ${Number(orders?.count || 0)}\n` +
    `Suspicious attempts: ${Number(suspicious?.suspicious_count || 0)}\n` +
    `Permanent block: ${Number(suspicious?.permanent || 0) ? "Yes" : "No"}\n` +
    `Blocked until: ${suspicious?.blocked_until || "No"}\n`;

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
              "🚫 Permanent",
            callback_data:
              `admin_ubp_${telegramId}`
          }
        ],
        [
          {
            text:
              "✅ Unblock",
            callback_data:
              `admin_ubu_${telegramId}`
          }
        ],
        [
          {
            text:
              "⬅️ Users",
            callback_data:
              "admin_users"
          }
        ]
      ]
    }
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
      WHERE status='payout_sent'
    `).first();

  const text =
    "💰 Revenue\n\n" +
    `GRAM: ${Number(row?.gram || 0).toLocaleString("en-US")}\n` +
    `PTN: ${Number(row?.ptn || 0).toLocaleString("en-US")}\n` +
    `Completed Orders: ${Number(row?.orders || 0)}`;

  await editMessage(
    env,
    query,
    text,
    ADMIN_BACK
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
    text,
    ADMIN_BACK
  );
}

async function flagSuspicious(
  env,
  telegramId,
  username,
  reason
) {
  await env.DB.prepare(`
    INSERT INTO suspicious_users (
      telegram_id,
      username,
      reason,
      suspicious_count,
      updated_at
    )
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username=excluded.username,
      reason=excluded.reason,
      suspicious_count=suspicious_users.suspicious_count+1,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    String(telegramId),
    username || null,
    reason || null
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
      WHERE suspicious_count > 0
      ORDER BY suspicious_count DESC,
               updated_at DESC
      LIMIT 50
    `).all();

  const users =
    rows.results || [];

  if (!users.length) {
    await editMessage(
      env,
      query,
      "🚨 Suspicious Users\n\nNo suspicious users found.",
      ADMIN_BACK
    );

    return;
  }

  const keyboard = [];

  for (
    const user of users
  ) {
    keyboard.push([
      {
        text:
          `${user.username ? "@" + user.username : user.telegram_id} — Attempts: ${Number(user.suspicious_count || 0)}`,
        callback_data:
          `admin_sus_${user.telegram_id}`
      }
    ]);
  }

  keyboard.push([
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
    `🚨 Suspicious Users\n\nUsers shown: ${users.length}`,
    {
      inline_keyboard:
        keyboard
    }
  );
}

async function showSuspiciousUser(
  env,
  query,
  telegramId
) {
  const user =
    await env.DB.prepare(`
      SELECT *
      FROM suspicious_users
      WHERE telegram_id=?
      LIMIT 1
    `).bind(
      telegramId
    ).first();

  if (!user) {
    await editMessage(
      env,
      query,
      "Suspicious user not found.",
      ADMIN_BACK
    );

    return;
  }

  const text =
    "🚨 Suspicious User\n\n" +
    `Telegram ID: ${telegramId}\n` +
    `Username: ${user.username ? "@" + user.username : "Not available"}\n` +
    `Attempts: ${Number(user.suspicious_count || 0)}\n` +
    `Reason: ${user.reason || "Not specified"}\n` +
    `Blocked until: ${user.blocked_until || "No"}\n` +
    `Permanent: ${Number(user.permanent || 0) ? "Yes" : "No"}`;

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
              "🚫 Permanent",
            callback_data:
              `admin_bp_${telegramId}`
          }
        ],
        [
          {
            text:
              "✅ Unblock",
            callback_data:
              `admin_bu_${telegramId}`
          }
        ],
        [
          {
            text:
              "⬅️ Suspicious",
            callback_data:
              "admin_suspicious"
          }
        ]
      ]
    }
  );
}

async function blockUser(
  env,
  query,
  telegramId,
  duration
) {
  const usernameRow =
    await env.DB.prepare(`
      SELECT username
      FROM users
      WHERE telegram_id=?
      LIMIT 1
    `).bind(
      telegramId
    ).first();

  let blockedUntil = null;
  let permanent = 0;

  if (
    duration ===
    "permanent"
  ) {
    permanent = 1;
  } else {
    const date =
      new Date();

    date.setDate(
      date.getDate() +
      Number(duration)
    );

    blockedUntil =
      date.toISOString();
  }

  await env.DB.prepare(`
    INSERT INTO suspicious_users (
      telegram_id,
      username,
      reason,
      suspicious_count,
      blocked_until,
      permanent,
      updated_at
    )
    VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username=excluded.username,
      blocked_until=excluded.blocked_until,
      permanent=excluded.permanent,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    telegramId,
    usernameRow?.username ||
      null,
    "Manual admin block",
    blockedUntil,
    permanent
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        telegramId,
      text:
        permanent
          ? "🚫 Your access to this bot has been permanently restricted."
          : `🚫 Your access to this bot has been restricted for ${duration} day(s).`
    }
  );

  await editMessage(
    env,
    query,
    "✅ User blocked.",
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
    SET blocked_until=NULL,
        permanent=0,
        updated_at=CURRENT_TIMESTAMP
    WHERE telegram_id=?
  `).bind(
    telegramId
  ).run();

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        telegramId,
      text:
        "✅ Your access to the PAYTON bot has been restored."
    }
  );

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
  duration
) {
  await blockUser(
    env,
    query,
    telegramId,
    duration
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

  if (!row) {
    return null;
  }

  if (
    Number(row.permanent || 0) ===
    1
  ) {
    return {
      permanent:
        true,
      blocked_until:
        null
    };
  }

  if (!row.blocked_until) {
    return null;
  }

  const blockedUntil =
    new Date(
      row.blocked_until
    );

  if (
    Number.isNaN(
      blockedUntil.getTime()
    )
  ) {
    return null;
  }

  if (
    blockedUntil.getTime() <=
    Date.now()
  ) {
    await env.DB.prepare(`
      UPDATE suspicious_users
      SET blocked_until=NULL,
          permanent=0,
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id=?
    `).bind(
      String(telegramId)
    ).run();

    return null;
  }

  return {
    permanent:
      false,
    blocked_until:
      row.blocked_until
  };
}

async function sendBlockedMessage(
  env,
  telegramId,
  restriction
) {
  let text =
    "🚫 Your access to this bot is currently restricted.";

  if (
    restriction.permanent
  ) {
    text +=
      "\n\nThis restriction is permanent.";
  } else if (
    restriction.blocked_until
  ) {
    text +=
      `\n\nAccess will be restored after ${formatUtcDate(restriction.blocked_until)}.`;
  }

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        telegramId,
      text
    }
  );
}
