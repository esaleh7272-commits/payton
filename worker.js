import { Buffer } from "buffer";
import {
  Address,
  beginCell,
  internal,
  SendMode,
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

const ADMIN_TELEGRAM_ID = "113074274";

const PTN_MASTER =
  "EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const GRAM_RECEIVING_WALLET =
  "UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";

const PTN_DECIMALS = 9;
const PTN_PER_GRAM = 1000000n;

const MIN_SENDER_TON_BALANCE = 300000000n;
const PAYOUT_MESSAGE_TON = 150000000n;

const MIN_GRAM_MICRO = 100000n;
const MAX_GRAM_MICRO = 1000000000000n;

const PAYMENT_EXPIRY_SECONDS = 3 * 24 * 60 * 60;
const PAYMENT_SEARCH_PAGES = 5;
const PAYOUT_SEARCH_PAGES = 5;

const WELCOME_TEXT =
  "Welcome to PTN Presale.\n\nChoose an option below.";

const MENU_TEXT =
  "PTN Presale Menu";

const ADMIN_TEXT =
  "Admin Panel";

const PRICE_TEXT =
  "PTN Price\n\n" +
  "1 GRAM = 1,000,000 PTN\n\n" +
  "PTN decimals: 9\n\n" +
  "Send GRAM only to the payment address shown in your order.";

const SUPPORT_TEXT =
  "Support\n\n" +
  "Send your message in one message. Your request will be forwarded to support.";

const CANCEL_TEXT =
  "Operation cancelled.";

const QUICK_REPLIES = {
  1: "Your payment is being checked on the TON blockchain.",
  2: "Your payment has been verified. PTN transfer processing has started.",
  3: "Your order has been received and is being processed.",
  4: "Please send the exact GRAM amount and include the exact payment comment shown in your order."
};

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "GET") {
        return new Response("PTN Bot OK");
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const update = await request.json();

      ctx.waitUntil(
        (async () => {
          try {
            await ensureSchema(env);
            await handleUpdate(env, update);
          } catch (error) {
            console.error("UPDATE ERROR:", error);
          }
        })()
      );

      return new Response("OK");
    } catch (error) {
      console.error("FETCH ERROR:", error);
      return new Response("OK");
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env);
          await processOrders(env);
        } catch (error) {
          console.error("CRON ERROR:", error);
        }
      })()
    );
  }
};

/* -------------------------------------------------------------------------- */
/* Telegram                                                                   */
/* -------------------------------------------------------------------------- */

async function telegram(env, method, body) {
  const token = String(env.BOT_TOKEN || "").trim();

  if (!token) {
    throw new Error("BOT_TOKEN missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API ${method} ${response.status}: ${text}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram API ${method}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function sendMessage(env, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  return telegram(env, "sendMessage", body);
}

async function editMessage(env, chatId, messageId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  return telegram(env, "editMessageText", body);
}

async function answerCallback(env, callbackId) {
  try {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callbackId
    });
  } catch (error) {
    console.error("CALLBACK ANSWER ERROR:", error);
  }
}

/* -------------------------------------------------------------------------- */
/* Keyboards                                                                  */
/* -------------------------------------------------------------------------- */

function mainMenuKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: "Buy PTN", callback_data: "buy" },
      { text: "PTN Price", callback_data: "price" }
    ],
    [
      { text: "My Orders", callback_data: "orders" },
      { text: "Support", callback_data: "support" }
    ]
  ];

  if (isAdmin) {
    rows.push([
      { text: "Admin Panel", callback_data: "admin" }
    ]);
  }

  return {
    inline_keyboard: rows
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Back", callback_data: "menu" }]
    ]
  };
}

function paymentKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        {
          text: "I Have Paid",
          callback_data: `paid:${orderId}`
        }
      ],
      [
        {
          text: "My Order",
          callback_data: `order:${orderId}`
        }
      ],
      [
        {
          text: "Back",
          callback_data: "menu"
        }
      ]
    ]
  };
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Dashboard", callback_data: "admin_dashboard" },
        { text: "All Orders", callback_data: "admin_orders" }
      ],
      [
        { text: "Pending", callback_data: "admin_pending" },
        { text: "Users", callback_data: "admin_users" }
      ],
      [
        { text: "Support", callback_data: "admin_support" },
        { text: "Suspicious", callback_data: "admin_suspicious" }
      ],
      [
        { text: "Revenue", callback_data: "admin_revenue" },
        { text: "Reply Templates", callback_data: "admin_templates" }
      ],
      [
        { text: "Back", callback_data: "menu" }
      ]
    ]
  };
}

function adminBackKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Admin Panel", callback_data: "admin" }
      ]
    ]
  };
}

function ticketKeyboard(ticketId) {
  return {
    inline_keyboard: [
      [
        {
          text: "Reply",
          callback_data: `ticket_reply:${ticketId}`
        }
      ],
      [
        {
          text: "Quick Reply 1",
          callback_data: `qr:1:${ticketId}`
        },
        {
          text: "Quick Reply 2",
          callback_data: `qr:2:${ticketId}`
        }
      ],
      [
        {
          text: "Quick Reply 3",
          callback_data: `qr:3:${ticketId}`
        },
        {
          text: "Quick Reply 4",
          callback_data: `qr:4:${ticketId}`
        }
      ],
      [
        {
          text: "Close Ticket",
          callback_data: `ticket_close:${ticketId}`
        }
      ],
      [
        {
          text: "Support List",
          callback_data: "admin_support"
        }
      ]
    ]
  };
}

