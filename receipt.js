import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

const TZ = "Asia/Manila";
const $ = (id) => document.getElementById(id);
const printer = $("printer");
const paperWrap = $("paperWrap");
const paper = $("paper");
const msg = $("msg");

/* ---------- Helpers ---------- */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

const peso = (n) =>
  "₱" + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });

const formatWhen = (ts) => {
  const d = ts && typeof ts.toDate === "function" ? ts.toDate() : null;
  if (!d) return "";
  return d.toLocaleString("en-PH", {
    timeZone: TZ, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
};

function fail(text) {
  paperWrap.hidden = true;
  msg.textContent = text;
  msg.hidden = false;
}

/* ---------- Receipt content ---------- */
function receiptHTML(r) {
  const items = Array.isArray(r.items) ? r.items : [];

  const rows = items.map((it) => {
    const qty = Number(it.qty) || 1;
    const hasPrice = it.price != null && Number.isFinite(Number(it.price));
    const parts = [];
    if (qty > 1) parts.push(hasPrice ? `${qty} × ${peso(it.price)}` : `Qty ${qty}`);
    if (it.extras) parts.push(esc(it.extras));
    return `
      <li>
        <div class="r-row">
          <span class="r-name">${esc(it.name)}</span>
          <span class="r-amt">${hasPrice ? peso(Number(it.price) * qty) : ""}</span>
        </div>
        ${parts.length ? `<div class="r-sub">${parts.join(" · ")}</div>` : ""}
      </li>`;
  }).join("");

  const when = formatWhen(r.orderedAt);
  const meta = [when, r.orderNo ? `Order ${esc(r.orderNo)}` : ""].filter(Boolean).join("<br />");

  return `
    <header class="r-head">
      <h1 class="r-brand">${esc(r.brand || "CJ Finds")}</h1>
      ${meta ? `<p class="r-meta">${meta}</p>` : ""}
    </header>
    <hr class="r-rule" />
    <p class="r-label">ITEMS PURCHASED</p>
    <ul class="r-items">${rows || "<li>No items</li>"}</ul>
    <hr class="r-rule" />
    <div class="r-total"><span>TOTAL</span><span>${peso(r.total)}</span></div>
    <hr class="r-rule" />
    <footer class="r-confirm">
      <p class="r-label">CONFIRMATION NO.</p>
      <p class="r-id">${esc(r.orderId)}</p>
    </footer>`;
}

/* ---------- Zigzag bottom edge ---------- */
function cutZigzag() {
  const W = paper.offsetWidth;
  const depth = 9;
  const teeth = Math.max(4, Math.round(W / 16));
  const step = W / teeth;
  const pts = ["0 0", "100% 0"];
  for (let i = teeth; i >= 0; i--) {
    const y = i % 2 === 0 ? "100%" : `calc(100% - ${depth}px)`;
    pts.push(`${(i * step).toFixed(2)}px ${y}`);
  }
  paper.style.clipPath = `polygon(${pts.join(",")})`;
}

/* ---------- Slide down once, then stop ---------- */
function slideOut() {
  const H = paper.offsetHeight;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduce) {
    paper.style.transform = "none";
    return;
  }

  // Taller receipts take a little longer, always slow and steady
  const duration = Math.min(14000, Math.max(5000, H * 14));
  let start = null;

  paper.style.transform = `translateY(${-H}px)`;
  printer.classList.add("is-printing");

  function frame(now) {
    if (start === null) start = now;
    const p = Math.min(1, (now - start) / duration);
    paper.style.transform = p < 1 ? `translateY(${-(1 - p) * H}px)` : "none";

    // On tall receipts, follow the leading edge of the paper down the page
    const edge = paperWrap.getBoundingClientRect().top + window.scrollY + p * H;
    const need = edge + 48 - window.innerHeight;
    if (need > window.scrollY) window.scrollTo(0, need);

    if (p < 1) requestAnimationFrame(frame);
    else printer.classList.remove("is-printing"); // all printed, animation ends
  }

  setTimeout(() => requestAnimationFrame(frame), 500);
}

/* ---------- Start ---------- */
async function main() {
  const token = new URLSearchParams(location.search).get("r");
  if (!token) return fail("This receipt link is incomplete.");

  let snap;
  try {
    snap = await getDoc(doc(db, "receipts", token));
  } catch (err) {
    console.error(err);
    return fail("We couldn't open this receipt. Please check your connection and try again.");
  }
  if (!snap.exists()) return fail("This receipt link isn't valid.");

  paper.innerHTML = receiptHTML(snap.data());

  // Wait for fonts so the paper height is final before it moves
  await Promise.race([
    document.fonts ? document.fonts.ready : Promise.resolve(),
    new Promise((r) => setTimeout(r, 1500)),
  ]);

  cutZigzag();
  slideOut();
}

main();
