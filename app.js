(function () {
  "use strict";

  var MAX_PHOTOS = 8;
  var MAX_SEC = 90;
  var JOBS_KEY = "field-os.jobs";
  var BOOK_KEY = "field-os.pricebook";
  var SHOP_KEY = "field-os.shop";
  var DB_NAME = "field-os";
  var STORE = "media";

  var DEFAULT_SHOP = {
    name: "Pembroke Pool Service",
    city: "Pembroke Pines",
    phone: "(954) 555-0194",
    license: "CPC1458921",
    accent: "#0C6B4F"
  };

  var STEPS = [
    "Open Field OS",
    "New job — homeowner + address",
    "Take photos of the pad",
    "Talk ~90 seconds (or type notes)",
    "Review scene-suggested line items, edit from pricebook",
    "Generate the estimate PDF",
    "Copy Jobber paste · job stays on the list"
  ];

  var SEED = [
    ["pb-pump-seal", "Pump seal / wet-end repair", "equipment", 185, "pump,leak,seal,drip,wet end,rust"],
    ["pb-pump-motor", "Pump motor rebuild", "equipment", 420, "pump,motor,noise,hum,bearing,hot"],
    ["pb-pump-ss", "Single-speed pump replace", "equipment", 980, "pump,replace,dead,seized,single"],
    ["pb-pump-vs", "Variable-speed pump replace", "equipment", 1850, "pump,vs,variable,pentair,hayward,replace"],
    ["pb-filter-cart", "Cartridge filter replace", "equipment", 720, "filter,cartridge,tank,white,pressure"],
    ["pb-filter-grid", "DE filter grid pack", "equipment", 340, "filter,de,grid,diatomaceous"],
    ["pb-filter-sand", "Sand filter replace", "equipment", 890, "filter,sand,multiport,tank"],
    ["pb-salt-clean", "Salt cell clean / inspect", "equipment", 195, "salt,cell,scale,chlorinator,ic40,aqua"],
    ["pb-salt-replace", "Salt cell replace", "equipment", 780, "salt,cell,dead cell,no chlorine,replace"],
    ["pb-heater-svc", "Heater service / igniter", "equipment", 265, "heater,igniter,pilot,won't fire,gas"],
    ["pb-heater-gas", "Gas heater replace", "equipment", 2350, "heater,gas,rust,cabinet,replace,raypak"],
    ["pb-heater-hp", "Heat pump replace", "equipment", 2400, "heater,heat pump,fan,coil"],
    ["pb-labor-trip", "Diagnostic / trip charge", "labor", 125, "diag,trip,look"],
    ["pb-labor-pad", "Equipment pad labor (2 hr)", "labor", 220, "pad,labor,set"],
    ["pb-labor-pump", "Pump swap labor", "labor", 185, "pump,labor,swap"],
    ["pb-labor-heater", "Heater swap labor", "labor", 320, "heater,labor,swap"],
    ["pb-labor-filter", "Filter swap labor", "labor", 165, "filter,labor,swap"],
    ["pb-labor-elec", "Electrical hookup", "labor", 240, "electric,bonding,wire,breaker"],
    ["pb-labor-permit", "Permit / inspection coord", "labor", 175, "permit,inspection,broward"],
    ["pb-pad-demo", "Pad demo and haul-off", "pad", 850, "pad,crack,broken,demo,spall,concrete"],
    ["pb-pad-small", "New concrete pad (small)", "pad", 1450, "pad,concrete,new pad,pour"],
    ["pb-pad-full", "New concrete pad (full remodel)", "pad", 3200, "pad,remodel,full,rebuild,crack"],
    ["pb-pad-plumb", "Equipment replumb (PVC)", "pad", 680, "plumb,pvc,union,valve,leak,manifold"],
    ["pb-pad-bond", "Bonding / grounding update", "pad", 310, "bond,ground,wire,lug"],
    ["pb-pad-encl", "Equipment pad enclosure", "pad", 1100, "enclosure,fence,screen,cover"],
    ["pb-pad-valve", "Valve manifold rebuild", "pad", 540, "valve,manifold,jandy,handle"]
  ].map(function (r) {
    return { id: r[0], name: r[1], category: r[2], unitPrice: r[3], unit: "ea", sceneTags: r[4].split(",") };
  });

  var previewCache = {};
  var recState = { on: false, sec: 0, rec: null, stream: null, recog: null, timer: null, chunks: [], started: 0, jobId: "" };
  var flash = "";
  var busy = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function uid(p) {
    return p + "-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function money(n) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(n) || 0);
  }
  function todayLabel(d) {
    return (d || new Date()).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  function quoteTotal(items) {
    return Math.round((items || []).reduce(function (s, i) { return s + i.qty * i.unitPrice; }, 0) * 100) / 100;
  }
  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function loadJobs() {
    return readJson(JOBS_KEY, []).sort(function (a, b) { return +new Date(b.updatedAt) - +new Date(a.updatedAt); });
  }
  function saveJobs(jobs) { writeJson(JOBS_KEY, jobs); }
  function getJob(id) { return loadJobs().find(function (j) { return j.id === id; }); }
  function upsertJob(job) {
    var jobs = loadJobs().filter(function (j) { return j.id !== job.id; });
    jobs.unshift(Object.assign({}, job, { updatedAt: new Date().toISOString() }));
    saveJobs(jobs);
  }
  function loadPricebook() {
    var stored = readJson(BOOK_KEY, null);
    return stored && stored.length ? stored : SEED.slice();
  }
  function savePricebook(items) { writeJson(BOOK_KEY, items); }
  function loadShop() { return Object.assign({}, DEFAULT_SHOP, readJson(SHOP_KEY, {})); }
  function saveShop(shop) { writeJson(SHOP_KEY, shop); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function putMedia(id, blob) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(blob, id);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function getMedia(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(id);
        req.onsuccess = function () { db.close(); resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function deleteMedia(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function compressImageFile(file, maxW, quality) {
    maxW = maxW || 960;
    quality = quality || 0.72;
    return blobToDataUrl(file).then(function (dataUrl) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, maxW / img.width);
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("no canvas"));
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("compress")); }, "image/jpeg", quality);
        };
        img.onerror = function () { reject(new Error("image")); };
        img.src = dataUrl;
      });
    });
  }

  function sat(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }
  function hue(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d === 0) return 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return h;
  }
  function analyzePhotoDataUrl(photoId, dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = 80, h = Math.max(1, Math.round((img.height / img.width) * w));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        var empty = { photoId: photoId, rust: 0, concrete: 0, whiteGear: 0, darkMetal: 0, greenAlgae: 0, heatTone: 0, brightness: 0.5 };
        if (!ctx) return resolve(empty);
        ctx.drawImage(img, 0, 0, w, h);
        var data = ctx.getImageData(0, 0, w, h).data;
        var rust = 0, concrete = 0, whiteGear = 0, darkMetal = 0, greenAlgae = 0, heatTone = 0, brightSum = 0;
        var n = data.length / 4;
        for (var i = 0; i < data.length; i += 4) {
          var r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
          var v = (r + g + b) / 3, s = sat(r, g, b), hh = hue(r, g, b);
          brightSum += v;
          if (s > 0.28 && v > 0.18 && v < 0.78 && hh >= 8 && hh <= 42 && r > g && r > b) rust++;
          if (s < 0.12 && v > 0.28 && v < 0.78) concrete++;
          if (s < 0.1 && v > 0.78) whiteGear++;
          if (v < 0.22 && s < 0.25) darkMetal++;
          if (s > 0.22 && hh >= 85 && hh <= 165 && v > 0.15 && v < 0.7) greenAlgae++;
          if (s > 0.15 && hh >= 25 && hh <= 55 && v > 0.25 && v < 0.7) heatTone++;
        }
        resolve({
          photoId: photoId, rust: rust / n, concrete: concrete / n, whiteGear: whiteGear / n,
          darkMetal: darkMetal / n, greenAlgae: greenAlgae / n, heatTone: heatTone / n, brightness: brightSum / n
        });
      };
      img.onerror = function () { reject(new Error("photo")); };
      img.src = dataUrl;
    });
  }
  function noteHits(notes) {
    var t = (notes || "").toLowerCase();
    var keys = ["pump","leak","noise","noisy","hum","heater","heat pump","salt","cell","filter","pad","crack","cracked","broken","rust","rusty","valve","plumb","union","electric","bond","replace","dead","won't fire","no chlorine","pressure","scale","spall","remodel"];
    var hits = {};
    keys.forEach(function (k) { if (t.indexOf(k) !== -1) hits[k] = 1; });
    return hits;
  }
  function avg(signals, key) {
    if (!signals.length) return 0;
    return signals.reduce(function (s, x) { return s + (typeof x[key] === "number" ? x[key] : 0); }, 0) / signals.length;
  }
  function suggestFromScene(job, book, signals) {
    var notes = ((job.notes || "") + "\n" + ((job.voice && job.voice.transcript) || "")).trim();
    var hits = noteHits(notes);
    var hasPhotos = job.photos && job.photos.length > 0;
    var rust = avg(signals, "rust"), concrete = avg(signals, "concrete"), white = avg(signals, "whiteGear");
    var dark = avg(signals, "darkMetal"), green = avg(signals, "greenAlgae"), heat = avg(signals, "heatTone");
    var photoCount = (job.photos || []).length;
    var scores = {};
    function bump(id, amount, reason) {
      var cur = scores[id] || { score: 0, reasons: [] };
      cur.score += amount;
      if (reason && cur.reasons.indexOf(reason) === -1) cur.reasons.push(reason);
      scores[id] = cur;
    }
    if (hasPhotos || notes) bump("pb-labor-trip", 1.2, "On-site equipment-pad visit");
    if (hasPhotos) bump("pb-labor-pad", 0.55, photoCount + " pad photo" + (photoCount === 1 ? "" : "s") + " captured");
    if (dark > 0.08 || rust > 0.04) {
      var why = rust > 0.04 ? "Rust tones on the pad photos" : "Dark pump/motor body in the photos";
      bump("pb-pump-seal", rust > 0.05 ? 1.4 : 0.9, why);
      bump("pb-labor-pump", 0.7, why);
      if (rust > 0.08 || hits.dead || hits.replace) bump("pb-pump-ss", 0.85, why + "; replacement band likely");
    }
    if (hits.pump || hits.leak || hits.noise || hits.noisy || hits.hum) {
      bump("pb-pump-seal", 1.1, "Voice/notes call out pump leak or noise");
      bump("pb-pump-motor", (hits.noise || hits.noisy || hits.hum) ? 1.15 : 0.6, "Voice/notes: pump running loud");
      bump("pb-labor-pump", 0.8, "Pump work called from the scene notes");
    }
    if (white > 0.1) {
      bump("pb-filter-cart", 0.95, "White tank / equipment body in photos");
      bump("pb-salt-clean", 0.7, "White cylindrical gear — common salt cell / filter");
    }
    if (hits.filter || hits.pressure) {
      bump("pb-filter-cart", 1.1, "Filter / pressure mentioned in notes");
      bump("pb-labor-filter", 0.85, "Filter work from notes");
    }
    if (hits.salt || hits.cell || hits.scale || hits["no chlorine"]) {
      bump("pb-salt-clean", 1.0, "Salt cell called in notes");
      bump("pb-salt-replace", (hits["no chlorine"] || hits.replace) ? 1.15 : 0.55, "Salt system issue in notes");
    }
    if (heat > 0.06 || hits.heater || hits["heat pump"] || hits["won't fire"]) {
      var hwhy = heat > 0.06 ? "Heater-cabinet color in the pad photos" : "Heater called in voice/notes";
      bump("pb-heater-svc", 1.05, hwhy);
      bump("pb-labor-heater", 0.75, hwhy);
      if (rust > 0.07 || hits.replace || hits["won't fire"]) bump("pb-heater-gas", 0.95, hwhy + "; cabinet looks tired or won't fire");
    }
    if (concrete > 0.22 || hits.pad || hits.crack || hits.cracked || hits.spall || hits.broken || hits.remodel) {
      var pwhy = concrete > 0.22 ? "Gray weathered concrete dominates the photos" : "Pad / crack language in the notes";
      bump("pb-pad-demo", 1.05, pwhy);
      if (photoCount >= 4 || hits.remodel || hits.cracked || concrete > 0.32) bump("pb-pad-full", 1.2, pwhy + "; full remodel range");
      else bump("pb-pad-small", 0.95, pwhy + "; small pour may cover it");
    }
    if (hits.valve || hits.union || hits.plumb || hits.leak) {
      bump("pb-pad-plumb", 0.95, "Plumbing / unions / leak in the scene notes");
      bump("pb-pad-valve", hits.valve ? 0.9 : 0.45, "Valve manifold from notes");
    }
    if (hits.electric || hits.bond) {
      bump("pb-labor-elec", 0.85, "Electrical / bonding mentioned");
      bump("pb-pad-bond", 0.7, "Bonding update from notes");
    }
    if (green > 0.05) bump("pb-pad-demo", 0.4, "Algae / staining around the pad");
    if (hasPhotos && photoCount >= 6 && concrete > 0.18 && (dark > 0.06 || white > 0.08)) {
      bump("pb-pad-plumb", 0.55, "Wide pad survey — replumb often rides along");
      bump("pb-labor-permit", 0.5, "Full pad remodel typically needs permit coord");
    }
    var out = [];
    book.forEach(function (item) {
      var hit = scores[item.id];
      if (!hit || hit.score < 0.7) return;
      out.push({ pricebookId: item.id, reason: hit.reasons.slice(0, 2).join(" · "), confidence: Math.max(0, Math.min(1, hit.score / 2.4)) });
    });
    out.sort(function (a, b) { return b.confidence - a.confidence; });
    return out.slice(0, 8);
  }

  function jobberPaste(job, shop) {
    var total = quoteTotal(job.lineItems);
    var lines = (job.lineItems || []).map(function (i) {
      return "• " + i.qty + " x " + i.name + " @ " + money(i.unitPrice) + " = " + money(i.qty * i.unitPrice) + (i.note ? " (" + i.note + ")" : "");
    }).join("\n");
    var voice = (job.voice && job.voice.transcript || "").trim();
    var notes = [job.notes && job.notes.trim(), voice ? "Voice: " + voice : ""].filter(Boolean).join("\n");
    return [
      "JOB — " + shop.name,
      "Homeowner: " + job.homeowner,
      "Address: " + job.address + (job.city ? ", " + job.city : ""),
      job.phone ? "Phone: " + job.phone : "",
      "Photos on pad: " + job.photos.length + "/8",
      job.voice && job.voice.durationSec ? "Voice note: " + Math.round(job.voice.durationSec) + "s" : "",
      "",
      "NOTES",
      notes || "(none)",
      "",
      "LINE ITEMS",
      lines || "(none yet)",
      "",
      "TOTAL: " + money(total),
      "This is an estimate, not a final invoice.",
      "",
      "Paste into Jobber as a new job / request."
    ].filter(function (row) { return row !== ""; }).join("\n");
  }

  function parseRoute() {
    var hash = (location.hash || "").replace(/^#/, "");
    var q = new URLSearchParams(location.search);
    if (!hash && q.get("id") && /jobs\/quote/.test(location.pathname)) hash = "/quote/" + q.get("id");
    else if (!hash && q.get("id")) hash = "/job/" + q.get("id");
    var parts = hash.replace(/^\//, "").split("/").filter(Boolean);
    var page = parts[0] || "jobs";
    var id = parts[1] || q.get("id") || "";
    if (page === "jobs" && id) page = "job";
    return { page: page, id: id };
  }
  function go(path) {
    location.hash = path;
  }

  function applyAccent(shop) {
    document.documentElement.style.setProperty("--green", shop.accent || "#0C6B4F");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", shop.accent || "#0C6B4F");
  }

  function guide(current) {
    return "<ol class='guide'>" + STEPS.map(function (step, i) {
      var n = i + 1;
      var cls = current === n ? "on" : current > n ? "done" : "";
      return "<li class='" + cls + "'><span class='num'>" + (current > n ? "✓" : n) + "</span><span>" + esc(step) + "</span></li>";
    }).join("") + "</ol>";
  }

  function shell(title, back, inner, navOn) {
    var shop = loadShop();
    applyAccent(shop);
    return (
      "<div class='shell'>" +
        "<header class='top no-print'>" +
          "<p class='kicker'>" + esc(shop.name) + " · " + esc(shop.city) + "</p>" +
          "<div class='row'>" +
            (back ? "<button class='back' data-go='" + esc(back) + "' aria-label='Back'>‹</button>" : "") +
            "<h1>" + esc(title) + "</h1>" +
          "</div>" +
        "</header>" +
        "<main>" + inner + "</main>" +
        "<nav class='bottom no-print'>" +
          "<a href='#/' class='" + (navOn === "jobs" ? "on" : "") + "'>Jobs</a>" +
          "<a href='#/pricebook' class='" + (navOn === "pricebook" ? "on" : "") + "'>Pricebook</a>" +
          "<a href='#/settings' class='" + (navOn === "settings" ? "on" : "") + "'>Shop</a>" +
        "</nav>" +
      "</div>"
    );
  }

  function viewJobs() {
    var jobs = loadJobs();
    var shop = loadShop();
    var list = jobs.length ? "<ul class='list'>" + jobs.map(function (job) {
      return "<li><a class='card' href='#/job/" + encodeURIComponent(job.id) + "'>" +
        "<h3>" + esc(job.homeowner) + "</h3>" +
        "<p class='muted' style='margin:4px 0 0;font-size:14px'>" + esc(job.address) + (job.city ? ", " + esc(job.city) : "") + "</p>" +
        "<p class='meta'>" + job.photos.length + "/8 photos · " + Math.round(job.voice.durationSec || 0) + "s talk · " +
          (job.quoteGeneratedAt ? "quote ready" : "intake") + "</p>" +
        (job.lineItems.length ? "<p class='money'>" + money(quoteTotal(job.lineItems)) + "</p>" : "") +
      "</a></li>";
    }).join("") + "</ul>" : "";
    var first = jobs.length === 0 ? "<div class='space'><h2 class='sec'>First run — 7 taps</h2>" + guide(2) + "</div>" : "";
    return shell("Field jobs", "",
      "<p class='lead'>Reno and equipment quotes from the pad. Not weekly routes. Sits beside Jobber — not instead of it.</p>" +
      "<a class='btn btn-green' href='#/new'>New job</a>" +
      first + "<div class='space'>" + list + "</div>" +
      "<p class='foot'>" + esc(shop.name) + " · " + todayLabel() + " · Field OS</p>",
      "jobs");
  }

  function viewNew() {
    var shop = loadShop();
    return shell("New job", "#/",
      "<p class='lead'>Homeowner + address. Then we go to the pad.</p>" +
      "<form class='form' data-form='newjob'>" +
        "<label class='field'><span>Homeowner</span><input name='homeowner' required placeholder='Maria Alvarez'></label>" +
        "<label class='field'><span>Address</span><input name='address' required placeholder='1842 NW 11th St'></label>" +
        "<label class='field'><span>City</span><input name='city' value='" + esc(shop.city || "Pembroke Pines") + "'></label>" +
        "<label class='field'><span>Phone (optional)</span><input name='phone' inputmode='tel' placeholder='(954) 555-0144'></label>" +
        "<button class='btn btn-green' type='submit'>Open job — shoot the pad</button>" +
      "</form>" +
      "<div class='space-lg'>" + guide(2) + "</div>",
      "jobs");
  }

  function viewJob(id) {
    var job = getJob(id);
    if (!job) return shell("Missing job", "#/", "<p class='lead'>That job is not on this phone.</p>", "jobs");
    var book = loadPricebook();
    var step = job.photos.length === 0 ? 3 : ((job.voice.durationSec || 0) < 20 && !(job.voice.transcript) && !job.notes ? 4 : 5);
    var photos = "<div class='hrow'><div><h2 class='sec'>Pad photos</h2><p class='muted' style='margin:0;font-size:14px'>Shoot the equipment pad. " + job.photos.length + " of " + MAX_PHOTOS + ".</p></div><span class='badge'>" + job.photos.length + "/" + MAX_PHOTOS + "</span></div>" +
      "<div class='photos space'>" + job.photos.map(function (p, i) {
        var src = previewCache[p.id] || "";
        return "<figure><img alt='Pad photo " + (i + 1) + "' src='" + esc(src) + "'><button type='button' class='x' data-act='delphoto' data-id='" + esc(p.id) + "'>✕</button></figure>";
      }).join("") +
      (job.photos.length < MAX_PHOTOS ? "<label class='addshot'><span class='plus'>" + (busy ? "…" : "+") + "</span><span>" + (busy ? "Saving" : job.photos.length === 0 ? "Open camera" : "Add photo") + "</span><input class='sr' type='file' accept='image/*' capture='environment' multiple data-act='photos'></label>" : "") +
      "</div><p class='muted tiny space'>Walk the pad: pump, filter, salt cell, heater, concrete. Scene pricing reads these photos — not SKUs you speak.</p>";

    var recBtn = recState.on && recState.jobId === job.id
      ? "<button type='button' class='btn btn-rust' data-act='stopvoice'>Stop · <span id='rec-sec'>" + recState.sec + "</span>s / " + MAX_SEC + "s</button>"
      : "<button type='button' class='btn btn-green' data-act='startvoice'>Hold the pad — start talking</button>";
    var audio = previewCache["voice_" + job.id]
      ? "<div class='space'><audio controls src='" + esc(previewCache["voice_" + job.id]) + "'></audio><button type='button' class='tiny' style='background:none;border:0;margin-top:6px' data-act='delvoice'>Remove audio</button></div>"
      : "";
    var heard = job.voice && job.voice.transcript ? "<p class='card space' style='font-size:14px;font-weight:600'>Heard: " + esc(job.voice.transcript) + "</p>" : "";

    var lines = (job.lineItems || []).map(function (item) {
      return "<li class='line'><div class='top'><h4>" + esc(item.name) + "</h4><button type='button' class='kill' data-act='delline' data-id='" + esc(item.id) + "' aria-label='Remove'>✕</button></div>" +
        (item.suggested && item.reason ? "<p class='why'>From the scene: " + esc(item.reason) + "</p>" : "") +
        "<div class='grid3'><label class='field'><span>Qty</span><input type='number' min='1' value='" + item.qty + "' data-act='lineqty' data-id='" + esc(item.id) + "'></label>" +
        "<label class='field'><span>Price</span><input type='number' min='0' step='1' value='" + item.unitPrice + "' data-act='lineprice' data-id='" + esc(item.id) + "'></label>" +
        "<label class='field'><span>Note</span><input type='text' value='" + esc(item.note || "") + "' data-act='linenote' data-id='" + esc(item.id) + "'></label></div></li>";
    }).join("");

    var unused = book.filter(function (b) { return !(job.lineItems || []).some(function (i) { return i.pricebookId === b.id; }); });
    var addSel = unused.length ? "<label class='field space'><span>Add from pricebook</span><select data-act='addbook'><option value=''>Choose a line…</option>" +
      unused.map(function (b) { return "<option value='" + esc(b.id) + "'>" + esc(b.name) + " · " + money(b.unitPrice) + "</option>"; }).join("") +
      "</select></label>" : "";

    return shell(job.homeowner, "#/",
      "<p class='lead' style='margin-bottom:4px'>" + esc(job.address) + (job.city ? ", " + esc(job.city) : "") + "</p>" +
      "<p class='muted' style='margin:0 0 16px;font-size:13px'>" + esc(job.phone || "No phone") + "</p>" +
      guide(step) +
      "<div class='space-lg'>" + photos + "</div>" +
      "<section class='space-lg'><h2 class='sec'>Talk the scene ~90s</h2>" +
        "<p class='muted' style='margin:0 0 10px;font-size:14px'>What you see on the pad — rust, cracks, noise, leaks. Do not read SKUs. Transcript fills notes if empty.</p>" +
        recBtn + (flash && recState.jobId === job.id ? "<p class='hint space' style='color:var(--rust)'>" + esc(flash) + "</p>" : "") +
        audio + heard +
        "<label class='field space'><span>Notes (always available)</span>" +
        "<textarea data-act='notes' placeholder='Pump leaking at seal. Filter pressure high. Quote VS pump replace vs repair.'>" + esc(job.notes || "") + "</textarea></label>" +
      "</section>" +
      "<div class='space-lg'>" +
        "<button type='button' class='btn btn-green' data-act='suggest'>Suggest line items from the scene</button>" +
        (flash && !recState.on ? "<p class='hint space'>" + esc(flash) + "</p>" : "") +
        "<h2 class='sec space'>Line items</h2>" +
        "<p class='muted' style='margin:0 0 10px;font-size:14px'>Scene suggestions first. Edit qty/price or pull more from the pricebook.</p>" +
        (job.lineItems.length ? "<ul class='list'>" + lines + "</ul><p class='money space'>Total " + money(quoteTotal(job.lineItems)) + "</p>" : "<p class='card dash'>No lines yet. Add pad photos + a voice note, then tap Suggest from scene.</p>") +
        addSel +
      "</div>" +
      "<a class='btn btn-ink space-lg' href='#/quote/" + encodeURIComponent(job.id) + "'>Generate branded estimate + Jobber paste</a>",
      "jobs");
  }

  function estimateHtml(shop, job, previews) {
    var rows = (job.lineItems || []).map(function (i) {
      return "<tr><td>" + esc(i.name) + (i.note ? "<div class='tiny muted'>" + esc(i.note) + "</div>" : "") + "</td><td>" + i.qty + "</td><td>" + money(i.unitPrice) + "</td><td class='r'>" + money(i.qty * i.unitPrice) + "</td></tr>";
    }).join("") || "<tr><td colspan='4'>No line items yet.</td></tr>";
    var imgs = (job.photos || []).map(function (p, i) {
      return previews[p.id] ? "<img src='" + esc(previews[p.id]) + "' alt='Pad photo " + (i + 1) + "' style='width:100%;border:1px solid #10221a'>" : "";
    }).join("");
    var notes = [job.notes, job.voice && job.voice.transcript].filter(Boolean).join("\n\n");
    return (
      "<article class='sheet print-sheet' style='border-color:" + esc(shop.accent) + "'>" +
        "<header class='sheet-head' style='background:" + esc(shop.accent) + "'>" +
          "<p class='k'>Equipment / reno estimate</p>" +
          "<h2>" + esc(shop.name) + "</h2>" +
          "<p style='margin:4px 0 0;font-weight:700'>" + esc(shop.city) + " · " + esc(shop.phone) + "</p>" +
          "<p class='tiny' style='opacity:.85'>License " + esc(shop.license) + "</p>" +
        "</header>" +
        "<div class='sheet-body'>" +
          "<div class='hrow' style='align-items:flex-start'>" +
            "<div><p class='tiny muted' style='text-transform:uppercase;margin:0'>Homeowner</p><p style='margin:0;font-size:16px;font-weight:900'>" + esc(job.homeowner) + "</p>" +
            "<p style='margin:0;font-weight:700'>" + esc(job.address) + (job.city ? ", " + esc(job.city) : "") + "</p>" +
            (job.phone ? "<p style='margin:0;font-weight:700'>" + esc(job.phone) + "</p>" : "") + "</div>" +
            "<div style='text-align:right;font-weight:700'><p class='tiny muted' style='text-transform:uppercase;margin:0'>Date</p><p style='margin:0'>" + todayLabel() + "</p><p style='margin:0'>" + job.photos.length + " pad photos</p></div>" +
          "</div>" +
          "<table class='space'><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th class='r'>Total</th></tr></thead><tbody>" + rows + "</tbody></table>" +
          (notes ? "<div class='space'><p class='tiny' style='text-transform:uppercase;font-weight:900;margin:0'>Voice / notes from the pad</p><p style='white-space:pre-wrap;font-size:13px;font-weight:600'>" + esc(notes) + "</p></div>" : "") +
          (imgs ? "<div class='space'><p class='tiny' style='text-transform:uppercase;font-weight:900;margin:0'>Pad photos</p><div class='photos space'>" + imgs + "</div></div>" : "") +
          "<div class='tot' style='border-color:" + esc(shop.accent) + "'><span style='text-transform:uppercase;font-size:14px'>Estimate total</span><span class='big'>" + money(quoteTotal(job.lineItems)) + "</span></div>" +
          "<p class='hint'>This is an estimate, not a final invoice.</p>" +
          "<p class='hint'>Priced from what was visible on the equipment pad. Final invoice may change if parts, access, or scope change after this visit.</p>" +
        "</div>" +
      "</article>"
    );
  }

  function viewQuote(id) {
    var job = getJob(id);
    var shop = loadShop();
    if (!job) return shell("Quote", "#/", "<p class='lead'>That job is not on this phone.</p>", "jobs");
    if (!job.quoteGeneratedAt) {
      job = Object.assign({}, job, { quoteGeneratedAt: new Date().toISOString() });
      upsertJob(job);
    }
    var paste = jobberPaste(job, shop);
    return shell("Estimate", "#/job/" + encodeURIComponent(job.id),
      "<div class='no-print stack' style='margin-bottom:16px'>" +
        "<button type='button' class='btn btn-green' data-act='print'>Print / Save PDF</button>" +
        "<button type='button' class='btn btn-ink' data-act='dlhtml'>Download estimate</button>" +
        (flash ? "<p class='ok'>" + esc(flash) + "</p>" : "") +
      "</div>" +
      estimateHtml(shop, job, previewCache) +
      "<div class='no-print space'>" +
        "<h2 class='sec'>Jobber paste</h2>" +
        "<p class='muted' style='margin:0 0 10px;font-size:14px'>Copy homeowner, address, notes, lines, and total. Paste into Jobber as a new job.</p>" +
        "<button type='button' class='btn btn-green' data-act='copypaste'>Copy Jobber paste</button>" +
        "<textarea class='space' readonly style='min-height:160px;font-size:13px'>" + esc(paste) + "</textarea>" +
        "<a class='btn btn-outline space' href='#/'>Back to job list</a>" +
      "</div>",
      "jobs");
  }

  function viewPricebook() {
    var items = loadPricebook();
    var cats = ["equipment", "labor", "pad"];
    var groups = cats.map(function (c) {
      var rows = items.filter(function (i) { return i.category === c; }).map(function (i) {
        return "<li class='card pb'><div><strong>" + esc(i.name) + "</strong><div class='tiny muted'>" + esc(i.category) + "</div></div>" +
          "<div style='display:flex;gap:8px;align-items:center'><input type='number' min='0' style='width:96px;min-height:44px;border-radius:12px' value='" + i.unitPrice + "' data-act='pbprice' data-id='" + esc(i.id) + "'>" +
          "<button class='kill' data-act='pbdel' data-id='" + esc(i.id) + "'>✕</button></div></li>";
      }).join("");
      return "<h3 class='cat'>" + c + "</h3><ul class='list'>" + rows + "</ul>";
    }).join("");
    return shell("Pricebook", "",
      "<p class='lead'>Shop-editable. Seeded for Broward equipment and pad remodel — not weekly routes.</p>" +
      "<form class='card form' data-form='addpb'>" +
        "<input name='name' placeholder='New line name' required>" +
        "<div class='grid2'><select name='category'><option value='equipment'>equipment</option><option value='labor'>labor</option><option value='pad'>pad</option></select>" +
        "<input name='price' type='number' min='0' value='180'></div>" +
        "<button class='btn btn-green' type='submit'>Add line</button>" +
      "</form>" +
      groups +
      "<button type='button' class='btn btn-outline space-lg' data-act='pbreset'>Reset seeded Broward book</button>",
      "pricebook");
  }

  function viewSettings() {
    var shop = loadShop();
    return shell("Shop", "",
      "<p class='lead'>Default shop is Pembroke Pool Service, Pembroke Pines. Color treatment hits the quote.</p>" +
      "<div class='form'>" +
        "<label class='field'><span>Shop name</span><input data-shop='name' value='" + esc(shop.name) + "'></label>" +
        "<label class='field'><span>City</span><input data-shop='city' value='" + esc(shop.city) + "'></label>" +
        "<label class='field'><span>Phone</span><input data-shop='phone' value='" + esc(shop.phone) + "'></label>" +
        "<label class='field'><span>License</span><input data-shop='license' value='" + esc(shop.license) + "'></label>" +
        "<label class='field'><span>Brand color</span><input type='color' data-shop='accent' value='" + esc(shop.accent) + "'></label>" +
        "<button type='button' class='btn btn-outline' data-act='shopreset'>Reset to Pembroke Pool Service</button>" +
      "</div>",
      "settings");
  }

  function hydratePreviews(job) {
    if (!job) return Promise.resolve();
    var jobs = [job];
    var pending = [];
    jobs[0].photos.forEach(function (p) {
      if (previewCache[p.id]) return;
      pending.push(getMedia(p.id).then(function (blob) {
        if (!blob) return;
        return blobToDataUrl(blob).then(function (url) { previewCache[p.id] = url; });
      }));
    });
    if (job.voice && job.voice.hasAudio && !previewCache["voice_" + job.id]) {
      pending.push(getMedia("voice_" + job.id).then(function (blob) {
        if (!blob) return;
        return blobToDataUrl(blob).then(function (url) { previewCache["voice_" + job.id] = url; });
      }));
    }
    return Promise.all(pending);
  }

  function render() {
    var r = parseRoute();
    var root = document.getElementById("app");
    var html;
    if (r.page === "new") html = viewNew();
    else if (r.page === "job") html = viewJob(r.id);
    else if (r.page === "quote") html = viewQuote(r.id);
    else if (r.page === "pricebook") html = viewPricebook();
    else if (r.page === "settings") html = viewSettings();
    else html = viewJobs();
    root.innerHTML = html;

    if (r.page === "job" || r.page === "quote") {
      var job = getJob(r.id);
      hydratePreviews(job).then(function () {
        var still = parseRoute();
        if ((still.page === "job" || still.page === "quote") && still.id === r.id) {
          var el = document.activeElement;
          var keep = el && el.getAttribute && el.getAttribute("data-act");
          if (keep === "notes" || keep === "linenote" || keep === "lineqty" || keep === "lineprice") return;
          root.innerHTML = still.page === "quote" ? viewQuote(r.id) : viewJob(r.id);
        }
      });
    }
  }

  function persistJobPatch(id, patchFn) {
    var job = getJob(id);
    if (!job) return null;
    var next = patchFn(job);
    upsertJob(next);
    return next;
  }

  function getRecog() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    return Ctor ? new Ctor() : null;
  }

  function stopVoice() {
    try { if (recState.rec && recState.rec.state === "recording") recState.rec.stop(); } catch (e) {}
    try { if (recState.recog) recState.recog.stop(); } catch (e) {}
    if (recState.stream) recState.stream.getTracks().forEach(function (t) { t.stop(); });
    if (recState.timer) clearInterval(recState.timer);
    recState.on = false;
    recState.timer = null;
    recState.rec = null;
    recState.stream = null;
    recState.recog = null;
  }

  async function startVoice(jobId) {
    flash = "";
    recState.chunks = [];
    recState.started = Date.now();
    recState.sec = 0;
    recState.jobId = jobId;
    recState.on = true;
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recState.stream = stream;
      var mime = (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm")) ? "audio/webm" : "";
      var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recState.chunks.push(e.data); };
      rec.onstop = async function () {
        if (recState.stream) recState.stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(recState.chunks, { type: rec.mimeType || "audio/webm" });
        var durationSec = Math.min(MAX_SEC, Math.round((Date.now() - recState.started) / 1000));
        await putMedia("voice_" + jobId, blob);
        previewCache["voice_" + jobId] = await blobToDataUrl(blob);
        persistJobPatch(jobId, function (job) {
          return Object.assign({}, job, { voice: Object.assign({}, job.voice, { durationSec: durationSec, hasAudio: true }) });
        });
        render();
      };
      recState.rec = rec;
      rec.start();
    } catch (e) {
      flash = "Mic blocked. Type the note below instead.";
      recState.on = false;
      render();
      return;
    }
    var recog = getRecog();
    if (recog) {
      recog.lang = "en-US";
      recog.interimResults = true;
      recog.continuous = true;
      recog.onresult = function (ev) {
        var text = "";
        for (var i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript + " ";
        var transcript = text.trim();
        persistJobPatch(jobId, function (job) {
          var next = Object.assign({}, job, { voice: Object.assign({}, job.voice, { transcript: transcript, durationSec: Math.round((Date.now() - recState.started) / 1000) }) });
          if (!job.notes) next.notes = transcript;
          return next;
        });
        var heard = document.querySelector("p.card.space");
        if (heard && /^Heard:/.test(heard.textContent || "")) heard.textContent = "Heard: " + transcript;
        else render();
      };
      try { recog.start(); recState.recog = recog; } catch (e) { recState.recog = null; }
    }
    recState.timer = setInterval(function () {
      recState.sec = Math.round((Date.now() - recState.started) / 1000);
      var el = document.getElementById("rec-sec");
      if (el) el.textContent = String(recState.sec);
      if (recState.sec >= MAX_SEC) stopVoice();
    }, 200);
    render();
  }

  async function addPhotos(jobId, files) {
    var job = getJob(jobId);
    if (!job || !files) return;
    var room = MAX_PHOTOS - job.photos.length;
    if (room <= 0) return;
    busy = true;
    render();
    try {
      var list = Array.prototype.slice.call(files, 0, room);
      var added = [];
      for (var i = 0; i < list.length; i++) {
        var blob = await compressImageFile(list[i]);
        var id = uid("photo");
        await putMedia(id, blob);
        previewCache[id] = await blobToDataUrl(blob);
        added.push({ id: id, createdAt: new Date().toISOString() });
      }
      persistJobPatch(jobId, function (j) { return Object.assign({}, j, { photos: j.photos.concat(added) }); });
    } finally {
      busy = false;
      render();
    }
  }

  async function suggest(jobId) {
    var job = getJob(jobId);
    var book = loadPricebook();
    if (!job) return;
    flash = "Reading the pad photos…";
    render();
    var signals = [];
    for (var i = 0; i < job.photos.length; i++) {
      var blob = await getMedia(job.photos[i].id);
      if (!blob) continue;
      var url = await blobToDataUrl(blob);
      signals.push(await analyzePhotoDataUrl(job.photos[i].id, url));
    }
    var suggestions = suggestFromScene(job, book, signals);
    if (!suggestions.length) {
      flash = "Need pad photos or scene notes before we can price from the pad.";
      render();
      return;
    }
    var existing = {};
    (job.lineItems || []).forEach(function (i) { if (i.pricebookId) existing[i.pricebookId] = 1; });
    var added = [];
    suggestions.forEach(function (s) {
      if (existing[s.pricebookId]) return;
      var pb = book.find(function (b) { return b.id === s.pricebookId; });
      if (!pb) return;
      added.push({ id: uid("line"), pricebookId: pb.id, name: pb.name, qty: 1, unitPrice: pb.unitPrice, suggested: true, reason: s.reason });
    });
    persistJobPatch(jobId, function (j) { return Object.assign({}, j, { lineItems: j.lineItems.concat(added) }); });
    flash = added.length ? ("Suggested " + added.length + " line" + (added.length === 1 ? "" : "s") + " from the pad scene.") : "Scene lines already on the quote. Edit them or add from the pricebook.";
    render();
  }

  function downloadEstimate(job, shop) {
    var body = "<!doctype html><html><head><meta charset='utf-8'><title>Estimate — " + esc(job.homeowner) + "</title>" +
      "<style>body{font-family:sans-serif;max-width:640px;margin:24px auto;color:#10221a}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #ddd}</style></head><body>" +
      estimateHtml(shop, job, previewCache) + "</body></html>";
    var blob = new Blob([body], { type: "text/html" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "estimate-" + (job.homeowner || "job").replace(/\s+/g, "-").toLowerCase() + ".html";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); return true; } catch (err) { return false; }
      finally { document.body.removeChild(ta); }
    }
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-go],[data-act],a[href^='#']");
    if (!t) return;
    if (t.getAttribute("data-go")) {
      e.preventDefault();
      go(t.getAttribute("data-go"));
      return;
    }
    var act = t.getAttribute("data-act");
    if (!act) return;
    var r = parseRoute();
    var job = r.id ? getJob(r.id) : null;
    if (act === "print") window.print();
    else if (act === "dlhtml" && job) {
      downloadEstimate(job, loadShop());
      flash = "Estimate downloaded.";
      render();
    } else if (act === "copypaste" && job) {
      copyText(jobberPaste(job, loadShop())).then(function (ok) {
        flash = ok ? "Copied for Jobber." : "Copy failed — select the text below.";
        render();
      });
    } else if (act === "startvoice" && job) startVoice(job.id);
    else if (act === "stopvoice") { stopVoice(); }
    else if (act === "delvoice" && job) {
      deleteMedia("voice_" + job.id).then(function () {
        delete previewCache["voice_" + job.id];
        persistJobPatch(job.id, function (j) { return Object.assign({}, j, { voice: Object.assign({}, j.voice, { hasAudio: false, durationSec: 0 }) }); });
        render();
      });
    } else if (act === "delphoto" && job) {
      var pid = t.getAttribute("data-id");
      deleteMedia(pid).then(function () {
        delete previewCache[pid];
        persistJobPatch(job.id, function (j) { return Object.assign({}, j, { photos: j.photos.filter(function (p) { return p.id !== pid; }) }); });
        render();
      });
    } else if (act === "delline" && job) {
      var lid = t.getAttribute("data-id");
      persistJobPatch(job.id, function (j) { return Object.assign({}, j, { lineItems: j.lineItems.filter(function (i) { return i.id !== lid; }) }); });
      render();
    } else if (act === "suggest" && job) suggest(job.id);
    else if (act === "pbdel") {
      var items = loadPricebook().filter(function (i) { return i.id !== t.getAttribute("data-id"); });
      savePricebook(items);
      render();
    } else if (act === "pbreset") {
      savePricebook(SEED.slice());
      render();
    } else if (act === "shopreset") {
      saveShop(DEFAULT_SHOP);
      render();
    }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    var r = parseRoute();
    if (t.getAttribute("data-act") === "photos" && r.id) {
      addPhotos(r.id, t.files);
      t.value = "";
      return;
    }
    if (t.getAttribute("data-act") === "addbook" && r.id && t.value) {
      var book = loadPricebook();
      var pb = book.find(function (b) { return b.id === t.value; });
      if (pb) {
        persistJobPatch(r.id, function (j) {
          if (j.lineItems.some(function (i) { return i.pricebookId === pb.id; })) return j;
          return Object.assign({}, j, { lineItems: j.lineItems.concat([{ id: uid("line"), pricebookId: pb.id, name: pb.name, qty: 1, unitPrice: pb.unitPrice }]) });
        });
        render();
      }
      return;
    }
    if (t.getAttribute("data-act") === "pbprice") {
      var items = loadPricebook().map(function (i) {
        return i.id === t.getAttribute("data-id") ? Object.assign({}, i, { unitPrice: Math.max(0, Number(t.value) || 0) }) : i;
      });
      savePricebook(items);
      return;
    }
    var shopKey = t.getAttribute("data-shop");
    if (shopKey) {
      var shop = loadShop();
      shop[shopKey] = t.value;
      saveShop(shop);
      applyAccent(shop);
      var kicker = document.querySelector("header.top .kicker");
      if (kicker && (shopKey === "name" || shopKey === "city")) kicker.textContent = shop.name + " · " + shop.city;
    }
  });

  document.addEventListener("input", function (e) {
    var t = e.target;
    var r = parseRoute();
    if (!r.id) return;
    var act = t.getAttribute("data-act");
    if (act === "notes") persistJobPatch(r.id, function (j) { return Object.assign({}, j, { notes: t.value }); });
    else if (act === "lineqty") persistJobPatch(r.id, function (j) {
      return Object.assign({}, j, { lineItems: j.lineItems.map(function (i) { return i.id === t.getAttribute("data-id") ? Object.assign({}, i, { qty: Math.max(1, Number(t.value) || 1) }) : i; }) });
    });
    else if (act === "lineprice") persistJobPatch(r.id, function (j) {
      return Object.assign({}, j, { lineItems: j.lineItems.map(function (i) { return i.id === t.getAttribute("data-id") ? Object.assign({}, i, { unitPrice: Math.max(0, Number(t.value) || 0) }) : i; }) });
    });
    else if (act === "linenote") persistJobPatch(r.id, function (j) {
      return Object.assign({}, j, { lineItems: j.lineItems.map(function (i) { return i.id === t.getAttribute("data-id") ? Object.assign({}, i, { note: t.value }) : i; }) });
    });
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (form.getAttribute("data-form") === "newjob") {
      e.preventDefault();
      var fd = new FormData(form);
      var homeowner = String(fd.get("homeowner") || "").trim();
      var address = String(fd.get("address") || "").trim();
      if (!homeowner || !address) return;
      var shop = loadShop();
      var now = new Date().toISOString();
      var job = {
        id: uid("job"), createdAt: now, updatedAt: now,
        homeowner: homeowner, address: address,
        city: String(fd.get("city") || "").trim() || shop.city,
        phone: String(fd.get("phone") || "").trim(),
        notes: "", photos: [], voice: { durationSec: 0, transcript: "", hasAudio: false }, lineItems: []
      };
      upsertJob(job);
      go("/job/" + job.id);
    } else if (form.getAttribute("data-form") === "addpb") {
      e.preventDefault();
      var fd2 = new FormData(form);
      var name = String(fd2.get("name") || "").trim();
      if (!name) return;
      var items = loadPricebook();
      items.push({ id: uid("pb"), name: name, category: String(fd2.get("category") || "equipment"), unitPrice: Math.max(0, Number(fd2.get("price")) || 0), unit: "ea", sceneTags: [] });
      savePricebook(items);
      render();
    }
  });

  window.addEventListener("hashchange", function () { flash = ""; render(); });
  render();
})();
