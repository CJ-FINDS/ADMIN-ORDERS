import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  getDoc,
  setDoc,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Setup ---------- */
const ORDER_PREFIX = "051026-";
// "051026-3", built from the order's number (older orders have none)
const orderLabel = (o) =>
  o.orderSeq != null ? ORDER_PREFIX + o.orderSeq : o.orderNo || "";
const ADMIN_EMAIL = "chanchan.tumulak@gmail.com";
const TZ = "Asia/Manila"; // Philippine time, UTC+8 (no daylight saving)
const MAX_ORDERS = 500;

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const el = {
  loginView: $("loginView"),
  deniedView: $("deniedView"),
  appView: $("appView"),
  who: $("who"),
  whoEmail: $("whoEmail"),
  loginForm: $("loginForm"),
  loginEmail: $("loginEmail"),
  loginPassword: $("loginPassword"),
  loginBtn: $("loginBtn"),
  loginMsg: $("loginMsg"),
  deniedText: $("deniedText"),
  fromDate: $("fromDate"),
  toDate: $("toDate"),
  statusFilter: $("statusFilter"),
  searchBox: $("searchBox"),
  itemBox: $("itemBox"),
  applyBtn: $("applyBtn"),
  chips: $("chips"),
  sumCount: $("sumCount"),
  sumTotal: $("sumTotal"),
  sumPending: $("sumPending"),
  listMsg: $("listMsg"),
  orders: $("orders"),
  toast: $("toast"),
};

let allOrders = []; // orders returned by the last Firestore query
let soldMap = new Map(); // soldItems document id -> { orderId, orderNo, name }
const newIds = new Set(); // new orders that haven't been opened yet (they keep the chime ringing)
let stopWatch = null; // unsubscribe function for the live order listener
const picks = new Map(); // order id -> Set of ticked item keys (kept while you filter or search)

/* ---------- Helpers ---------- */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

const peso = (n) =>
  "₱" + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });

// Identifies "the same item" across orders: product id if the order saved one, else the name
const itemKey = (it) =>
  it && typeof it === "object"
    ? String(it.id ?? it.productId ?? it.name ?? it.title ?? "").trim().toLowerCase()
    : String(it ?? "").trim().toLowerCase();

// Document id for a sold item. Keep identical to soldDocId in order-status.js
const soldDocId = (key) => "i_" + encodeURIComponent(key).slice(0, 400);

// "YYYY-MM-DD" for a Date, as seen in Philippine time
const manilaYMD = (d = new Date()) =>
  d.toLocaleDateString("en-CA", { timeZone: TZ });

const addDays = (ymd, n) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Start of a Philippine calendar day as a Timestamp
const dayStart = (ymd) => Timestamp.fromDate(new Date(ymd + "T00:00:00+08:00"));

const formatWhen = (ts) => {
  const d = ts && typeof ts.toDate === "function" ? ts.toDate() : null;
  if (!d) return "No date";
  return d.toLocaleString("en-PH", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 2800);
}

function showMessage(text, isError = false) {
  el.listMsg.textContent = text;
  el.listMsg.classList.toggle("msg-error", isError);
  el.listMsg.hidden = !text;
}

function showView(name) {
  el.loginView.hidden = name !== "login";
  el.deniedView.hidden = name !== "denied";
  el.appView.hidden = name !== "app";
}

/* ---------- Auth ---------- */
onAuthStateChanged(auth, (user) => {
  if (!user) {
    el.who.hidden = true;
    stopWatching();
    showView("login");
    return;
  }

  el.who.hidden = false;
  el.whoEmail.textContent = user.email || "";

  const isAdmin =
    user.emailVerified && (user.email || "").toLowerCase() === ADMIN_EMAIL;

  if (!isAdmin) {
    el.deniedText.textContent = !user.emailVerified
      ? "This email isn't verified yet. Verify it, then sign in again."
      : `Only ${ADMIN_EMAIL} can view orders. Sign out and use that account.`;
    stopWatching();
    showView("denied");
    return;
  }

  showView("app");
  applyRange("7");
  startWatching();
});

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.loginMsg.hidden = true;
  el.loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(
      auth,
      el.loginEmail.value.trim(),
      el.loginPassword.value
    );
    el.loginPassword.value = "";
  } catch (err) {
    el.loginMsg.textContent =
      err.code === "auth/too-many-requests"
        ? "Too many attempts. Wait a few minutes and try again."
        : "Wrong email or password.";
    el.loginMsg.hidden = false;
  } finally {
    el.loginBtn.disabled = false;
  }
});

const doSignOut = () => signOut(auth);
$("signOutBtn").addEventListener("click", doSignOut);
$("deniedSignOut").addEventListener("click", doSignOut);