function userAdminKeyboard(telegramId, blocked) {
  return {
    inline_keyboard: [
      [
        {
          text: blocked ? "Unblock User" : "Block User",
          callback_data: `${blocked ? "unblock" : "block"}:${telegramId}`
        }
      ],
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };
}

/* -------------------------------------------------------------------------- */
/* Update handling                                                            */
/* -------------------------------------------------------------------------- */

async function handleUpdate(env, update) {
  if (update.callback_query) {
    const callback = update.callback_query;

    const telegramId = String(
      callback.from?.id ?? ""
    );

    if (!telegramId) {
      return;
    }

    await upsertUser(env, callback.from);

    const blocked = await isUserBlocked(env, telegramId);

    if (blocked && !isAdmin(telegramId)) {
      await answerCallback(env, callback.id);
      await sendMessage(
        env,
        telegramId,
        "Your account is currently blocked."
      );
      return;
    }

    await answerCallback(env, callback.id);
    await handleCallback(env, callback);

    return;
  }

  if (!update.message) {
    return;
  }

  const message = update.message;
  const from = message.from;

  if (!from?.id) {
    return;
  }

  const telegramId = String(from.id);

  await upsertUser(env, from);

  const blocked = await isUserBlocked(env, telegramId);

  if (blocked && !isAdmin(telegramId)) {
    await sendMessage(
      env,
      telegramId,
      "Your account is currently blocked."
    );
    return;
  }

  const text = String(message.text || "").trim();

  if (!text) {
    return;
  }

  if (text === "/start") {
    await clearUserState(env, telegramId);

    await sendMessage(
      env,
      telegramId,
      WELCOME_TEXT,
      mainMenuKeyboard(isAdmin(telegramId))
    );

    return;
  }

  if (text === "/menu") {
    await clearUserState(env, telegramId);

    await sendMessage(
      env,
      telegramId,
      MENU_TEXT,
      mainMenuKeyboard(isAdmin(telegramId))
    );

    return;
  }

  if (text === "/admin") {
    if (isAdmin(telegramId)) {
      await clearUserState(env, telegramId);
      await sendMessage(
        env,
        telegramId,
        ADMIN_TEXT,
        adminMenuKeyboard()
      );
    }

    return;
  }

  if (text === "/support") {
    await clearUserState(env, telegramId);
    await setUserState(env, telegramId, "support_message", null);

    await sendMessage(
      env,
      telegramId,
      SUPPORT_TEXT,
      backKeyboard()
    );

    return;
  }

  await handleTextMessage(env, message);
}

/* -------------------------------------------------------------------------- */
/* Callback handling                                                          */
/* -------------------------------------------------------------------------- */

async function handleCallback(env, callback) {
  const telegramId = String(callback.from.id);
  const data = String(callback.data || "");
  const message = callback.message;

  if (data === "menu") {
    await clearUserState(env, telegramId);

    await editMessage(
      env,
      telegramId,
      message.message_id,
      MENU_TEXT,
      mainMenuKeyboard(isAdmin(telegramId))
    );

    return;
  }

  if (data === "buy") {
    await startBuyFlow(env, telegramId);
    return;
  }

  if (data === "price") {
    await editMessage(
      env,
      telegramId,
      message.message_id,
      PRICE_TEXT +
        "\n\nPayment address:\n" +
        formatDisplayAddress(GRAM_RECEIVING_WALLET),
      backKeyboard()
    );

    return;
  }

  if (data === "orders") {
    await showUserOrders(env, telegramId);
    return;
  }

  if (data === "support") {
    await clearUserState(env, telegramId);
    await setUserState(env, telegramId, "support_message", null);

    await editMessage(
      env,
      telegramId,
      message.message_id,
      SUPPORT_TEXT,
      backKeyboard()
    );

    return;
  }

  if (data === "admin") {
    if (!isAdmin(telegramId)) {
      return;
    }

    await clearUserState(env, telegramId);

    await editMessage(
      env,
      telegramId,
      message.message_id,
      ADMIN_TEXT,
      adminMenuKeyboard()
    );

    return;
  }

  if (data.startsWith("paid:")) {
    const orderId = Number(data.split(":")[1]);

    if (!Number.isInteger(orderId)) {
      return;
    }

    const order = await getOrderById(env, orderId);

    if (!order || String(order.telegram_id) !== telegramId) {
      return;
    }

    await editMessage(
      env,
      telegramId,
      message.message_id,
      "Checking the blockchain for your exact payment...",
      backKeyboard()
    );

    const result = await processSingleOrder(env, orderId);

    if (result === "payout_sent") {
      await sendMessage(
        env,
        telegramId,
        `Payment verified and PTN sent.\n\nOrder #${orderId}`,
        backKeyboard()
      );
    } else if (result === "payment_verified") {
      await sendMessage(
        env,
        telegramId,
        `Payment verified.\n\nPTN payout is now processing.\n\nOrder #${orderId}`,
        backKeyboard()
      );
    } else if (result === "payment_not_found") {
      const updated = await getOrderById(env, orderId);

      await sendMessage(
        env,
        telegramId,
        "No matching blockchain payment was found yet.\n\n" +
          "Make sure the amount is exact and the payment comment is exact.\n\n" +
          "Your order remains active and will be checked automatically.",
        paymentKeyboard(updated?.id || orderId)
      );
    } else {
      await sendMessage(
        env,
        telegramId,
        "Your order is still being processed.\n\n" +
          "The system will continue checking automatically.",
        paymentKeyboard(orderId)
      );
    }

    return;
  }

  if (data.startsWith("order:")) {
    const orderId = Number(data.split(":")[1]);

    if (!Number.isInteger(orderId)) {
      return;
    }

    await showUserOrder(env, telegramId, orderId);
    return;
  }

  if (data === "admin_dashboard") {
    if (!isAdmin(telegramId)) return;

    await showAdminDashboard(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_orders") {
    if (!isAdmin(telegramId)) return;

    await showAdminOrders(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_pending") {
    if (!isAdmin(telegramId)) return;

    await showAdminPending(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_users") {
    if (!isAdmin(telegramId)) return;

    await showAdminUsers(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_support") {
    if (!isAdmin(telegramId)) return;

    await showAdminSupport(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_suspicious") {
    if (!isAdmin(telegramId)) return;

    await showAdminSuspicious(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_revenue") {
    if (!isAdmin(telegramId)) return;

    await showAdminRevenue(env, telegramId, message.message_id);
    return;
  }

  if (data === "admin_templates") {
    if (!isAdmin(telegramId)) return;

    await showAdminTemplates(env, telegramId, message.message_id);
    return;
  }

  if (data.startsWith("ticket:")) {
    if (!isAdmin(telegramId)) return;

    const ticketId = Number(data.split(":")[1]);

    if (!Number.isInteger(ticketId)) {
      return;
    }

    await showTicket(env, telegramId, message.message_id, ticketId);
    return;
  }

  if (data.startsWith("ticket_reply:")) {
    if (!isAdmin(telegramId)) return;

    const ticketId = Number(data.split(":")[1]);

    if (!Number.isInteger(ticketId)) {
      return;
    }

    await setUserState(
      env,
      telegramId,
      "admin_reply_ticket",
      ticketId
    );

    await editMessage(
      env,
      telegramId,
      message.message_id,
      `Enter your reply for ticket #${ticketId}.`,
      adminBackKeyboard()
    );

    return;
  }

  if (data.startsWith("ticket_close:")) {
    if (!isAdmin(telegramId)) return;

    const ticketId = Number(data.split(":")[1]);

    if (!Number.isInteger(ticketId)) {
      return;
    }

    await env.DB.prepare(
      `UPDATE support_tickets
       SET status='closed', updated_at=?
       WHERE id=?`
    )
      .bind(now(), ticketId)
      .run();

    await showAdminSupport(env, telegramId, message.message_id);

    return;
  }

  if (data.startsWith("qr:")) {
    if (!isAdmin(telegramId)) return;

    const parts = data.split(":");
    const templateId = Number(parts[1]);
    const ticketId = Number(parts[2]);

    if (!QUICK_REPLIES[templateId] || !Number.isInteger(ticketId)) {
      return;
    }

    await sendQuickReply(
      env,
      telegramId,
      ticketId,
      QUICK_REPLIES[templateId]
    );

    return;
  }

  if (data.startsWith("block:")) {
    if (!isAdmin(telegramId)) return;

    const targetId = data.split(":")[1];

    await env.DB.prepare(
      `UPDATE users
       SET is_blocked=1, updated_at=?
       WHERE telegram_id=?`
    )
      .bind(now(), targetId)
      .run();

    await sendMessage(
      env,
      targetId,
      "Your account has been blocked."
    );

    await sendMessage(
      env,
      telegramId,
      `User ${targetId} has been blocked.`,
      userAdminKeyboard(targetId, true)
    );

    return;
  }

  if (data.startsWith("unblock:")) {
    if (!isAdmin(telegramId)) return;

    const targetId = data.split(":")[1];

    await env.DB.prepare(
      `UPDATE users
       SET is_blocked=0, updated_at=?
       WHERE telegram_id=?`
    )
      .bind(now(), targetId)
      .run();

    await sendMessage(
      env,
      telegramId,
      `User ${targetId} has been unblocked.`,
      userAdminKeyboard(targetId, false)
    );

    return;
  }

  if (data.startsWith("admin_order:")) {
    if (!isAdmin(telegramId)) return;

    const orderId = Number(data.split(":")[1]);

    if (!Number.isInteger(orderId)) {
      return;
    }

    await showAdminOrder(env, telegramId, message.message_id, orderId);
    return;
  }

  if (data.startsWith("retry_order:")) {
    if (!isAdmin(telegramId)) return;

    const orderId = Number(data.split(":")[1]);

    if (!Number.isInteger(orderId)) {
      return;
    }

    await env.DB.prepare(
      `UPDATE orders
       SET status='payment_verified',
           processing_until=NULL,
           failure_reason=NULL,
           updated_at=?
       WHERE id=?
         AND status IN ('payout_processing','payment_verified')`
    )
      .bind(now(), orderId)
      .run();

    await processSingleOrder(env, orderId);

    await showAdminOrder(
      env,
      telegramId,
      message.message_id,
      orderId
    );

    return;
  }
}

/* -------------------------------------------------------------------------- */
/* User text flow                                                             */
/* -------------------------------------------------------------------------- */

async function handleTextMessage(env, message) {
  const telegramId = String(message.from.id);
  const text = String(message.text || "").trim();

  const user = await getUser(env, telegramId);

  if (!user) {
    await upsertUser(env, message.from);
  }

  if (text.toLowerCase() === "cancel") {
    await clearUserState(env, telegramId);

    await sendMessage(
      env,
      telegramId,
      CANCEL_TEXT,
      mainMenuKeyboard(isAdmin(telegramId))
    );

    return;
  }

  if (isAdmin(telegramId) && user?.state === "admin_reply_ticket") {
    await handleAdminReplyText(
      env,
      telegramId,
      Number(user.draft_order_id),
      text
    );
    return;
  }

  if (user?.state === "awaiting_amount") {
    await handleGramAmountInput(
      env,
      telegramId,
      text,
      Number(user.draft_order_id)
    );
    return;
  }

  if (user?.state === "awaiting_wallet") {
    await handleWalletInput(
      env,
      telegramId,
      text,
      Number(user.draft_order_id)
    );
    return;
  }

  if (user?.state === "support_message") {
    await handleSupportMessage(
      env,
      telegramId,
      message.from,
      text
    );
    return;
  }

  await sendMessage(
    env,
    telegramId,
    "Please choose an option from the menu.",
    mainMenuKeyboard(isAdmin(telegramId))
  );
}

/* -------------------------------------------------------------------------- */
/* Buy flow                                                                   */
/* -------------------------------------------------------------------------- */

async function startBuyFlow(env, telegramId) {
  await clearUserState(env, telegramId);

  const draft = await createDraftOrder(env, telegramId);

  await setUserState(
    env,
    telegramId,
    "awaiting_amount",
    draft.id
  );

  await sendMessage(
    env,
    telegramId,
    "Enter the GRAM amount you want to purchase.\n\n" +
      "Example:\n" +
      "10\n\n" +
      "Maximum precision: 6 decimal places.\n" +
      "Minimum order: 0.1 GRAM."
  );
}

async function handleGramAmountInput(
  env,
  telegramId,
  text,
  orderId
) {
  const order = await getOrderById(env, orderId);

  if (!order || String(order.telegram_id) !== telegramId) {
    await startBuyFlow(env, telegramId);
    return;
  }

  let gramMicro;

  try {
    gramMicro = parseGramAmount(text);
  } catch (error) {
    await sendMessage(
      env,
      telegramId,
      error.message
    );
    return;
  }

  const ptnAmount = gramMicroToPtn(gramMicro);

  await env.DB.prepare(
    `UPDATE orders
     SET gram_amount=?,
         ptn_amount=?,
         status='awaiting_wallet',
         updated_at=?
     WHERE id=?`
  )
    .bind(
      formatGramMicro(gramMicro),
      ptnAmount.toString(),
      now(),
      orderId
    )
    .run();

  await setUserState(
    env,
    telegramId,
    "awaiting_wallet",
    orderId
  );

  await sendMessage(
    env,
    telegramId,
    "Enter your TON wallet address.\n\n" +
      "This must be the wallet you will use to send the GRAM payment.\n" +
      "The PTN payout will be sent to the same address."
  );
}

async function handleWalletInput(
  env,
  telegramId,
  text,
  orderId
) {
  const order = await getOrderById(env, orderId);

  if (!order || String(order.telegram_id) !== telegramId) {
    await startBuyFlow(env, telegramId);
    return;
  }

  let walletAddress;

  try {
    walletAddress = normalizeUserAddress(text);
  } catch (error) {
    await sendMessage(
      env,
      telegramId,
      "Invalid TON wallet address.\n\nPlease send a valid mainnet TON address."
    );
    return;
  }

  const paymentComment = await createUniquePaymentComment(
    env,
    orderId
  );

  await env.DB.prepare(
    `UPDATE orders
     SET payment_address=?,
         payment_comment=?,
         status='pending',
         updated_at=?
     WHERE id=?`
  )
    .bind(
      walletAddress,
      paymentComment,
      now(),
      orderId
    )
    .run();

  await clearUserState(env, telegramId);

  await sendPaymentInstructions(
    env,
    telegramId,
    orderId
  );
}

async function sendPaymentInstructions(
  env,
  telegramId,
  orderId
) {
  const order = await getOrderById(env, orderId);

  if (!order) {
    return;
  }

  const text =
    `Order #${order.id}\n\n` +
    `GRAM amount: ${order.gram_amount}\n` +
    `PTN amount: ${formatInteger(order.ptn_amount)} PTN\n\n` +
    `Send exactly:\n` +
    `${order.gram_amount} GRAM\n\n` +
    `To payment address:\n` +
    `${formatDisplayAddress(GRAM_RECEIVING_WALLET)}\n\n` +
    `Payment comment:\n` +
    `${order.payment_comment}\n\n` +
    `Important:\n` +
    `1. Send from the TON wallet you entered.\n` +
    `2. Send the exact GRAM amount.\n` +
    `3. Use the exact payment comment.\n` +
    `4. Keep enough additional TON for network fees.\n` +
    `5. Do not send extra GRAM to this order.`;

  await sendMessage(
    env,
    telegramId,
    text,
    paymentKeyboard(order.id)
  );
}

/* -------------------------------------------------------------------------- */
/* User orders                                                                */
/* -------------------------------------------------------------------------- */

async function showUserOrders(env, telegramId) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM orders
     WHERE telegram_id=?
     ORDER BY id DESC
     LIMIT 10`
  )
    .bind(telegramId)
    .all();

  const rows = result.results || [];

  if (!rows.length) {
    await sendMessage(
      env,
      telegramId,
      "You do not have any orders yet.",
      backKeyboard()
    );

    return;
  }

  let text = "My Orders\n\n";

  for (const order of rows) {
    text +=
      `#${order.id} | ` +
      `${order.gram_amount || "-"} GRAM | ` +
      `${formatInteger(order.ptn_amount || "0")} PTN | ` +
      `${formatStatus(order.status)}\n`;
  }

  const keyboard = {
    inline_keyboard: [
      ...rows.slice(0, 8).map((order) => [
        {
          text: `Order #${order.id}`,
          callback_data: `order:${order.id}`
        }
      ]),
      [
        { text: "Back", callback_data: "menu" }
      ]
    ]
  };

  await sendMessage(
    env,
    telegramId,
    text,
    keyboard
  );
}

async function showUserOrder(env, telegramId, orderId) {
  const order = await getOrderById(env, orderId);

  if (!order || String(order.telegram_id) !== telegramId) {
    await sendMessage(
      env,
      telegramId,
      "Order not found.",
      backKeyboard()
    );

    return;
  }

  let text =
    `Order #${order.id}\n\n` +
    `GRAM: ${order.gram_amount || "-"}\n` +
    `PTN: ${formatInteger(order.ptn_amount || "0")}\n` +
    `Status: ${formatStatus(order.status)}\n`;

  if (order.payment_address) {
    text +=
      `\nPayment wallet:\n${formatDisplayAddress(order.payment_address)}\n`;
  }

  if (order.payment_tx_hash) {
    text +=
      `\nPayment transaction:\n${order.payment_tx_hash}\n`;
  }

  if (order.payout_tx_hash) {
    text +=
      `\nPTN transaction:\n${order.payout_tx_hash}\n`;
  }

  if (order.status === "pending") {
    text +=
      `\nPayment comment:\n${order.payment_comment || "-"}\n`;
  }

  const keyboard = {
    inline_keyboard: [
      ...(order.status === "pending"
        ? [
            [
              {
                text: "I Have Paid",
                callback_data: `paid:${order.id}`
              }
            ]
          ]
        : []),
      [
        { text: "My Orders", callback_data: "orders" }
      ],
      [
        { text: "Back", callback_data: "menu" }
      ]
    ]
  };

  await sendMessage(
    env,
    telegramId,
    text,
    keyboard
  );
}

/* -------------------------------------------------------------------------- */
/* Payment verification                                                       */
/* -------------------------------------------------------------------------- */

async function processOrders(env) {
  const pendingResult = await env.DB.prepare(
    `SELECT *
     FROM orders
     WHERE status IN ('pending','payment_verified','payout_processing')
     ORDER BY id ASC
     LIMIT 25`
  ).all();

  const orders = pendingResult.results || [];

  for (const order of orders) {
    try {
      await processSingleOrder(env, Number(order.id));
    } catch (error) {
      console.error(
        `PROCESS ORDER ERROR ${order.id}:`,
        error
      );
    }
  }
}

async function processSingleOrder(env, orderId) {
  let order = await getOrderById(env, orderId);

  if (!order) {
    return "not_found";
  }

  const currentTime = now();

  if (
    order.status === "pending" &&
    currentTime -
      Number(order.created_at || currentTime) >
      PAYMENT_EXPIRY_SECONDS
  ) {
    await env.DB.prepare(
      `UPDATE orders
       SET status='expired',
           updated_at=?
       WHERE id=?
         AND status='pending'`
    )
      .bind(currentTime, orderId)
      .run();

    return "expired";
  }

  if (order.status === "pending") {
    if (!order.payment_address || !order.payment_comment) {
      return "payment_not_ready";
    }

    const payment = await findPayment(env, order);

    if (!payment) {
      return "payment_not_found";
    }

    const reused = await env.DB.prepare(
      `SELECT id
       FROM orders
       WHERE payment_tx_hash=?
         AND id<>?
       LIMIT 1`
    )
      .bind(payment.transactionHash, orderId)
      .first();

    if (reused) {
      console.error(
        `PAYMENT HASH ALREADY USED: ${payment.transactionHash}`
      );

      return "payment_not_found";
    }

    const update = await env.DB.prepare(
      `UPDATE orders
       SET status='payment_verified',
           payment_tx_hash=?,
           paid_at=?,
           updated_at=?,
           failure_reason=NULL
       WHERE id=?
         AND status='pending'`
    )
      .bind(
        payment.transactionHash,
        payment.timestamp,
        currentTime,
        orderId
      )
      .run();

    if (!update.meta?.changes) {
      order = await getOrderById(env, orderId);

      if (!order) {
        return "not_found";
      }
    } else {
      await sendMessage(
        env,
        order.telegram_id,
        `Payment verified on-chain.\n\nOrder #${order.id}\n\n` +
          `PTN payout processing has started.`
      );
    }

    order = await getOrderById(env, orderId);

    if (!order) {
      return "not_found";
    }
  }

  if (order.status === "payout_processing") {
    const processingUntil = Number(
      order.processing_until || 0
    );

    if (processingUntil > currentTime) {
      return "payout_processing";
    }

    const reset = await env.DB.prepare(
      `UPDATE orders
       SET status='payment_verified',
           processing_until=NULL,
           updated_at=?
       WHERE id=?
         AND status='payout_processing'`
    )
      .bind(currentTime, orderId)
      .run();

    if (!reset.meta?.changes) {
      return "payout_processing";
    }

    order = await getOrderById(env, orderId);

    if (!order) {
      return "not_found";
    }
  }

  if (order.status !== "payment_verified") {
    if (order.status === "payout_sent") {
      return "payout_sent";
    }

    return order.status;
  }

  const claimUntil = currentTime + 600;

  const claim = await env.DB.prepare(
    `UPDATE orders
     SET status='payout_processing',
         processing_until=?,
         retry_count=COALESCE(retry_count,0)+1,
         updated_at=?
     WHERE id=?
       AND status='payment_verified'`
  )
    .bind(
      claimUntil,
      currentTime,
      orderId
    )
    .run();

  if (!claim.meta?.changes) {
    return "payout_processing";
  }

  order = await getOrderById(env, orderId);

  if (!order) {
    return "not_found";
  }

  const payout = await sendPTN(env, order);

  if (payout.success) {
    await env.DB.prepare(
      `UPDATE orders
       SET status='payout_sent',
           payout_tx_hash=?,
           payout_at=?,
           processing_until=NULL,
           failure_reason=NULL,
           updated_at=?
       WHERE id=?
         AND status='payout_processing'`
    )
      .bind(
        payout.hash,
        currentTime,
        currentTime,
        orderId
      )
      .run();

    await sendMessage(
      env,
      order.telegram_id,
      `PTN payout completed.\n\n` +
        `Order #${order.id}\n` +
        `PTN: ${formatInteger(order.ptn_amount)}\n\n` +
        `Transaction:\n${payout.hash}`,
      backKeyboard()
    );

    return "payout_sent";
  }

  if (payout.pending) {
    await sendMessage(
      env,
      order.telegram_id,
      `Your payment is verified.\n\n` +
        `The PTN transaction has been submitted or is still being confirmed.\n` +
        `The system will continue checking automatically.\n\n` +
        `Order #${order.id}`
    );

    return "payout_processing";
  }

  await env.DB.prepare(
    `UPDATE orders
     SET status='payment_verified',
         processing_until=NULL,
         failure_reason=?,
         updated_at=?
     WHERE id=?
       AND status='payout_processing'`
  )
    .bind(
      payout.error || "Payout failed",
      currentTime,
      orderId
    )
    .run();

  const retryCount = Number(order.retry_count || 0);
  const shouldNotify =
    retryCount <= 1 ||
    retryCount % 3 === 0;

  if (shouldNotify) {
    await sendMessage(
      env,
      order.telegram_id,
      `Your payment has been verified, but the PTN payout needs another attempt.\n\n` +
        `Your payment is recorded and the system will retry automatically.\n\n` +
        `Order #${order.id}`
    );
  }

  return "payout_failed";
}

async function findPayment(env, order) {
  const apiKey = String(
    env.TONCENTER_API_KEY || ""
  ).trim();

  if (!apiKey) {
    console.error("TONCENTER_API_KEY missing");
    return null;
  }

  const source = canonicalAddress(
    order.payment_address
  );

  const destination = canonicalAddress(
    GRAM_RECEIVING_WALLET
  );

  const startUtime = Math.max(
    0,
    Number(order.created_at || now()) - 120
  );

  const endUtime = now() + 30;

  try {
    for (let page = 0; page < PAYMENT_SEARCH_PAGES; page++) {
      const params = new URLSearchParams();

      params.set("source", source);
      params.set("destination", destination);
      params.set("direction", "in");
      params.set("exclude_externals", "true");
      params.set("start_utime", String(startUtime));
      params.set("end_utime", String(endUtime));
      params.set("limit", "1000");
      params.set("offset", String(page * 1000));
      params.set("sort", "desc");

      const url =
        "https://toncenter.com/api/v3/messages?" +
        params.toString();

      const response = await fetch(url, {
        headers: {
          "X-API-Key": apiKey
        }
      });

      if (!response.ok) {
        const body = await response.text();

        console.error(
          "PAYMENT SEARCH ERROR:",
          response.status,
          body
        );

        return null;
      }

      const data = await response.json();

      const messages = Array.isArray(data?.messages)
        ? data.messages
        : [];

      if (!messages.length) {
        break;
      }

      for (const message of messages) {
        if (!sameAddress(message?.source, source)) {
          continue;
        }

        if (!sameAddress(message?.destination, destination)) {
          continue;
        }

        if (message?.bounced === true) {
          continue;
        }

        if (
          String(message?.created_at || "") !== "" &&
          Number(message.created_at) < startUtime
        ) {
          continue;
        }

        const value = String(message?.value ?? "0");

        const expectedValue = gramToNano(
          order.gram_amount
        );

        if (value !== expectedValue.toString()) {
          continue;
        }

        const comment = await extractMessageComment(
          message
        );

        if (comment !== order.payment_comment) {
          continue;
        }

        const transactionHash =
          message?.in_msg_tx_hash ||
          message?.out_msg_tx_hash ||
          message?.hash ||
          "";

        if (!transactionHash) {
          continue;
        }

        const transactionTimestamp = Number(
          message?.created_at || now()
        );

        return {
          transactionHash,
          timestamp: transactionTimestamp,
          message
        };
      }

      if (messages.length < 1000) {
        break;
      }
    }
  } catch (error) {
    console.error(
      "PAYMENT SEARCH EXCEPTION:",
      error
    );
  }

  return null;
}

async function extractMessageComment(message) {
  const decoded =
    message?.message_content?.decoded;

  const decodedComment = findDecodedComment(decoded);

  if (decodedComment !== null) {
    return decodedComment;
  }

  const body =
    message?.message_content?.body;

  if (!body) {
    return "";
  }

  try {
    const normalized = normalizeBase64(body);
    const boc = Buffer.from(normalized, "base64");
    const cells = Cell.fromBoc(boc);

    if (!cells.length) {
      return "";
    }

    const slice = cells[0].beginParse();

    if (slice.remainingBits < 32) {
      return "";
    }

    const opcode = slice.loadUint(32);

    if (opcode !== 0) {
      return "";
    }

    return slice.loadStringTail();
  } catch (error) {
    return "";
  }
}

function findDecodedComment(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (
    typeof value.comment === "string"
  ) {
    return value.comment;
  }

  if (
    typeof value.text === "string"
  ) {
    return value.text;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDecodedComment(item);

      if (found !== null) {
        return found;
      }
    }

    return null;
  }

  for (const item of Object.values(value)) {
    if (
      item &&
      typeof item === "object"
    ) {
      const found = findDecodedComment(item);

      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* PTN payout                                                                 */
/* -------------------------------------------------------------------------- */

async function sendPTN(env, order) {
  try {
    const mnemonic = String(
      env.PTN_MNEMONIC || ""
    ).trim();

    if (!mnemonic) {
      throw new Error("PTN_MNEMONIC missing");
    }

    const words = mnemonic.split(/\s+/);

    if (
      words.length !== 12 &&
      words.length !== 24
    ) {
      throw new Error(
        `PTN_MNEMONIC has invalid word count: ${words.length}`
      );
    }

    const apiKey = String(
      env.TONCENTER_API_KEY || ""
    ).trim();

    if (!apiKey) {
      throw new Error(
        "TONCENTER_API_KEY missing"
      );
    }

    const keyPair =
      await mnemonicToPrivateKey(words);

    const client = new TonClient({
      endpoint:
        "https://toncenter.com/api/v2/jsonRPC",
      apiKey
    });

    const senderWallet =
      WalletContractV5R1.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
        walletId: {
          networkGlobalId: -239
        }
      });

    const derivedAddress =
      senderWallet.address.toString({
        bounceable: false,
        testOnly: false,
        urlSafe: true
      });

    const configuredAddress =
      Address.parse(
        PTN_SENDER_WALLET
      ).toString({
        bounceable: false,
        testOnly: false,
        urlSafe: true
      });

    if (
      derivedAddress !== configuredAddress
    ) {
      throw new Error(
        "Derived sender wallet does not match PTN_SENDER_WALLET. " +
        `Derived: ${derivedAddress} ` +
        `Configured: ${configuredAddress}`
      );
    }

    const wallet =
      client.open(senderWallet);

    const deployed =
      await client.isContractDeployed(
        senderWallet.address
      );

    if (!deployed) {
      throw new Error(
        "PTN sender wallet is not deployed"
      );
    }

    const tonBalance =
      await client.getBalance(
        senderWallet.address
      );

    if (
      tonBalance <
      MIN_SENDER_TON_BALANCE
    ) {
      throw new Error(
        `Insufficient TON balance. Required reserve: ` +
        `${MIN_SENDER_TON_BALANCE.toString()} nanotons. ` +
        `Available: ${tonBalance.toString()}`
      );
    }

    const master =
      client.open(
        JettonMaster.create(
          Address.parse(PTN_MASTER)
        )
      );

    const senderJettonAddress =
      await master.getWalletAddress(
        senderWallet.address
      );

    const senderJettonWallet =
      client.open(
        JettonWallet.create(
          senderJettonAddress
        )
      );

    const senderJettonBalance =
      await senderJettonWallet.getBalance();

    const amount =
      BigInt(order.ptn_amount) *
      10n ** BigInt(PTN_DECIMALS);

    if (
      amount <= 0n
    ) {
      throw new Error(
        "Invalid PTN payout amount"
      );
    }

    if (
      senderJettonBalance <
      amount
    ) {
      throw new Error(
        `Insufficient PTN balance. ` +
        `Required: ${amount.toString()}, ` +
        `Available: ${senderJettonBalance.toString()}`
      );
    }

    const destination =
      Address.parse(
        order.payment_address
      );

    const queryId =
      BigInt(order.id);

    const existingBefore =
      await findExistingPayout(
        env,
        senderWallet.address,
        senderJettonAddress,
        destination,
        queryId,
        amount
      );

    if (existingBefore) {
      return {
        success: true,
        hash: existingBefore.hash
      };
    }

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
        .storeCoins(amount)
        .storeAddress(destination)
        .storeAddress(senderWallet.address)
        .storeBit(0)
        .storeCoins(0n)
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
          to: senderJettonAddress,
          value: PAYOUT_MESSAGE_TON,
          bounce: true,
          body
        })
      ]
    });

    for (
      let attempt = 0;
      attempt < 12;
      attempt++
    ) {
      await sleep(2500);

      const confirmed =
        await findExistingPayout(
          env,
          senderWallet.address,
          senderJettonAddress,
          destination,
          queryId,
          amount
        );

      if (confirmed) {
        return {
          success: true,
          hash: confirmed.hash
        };
      }
    }

    return {
      success: false,
      pending: true
    };
  } catch (error) {
    console.error(
      `PTN PAYOUT ERROR ORDER ${order.id}:`,
      error
    );

    return {
      success: false,
      error: String(
        error?.message ||
        error ||
        "Unknown payout error"
      )
    };
  }
}

