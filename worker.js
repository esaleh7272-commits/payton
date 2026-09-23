import{Buffer}from"buffer";import{Address,beginCell,internal,SendMode,toNano,Cell}from"@ton/core";import{TonClient,WalletContractV5R1,JettonMaster}from"@ton/ton";import{keyPairFromSeed}from"@ton/crypto";globalThis.Buffer=Buffer;

/* =========================================================
   CLOUDFLARE WORKER TON MNEMONIC DERIVATION
========================================================= */

async function tonMnemonicToPrivateKeyWorker(words){
const normalized=words.map(word=>word.toLowerCase().trim());
const mnemonicText=normalized.join(" ");
const encoder=new TextEncoder();

const hmacKey=await crypto.subtle.importKey(
"raw",
encoder.encode(mnemonicText),
{name:"HMAC",hash:"SHA-512"},
false,
["sign"]
);

const entropy=new Uint8Array(
await crypto.subtle.sign(
"HMAC",
hmacKey,
encoder.encode("")
)
);

const pbkdfKey=await crypto.subtle.importKey(
"raw",
entropy,
"PBKDF2",
false,
["deriveBits"]
);

const seed=new Uint8Array(
await crypto.subtle.deriveBits(
{
name:"PBKDF2",
hash:"SHA-512",
salt:encoder.encode("TON default seed"),
iterations:100000
},
pbkdfKey,
512
)
);

const keyPair=keyPairFromSeed(
Buffer.from(seed.slice(0,32))
);

return{
publicKey:Buffer.from(keyPair.publicKey),
secretKey:Buffer.from(keyPair.secretKey)
};
}

/* =========================================================
   PAYTON CONFIG
========================================================= */

const WELCOME=`🦊 Welcome to PAYTON (PTN)

Welcome to the official PAYTON presale.

💰 Payment: GRAM

Presale Price: 1,000,000 PTN = 1 GRAM

Choose an option below:`;

const MENU={
inline_keyboard:[
[{text:"🪙 Buy PTN",callback_data:"buy"}],
[{text:"💰 Price",callback_data:"price"}],
[{text:"📋 My Orders",callback_data:"orders"}],
[{text:"💬 Support",callback_data:"support"}]
]
};

const BACK={
inline_keyboard:[
[{text:"⬅️ Back",callback_data:"home"}]
]
};

/* =========================================================
   ADMIN
========================================================= */

const ADMIN_TELEGRAM_ID="113074274";

const ADMIN_BACK={
inline_keyboard:[
[{text:"⬅️ Admin Panel",callback_data:"admin_home"}]
]
};

/* =========================================================
   PRESALE CONFIG
========================================================= */

const PTN_MASTER="EQAZ_Rw9M91opByfYz1edG0TbeAKP72WcdccprkZvbvPVkAZ";

const PTN_SENDER_WALLET="UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const GRAM_RECEIVING_WALLET="UQB9E73FFG6ql1XwXjt5XXBXi0Xss6zWh1xaJcow1HWaE4IT";

const PTN_DECIMALS=9;

const PTN_PER_GRAM=1000000n;

const MIN_SENDER_TON_BALANCE=toNano("0.20");

/* =========================================================
   SUPPORT QUICK REPLIES
========================================================= */

const QUICK_REPLIES=[
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
"❌ Your order could not be completed."
];

/* =========================================================
   HELPERS
========================================================= */

function formatNumber(value){
return Number(value).toLocaleString("en-US");
}

function gramToNano(value){
const s=String(value).trim();
const [a,b=""]=s.split(".");
return(BigInt(a||"0")*1000000000n)+BigInt((b+"000000000").slice(0,9));
}

async function telegram(env,method,payload){
const token=env.BOT_TOKEN;
if(!token)throw new Error("BOT_TOKEN missing");

const r=await fetch(
`https://api.telegram.org/bot${token}/${method}`,
{
method:"POST",
headers:{"content-type":"application/json"},
body:JSON.stringify(payload)
}
);

const data=await r.json();

if(!data.ok){
throw new Error(
`Telegram ${method} failed: ${JSON.stringify(data)}`
);
}

return data.result;
}