/* ---------- Date range chips ---------- */
function applyRange(range) {
  const today = manilaYMD();
  let from = "";
  let to = "";

  if (range === "today") { from = today; to = today; }
  else if (range === "yesterday") { from = to = addDays(today, -1); }
  else if (range === "7") { from = addDays(today, -6); to = today; }
  else if (range === "month") { from = today.slice(0, 8) + "01"; to = today; }
  // "all" leaves both empty

  el.fromDate.value = from;
  el.toDate.value = to;

  el.chips.querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("is-active", c.dataset.range === range)
  );
  loadOrders();
}

el.chips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) applyRange(chip.dataset.range);
});

// Typing your own dates clears the quick-range highlight
[el.fromDate, el.toDate].forEach((input) =>
  input.addEventListener("change", () =>
    el.chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"))
  )
);

el.applyBtn.addEventListener("click", loadOrders);
el.statusFilter.addEventListener("change", render);
el.searchBox.addEventListener("input", render);
el.itemBox.addEventListener("input", render);

/* ---------- Load from Firestore ---------- */
async function loadOrders() {
  showMessage("Loading orders…");
  el.orders.innerHTML = "";
  el.applyBtn.disabled = true;

  try {
    const constraints = [];
    if (el.fromDate.value) {
      constraints.push(where("createdAt", ">=", dayStart(el.fromDate.value)));
    }
    if (el.toDate.value) {
      // "To" is inclusive, so stop before the start of the next day
      constraints.push(where("createdAt", "<", dayStart(addDays(el.toDate.value, 1))));
    }
    constraints.push(orderBy("createdAt", "desc"), limit(MAX_ORDERS));

    const snap = await getDocs(query(collection(db, "orders"), ...constraints));
    allOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    await loadSoldItems();
    showMessage("");
    render();
  } catch (err) {
    console.error(err);
    allOrders = [];
    render();
    if (err.code === "permission-denied") {
      showMessage(
        "Firestore denied access. Sign in as the verified admin email used in your rules.",
        true
      );
    } else if (err.code === "failed-precondition") {
      showMessage(
        "Firestore needs an index for this query. Open the browser console (F12) and click the link in the error to create it.",
        true
      );
    } else {
      showMessage("Couldn't load orders. Check your connection and try again.", true);
    }
  } finally {
    el.applyBtn.disabled = false;
  }
}

/* ---------- Render ---------- */
function visibleOrders() {
  const status = el.statusFilter.value;
  const q = el.searchBox.value.trim().toLowerCase();
  const itemQ = el.itemBox.value.trim().toLowerCase();

  return allOrders.filter((o) => {
    if (status && o.status !== status) return false;
    if (itemQ) {
      const items = Array.isArray(o.items) ? o.items : [];
      const hasItem = items.some((it) =>
        String(it && typeof it === "object" ? it.name || it.title || "" : it)
          .toLowerCase()
          .includes(itemQ)
      );
      if (!hasItem) return false;
    }
    if (!q) return true;
    return [orderLabel(o), o.name, o.email, o.phone, o.social, o.id]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });
}

// Reads every sold-item record, so each order's breakdown can show a SOLD tag
async function loadSoldItems() {
  try {
    const snap = await getDocs(collection(db, "soldItems"));
    soldMap = new Map(snap.docs.map((d) => [d.id, d.data()]));
  } catch (err) {
    console.error(err);
    soldMap = new Map();
    toast("Couldn't load the sold items, so SOLD tags may be missing.");
  }
}

// "other" = sold through a different order, "mine" = sold through this order
function soldState(it, order) {
  const rec = soldMap.get(soldDocId(itemKey(it)));
  if (!rec) return null;
  return rec.orderId === order.id ? { kind: "mine", rec } : { kind: "other", rec };
}

// Is this item ticked? Items sold in another order are never ticked.
function isPicked(order, key, sold) {
  if (sold && sold.kind === "other") return false;
  const chosen = picks.get(order.id);
  if (chosen) return chosen.has(key);
  if (order.status === "COMPLETED" && Array.isArray(order.completedKeys)) {
    return order.completedKeys.includes(key);
  }
  return true; // new orders start with every available item ticked
}

