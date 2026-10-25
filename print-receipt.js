import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Setup ---------- */
const ADMIN_EMAIL = "chanchan.tumulak@gmail.com";
const BRAND = "CJ Finds";
const ORDER_PREFIX = "051026-";

// Where buyers open the receipt. Leave empty to use receipt.html next to this page.
// When your site is online, set it to the live address, for example:
// const RECEIPT_BASE_URL = "https://your-site.com/receipt.html";
const RECEIPT_BASE_URL = "";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const form = $("form");
const orderInput = $("orderId");
const printBtn = $("printBtn");
const msg = $("msg");
const result = $("result");
const linkBox = $("linkBox");
const copyBtn = $("copyBtn");

let authReady = false;
let isAdmin = false;

/* ---------- Helpers ---------- */
function say(html, kind = "") {
  msg.innerHTML = html;
  msg.className = "msg" + (kind ? " msg-" + kind : "");
  msg.hidden = !html;
}

const NOT_ADMIN_HTML =
  'Sign in as the admin first on the <a href="admin-orders.html">Orders page</a>, then come back here.';

// Same way admin-orders.js decides what "the same item" is
const itemKey = (it) =>
  it && typeof it === "object"
    ? String(it.id ?? it.productId ?? it.name ?? it.title ?? "").trim().toLowerCase()
    : String(it ?? "").trim().toLowerCase();

const orderLabel = (o) =>
  o.orderSeq != null ? ORDER_PREFIX + o.orderSeq : o.orderNo || "";

// A long random code nobody can guess (about 120 bits)
function makeToken() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function buildLink(token) {
  const base = RECEIPT_BASE_URL || new URL("receipt.html", location.href).href;
  const url = new URL(base);
  url.searchParams.set("r", token);
  return url.href;
}

function toLine(it) {
  if (it === null || typeof it !== "object") {
    return { name: String(it ?? "Item"), qty: 1, price: null, extras: "" };
  }
  const price = Number(it.price);
  return {
    name: String(it.name || it.title || "Item"),
    qty: Number(it.qty ?? it.quantity ?? 1) || 1,
    price: it.price != null && Number.isFinite(price) ? price : null,
    extras: [it.size, it.color, it.condition].filter(Boolean).join(", "),
  };
}

// The receipt is a copy of only what the buyer needs to see.
// No address, phone or email goes into it.
function buildReceipt(orderId, o) {
  const items = Array.isArray(o.items) ? o.items : [];

  // If the order was completed with ticked items, the receipt lists only those
  const kept =
    o.status === "COMPLETED" && Array.isArray(o.completedKeys) && o.completedKeys.length
      ? new Set(o.completedKeys)
      : null;
  const bought = kept ? items.filter((it) => kept.has(itemKey(it))) : items;
  const lines = bought.map(toLine);

  const sum = lines.reduce((s, l) => s + (l.price != null ? l.price * l.qty : 0), 0);
  const useSum = kept && bought.length !== items.length;
  const total = useSum ? sum : Number.isFinite(Number(o.total)) ? Number(o.total) : sum;

  return {
    brand: BRAND,
    orderId,
    orderNo: orderLabel(o),
    items: lines,
    total,
    orderedAt: o.createdAt || null,
    issuedAt: serverTimestamp(),
  };
}

/* ---------- Auth (shares the sign-in from the Orders page) ---------- */
onAuthStateChanged(auth, (user) => {
  authReady = true;
  isAdmin =
    !!user && user.emailVerified && (user.email || "").toLowerCase() === ADMIN_EMAIL;
  if (!isAdmin) say(NOT_ADMIN_HTML);
  else if (msg.innerHTML === NOT_ADMIN_HTML) say("");
});

/* ---------- Print Receipt ---------- */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  result.hidden = true;

  const id = orderInput.value.trim();
  if (!id) return say("Enter an order ID.", "error");
  if (id.includes("/")) return say("That doesn't look like an order ID.", "error");
  if (!authReady) return say("One moment, checking your sign-in…");
  if (!isAdmin) return say(NOT_ADMIN_HTML, "error");

  printBtn.disabled = true;
  say("Looking for the order…");

  try {
    const snap = await getDoc(doc(db, "orders", id));
    if (!snap.exists()) {
      say("No order found with that ID.", "error");
      return;
    }

    const token = makeToken();
    await setDoc(doc(db, "receipts", token), buildReceipt(id, snap.data()));

    const link = buildLink(token);
    linkBox.value = link;
    result.hidden = false;
    linkBox.select();

    let copied = false;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch (_) { /* the Copy button still works */ }
    say(copied ? "Receipt ready. Link copied, send it to the buyer." : "Receipt ready. Copy the link and send it to the buyer.", "ok");
  } catch (err) {
    console.error(err);
    say(
      err.code === "permission-denied"
        ? "Firestore denied access. Publish the updated firestore.rules, then try again."
        : "Something went wrong. Check your connection and try again.",
      "error"
    );
  } finally {
    printBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  linkBox.select();
  try {
    await navigator.clipboard.writeText(linkBox.value);
    say("Link copied.", "ok");
  } catch (_) {
    document.execCommand("copy");
    say("Link copied.", "ok");
  }
});
linkBox.addEventListener("focus", () => linkBox.select());
