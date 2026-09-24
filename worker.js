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

const MAINNET_NETWORK_ID = -239;

const PTN_DECIMALS = 9;
const PTN_PER_GRAM = 1000000n;

const PAYMENT_LOOKBACK_LIMIT = 100;
const ORDER_BATCH_SIZE = 20;

const PAYOUT_TON_AMOUNT = "0.10";
const FORWARD_TON_AMOUNT = 1n;

const PAYOUT_CONFIRM_ATTEMPTS = 5;
const PAYOUT_CONFIRM_DELAY_MS = 2000;

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname === "/") {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "payton-presale",
            network: "mainnet"
          }),
          {
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      return new Response("OK");
    } catch (error) {
      console.error("FETCH ERROR:", error);
      return new Response("Internal error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      processOrders(env).catch(error => {
        console.error("SCHEDULE ERROR:", error);
      })
    );
  }
};

function requireEnv(env, name) {
  const value = String(env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} missing`);
  }

  return value;
}

function normalizeAddress(value) {
  return Address.parse(String(value)).toRawString();
}

function sameAddress(a, b) {
  try {
    return normalizeAddress(a) === normalizeAddress(b);
  } catch {
    return false;
  }
}

function decimalToUnits(value, decimals) {
  const input = String(value).trim();

  if (!input) {
    throw new Error("Invalid decimal value");
  }

  const parts = input.split(".");

  if (parts.length > 2) {
    throw new Error("Invalid decimal value");
  }

  const whole = parts[0] || "0";
  const fraction = parts[1] || "";

  if (
    !/^\d+$/.test(whole) ||
    !/^\d*$/.test(fraction) ||
    fraction.length > decimals
  ) {
    throw new Error("Invalid decimal value");
  }

  const scale = 10n ** BigInt(decimals);

  const paddedFraction = (
    fraction + "0".repeat(decimals)
  ).slice(0, decimals);

  const fractionUnits = paddedFraction
    ? BigInt(paddedFraction)
    : 0n;

  return BigInt(whole) * scale + fractionUnits;
}

function gramToNano(gram) {
  return decimalToUnits(gram, 9);
}

function unitsToDecimal(units, decimals) {
  const scale = 10n ** BigInt(decimals);

  const whole = units / scale;

  const fraction = (units % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return fraction
    ? `${whole}.${fraction}`
    : whole.toString();
}

function gramToPtn(gram) {
  const gramNano = gramToNano(gram);
  const ptnUnits = gramNano * PTN_PER_GRAM;

  return unitsToDecimal(ptnUnits, PTN_DECIMALS);
}

function getOrderCreatedUtime(order) {
  if (order.created_at === null || order.created_at === undefined) {
    return 0;
  }

  const value = String(order.created_at).trim();

  if (/^\d+$/.test(value)) {
    const numeric = Number(value);

    if (numeric > 1000000000000) {
      return Math.floor(numeric / 1000);
    }

    return numeric;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  return Math.floor(timestamp / 1000);
}

function decodeComment(msgData) {
  if (!msgData || typeof msgData !== "string") {
    return "";
  }

  try {
    const cell = Cell.fromBase64(msgData);
    const slice = cell.beginParse();

    if (slice.remainingBits < 32) {
      return "";
    }

    const opcode = slice.loadUint(32);

    if (opcode !== 0) {
      return "";
    }

    const bytes = [];

    function readSnake(currentSlice) {
      while (currentSlice.remainingBits >= 8) {
        bytes.push(currentSlice.loadUint(8));
      }

      while (currentSlice.remainingRefs > 0) {
        const next = currentSlice.loadRef().beginParse();
        readSnake(next);
      }
    }

    readSnake(slice);

    return new TextDecoder()
      .decode(new Uint8Array(bytes))
      .replace(/\0+$/, "")
      .trim();
  } catch {
    return "";
  }
}

function extractOrderIdFromComment(comment) {
  const text = String(comment || "").trim();

  if (!text) {
    return null;
  }

  const patterns = [
    /\border[\s:_#-]*(\d+)\b/i,
    /\bpayton[\s:_#-]*(\d+)\b/i,
    /\bptn[\s:_#-]*(\d+)\b/i,
    /\bpresale[\s:_#-]*(\d+)\b/i,
    /#[\s]*(\d+)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

async function getTonClient(env) {
  const apiKey = requireEnv(env, "TONCENTER_API_KEY");

  return new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey,
    timeout: 30000
  });
}

async function deriveSenderWallet(env) {
  const mnemonic = requireEnv(env, "PTN_MNEMONIC");

  const words = mnemonic.split(/\s+/);

  if (words.length !== 12 && words.length !== 24) {
    throw new Error(
      `PTN_MNEMONIC has invalid word count: ${words.length}`
    );
  }

  const keyPair = await mnemonicToPrivateKey(words);

  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
    walletId: {
      networkGlobalId: MAINNET_NETWORK_ID
    }
  });

  const configuredAddress = requireEnv(
    env,
    "PTN_SENDER_WALLET"
  );

  const derivedAddress = wallet.address.toString({
    bounceable: false,
    testOnly: false,
    urlSafe: true
  });

  const expectedAddress = Address.parse(
    configuredAddress
  ).toString({
    bounceable: false,
    testOnly: false,
    urlSafe: true
  });

  if (derivedAddress !== expectedAddress) {
    throw new Error(
      "Derived sender wallet does not match configured PTN sender wallet"
    );
  }

  return {
    keyPair,
    wallet
  };
}

async function toncenterGet(env, path, params) {
  const apiKey = requireEnv(env, "TONCENTER_API_KEY");

  const url = new URL(
    `https://toncenter.com/api/v3${path}`
  );

  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      "accept": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      `TONCENTER ERROR ${response.status}: ${body}`
    );
  }

  return response.json();
}

