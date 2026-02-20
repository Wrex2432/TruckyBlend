// -----------------------------
// Config
// -----------------------------
const backend  = "https://api.thejoymeter.com";
const wsOrigin = "wss://api.thejoymeter.com/ws"; // browser WS via reverse proxy
const LS_KEY   = "TOW_STATE_V1"; // localStorage key

// How long the button shows "Inactive" (ms) after a click
const PRESS_FEEDBACK_MS = 100;

// -----------------------------
// DOM
// -----------------------------
const joinBtn        = document.getElementById('joinBtn');
const pullBtn        = document.getElementById('pullBtn');
const pullBtnImage   = document.getElementById('pullBtnImage');
const toggleBtn      = document.getElementById('toggleModeBtn');
const teamSelect     = document.getElementById('team');

const joinSection    = document.getElementById('join-section');
const controlSection = document.getElementById('control-section');
const statusText     = document.getElementById('status');
const welcomeText    = document.getElementById('welcome');

const teamBanner     = document.getElementById('teamBanner');
const teamTruck      = document.getElementById('teamTruck');

const badgeCode      = document.getElementById('badgeCode');
const badgeTeam      = document.getElementById('badgeTeam');
const clearStateBtn  = document.getElementById('clearStateBtn');

// Voucher modal
const voucherModal    = document.getElementById('voucherModal');
const voucherCodeText = document.getElementById('voucherCodeText');
const copyVoucherBtn  = document.getElementById('copyVoucherBtn');
const closeVoucherBtn = document.getElementById('closeVoucherBtn');

let username, code, team;
let isManual = false;
let ws = null;
let pingHandle = null;
let pressTimer = null; // ← keeps track of the revert timer

// -----------------------------
// Helpers: Local Storage
// -----------------------------
function readState () {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeState (patch) {
  const cur = readState();
  const next = { ...cur, ...patch };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}

function clearState () {
  localStorage.removeItem(LS_KEY);
}

// Keep voucher when clearing join-only info (used when closing modal)
function clearJoinStateButKeepVoucher () {
  const st = readState();
  localStorage.setItem(LS_KEY, JSON.stringify({
    voucherCode: st.voucherCode || null,
    voucherAt: st.voucherAt || null,
    username: st.username || null // optional: keep name for convenience
  }));
}

// -----------------------------
// UI Helpers
// -----------------------------
function showStatus (msg) {
  if (statusText) statusText.textContent = msg || "";
}

function setTeamVisuals (teamName) {
  if (!teamName) return;
  if (teamName === 'TeamA') {
    teamBanner.src = './assets/Banner_TeamA.png';
    teamTruck.src  = './assets/TruckA.png';
  } else {
    teamBanner.src = './assets/Banner_TeamB.png';
    teamTruck.src  = './assets/TruckB.png';
  }
  teamBanner.classList.remove('hidden');
  teamTruck.classList.remove('hidden');
}

function setBadges (codeStr, teamName) {
  if (badgeCode) badgeCode.textContent = codeStr ? `Code: ${codeStr}` : '';
  if (badgeTeam) badgeTeam.textContent = teamName ? ` • ${teamName}` : '';
}

// Voucher modal helpers
function openVoucherModal(voucherCode) {
  if (!voucherCode) return;
  voucherCodeText.textContent = voucherCode;
  voucherModal.classList.remove('hidden');
  voucherModal.setAttribute('aria-hidden', 'false');
}

function closeVoucherModal() {
  voucherModal.classList.add('hidden');
  voucherModal.setAttribute('aria-hidden', 'true');
}

// Copy to clipboard
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showStatus("Voucher copied!");
    setTimeout(() => showStatus(""), 1200);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(el);
    showStatus("Voucher copied!");
    setTimeout(() => showStatus(""), 1200);
  }
}

// Wire modal buttons
if (copyVoucherBtn) {
  copyVoucherBtn.onclick = () => {
    const code = voucherCodeText?.textContent || '';
    if (code) copyText(code);
  };
}
if (closeVoucherBtn) {
  closeVoucherBtn.onclick = () => {
    closeVoucherModal();
    joinSection.classList.remove('hidden');
    controlSection.classList.add('hidden');
    clearJoinStateButKeepVoucher();
  };
}

// -----------------------------
// Mode toggle (auto/manual team)
// -----------------------------
teamSelect.style.display = 'none';
toggleBtn.textContent = "Switch to Manual";

toggleBtn.onclick = () => {
  isManual = !isManual;
  teamSelect.style.display = isManual ? 'block' : 'none';
  toggleBtn.textContent = isManual ? "Switch to Auto" : "Switch to Manual";
};