async function findExistingPayout(
  env,
  ownerAddress,
  senderJettonAddress,
  destination,
  queryId,
  expectedAmount
) {
  const apiKey = String(
    env.TONCENTER_API_KEY || ""
  ).trim();

  if (!apiKey) {
    console.error(
      "TONCENTER_API_KEY missing"
    );

    return null;
  }

  try {
    const owner =
      canonicalAddress(ownerAddress);

    const sourceJettonWallet =
      canonicalAddress(
        senderJettonAddress
      );

    const destinationAddress =
      canonicalAddress(destination);

    for (
      let page = 0;
      page < PAYOUT_SEARCH_PAGES;
      page++
    ) {
      const params =
        new URLSearchParams();

      params.set(
        "owner_address",
        owner
      );

      params.set(
        "jetton_master",
        PTN_MASTER
      );

      params.set(
        "direction",
        "out"
      );

      params.set(
        "limit",
        "1000"
      );

      params.set(
        "offset",
        String(page * 1000)
      );

      params.set(
        "sort",
        "desc"
      );

      const url =
        "https://toncenter.com/api/v3/jetton/transfers?" +
        params.toString();

      const response =
        await fetch(url, {
          headers: {
            "X-API-Key": apiKey
          }
        });

      if (!response.ok) {
        const text =
          await response.text();

        console.error(
          "JETTON PAYOUT SEARCH ERROR:",
          response.status,
          text
        );

        return null;
      }

      const data =
        await response.json();

      const transfers =
        Array.isArray(
          data?.jetton_transfers
        )
          ? data.jetton_transfers
          : [];

      if (!transfers.length) {
        break;
      }

      for (const transfer of transfers) {
        let transferQueryId;

        try {
          transferQueryId =
            BigInt(
              String(
                transfer?.query_id ?? ""
              )
            );
        } catch {
          continue;
        }

        if (
          transferQueryId !==
          BigInt(queryId)
        ) {
          continue;
        }

        if (
          transfer?.transaction_aborted ===
          true
        ) {
          continue;
        }

        if (
          !sameAddress(
            transfer?.jetton_master,
            PTN_MASTER
          )
        ) {
          continue;
        }

        if (
          !sameAddress(
            transfer?.source_wallet,
            sourceJettonWallet
          )
        ) {
          continue;
        }

        if (
          !sameAddress(
            transfer?.destination,
            destinationAddress
          )
        ) {
          continue;
        }

        if (
          String(
            transfer?.amount ?? ""
          ) !==
          expectedAmount.toString()
        ) {
          continue;
        }

        const hash =
          transfer?.transaction_hash ||
          transfer?.transactionHash ||
          "";

        if (!hash) {
          continue;
        }

        return {
          hash,
          transfer
        };
      }

      if (
        transfers.length < 1000
      ) {
        break;
      }
    }
  } catch (error) {
    console.error(
      "PAYOUT SEARCH EXCEPTION:",
      error
    );
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Support                                                                   */
/* -------------------------------------------------------------------------- */

async function handleSupportMessage(
  env,
  telegramId,
  telegramUser,
  text
) {
  await clearUserState(env, telegramId);

  const existing =
    await env.DB.prepare(
      `SELECT id
       FROM support_tickets
       WHERE telegram_id=?
         AND status='open'
       ORDER BY id DESC
       LIMIT 1`
    )
      .bind(telegramId)
      .first();

  let ticketId;

  if (existing) {
    ticketId = Number(existing.id);
  } else {
    const inserted =
      await env.DB.prepare(
        `INSERT INTO support_tickets
         (telegram_id, subject, status, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?)`
      )
        .bind(
          telegramId,
          "Support Request",
          now(),
          now()
        )
        .run();

    ticketId =
      Number(
        inserted.meta?.last_row_id
      );
  }

  await env.DB.prepare(
    `INSERT INTO support_messages
     (ticket_id, telegram_id, sender_role, message_text, created_at)
     VALUES (?, ?, 'user', ?, ?)`
  )
    .bind(
      ticketId,
      telegramId,
      text,
      now()
    )
    .run();

  const username =
    telegramUser.username
      ? `@${telegramUser.username}`
      : telegramUser.first_name ||
        telegramId;

  await sendMessage(
    env,
    telegramId,
    `Your support message has been received.\n\nTicket #${ticketId}`
  );

  await sendMessage(
    env,
    ADMIN_TELEGRAM_ID,
    `New support message\n\n` +
      `Ticket: #${ticketId}\n` +
      `User: ${username}\n` +
      `Telegram ID: ${telegramId}\n\n` +
      text,
    ticketKeyboard(ticketId)
  );
}

async function handleAdminReplyText(
  env,
  adminTelegramId,
  ticketId,
  text
) {
  if (!ticketId) {
    await clearUserState(
      env,
      adminTelegramId
    );

    return;
  }

  const ticket =
    await env.DB.prepare(
      `SELECT *
       FROM support_tickets
       WHERE id=?
       LIMIT 1`
    )
      .bind(ticketId)
      .first();

  if (!ticket) {
    await clearUserState(
      env,
      adminTelegramId
    );

    await sendMessage(
      env,
      adminTelegramId,
      "Ticket not found.",
      adminBackKeyboard()
    );

    return;
  }

  await env.DB.prepare(
    `INSERT INTO support_messages
     (ticket_id, telegram_id, sender_role, message_text, created_at)
     VALUES (?, ?, 'admin', ?, ?)`
  )
    .bind(
      ticketId,
      ticket.telegram_id,
      text,
      now()
    )
    .run();

  await env.DB.prepare(
    `UPDATE support_tickets
     SET status='open', updated_at=?
     WHERE id=?`
  )
    .bind(
      now(),
      ticketId
    )
    .run();

  await clearUserState(
    env,
    adminTelegramId
  );

  await sendMessage(
    env,
    ticket.telegram_id,
    `Support reply\n\n${text}\n\nTicket #${ticketId}`
  );

  await sendMessage(
    env,
    adminTelegramId,
    `Reply sent to ticket #${ticketId}.`,
    adminBackKeyboard()
  );
}

async function showAdminSupport(
  env,
  adminTelegramId,
  messageId
) {
  const result =
    await env.DB.prepare(
      `SELECT *
       FROM support_tickets
       ORDER BY
         CASE WHEN status='open' THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT 20`
    )
      .all();

  const tickets =
    result.results || [];

  let text =
    "Support Tickets\n\n";

  if (!tickets.length) {
    text += "No tickets.";
  } else {
    for (const ticket of tickets) {
      text +=
        `#${ticket.id} | ` +
        `User ${ticket.telegram_id} | ` +
        `${ticket.status}\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      ...tickets.map((ticket) => [
        {
          text:
            `Ticket #${ticket.id} (${ticket.status})`,
          callback_data:
            `ticket:${ticket.id}`
        }
      ]),
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    keyboard
  );
}