async function findInboundPayment(env, order, ambiguous) {
  const expectedNano = gramToNano(order.gram_amount);

  const params = new URLSearchParams();

  params.set(
    "destination",
    String(order.payment_address)
  );

  params.set("direction", "in");
  params.set("exclude_externals", "true");
  params.set(
    "start_utime",
    String(getOrderCreatedUtime(order))
  );
  params.set(
    "limit",
    String(PAYMENT_LOOKBACK_LIMIT)
  );
  params.set("sort", "desc");

  const data = await toncenterGet(
    env,
    "/messages",
    params
  );

  const messages = Array.isArray(data?.messages)
    ? data.messages
    : [];

  for (const message of messages) {
    if (message?.bounced === true) {
      continue;
    }

    if (message?.bounce === true) {
      continue;
    }

    if (
      !message?.destination ||
      !sameAddress(
        message.destination,
        order.payment_address
      )
    ) {
      continue;
    }

    let value;

    try {
      value = BigInt(String(message?.value ?? "0"));
    } catch {
      continue;
    }

    if (value !== expectedNano) {
      continue;
    }

    const comment = decodeComment(
      message?.message_content?.body || ""
    );

    const commentOrderId =
      extractOrderIdFromComment(comment);

    if (commentOrderId === order.id) {
      return {
        txHash:
          message?.in_msg_tx_hash ||
          message?.out_msg_tx_hash ||
          message?.hash ||
          "",
        source: message?.source || "",
        destination: message.destination,
        value,
        comment
      };
    }

    if (!comment && !ambiguous) {
      return {
        txHash:
          message?.in_msg_tx_hash ||
          message?.out_msg_tx_hash ||
          message?.hash ||
          "",
        source: message?.source || "",
        destination: message.destination,
        value,
        comment
      };
    }
  }

  return null;
}

async function isTransactionAlreadyUsed(env, txHash, orderId) {
  if (!txHash) {
    return false;
  }

  const result = await env.DB.prepare(`
    SELECT id
    FROM orders
    WHERE transaction_hash = ?
      AND id != ?
    LIMIT 1
  `)
    .bind(txHash, orderId)
    .first();

  return Boolean(result);
}