// -----------------------------
// Join
// -----------------------------
joinBtn.onclick = async () => {
  username = document.getElementById('username').value.trim();
  code     = document.getElementById('code').value.trim().toUpperCase();
  team     = isManual ? teamSelect.value : undefined;

  if (!username || !code) {
    showStatus("Please enter your name and game code.");
    return;
  }

  const body = { username, code, gameType: "tug_of_war", location: "local" };
  if (isManual) body.team = team;

  try {
    const res  = await fetch(`${backend}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      showStatus(data?.error || "Failed to join.");
      return;
    }
    if (data.status === "full") {
      showStatus("❌ This game is already full.");
      return;
    }

    team = data.team; // server decides team if auto
    showStatus("");
    welcomeText.textContent = `Hi ${username}, you joined ${team}`;
    joinSection.classList.add('hidden');
    controlSection.classList.remove('hidden');
    setTeamVisuals(team);
    setBadges(code, team);

    writeState({ code, username, team });
    setupWebSocket();
  } catch (err) {
    console.error(err);
    showStatus("Server error.");
  }
};

// -----------------------------
// Pull action with momentary "Inactive" feedback
// -----------------------------
if (pullBtn) {
  pullBtn.onclick = async () => {
    const st = readState();
    const u  = username || st.username;
    const c  = code || st.code;
    if (!u || !c) return;

    // Visual press feedback: show Inactive briefly, then revert
    if (pullBtnImage) {
      // Clear previous timer if user spams clicks
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      // Set inactive and temporarily disable the button (prevents double-fire in some browsers)
      pullBtn.disabled = true;
      pullBtnImage.src = "./assets/Button_Inactive.png";

      // Revert after PRESS_FEEDBACK_MS
      pressTimer = setTimeout(() => {
        pullBtnImage.src = "./assets/Button_Active.png";
        pullBtn.disabled = false;
        pressTimer = null;
      }, PRESS_FEEDBACK_MS);
    }

    // Fire action to backend (no need to await for the visual to revert)
    try {
      await fetch(`${backend}/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, code: c, action: "pull" })
      });
    } catch (err) {
      console.error("Failed to trigger pull:", err);
      // Even on error, make sure button is usable again
      if (pullBtnImage && !pressTimer) {
        pullBtnImage.src = "./assets/Button_Active.png";
        pullBtn.disabled  = false;
      }
    }
  };
}

// -----------------------------
// Voucher fetch (safety net)
// -----------------------------
async function fetchVoucherStatus(u, c) {
  try {
    const resp = await fetch(`${backend}/voucher-status?code=${encodeURIComponent(c)}&username=${encodeURIComponent(u)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.awarded && data.voucherCode) {
      openVoucherModal(data.voucherCode);
      writeState({ voucherCode: data.voucherCode, voucherAt: Date.now() });
    }
  } catch { /* ignore */ }
}

// -----------------------------
// WebSocket
// -----------------------------
function setupWebSocket () {
  const st = readState();
  const c  = code || st.code;
  const u  = username || st.username;
  if (!c || !u) return;

  try {
    ws = new WebSocket(`${wsOrigin}/${c}`);

    ws.onopen = () => {
      console.log("✅ WebSocket connected");
      ws.send(JSON.stringify({ type: "registerClient", username: u }));

      clearInterval(pingHandle);
      pingHandle = setInterval(() => {
        try { ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }, 20000);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("📩 WS message:", data);

      if (data.type === "voucherAward") {
        openVoucherModal(data.voucherCode);
        writeState({
          code: data.gameCode || c,
          username: u,
          team: st.team || team || null,
          voucherCode: data.voucherCode,
          voucherAt: Date.now()
        });
      }

      if (data.type === "gameStart") {
        showStatus("✅ Game Started!");
      }

      if (data.type === "gameEnd") {
        showStatus("🛑 Game Ended!");
        const hadVoucher = !!readState().voucherCode;
        if (!hadVoucher) {
          setTimeout(() => fetchVoucherStatus(u, c), 800);
        }
      }

      if (data.type === "roleAssignment") {
        writeState({ role: data.role || null });
      }
    };

    ws.onclose = () => {
      console.log("❌ WebSocket closed");
      clearInterval(pingHandle);
    };

    ws.onerror = (err) => {
      console.error("⚠️ WebSocket error", err);
    };
  } catch (e) {
    console.warn("WS init failed:", e);
  }
}

// -----------------------------
// Restore on load
// -----------------------------
function restoreFromStorage () {
  const st = readState();

  // Always default to join screen on reload
  joinSection.classList.remove('hidden');
  controlSection.classList.add('hidden');

  // Prefill username if stored (keeps your UX)
  if (st?.username) {
    const u = document.getElementById('username');
    if (u) u.value = st.username;
  }

  // If they have a saved voucher, show it as pop-up
  if (st?.voucherCode) {
    openVoucherModal(st.voucherCode);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreFromStorage, { once: true });
} else {
  restoreFromStorage();
}

// -----------------------------
// Clear Saved State (for testing/support)
// -----------------------------
if (clearStateBtn) {
  clearStateBtn.onclick = () => {
    clearState();
    location.reload();
  };
}

// -----------------------------
// Graceful disconnect notice (best-effort)
// -----------------------------
window.addEventListener('beforeunload', async () => {
  const st = readState();
  const u  = username || st.username;
  const c  = code || st.code;
  if (!u || !c) return;
  try {
    await fetch(`${backend}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, code: c, gameType: 'tug_of_war' })
    });
  } catch { /* ignore */ }
});