async function showTicket(
  env,
  adminTelegramId,
  messageId,
  ticketId
) {
  const ticket =
    await env.DB.prepare(
      `SELECT *
       FROM support_tickets
       WHERE id=?
       LIMIT 1`
    )
      .bind(ticketId)
      .first();

  if (!ticket) {
    await editMessage(
      env,
      adminTelegramId,
      messageId,
      "Ticket not found.",
      adminBackKeyboard()
    );

    return;
  }

  const result =
    await env.DB.prepare(
      `SELECT *
       FROM support_messages
       WHERE ticket_id=?
       ORDER BY id ASC
       LIMIT 30`
    )
      .bind(ticketId)
      .all();

  const messages =
    result.results || [];

  let text =
    `Ticket #${ticket.id}\n\n` +
    `User: ${ticket.telegram_id}\n` +
    `Status: ${ticket.status}\n\n`;

  for (const item of messages) {
    text +=
      `[${item.sender_role}] ${item.message_text}\n\n`;
  }

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    ticketKeyboard(ticketId)
  );
}

async function sendQuickReply(
  env,
  adminTelegramId,
  ticketId,
  text
) {
  const ticket =
    await env.DB.prepare(
      `SELECT *
       FROM support_tickets
       WHERE id=?
       LIMIT 1`
    )
      .bind(ticketId)
      .first();

  if (!ticket) {
    return;
  }

  await env.DB.prepare(
    `INSERT INTO support_messages
     (ticket_id, telegram_id, sender_role, message_text, created_at)
     VALUES (?, ?, 'admin', ?, ?)`
  )
    .bind(
      ticketId,
      ticket.telegram_id,
      text,
      now()
    )
    .run();

  await env.DB.prepare(
    `UPDATE support_tickets
     SET status='open', updated_at=?
     WHERE id=?`
  )
    .bind(
      now(),
      ticketId
    )
    .run();

  await sendMessage(
    env,
    ticket.telegram_id,
    `Support reply\n\n${text}\n\nTicket #${ticketId}`
  );

  await sendMessage(
    env,
    adminTelegramId,
    `Quick reply sent to ticket #${ticketId}.`,
    ticketKeyboard(ticketId)
  );
}