async function markPaymentConfirmed(env, orderId, txHash) {
  const result = await env.DB.prepare(`
    UPDATE orders
    SET status = 'payment_confirmed',
        transaction_hash = ?
    WHERE id = ?
      AND status = 'pending'
  `)
    .bind(txHash, orderId)
    .run();

  return result?.meta?.changes === 1;
}

async function createPtnTransferBody(
  order,
  senderWallet,
  amount,
  destination
) {
  return beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(BigInt(order.id), 64)
    .storeCoins(amount)
    .storeAddress(destination)
    .storeAddress(senderWallet.address)
    .storeBit(0)
    .storeCoins(FORWARD_TON_AMOUNT)
    .storeBit(0)
    .endCell();
}

async function findConfirmedJettonPayout(
  env,
  senderOwnerAddress,
  order,
  amount
) {
  const ownerAddress = senderOwnerAddress.toString({
    bounceable: false,
    testOnly: false,
    urlSafe: true
  });

  const jettonMaster = requireEnv(
    env,
    "PTN_MASTER"
  );

  const params = new URLSearchParams();

  params.set("owner_address", ownerAddress);
  params.set("jetton_master", jettonMaster);
  params.set("direction", "out");
  params.set("limit", "100");
  params.set("sort", "desc");

  const data = await toncenterGet(
    env,
    "/jetton/transfers",
    params
  );

  const transfers = Array.isArray(
    data?.jetton_transfers
  )
    ? data.jetton_transfers
    : [];

  for (const transfer of transfers) {
    if (transfer?.transaction_aborted === true) {
      continue;
    }

    if (
      !sameAddress(
        transfer?.jetton_master,
        jettonMaster
      )
    ) {
      continue;
    }

    if (
      !sameAddress(
        transfer?.destination,
        order.payout_destination
      )
    ) {
      continue;
    }

    let queryMatches = false;

    try {
      queryMatches =
        BigInt(
          String(transfer?.query_id ?? "")
        ) === BigInt(order.id);
    } catch {
      queryMatches = false;
    }

    if (!queryMatches) {
      continue;
    }

    try {
      if (
        BigInt(String(transfer?.amount ?? "")) !==
        amount
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const hash =
      transfer?.transaction_hash || "";

    if (hash) {
      return hash;
    }
  }

  return null;
}

async function waitForJettonPayout(
  env,
  senderOwnerAddress,
  order,
  amount
) {
  for (
    let attempt = 0;
    attempt < PAYOUT_CONFIRM_ATTEMPTS;
    attempt++
  ) {
    const hash =
      await findConfirmedJettonPayout(
        env,
        senderOwnerAddress,
        order,
        amount
      );

    if (hash) {
      return hash;
    }

    if (
      attempt <
      PAYOUT_CONFIRM_ATTEMPTS - 1
    ) {
      await new Promise(resolve =>
        setTimeout(
          resolve,
          PAYOUT_CONFIRM_DELAY_MS
        )
      );
    }
  }

  return null;
}

async function sendPtnPayout(
  env,
  order
) {
  const client = await getTonClient(env);

  const {
    keyPair,
    wallet: senderWallet
  } = await deriveSenderWallet(env);

  const destination = Address.parse(
    order.payout_destination
  );

  const amount = decimalToUnits(
    order.ptn_amount,
    PTN_DECIMALS
  );

  if (amount <= 0n) {
    throw new Error(
      `Invalid PTN amount for order ${order.id}`
    );
  }

  const existing =
    await findConfirmedJettonPayout(
      env,
      senderWallet.address,
      order,
      amount
    );

  if (existing) {
    return {
      success: true,
      hash: existing,
      alreadySent: true
    };
  }

  const jettonMaster = client.open(
    JettonMaster.create(
      Address.parse(
        requireEnv(env, "PTN_MASTER")
      )
    )
  );

  const senderJettonWalletAddress =
    await jettonMaster.getWalletAddress(
      senderWallet.address
    );

  const body =
    await createPtnTransferBody(
      order,
      senderWallet,
      amount,
      destination
    );

  const walletContract =
    client.open(senderWallet);

  const seqno =
    await walletContract.getSeqno();

  await walletContract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: senderJettonWalletAddress,
        value: toNano(PAYOUT_TON_AMOUNT),
        bounce: true,
        body
      })
    ],
    sendMode:
      SendMode.PAY_GAS_SEPARATELY
  });

  const confirmedHash =
    await waitForJettonPayout(
      env,
      senderWallet.address,
      order,
      amount
    );

  if (!confirmedHash) {
    throw new Error(
      "PTN transfer was broadcast, but indexed confirmation was not found yet"
    );
  }

  return {
    success: true,
    hash: confirmedHash,
    alreadySent: false
  };
}