async function editMessage(env,query,text,reply_markup){
return telegram(
env,
"editMessageText",
{
chat_id:query.message.chat.id,
message_id:query.message.message_id,
text,
reply_markup
}
);
}

/* =========================================================
   USERS
========================================================= */

async function upsertUser(env,user){
await env.DB.prepare(`
INSERT INTO users
(telegram_id,username,first_name,last_name,created_at)
VALUES(?,?,?,?,CURRENT_TIMESTAMP)
ON CONFLICT(telegram_id)
DO UPDATE SET
username=excluded.username,
first_name=excluded.first_name,
last_name=excluded.last_name
`)
.bind(
String(user.id),
user.username||null,
user.first_name||null,
user.last_name||null
)
.run();
}

/* =========================================================
   ORDER CREATION
========================================================= */

async function createInitialOrder(env,telegramId){

const existing=await env.DB.prepare(`
SELECT id
FROM orders
WHERE telegram_id=?
AND status='awaiting_amount'
LIMIT 1
`)
.bind(String(telegramId))
.first();

if(existing)return existing;

return env.DB.prepare(`
INSERT INTO orders
(telegram_id,status,created_at)
VALUES(?,'awaiting_amount',CURRENT_TIMESTAMP)
RETURNING *
`)
.bind(String(telegramId))
.first();
}

/* =========================================================
   SUPPORT
========================================================= */

async function createSupportRequest(env,user){
await env.DB.prepare(`
INSERT INTO support_messages
(telegram_id,message,status,created_at)
VALUES(? ,? ,'open',CURRENT_TIMESTAMP)
`)
.bind(
String(user.id),
""
)
.run();
}

/* =========================================================
   USER MESSAGE HANDLER
========================================================= */

async function handleUserMessage(message,env){

const chatId=message.chat.id;
const text=String(message.text||"").trim();

if(!text)return;

await upsertUser(env,message.from);

const order=await env.DB.prepare(`
SELECT *
FROM orders
WHERE telegram_id=?
AND status='awaiting_amount'
ORDER BY id DESC
LIMIT 1
`)
.bind(String(chatId))
.first();

if(
order&&
/^[0-9]+(?:\.[0-9]+)?$/.test(text)
){

const gram=Number(text);

if(!(gram>0)){
await telegram(
env,
"sendMessage",
{
chat_id:chatId,
text:"Please enter a valid GRAM amount.",
reply_markup:BACK
}
);
return;
}

const ptn=BigInt(
Math.round(gram*1000000)
);

const paymentAddress=String(chatId);

await env.DB.prepare(`
UPDATE orders
SET gram_amount=?,
ptn_amount=?,
payment_address=?,
status='pending'
WHERE id=?
`)
.bind(
gram,
String(ptn),
paymentAddress,
order.id
)
.run();

await telegram(
env,
"sendMessage",
{
chat_id:chatId,
text:
`🪙 Order #${order.id}\n\n`+
`Amount: ${gram} GRAM\n`+
`PTN: ${formatNumber(ptn)}\n\n`+
`Send exactly: ${gram} GRAM\n`+
`Payment comment: PAYTON-${order.id}\n\n`+
`Payment address:\n${GRAM_RECEIVING_WALLET}`,
reply_markup:BACK
}
);

return;
}

await telegram(
env,
"sendMessage",
{
chat_id:chatId,
text:"Please use the menu below.",
reply_markup:MENU
}
);
}

/* =========================================================
   USER ORDERS
========================================================= */