function itemLine(it, order) {
  if (it === null || typeof it !== "object") {
    return `<li><span>${esc(it)}</span></li>`;
  }
  const name = it.name || it.title || "Item";
  const qty = it.qty ?? it.quantity ?? 1;
  const price = Number(it.price);
  const extras = [it.size, it.color, it.condition].filter(Boolean).join(", ");
  const sold = soldState(it, order);
  const key = itemKey(it);
  const locked =
    order.status === "COMPLETED" || order.status === "ITEM SOLD" || (sold && sold.kind === "other");
  const tick = `<input type="checkbox" class="pick" data-key="${esc(key)}" ${isPicked(order, key, sold) ? "checked" : ""} ${locked ? "disabled" : ""} aria-label="Customer still wants ${esc(name)}" />`;
  const tag = !sold
    ? ""
    : sold.kind === "other"
      ? `<span class="tag tag-sold" title="Sold in order ${esc(sold.rec.orderNo || "")}">SOLD${sold.rec.orderNo ? ` · ${esc(sold.rec.orderNo)}` : ""}</span>`
      : `<span class="tag tag-mine">SOLD · THIS ORDER</span>`;
  return `
    <li class="${sold && sold.kind === "other" ? "is-sold" : ""}">
      <label class="pick-label">${tick}<span class="pname">${esc(name)}${qty > 1 ? ` × ${esc(qty)}` : ""}
        ${extras ? `<span class="meta"> (${esc(extras)})</span>` : ""}</span></label>
      <span class="side">${tag}<span>${Number.isFinite(price) ? peso(price * qty) : ""}</span></span>
    </li>`;
}

function orderHTML(o) {
  const st = o.status === "COMPLETED" ? "done" : o.status === "ITEM SOLD" ? "sold" : "pending";
  const label = { done: "Completed", sold: "Item sold", pending: "Not completed" }[st];
  const btnText = { done: "Mark as not completed", sold: "Reopen order", pending: "Mark as completed" }[st];
  const items = Array.isArray(o.items) ? o.items : [];

  return `
  <details class="order${newIds.has(o.id) ? " is-new" : ""}" data-id="${esc(o.id)}">
    <summary>
      <span class="o-name"><span class="o-no">${esc(orderLabel(o) || "No number")}</span>${esc(o.name || "No name")}</span>
      <span class="o-total">${peso(o.total)}</span>
      <span class="o-date">${esc(formatWhen(o.createdAt))}</span>
      <span class="pill pill-${st}">${label}</span>
    </summary>
    <div class="order-body">
      <div class="kv">
        <h2>Customer</h2>
        <p><span class="k">Email</span>${esc(o.email)}</p>
        <p><span class="k">Phone</span>${esc(o.phone)}</p>
        <p><span class="k">Social</span>${esc(o.social)}</p>
        <p><span class="k">Address</span>${esc(o.address)}</p>
        ${o.note ? `<p><span class="k">Note</span>${esc(o.note)}</p>` : ""}
      </div>
      <div>
        <h2>Items (${items.length})</h2>
        <ul class="items">${items.map((it) => itemLine(it, o)).join("") || "<li>No items</li>"}</ul>
      </div>
      <div class="full actions">
        <button type="button" class="btn btn-primary btn-small" data-action="toggle">
          ${btnText}
        </button>
        <button type="button" class="btn btn-danger btn-small" data-action="delete">Delete</button>
      </div>
      <p class="full order-id">Order number: ${esc(orderLabel(o) || "none (older order)")} &middot; ID: ${esc(o.id)}</p>
    </div>
  </details>`;
}

function render() {
  const list = visibleOrders();

  el.orders.innerHTML = list.map(orderHTML).join("");

  el.sumCount.textContent = list.length;
  el.sumTotal.textContent = peso(list.reduce((s, o) => s + (Number(o.total) || 0), 0));
  el.sumPending.textContent = list.filter((o) => o.status !== "COMPLETED" && o.status !== "ITEM SOLD").length;

  if (!list.length && el.listMsg.hidden) {
    showMessage(
      allOrders.length
        ? "No orders match your status or search filters."
        : "No orders in this date range. Try a wider range or choose All."
    );
  } else if (list.length && !el.listMsg.classList.contains("msg-error")) {
    showMessage("");
  }

  if (allOrders.length === MAX_ORDERS) {
    toast(`Showing the latest ${MAX_ORDERS} orders. Narrow the dates to see others.`);
  }
}


/* ---------- Live new-order alerts (repeating chime) ---------- */
// Listens for orders arriving while this page is open. The chime (order-chime.js)
// repeats until each new order is clicked/opened.
function startWatching() {
  if (stopWatch) return;
  let firstLoad = true;
  stopWatch = onSnapshot(
    query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(25)),
    (snap) => {
      if (firstLoad) { firstLoad = false; return; } // orders that already existed don't ring
      snap.docChanges().forEach((ch) => {
        if (ch.type === "added") onNewOrder({ id: ch.doc.id, ...ch.doc.data() });
        else if (ch.type === "removed") {
          newIds.delete(ch.doc.id);
          window.OrderChime?.stop(ch.doc.id);
        }
      });
    },
    (err) => console.error("Live orders listener stopped:", err)
  );
}

function stopWatching() {
  if (stopWatch) { stopWatch(); stopWatch = null; }
  newIds.clear();
  window.OrderChime?.stopAll();
}