async function sendTelegramMessage(
  env,
  chatId,
  text
) {
  const botToken = requireEnv(
    env,
    "TELEGRAM_BOT_TOKEN"
  );

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    }
  );

  if (!response.ok) {
    const body =
      await response.text().catch(() => "");

    throw new Error(
      `TELEGRAM ERROR ${response.status}: ${body}`
    );
  }
}

async function getPendingOrders(env) {
  const result = await env.DB.prepare(`
    SELECT
      id,
      telegram_id,
      gram_amount,
      ptn_amount,
      payment_address,
      transaction_hash,
      status,
      created_at,
      payout_tx_hash
    FROM orders
    WHERE status IN (
      'pending',
      'payment_confirmed',
      'payout_processing'
    )
    ORDER BY id ASC
    LIMIT ?
  `)
    .bind(ORDER_BATCH_SIZE)
    .all();

  return Array.isArray(result?.results)
    ? result.results
    : [];
}

function buildAmbiguousMap(orders) {
  const map = new Map();

  for (const order of orders) {
    if (
      order.status !== "pending" ||
      !order.payment_address
    ) {
      continue;
    }

    let key;

    try {
      key = `${normalizeAddress(
        order.payment_address
      )}:${gramToNano(
        order.gram_amount
      ).toString()}`;
    } catch {
      continue;
    }

    map.set(
      key,
      (map.get(key) || 0) + 1
    );
  }

  return map;
}

async function processPendingOrder(
  env,
  order,
  ambiguousMap
) {
  const paymentKey =
    `${normalizeAddress(
      order.payment_address
    )}:${gramToNano(
      order.gram_amount
    ).toString()}`;

  const ambiguous =
    (ambiguousMap.get(paymentKey) || 0) > 1;

  const payment =
    await findInboundPayment(
      env,
      order,
      ambiguous
    );

  if (!payment) {
    return false;
  }

  if (!payment.txHash) {
    return false;
  }

  const alreadyUsed =
    await isTransactionAlreadyUsed(
      env,
      payment.txHash,
      order.id
    );

  if (alreadyUsed) {
    console.warn(
      "PAYMENT TRANSACTION ALREADY USED:",
      order.id,
      payment.txHash
    );

    return false;
  }

  if (!payment.source) {
    console.error(
      "PAYMENT SOURCE MISSING:",
      order.id
    );

    return false;
  }

  const claimed =
    await markPaymentConfirmed(
      env,
      order.id,
      payment.txHash
    );

  if (!claimed) {
    return false;
  }

  order.status = "payment_confirmed";
  order.transaction_hash =
    payment.txHash;

  order.payout_destination =
    payment.source;

  console.log(
    "PAYMENT CONFIRMED:",
    {
      orderId: order.id,
      txHash: payment.txHash,
      source: payment.source,
      gramAmount: order.gram_amount,
      ptnAmount: order.ptn_amount
    }
  );

  try {
    await sendTelegramMessage(
      env,
      order.telegram_id,
      `Payment confirmed for Order #${order.id}.\n\nGRAM: ${order.gram_amount}\nPTN: ${order.ptn_amount}\n\nPTN payout is being processed.`
    );
  } catch (error) {
    console.error(
      "PAYMENT TELEGRAM ERROR:",
      error
    );
  }

  return true;
}