/* -------------------------------------------------------------------------- */
/* Admin dashboard                                                            */
/* -------------------------------------------------------------------------- */

async function showAdminDashboard(
  env,
  adminTelegramId,
  messageId
) {
  const result =
    await env.DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM orders
       GROUP BY status`
    )
      .all();

  const counts = {};

  for (
    const row of result.results || []
  ) {
    counts[row.status] =
      Number(row.count);
  }

  const users =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM users`
    ).first();

  const openTickets =
    await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM support_tickets
       WHERE status='open'`
    ).first();

  const text =
    `Dashboard\n\n` +
    `Users: ${Number(users?.count || 0)}\n` +
    `Open tickets: ${Number(openTickets?.count || 0)}\n\n` +
    `Awaiting amount: ${counts.awaiting_amount || 0}\n` +
    `Awaiting wallet: ${counts.awaiting_wallet || 0}\n` +
    `Pending payment: ${counts.pending || 0}\n` +
    `Payment verified: ${counts.payment_verified || 0}\n` +
    `Payout processing: ${counts.payout_processing || 0}\n` +
    `Payout sent: ${counts.payout_sent || 0}\n` +
    `Expired: ${counts.expired || 0}`;

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    adminBackKeyboard()
  );
}

async function showAdminOrders(
  env,
  adminTelegramId,
  messageId
) {
  const result =
    await env.DB.prepare(
      `SELECT *
       FROM orders
       ORDER BY id DESC
       LIMIT 25`
    ).all();

  const orders =
    result.results || [];

  let text =
    "All Orders\n\n";

  if (!orders.length) {
    text += "No orders.";
  } else {
    for (const order of orders) {
      text +=
        `#${order.id} | ` +
        `${order.gram_amount || "-"} GRAM | ` +
        `${formatInteger(order.ptn_amount || "0")} PTN | ` +
        `${formatStatus(order.status)} | ` +
        `${order.telegram_id}\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      ...orders.slice(0, 15).map((order) => [
        {
          text:
            `#${order.id} ${formatStatus(order.status)}`,
          callback_data:
            `admin_order:${order.id}`
        }
      ]),
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    keyboard
  );
}