function onNewOrder(order) {
  if (allOrders.some((o) => o.id === order.id)) return;
  newIds.add(order.id);
  window.OrderChime?.start(order.id);
  toast(`New order from ${order.name || "a customer"}`);

  // Make sure the new order can actually be seen, so it can be opened to stop the chime
  el.statusFilter.value = "";
  el.searchBox.value = "";
  el.itemBox.value = "";
  const to = el.toDate.value;
  const from = el.fromDate.value;
  const today = manilaYMD();
  if ((to && today > to) || (from && today < from)) {
    applyRange("today"); // viewing another date range: jump to today's orders
    return;
  }
  const openIds = [...el.orders.querySelectorAll(".order[open]")].map((d) => d.dataset.id);
  allOrders.unshift(order);
  render();
  openIds.forEach((id) =>
    el.orders.querySelector(`[data-id="${CSS.escape(id)}"]`)?.setAttribute("open", "")
  );
}

// Opening a new order (clicking it) stops its chime
el.orders.addEventListener(
  "toggle",
  (e) => {
    const card = e.target;
    if (!card.matches || !card.matches("details.order") || !card.open) return;
    const id = card.dataset.id;
    if (newIds.delete(id)) {
      card.classList.remove("is-new");
      window.OrderChime?.stop(id);
    }
  },
  true
);

/* ---------- Items sold: one record per item, so other buyers see "SOLD" ---------- */
const orderItems = (order) => (Array.isArray(order.items) ? order.items : []);
const uniqueKeys = (order) => [...new Set(orderItems(order).map(itemKey).filter(Boolean))];

// Completed order -> only its ticked items are sold (unless another order already got them)
async function markItemsSold(order, keys) {
  try {
    const already = [];
    for (const k of keys) {
      const ref = doc(db, "soldItems", soldDocId(k));
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data().orderId !== order.id) {
        already.push(snap.data().name || k);
        continue;
      }
      const it = orderItems(order).find((i) => itemKey(i) === k);
      await setDoc(ref, {
        orderId: order.id,
        orderNo: orderLabel(order),
        name: (it && (it.name || it.title)) || k,
        soldAt: serverTimestamp(),
      });
    }
    if (already.length) {
      toast(`Heads up: ${already.join(", ")} was already sold in another order.`);
    }
  } catch (err) {
    console.error(err);
    toast("Order completed, but couldn't mark its items as sold.");
  }
}

// Reopened order -> give back only the items that were sold through this order
async function releaseItems(order) {
  try {
    for (const k of uniqueKeys(order)) {
      const ref = doc(db, "soldItems", soldDocId(k));
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data().orderId === order.id) await deleteDoc(ref);
    }
  } catch (err) {
    console.error(err);
    toast("Order reopened, but couldn't release its items.");
  }
}

/* ---------- Actions: complete / delete ---------- */
el.orders.addEventListener("change", (e) => {
  const box = e.target.closest("input.pick");
  if (!box) return;
  const card = box.closest(".order");
  picks.set(
    card.dataset.id,
    new Set([...card.querySelectorAll("input.pick:checked")].map((b) => b.dataset.key))
  );
});

el.orders.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const id = btn.closest(".order").dataset.id;
  const order = allOrders.find((o) => o.id === id);
  if (!order) return;

  btn.disabled = true;
  try {
    if (btn.dataset.action === "toggle") {
      const next =
        order.status === "COMPLETED" || order.status === "ITEM SOLD"
          ? "NOT COMPLETED"
          : "COMPLETED";
      let keys = [];
      if (next === "COMPLETED") {
        keys = uniqueKeys(order).filter((k) => {
          const it = orderItems(order).find((i) => itemKey(i) === k);
          return isPicked(order, k, soldState(it, order));
        });
        if (!keys.length) {
          toast("Tick at least one item the customer still wants.");
          btn.disabled = false;
          return;
        }
      }
      await updateDoc(doc(db, "orders", id), { status: next, completedKeys: keys });
      order.status = next;
      order.completedKeys = keys;
      picks.delete(id); // ticks now come from the saved order
      toast(next === "COMPLETED" ? "Marked as completed" : "Marked as not completed");
      if (next === "COMPLETED") await markItemsSold(order, keys);
      else await releaseItems(order);
      await loadSoldItems();
      render();
      // keep the order open after re-render
      el.orders.querySelector(`[data-id="${CSS.escape(id)}"]`)?.setAttribute("open", "");
    } else if (btn.dataset.action === "delete") {
      if (!confirm(`Delete the order from ${order.name || "this customer"}? This can't be undone.`)) {
        btn.disabled = false;
        return;
      }
      await deleteDoc(doc(db, "orders", id));
      allOrders = allOrders.filter((o) => o.id !== id);
      toast("Order deleted");
      render();
    }
  } catch (err) {
    console.error(err);
    toast("Couldn't update the order. Try again.");
    btn.disabled = false;
  }
});