async function claimPayoutProcessing(
  env,
  orderId
) {
  const result = await env.DB.prepare(`
    UPDATE orders
    SET status = 'payout_processing'
    WHERE id = ?
      AND status = 'payment_confirmed'
  `)
    .bind(orderId)
    .run();

  return result?.meta?.changes === 1;
}

async function markPayoutSent(
  env,
  orderId,
  payoutHash
) {
  const result = await env.DB.prepare(`
    UPDATE orders
    SET status = 'payout_sent',
        payout_tx_hash = ?
    WHERE id = ?
      AND status = 'payout_processing'
  `)
    .bind(payoutHash, orderId)
    .run();

  return result?.meta?.changes === 1;
}

async function processPayoutOrder(
  env,
  order
) {
  if (
    order.status !==
      "payment_confirmed" &&
    order.status !==
      "payout_processing"
  ) {
    return;
  }

  if (!order.payout_destination) {
    if (!order.transaction_hash) {
      throw new Error(
        `Order ${order.id} has no payment transaction hash`
      );
    }

    const paymentAddress =
      Address.parse(
        order.payment_address
      );

    const paymentParams =
      new URLSearchParams();

    paymentParams.set(
      "msg_hash",
      order.transaction_hash
    );

    const paymentData =
      await toncenterGet(
        env,
        "/messages",
        paymentParams
      );

    const paymentMessages =
      Array.isArray(
        paymentData?.messages
      )
        ? paymentData.messages
        : [];

    let source = "";

    for (const message of paymentMessages) {
      if (
        message?.source &&
        sameAddress(
          message.destination,
          order.payment_address
        )
      ) {
        source = message.source;
        break;
      }
    }

    if (!source) {
      throw new Error(
        `Unable to resolve payout destination for order ${order.id}`
      );
    }

    order.payout_destination =
      source;
  }

  if (
    order.status ===
    "payment_confirmed"
  ) {
    const claimed =
      await claimPayoutProcessing(
        env,
        order.id
      );

    if (!claimed) {
      return;
    }

    order.status =
      "payout_processing";
  }

  if (
    order.status !==
    "payout_processing"
  ) {
    return;
  }

  const result =
    await sendPtnPayout(
      env,
      order
    );

  if (!result.success) {
    throw new Error(
      `PTN payout failed for order ${order.id}`
    );
  }

  const marked =
    await markPayoutSent(
      env,
      order.id,
      result.hash
    );

  if (!marked) {
    throw new Error(
      `Could not mark payout_sent for order ${order.id}`
    );
  }

  console.log(
    "PAYOUT CONFIRMED:",
    {
      orderId: order.id,
      ptnAmount: order.ptn_amount,
      destination:
        order.payout_destination,
      payoutHash: result.hash
    }
  );

  try {
    await sendTelegramMessage(
      env,
      order.telegram_id,
      `PTN payout completed successfully.\n\nOrder: #${order.id}\nGRAM: ${order.gram_amount}\nPTN: ${order.ptn_amount}\n\nTransaction:\n${result.hash}`
    );
  } catch (error) {
    console.error(
      "PAYOUT TELEGRAM ERROR:",
      error
    );
  }
}

async function processOrders(env) {
  const orders =
    await getPendingOrders(env);

  if (!orders.length) {
    console.log(
      "NO ORDERS TO PROCESS"
    );

    return;
  }

  console.log(
    "ORDERS FOUND:",
    orders.length
  );

  const ambiguousMap =
    buildAmbiguousMap(orders);

  for (const order of orders) {
    try {
      if (
        order.status === "pending"
      ) {
        await processPendingOrder(
          env,
          order,
          ambiguousMap
        );
      }

      if (
        order.status ===
          "payment_confirmed" ||
        order.status ===
          "payout_processing"
      ) {
        if (
          !order.payout_destination
        ) {
          order.payout_destination =
            null;
        }

        await processPayoutOrder(
          env,
          order
        );
      }
    } catch (error) {
      console.error(
        "ORDER PROCESSING ERROR:",
        {
          orderId: order.id,
          status: order.status,
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );
    }
  }
}