async function showAdminPending(
  env,
  adminTelegramId,
  messageId
) {
  const result =
    await env.DB.prepare(
      `SELECT *
       FROM orders
       WHERE status IN ('pending','payment_verified','payout_processing')
       ORDER BY id ASC
       LIMIT 25`
    ).all();

  const orders =
    result.results || [];

  let text =
    "Pending Orders\n\n";

  if (!orders.length) {
    text += "No pending orders.";
  } else {
    for (const order of orders) {
      text +=
        `#${order.id} | ` +
        `${order.gram_amount} GRAM | ` +
        `${formatStatus(order.status)} | ` +
        `${order.telegram_id}\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      ...orders.map((order) => [
        {
          text:
            `Order #${order.id}`,
          callback_data:
            `admin_order:${order.id}`
        }
      ]),
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    keyboard
  );
}

async function showAdminUsers(
  env,
  adminTelegramId,
  messageId
) {
  const result =
    await env.DB.prepare(
      `SELECT *
       FROM users
       ORDER BY id DESC
       LIMIT 25`
    ).all();

  const users =
    result.results || [];

  let text =
    "Users\n\n";

  if (!users.length) {
    text += "No users.";
  } else {
    for (const user of users) {
      text +=
        `${user.telegram_id} | ` +
        `${user.username || user.first_name || "-"} | ` +
        `${user.is_blocked ? "blocked" : "active"}\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      ...users.map((user) => [
        {
          text:
            `${user.username || user.telegram_id} ` +
            `${user.is_blocked ? "Unblock" : "Block"}`,
          callback_data:
            `${user.is_blocked ? "unblock" : "block"}:${user.telegram_id}`
        }
      ]),
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    keyboard
  );
}

async function showAdminSuspicious(
  env,
  adminTelegramId,
  messageId
) {
  const cutoff =
    now() - 1800;

  const result =
    await env.DB.prepare(
      `SELECT *
       FROM orders
       WHERE
         (
           status='pending'
           AND created_at<?
         )
         OR
         (
           status='payout_processing'
           AND COALESCE(processing_until,0)<?
         )
       ORDER BY id ASC
       LIMIT 25`
    )
      .bind(
        cutoff,
        now()
      )
      .all();

  const orders =
    result.results || [];

  let text =
    "Suspicious / Stalled Orders\n\n";

  if (!orders.length) {
    text += "No suspicious or stalled orders.";
  } else {
    for (const order of orders) {
      text +=
        `#${order.id} | ` +
        `${order.telegram_id} | ` +
        `${order.status} | ` +
        `${order.gram_amount} GRAM\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      ...orders.map((order) => [
        {
          text:
            `Order #${order.id}`,
          callback_data:
            `admin_order:${order.id}`
        }
      ]),
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    keyboard
  );
}