async function showUserOrders(env,query){

const rows=await env.DB.prepare(`
SELECT *
FROM orders
WHERE telegram_id=?
ORDER BY id DESC
LIMIT 10
`)
.bind(String(query.from.id))
.all();

let text="📋 My Orders\n\n";

if(!rows.results?.length){

text+="No orders found.";

}else{

for(const o of rows.results){

text+=
`#${o.id} — `+
`${o.gram_amount||"-"} GRAM — `+
`${formatNumber(o.ptn_amount||0)} PTN — `+
`${o.status}\n`;

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
   USER CALLBACK
========================================================= */

async function handleUserCallback(query,env){

const data=String(query.data||"");
const chatId=query.message.chat.id;

await telegram(
env,
"answerCallbackQuery",
{
callback_query_id:query.id
}
);

if(data==="home"){

await editMessage(
env,
query,
WELCOME,
MENU
);

return;
}

if(data==="buy"){

await upsertUser(
env,
query.from
);

await telegram(
env,
"sendMessage",
{
chat_id:chatId,
text:
"🪙 Buy PTN\n\n"+
"Please enter the amount of GRAM you want to pay.\n\n"+
"Example:\n\n"+
"10\n\n"+
"You will receive 10,000,000 PTN.",
reply_markup:BACK
}
);

await createInitialOrder(
env,
chatId
);

return;
}

if(data==="price"){

await editMessage(
env,
query,
"💰 PAYTON (PTN) Presale Price\n\n1 GRAM = 1,000,000 PTN",
BACK
);

return;
}

if(data==="orders"){

await showUserOrders(
env,
query
);

return;
}

if(data==="support"){

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
   PAYMENT SEARCH
========================================================= */

function getOrderCreatedUtime(createdAt){

if(!createdAt)return null;

const t=Date.parse(
String(createdAt).replace(" ","T")+"Z"
);

if(Number.isNaN(t))return null;

return Math.floor(t/1000);
}

async function findPayment(env,order){

if(!order.payment_address){
return null;
}

const apiKey=env.TONCENTER_API_KEY;

if(!apiKey){

console.error(
"TONCENTER_API_KEY missing"
);

return null;
}

const expectedAmount=BigInt(
gramToNano(order.gram_amount)
);

const orderCreatedUtime=
getOrderCreatedUtime(
order.created_at
);

if(orderCreatedUtime===null){

console.error(
`ORDER ${order.id}: invalid created_at`
);

return null;
}

const startUtime=Math.max(
0,
orderCreatedUtime-30
);

let offset=0;

for(let page=0;page<10;page++){

const u=new URL(
"https://toncenter.com/api/v3/messages"
);

u.searchParams.set(
"destination",
GRAM_RECEIVING_WALLET
);

u.searchParams.set(
"start_utime",
String(startUtime)
);

u.searchParams.set(
"limit",
"1000"
);

u.searchParams.set(
"offset",
String(offset)
);

u.searchParams.set(
"api_key",
apiKey
);

const r=await fetch(u);

if(!r.ok){

throw new Error(
`TON Center HTTP ${r.status}`
);

}

const d=await r.json();

const messages=d.messages||[];

for(const m of messages){

const value=BigInt(
m.value||0
);

if(value!==expectedAmount)continue;

const body=JSON.stringify(m);

if(!body.includes(
`PAYTON-${order.id}`
))continue;

const hash=
m.transaction_id?.hash||
m.hash||
null;

if(hash){
return{hash};
}

}

if(messages.length<1000){
break;
}

offset+=1000;
}

return null;
}

/* =========================================================
   FIND EXISTING PAYOUT
========================================================= */

async function findExistingPayout(
client,
senderWalletAddress,
queryId
){

try{

const txs=
await client.getTransactions(
senderWalletAddress,
{
limit:100
}
);

for(const tx of txs){

const boc=
tx.raw?.in_msg?.body||
"";

if(
boc&&
String(boc).includes(
String(queryId)
)
){

return tx.hash?.toString?.()||
tx.hash||
null;

}

}

}catch(error){

console.error(
"findExistingPayout error:",
error
);

}

return null;
}

/* =========================================================
   PTN PAYOUT
========================================================= */

async function sendPTN(env,order){

try{

const mnemonic=
env.PTN_MNEMONIC;

if(!mnemonic){

throw new Error(
"PTN_MNEMONIC missing"
);

}

const words=
mnemonic
.trim()
.split(/\s+/);

console.log(
`PTN MNEMONIC CHECK: present=${Boolean(mnemonic)} words=${words.length}`
);

if(
words.length!==12&&
words.length!==24
){

throw new Error(
`PTN_MNEMONIC has invalid word count: ${words.length}`
);

}

/*
  IMPORTANT:

  Do NOT use @ton/crypto mnemonicValidate()
  or mnemonicToPrivateKey() here.

  Cloudflare Worker's bundled browser path
  was failing with:

  ReferenceError: window is not defined

  We now derive the TON key using the
  Worker Web Crypto API.
*/

console.log(
"PTN MNEMONIC CHECK: using Cloudflare WebCrypto derivation"
);

const keyPair=
await tonMnemonicToPrivateKeyWorker(
words
);

console.log(
"PTN MNEMONIC CHECK: key derivation succeeded"
);

const client=
new TonClient({
endpoint:
"https://toncenter.com/api/v2/jsonRPC",
apiKey:
env.TONCENTER_API_KEY
});

const senderWallet=
WalletContractV5R1.create({
workchain:0,
publicKey:keyPair.publicKey
});

const derivedAddress=
senderWallet.address.toString();

console.log(
`PTN MNEMONIC CHECK: derived wallet=${derivedAddress}`
);

if(
derivedAddress!==PTN_SENDER_WALLET
){

throw new Error(
"Derived sender wallet does not match configured PTN sender wallet"
);

}

console.log(
"PTN MNEMONIC CHECK: sender wallet matches"
);

const wallet=
client.open(
senderWallet
);

const deployed=
await client.isContractDeployed(
senderWallet.address
);

if(!deployed){

throw new Error(
"PTN sender wallet is not initialized/deployed"
);

}

const balance=
await client.getBalance(
senderWallet.address
);

if(
balance<
MIN_SENDER_TON_BALANCE
){

throw new Error(
"Insufficient native TON balance for payout"
);

}

const master=
client.open(
JettonMaster.create(
Address.parse(
PTN_MASTER
)
)
);

const senderJettonWallet=
client.open(
await master.getWalletAddress(
senderWallet.address
)
);

const senderJettonBalance=
await senderJettonWallet.getJettonBalance();

const amount=
BigInt(order.ptn_amount)*
10n**BigInt(
PTN_DECIMALS
);

if(
senderJettonBalance<
amount
){

throw new Error(
"Insufficient PTN balance"
);

}

/*
  Idempotency:
  query_id = order.id
*/

const existing=
await findExistingPayout(
client,
senderWallet.address,
BigInt(order.id)
);

if(existing){

return{
success:true,
hash:existing
};

}

const destination=
Address.parse(
order.payment_address
);

const destinationJettonWallet=
await master.getWalletAddress(
destination
);

const body=
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

const seqno=
await wallet.getSeqno();

await wallet.sendTransfer({
seqno,
secretKey:keyPair.secretKey,
sendMode:
SendMode.PAY_GAS_SEPARATELY+
SendMode.IGNORE_ERRORS,
messages:[
internal({
to:
destinationJettonWallet,
value:
toNano("0.10"),
body
})
]
});

return{
success:true,
hash:null
};

}catch(error){

console.error(
`PTN PAYOUT ERROR ORDER ${order.id}: ${error?.name||"Error"}: ${error?.message||String(error)}\n${error?.stack||""}`
);

await env.DB.prepare(`
UPDATE orders
SET status='payment_verified'
WHERE id=?
AND status='payment_verified'
`)
.bind(order.id)
.run();

await telegram(
env,
"sendMessage",
{
chat_id:order.telegram_id,
text:
"⚠️ Your payment has been verified, but the PTN transfer could not be completed yet.\n\n"+
"Your payment is safe and the system will retry the PTN transfer automatically."
}
);

return{
success:false,
error:String(error)
};

}
}

/* =========================================================
   PROCESS ORDERS
========================================================= */

async function processOrders(env){

const rows=
await env.DB.prepare(`
SELECT *
FROM orders
WHERE status IN (
'pending',
'payment_verified'
)
ORDER BY id ASC
LIMIT 20
`)
.all();

for(
const order of rows.results||[]
){

try{

if(
order.status==="pending"
){

const payment=
await findPayment(
env,
order
);

if(!payment){
continue;
}

const alreadyUsed=
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

if(alreadyUsed){

await env.DB.prepare(`
UPDATE orders
SET status='payment_duplicate'
WHERE id=?
`)
.bind(order.id)
.run();

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

await telegram(
env,
"sendMessage",
{
chat_id:order.telegram_id,
text:
"✅ Payment verified successfully.\n\n"+
`Order #${order.id}\n`+
`GRAM received: ${formatNumber(order.gram_amount)}\n`+
`PTN amount: ${formatNumber(order.ptn_amount)}\n\n`+
"Your PTN tokens are now being sent automatically."
}
);

}

if(
order.status==="payment_verified"
){

const freshOrder=
await env.DB.prepare(`
SELECT *
FROM orders
WHERE id=?
LIMIT 1
`)
.bind(order.id)
.first();

if(!freshOrder){
continue;
}

const payout=
await sendPTN(
env,
freshOrder
);

if(payout?.success){

await env.DB.prepare(`
UPDATE orders
SET status='payout_sent'
WHERE id=?
`)
.bind(order.id)
.run();

await telegram(
env,
"sendMessage",
{
chat_id:order.telegram_id,
text:
"🎉 Order completed successfully!\n\n"+
`Order #${order.id}\n`+
`${formatNumber(order.ptn_amount)} PTN has been sent to your wallet.\n\n`+
`Transaction:\n${payout.hash||"Submitted to blockchain"}`
}
);

}

}

}catch(error){

console.error(
`ORDER ${order.id} ERROR: ${error?.name||"Error"}: ${error?.message||String(error)}\n${error?.stack||""}`
);

}

}
}

/* =========================================================
   ADMIN
========================================================= */

async function getAdminMenu(env){

return{
inline_keyboard:[
[
{
text:"📊 Dashboard",
callback_data:"admin_dashboard"
}
],
[
{
text:"📋 Orders",
callback_data:"admin_orders"
}
],
[
{
text:"⏳ Pending",
callback_data:"admin_pending"
}
],
[
{
text:"👥 Users",
callback_data:"admin_users"
}
]
]
};
}

async function showAdminDashboard(env,query){

const r=
await env.DB.prepare(`
SELECT
COUNT(*) c,
COALESCE(SUM(gram_amount),0) grams,
COALESCE(SUM(ptn_amount),0) ptn
FROM orders
WHERE status='payout_sent'
`)
.first();

await editMessage(
env,
query,
`📊 Dashboard\n\n`+
`Completed orders: ${r?.c||0}\n`+
`GRAM sold: ${r?.grams||0}\n`+
`PTN sold: ${formatNumber(r?.ptn||0)}`,
ADMIN_BACK
);
}

async function showAdminOrders(env,query){

const rows=
await env.DB.prepare(`
SELECT *
FROM orders
ORDER BY id DESC
LIMIT 20
`)
.all();

let text=
"📋 Orders\n\n";

for(
const o of rows.results||[]
){

text+=
`#${o.id} | `+
`${o.telegram_id} | `+
`${o.gram_amount||"-"} GRAM | `+
`${formatNumber(o.ptn_amount||0)} PTN | `+
`${o.status}\n`;

}

await editMessage(
env,
query,
text,
ADMIN_BACK
);
}

async function showAdminPending(env,query){

const rows=
await env.DB.prepare(`
SELECT *
FROM orders
WHERE status IN (
'pending',
'payment_verified'
)
ORDER BY id ASC
`)
.all();

let text=
"⏳ Pending Orders\n\n";

for(
const o of rows.results||[]
){

text+=
`#${o.id} | `+
`${o.gram_amount||"-"} GRAM | `+
`${o.status}\n`;

}

if(
!(rows.results||[]).length
){

text+="No pending orders.";

}

await editMessage(
env,
query,
text,
ADMIN_BACK
);
}

async function showAdminUsers(env,query){

const rows=
await env.DB.prepare(`
SELECT *
FROM users
ORDER BY created_at DESC
LIMIT 30
`)
.all();

let text=
"👥 Users\n\n";

for(
const u of rows.results||[]
){

text+=
`${u.telegram_id} | `+
`${u.username||u.first_name||"-"}\n`;

}

await editMessage(
env,
query,
text,
ADMIN_BACK
);
}

async function showAdminUser(
env,
query,
telegramId
){

const orders=
await env.DB.prepare(`
SELECT *
FROM orders
WHERE telegram_id=?
ORDER BY id DESC
LIMIT 10
`)
.bind(telegramId)
.all();

let text=
`👤 User ${telegramId}\n\n`;

for(
const o of orders.results||[]
){

text+=
`#${o.id} | `+
`${o.gram_amount||"-"} GRAM | `+
`${o.status}\n`;

}

if(
!(orders.results||[]).length
){

text+="No orders.";

}

await editMessage(
env,
query,
text,
ADMIN_BACK
);
}

async function blockUser(
env,
query,
telegramId,
days
){

if(!telegramId)return;

await env.DB.prepare(`
UPDATE users
SET blocked_until=datetime(
'now',
?
)
WHERE telegram_id=?
`)
.bind(
`+${days} day`,
telegramId
)
.run();

await telegram(
env,
"sendMessage",
{
chat_id:telegramId,
text:
"⚠️ Your access to the PAYTON bot has been temporarily restricted."
}
);

await editMessage(
env,
query,
"✅ User blocked.",
ADMIN_BACK
);
}

/* =========================================================
   ADMIN CALLBACK
========================================================= */

async function handleAdminCallback(
query,
env
){

const data=
String(query.data||"");

await telegram(
env,
"answerCallbackQuery",
{
callback_query_id:query.id
}
);

if(data==="admin_home"){

await editMessage(
env,
query,
"🛠 PAYTON Admin Panel",
await getAdminMenu(env)
);

return;
}

if(data==="admin_dashboard"){

await showAdminDashboard(
env,
query
);

return;
}

if(data==="admin_orders"){

await showAdminOrders(
env,
query
);

return;
}

if(data==="admin_pending"){

await showAdminPending(
env,
query
);

return;
}

if(data==="admin_users"){

await showAdminUsers(
env,
query
);

return;
}

if(data.startsWith("admin_user_")){

const telegramId=
data.replace(
"admin_user_",
""
);

if(telegramId){

await showAdminUser(
env,
query,
telegramId
);

}

return;
}

if(data.startsWith("admin_ub1_")){

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

if(data.startsWith("admin_ub3_")){

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
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default{

async fetch(request,env){

try{

if(request.method!=="POST"){

return new Response("OK");

}

const update=
await request.json();

if(update.callback_query){

if(
String(update.callback_query.from?.id)===
ADMIN_TELEGRAM_ID&&
String(update.callback_query.data||"").startsWith("admin_")
){

await handleAdminCallback(
update.callback_query,
env
);

}else{

await handleUserCallback(
update.callback_query,
env
);

}

}else if(update.message){

if(
String(update.message.from?.id)===
ADMIN_TELEGRAM_ID&&
update.message.text==="/admin"
){

await telegram(
env,
"sendMessage",
{
chat_id:update.message.chat.id,
text:"🛠 PAYTON Admin Panel",
reply_markup:
await getAdminMenu(env)
}
);

}else{

await handleUserMessage(
update.message,
env
);

}

}

return new Response("OK");

}catch(error){

console.error(
"FETCH ERROR:",
error
);

return new Response("OK");

}

},

async scheduled(event,env,ctx){

ctx.waitUntil(
processOrders(env)
);

}

};
