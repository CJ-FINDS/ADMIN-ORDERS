/* order-chime.js
   Repeating chime for CJ Orders (admin-orders).
   - Rings every few seconds while at least one new order is unopened.
   - Stops only when that order is clicked/opened (stop) or stopAll() is called.
   - Uses the Web Audio API, so no audio file is needed.

   Usage:
     OrderChime.start(orderId);   // when a NEW order arrives
     OrderChime.stop(orderId);    // when that order is clicked/opened
*/
(function () {
    var REPEAT_MS = 3000;          // gap between chimes
    var pending = new Set();       // ids of new, unopened orders
    var timer = null;
    var ctx = null;
    var banner = null;
  
    function getCtx() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      return ctx;
    }
  
    // Browsers block sound until the page has been clicked/tapped once.
    function unlock() {
      var c = getCtx();
      if (c && c.state === "suspended") c.resume();
      if (c && c.state === "running") hideBanner();
    }
    ["click", "keydown", "touchstart"].forEach(function (ev) {
      document.addEventListener(ev, unlock, { passive: true });
    });
  
    function showBanner() {
      if (banner || !document.body) return;
      banner = document.createElement("div");
      banner.textContent = "🔔 Click anywhere on this page to enable order alerts";
      banner.style.cssText =
        "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);" +
        "background:#5d293e;color:#fff;padding:10px 16px;border-radius:999px;" +
        "font:14px sans-serif;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.25)";
      document.body.appendChild(banner);
    }
    function hideBanner() {
      if (banner) { banner.remove(); banner = null; }
    }
  
    function tone(freq, start, dur, vol) {
      var c = ctx;
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    }
  
    function playChime() {
      var c = getCtx();
      if (!c) return;
      if (c.state === "suspended") {
        c.resume();
        if (c.state !== "running") { showBanner(); return; }
      }
      var t = c.currentTime;
      tone(880, t, 0.9, 0.35);          // A5
      tone(1318.5, t + 0.18, 1.1, 0.3); // E6
      tone(1760, t + 0.36, 1.3, 0.25);  // A6
    }
  
    function loop() {
      if (pending.size === 0) { clearInterval(timer); timer = null; return; }
      playChime();
    }
  
    window.OrderChime = {
      start: function (id) {
        pending.add(String(id));
        if (!timer) {
          playChime();
          timer = setInterval(loop, REPEAT_MS);
        }
      },
      stop: function (id) {
        pending.delete(String(id));
        if (pending.size === 0 && timer) { clearInterval(timer); timer = null; }
      },
      stopAll: function () {
        pending.clear();
        if (timer) { clearInterval(timer); timer = null; }
      },
      isRinging: function () { return pending.size > 0; }
    };
  })();