async function showAdminRevenue(
  env,
  adminTelegramId,
  messageId
) {
  const result =
    await env.DB.prepare(
      `SELECT gram_amount, ptn_amount
       FROM orders
       WHERE status='payout_sent'
       LIMIT 10000`
    ).all();

  let totalGramMicro = 0n;
  let totalPtn = 0n;

  for (
    const row of result.results || []
  ) {
    try {
      totalGramMicro +=
        gramToMicro(
          row.gram_amount
        );

      totalPtn +=
        BigInt(
          row.ptn_amount || "0"
        );
    } catch {
      continue;
    }
  }

  const text =
    `Revenue\n\n` +
    `Completed orders: ${(result.results || []).length}\n` +
    `GRAM received: ${formatGramMicro(totalGramMicro)}\n` +
    `PTN sent: ${formatInteger(totalPtn.toString())}`;

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    adminBackKeyboard()
  );
}

async function showAdminTemplates(
  env,
  adminTelegramId,
  messageId
) {
  const text =
    "Reply Templates\n\n" +
    `1. ${QUICK_REPLIES[1]}\n\n` +
    `2. ${QUICK_REPLIES[2]}\n\n` +
    `3. ${QUICK_REPLIES[3]}\n\n` +
    `4. ${QUICK_REPLIES[4]}`;

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    adminBackKeyboard()
  );
}

async function showAdminOrder(
  env,
  adminTelegramId,
  messageId,
  orderId
) {
  const order =
    await getOrderById(
      env,
      orderId
    );

  if (!order) {
    await editMessage(
      env,
      adminTelegramId,
      messageId,
      "Order not found.",
      adminBackKeyboard()
    );

    return;
  }

  let text =
    `Order #${order.id}\n\n` +
    `Telegram ID: ${order.telegram_id}\n` +
    `GRAM: ${order.gram_amount || "-"}\n` +
    `PTN: ${formatInteger(order.ptn_amount || "0")}\n` +
    `Status: ${formatStatus(order.status)}\n` +
    `Created: ${formatTime(order.created_at)}\n`;

  if (order.payment_address) {
    text +=
      `Payment wallet:\n${formatDisplayAddress(order.payment_address)}\n`;
  }

  if (order.payment_comment) {
    text +=
      `Payment comment:\n${order.payment_comment}\n`;
  }

  if (order.payment_tx_hash) {
    text +=
      `Payment TX:\n${order.payment_tx_hash}\n`;
  }

  if (order.payout_tx_hash) {
    text +=
      `Payout TX:\n${order.payout_tx_hash}\n`;
  }

  if (order.failure_reason) {
    text +=
      `Failure:\n${order.failure_reason}\n`;
  }

  const keyboard = {
    inline_keyboard: [
      ...(order.status === "payment_verified" ||
      order.status === "payout_processing"
        ? [
            [
              {
                text: "Retry Payout",
                callback_data:
                  `retry_order:${order.id}`
              }
            ]
          ]
        : []),
      [
        {
          text: "Pending",
          callback_data: "admin_pending"
        }
      ],
      [
        {
          text: "Admin Panel",
          callback_data: "admin"
        }
      ]
    ]
  };

  await editMessage(
    env,
    adminTelegramId,
    messageId,
    text,
    keyboard
  );
}

/* -------------------------------------------------------------------------- */
/* Database                                                                   */
/* -------------------------------------------------------------------------- */

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      state TEXT,
      draft_order_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      username TEXT,
      gram_amount TEXT,
      ptn_amount TEXT,
      payment_address TEXT,
      payment_comment TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_amount',
      payment_tx_hash TEXT,
      payout_tx_hash TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      payout_at INTEGER,
      processing_until INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      last_failure_notified_at INTEGER,
      updated_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      telegram_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
  ).run();

  await ensureColumn(
    env,
    "users",
    "username",
    "TEXT"
  );

  await ensureColumn(
    env,
    "users",
    "first_name",
    "TEXT"
  );

  await ensureColumn(
    env,
    "users",
    "is_blocked",
    "INTEGER NOT NULL DEFAULT 0"
  );

  await ensureColumn(
    env,
    "users",
    "state",
    "TEXT"
  );

  await ensureColumn(
    env,
    "users",
    "draft_order_id",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "users",
    "created_at",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "users",
    "updated_at",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "orders",
    "username",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "gram_amount",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "ptn_amount",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "payment_address",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "payment_comment",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "payment_tx_hash",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "payout_tx_hash",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "paid_at",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "orders",
    "payout_at",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "orders",
    "processing_until",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "orders",
    "retry_count",
    "INTEGER NOT NULL DEFAULT 0"
  );

  await ensureColumn(
    env,
    "orders",
    "failure_reason",
    "TEXT"
  );

  await ensureColumn(
    env,
    "orders",
    "last_failure_notified_at",
    "INTEGER"
  );

  await ensureColumn(
    env,
    "orders",
    "updated_at",
    "INTEGER"
  );

  const current = now();

  await env.DB.prepare(
    `UPDATE users
     SET created_at=COALESCE(created_at,?),
         updated_at=COALESCE(updated_at,?)
     WHERE created_at IS NULL
        OR updated_at IS NULL`
  )
    .bind(current, current)
    .run();

  await env.DB.prepare(
    `UPDATE orders
     SET created_at=COALESCE(created_at,?),
         updated_at=COALESCE(updated_at,?)
     WHERE created_at IS NULL
        OR updated_at IS NULL`
  )
    .bind(current, current)
    .run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_orders_status
     ON orders(status)`
  ).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_orders_telegram
     ON orders(telegram_id)`
  ).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_orders_created
     ON orders(created_at)`
  ).run();

  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_hash
     ON orders(payment_tx_hash)
     WHERE payment_tx_hash IS NOT NULL`
  ).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_support_status
     ON support_tickets(status)`
  ).run();

  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_support_user
     ON support_tickets(telegram_id)`
  ).run();
}

async function ensureColumn(
  env,
  table,
  column,
  definition
) {
  const result =
    await env.DB.prepare(
      `PRAGMA table_info(${table})`
    ).all();

  const exists =
    (result.results || []).some(
      (row) =>
        String(row.name) ===
        String(column)
    );

  if (exists) {
    return;
  }

  await env.DB.prepare(
    `ALTER TABLE ${table}
     ADD COLUMN ${column} ${definition}`
  ).run();
}

/* -------------------------------------------------------------------------- */
/* User database helpers                                                      */
/* -------------------------------------------------------------------------- */

async function upsertUser(env, from) {
  const telegramId =
    String(from.id);

  const username =
    from.username ||
    "";

  const firstName =
    from.first_name ||
    "";

  const timestamp =
    now();

  await env.DB.prepare(
    `INSERT INTO users
     (telegram_id, username, first_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id)
     DO UPDATE SET
       username=excluded.username,
       first_name=excluded.first_name,
       updated_at=excluded.updated_at`
  )
    .bind(
      telegramId,
      username,
      firstName,
      timestamp,
      timestamp
    )
    .run();
}

async function getUser(env, telegramId) {
  return env.DB.prepare(
    `SELECT *
     FROM users
     WHERE telegram_id=?
     LIMIT 1`
  )
    .bind(String(telegramId))
    .first();
}

async function isUserBlocked(
  env,
  telegramId
) {
  const user =
    await getUser(
      env,
      telegramId
    );

  return Boolean(
    user?.is_blocked
  );
}

async function setUserState(
  env,
  telegramId,
  state,
  draftOrderId
) {
  await env.DB.prepare(
    `UPDATE users
     SET state=?,
         draft_order_id=?,
         updated_at=?
     WHERE telegram_id=?`
  )
    .bind(
      state,
      draftOrderId,
      now(),
      String(telegramId)
    )
    .run();
}

async function clearUserState(
  env,
  telegramId
) {
  await env.DB.prepare(
    `UPDATE users
     SET state=NULL,
         draft_order_id=NULL,
         updated_at=?
     WHERE telegram_id=?`
  )
    .bind(
      now(),
      String(telegramId)
    )
    .run();
}

/* -------------------------------------------------------------------------- */
/* Order database helpers                                                     */
/* -------------------------------------------------------------------------- */

async function createDraftOrder(
  env,
  telegramId
) {
  const user =
    await getUser(
      env,
      telegramId
    );

  const inserted =
    await env.DB.prepare(
      `INSERT INTO orders
       (
         telegram_id,
         username,
         status,
         created_at,
         retry_count,
         updated_at
       )
       VALUES (?, ?, 'awaiting_amount', ?, 0, ?)`
    )
      .bind(
        String(telegramId),
        user?.username ||
          user?.first_name ||
          "",
        now(),
        now()
      )
      .run();

  return {
    id: Number(
      inserted.meta?.last_row_id
    )
  };
}

async function getOrderById(
  env,
  orderId
) {
  return env.DB.prepare(
    `SELECT *
     FROM orders
     WHERE id=?
     LIMIT 1`
  )
    .bind(Number(orderId))
    .first();
}

/* -------------------------------------------------------------------------- */
/* TON parsing and formatting                                                 */
/* -------------------------------------------------------------------------- */

function parseGramAmount(value) {
  let text =
    String(value ?? "")
      .trim()
      .replace(/,/g, ".")
      .replace(/\s+/g, "");

  if (!text) {
    throw new Error(
      "Enter a GRAM amount."
    );
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(
      "Invalid GRAM amount. Use numbers only, for example 10 or 10.25."
    );
  }

  const parts =
    text.split(".");

  const whole =
    parts[0] || "0";

  const decimals =
    parts[1] || "";

  if (decimals.length > 6) {
    throw new Error(
      "GRAM supports a maximum of 6 decimal places."
    );
  }

  const padded =
    decimals
      .padEnd(6, "0");

  const micro =
    BigInt(whole) *
      1000000n +
    BigInt(padded || "0");

  if (
    micro <
    MIN_GRAM_MICRO
  ) {
    throw new Error(
      "Minimum order is 0.1 GRAM."
    );
  }

  if (
    micro >
    MAX_GRAM_MICRO
  ) {
    throw new Error(
      "The GRAM amount is above the maximum allowed order size."
    );
  }

  return micro;
}

function gramToMicro(value) {
  return parseGramAmount(value);
}

function gramToNano(value) {
  const micro =
    gramToMicro(value);

  return (
    micro * 1000n
  );
}

function gramMicroToPtn(
  gramMicro
) {
  return (
    gramMicro *
    PTN_PER_GRAM /
    1000000n
  );
}

function formatGramMicro(
  micro
) {
  const negative =
    micro < 0n;

  const value =
    negative
      ? -micro
      : micro;

  const whole =
    value / 1000000n;

  const fraction =
    value % 1000000n;

  let fractionText =
    fraction
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");

  if (!fractionText) {
    return (
      negative
        ? "-"
        : ""
    ) +
      formatInteger(
        whole.toString()
      );
  }

  return (
    negative
      ? "-"
      : ""
  ) +
    formatInteger(
      whole.toString()
    ) +
    "." +
    fractionText;
}

function formatInteger(value) {
  const text =
    String(value ?? "0");

  return text.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ","
  );
}

function normalizeUserAddress(
  value
) {
  const address =
    Address.parse(
      String(value).trim()
    );

  if (
    address.workChain !== 0
  ) {
    throw new Error(
      "Only basechain wallets are supported."
    );
  }

  return address.toString({
    bounceable: false,
    testOnly: false,
    urlSafe: true
  });
}

function canonicalAddress(
  value
) {
  return Address.parse(
    String(value)
  ).toString({
    bounceable: false,
    testOnly: false,
    urlSafe: true
  });
}

function sameAddress(
  first,
  second
) {
  try {
    return (
      Address.parse(
        String(first)
      ).toRawString() ===
      Address.parse(
        String(second)
      ).toRawString()
    );
  } catch {
    return false;
  }
}

function formatDisplayAddress(
  value
) {
  try {
    return canonicalAddress(
      value
    );
  } catch {
    return String(value);
  }
}

function formatStatus(
  status
) {
  const map = {
    awaiting_amount:
      "Awaiting Amount",
    awaiting_wallet:
      "Awaiting Wallet",
    pending:
      "Pending Payment",
    payment_verified:
      "Payment Verified",
    payout_processing:
      "Payout Processing",
    payout_sent:
      "Payout Sent",
    expired:
      "Expired"
  };

  return (
    map[status] ||
    String(status || "-")
  );
}

function formatTime(
  timestamp
) {
  if (!timestamp) {
    return "-";
  }

  try {
    return new Date(
      Number(timestamp) * 1000
    ).toISOString();
  } catch {
    return "-";
  }
}

/* -------------------------------------------------------------------------- */
/* Payment comment                                                            */
/* -------------------------------------------------------------------------- */

async function createUniquePaymentComment(
  env,
  orderId
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes =
      new Uint8Array(8);

    crypto.getRandomValues(
      bytes
    );

    let suffix = "";

    for (const byte of bytes) {
      suffix += byte
        .toString(16)
        .padStart(2, "0");
    }

    const comment =
      `PTN-${orderId}-${suffix.toUpperCase()}`;

    const existing =
      await env.DB.prepare(
        `SELECT id
         FROM orders
         WHERE payment_comment=?
         LIMIT 1`
      )
        .bind(comment)
        .first();

    if (!existing) {
      return comment;
    }
  }

  throw new Error(
    "Could not generate a unique payment comment."
  );
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function now() {
  return Math.floor(
    Date.now() / 1000
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function isAdmin(
  telegramId
) {
  return (
    String(telegramId) ===
    ADMIN_TELEGRAM_ID
  );
}

function normalizeBase64(
  value
) {
  let text =
    String(value)
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  while (
    text.length % 4
  ) {
    text += "=";
  }

  return text;
}
