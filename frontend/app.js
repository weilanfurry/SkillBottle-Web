/**
 * SkillBottle Web – Frontend Application
 *
 * Architecture notes:
 * - Token stored in HttpOnly cookie (sb_admin_token), read via /api/admin/status
 * - iframe communication via postMessage with origin validation
 * - Personalize sync: localStorage (offline) + backend DB (persistent), last-write-wins
 */

// --------------------------------------------------------------------------- //
// Utilities
// --------------------------------------------------------------------------- //

let _toastTimer = null;

function showToast(message, type = "info", duration = 4000) {
  const el = document.getElementById("sbToast");
  if (!el) return;
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
  el.className = "sb-toast toast-" + type;
  el.textContent = message;
  el.style.display = "block";
  el.style.opacity = "1";
  el.onclick = () => {
    el.style.display = "none";
    el.onclick = null;
  };
  _toastTimer = setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => {
      if (el.style.opacity === "0") el.style.display = "none";
    }, 200);
  }, duration);
}

async function fetchJson(url, init) {
  const debug =
    new URLSearchParams(location.search || "").get("debug") === "1" ||
    localStorage.getItem(STORAGE_DEBUG) === "1";

  const i = { ...(init || {}) };
  const timeoutMs = typeof i.timeoutMs === "number" ? i.timeoutMs : 15000;
  delete i.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (debug) console.log("[SkillBottle] fetch", url, { timeoutMs });
    const res = await fetch(url, {
      ...i,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...((i && i.headers) || {}),
      },
      credentials: "include",  // always send cookies
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function showInitError(err) {
  console.error("[SkillBottle] init failed", err);
  const el = document.getElementById("navEmpty");
  const items = document.getElementById("navItems");
  if (!el) return;
  if (items && items.children && items.children.length) return;

  const msg = err && err.message ? err.message : String(err || "unknown error");
  el.textContent = `前端初始化失败：${msg}（可在地址栏加 ?debug=1 查看更多日志）`;
  el.style.display = "block";
  showToast(`初始化失败：${msg}`, "error");
}

function setEmptyVisible(visible) {
  const empty = document.getElementById("viewerEmpty");
  if (!empty) return;
  empty.style.display = visible ? "flex" : "none";
}

function setViewerEmpty(title, desc) {
  const titleEl = document.getElementById("viewerTitle");
  const descEl = document.getElementById("viewerDesc");
  if (titleEl) titleEl.textContent = title || "";
  if (descEl) descEl.textContent = desc || "";
}

function showLockedMessage(item) {
  hideAllViewers();
  const label = item ? item.label : "该项目";
  setViewerEmpty(
    `${label} 已锁定`,
    `如需访问，请联系管理员获取授权。\n技术交流生态 QQ群：996390776`
  );
  setEmptyVisible(true);
}

// --------------------------------------------------------------------------- //
// Storage helpers (localStorage / sessionStorage with error guards)
// --------------------------------------------------------------------------- //

function safeStorageGet(storage, key) {
  try {
    return storage && storage.getItem ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(storage, key, value) {
  try {
    if (storage && storage.setItem) storage.setItem(key, value);
  } catch {}
}

function safeStorageRemove(storage, key) {
  try {
    if (storage && storage.removeItem) storage.removeItem(key);
  } catch {}
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function normalizeUnixSeconds(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v || "0"));
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Back-compat: older builds stored ms timestamps (Date.now()).
  return n > 1e12 ? n / 1000 : n;
}

function nowUnixSeconds() {
  return Date.now() / 1000;
}

function loadPersonalizeTs() {
  const raw = loadJson(STORAGE_PERSONALIZE_TS, 0);
  const ts = normalizeUnixSeconds(raw);
  if (raw && typeof raw === "number" && raw > 1e12) {
    // Migrate ms -> seconds
    saveJson(STORAGE_PERSONALIZE_TS, ts);
  }
  return ts;
}

// --------------------------------------------------------------------------- //
// Storage keys
// --------------------------------------------------------------------------- //

const STORAGE_MANAGE = "skillbottle:manage";
const STORAGE_LOCKED = "skillbottle:locked";
const STORAGE_LABELS = "skillbottle:labels";
const STORAGE_PERSONALIZE = "skillbottle:personalize";
const STORAGE_THEME = "skillbottle:theme";
const STORAGE_LAST = "skillbottle:last";
const STORAGE_DEBUG = "skillbottle:debug";
const STORAGE_DEVICE = "skillbottle:device";
const STORAGE_PERSONALIZE_VERSION = "skillbottle:personalize_version";
const STORAGE_PERSONALIZE_TS = "skillbottle:personalize_ts";

// --------------------------------------------------------------------------- //
// Global state
// --------------------------------------------------------------------------- //

let manageMode = safeStorageGet(sessionStorage, STORAGE_MANAGE) === "1";
let adminToken = null;  // never persisted – lives in HttpOnly cookie on server
let labels = loadJson(STORAGE_LABELS, {});
let lockedObj = loadJson(STORAGE_LOCKED, {});
const lockedIds = new Set(Object.keys(lockedObj || {}).filter((k) => lockedObj[k]));
let serverConfigTs = 0;

function isLocked(id) {
  return !!id && id !== ADVANCED_ID && lockedIds.has(id);
}

// --------------------------------------------------------------------------- //
// Constants
// --------------------------------------------------------------------------- //

const ADVANCED_ID = "__advanced__";

// --------------------------------------------------------------------------- //
// Theme
// --------------------------------------------------------------------------- //

function getEmbeddedTheme() {
  const el = document.getElementById("sb-theme");
  if (!el) return "";
  try {
    const v = JSON.parse(el.textContent || '""');
    return v === "light" || v === "dark" ? v : "";
  } catch {
    return "";
  }
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  safeStorageSet(localStorage, STORAGE_THEME, t);

  const toggle = document.getElementById("themeToggle");
  if (toggle) toggle.checked = t === "light";

  // Update theme preview box
  const previewBox = document.getElementById("themePreviewBox");
  if (previewBox) {
    previewBox.style.background = t === "dark" ? "#121212" : "#f6f7f9";
    previewBox.style.borderColor = t === "dark" ? "#333" : "#e4e7ec";
  }
  const previewInner = document.getElementById("themePreviewInner");
  if (previewInner) {
    previewInner.style.background = t === "dark" ? "#1A1A1A" : "#fff";
  }
}

function initTheme() {
  const saved = safeStorageGet(localStorage, STORAGE_THEME);
  const embedded = getEmbeddedTheme();
  applyTheme(saved || embedded || "dark");

  const toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.addEventListener("change", () => {
      applyTheme(toggle.checked ? "light" : "dark");
      // Persist theme preference (personalize sync is separate)
      if (manageMode) {
        syncPersonalizeToBackend();
      }
    });
  }
}

// --------------------------------------------------------------------------- //
// Personalize
// --------------------------------------------------------------------------- //

function getEmbeddedPersonalize() {
  const el = document.getElementById("sb-personalize");
  if (!el) return null;
  try {
    const v = JSON.parse(el.textContent || "{}");
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function normalizeHexColor(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return "";
}

function getCssHexVar(name) {
  try {
    return normalizeHexColor(
      getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    );
  } catch {
    return "";
  }
}

function applyPersonalize(state, defaults) {
  const root = document.documentElement;

  const titleRaw = state && typeof state.title === "string" ? state.title.trim() : "";
  const subtitleRaw =
    state && typeof state.subtitle === "string" ? state.subtitle.trim() : "";

  const title = titleRaw || defaults.defaultTitle;
  const subtitle = subtitleRaw || defaults.defaultSubtitle;

  if (defaults.titleEl) defaults.titleEl.textContent = title;
  if (defaults.subtitleEl) defaults.subtitleEl.textContent = subtitle;
  document.title = title;

  const brandColor = normalizeHexColor(state && state.brandColor);
  if (brandColor) root.style.setProperty("--custom-brand-color", brandColor);
  else root.style.removeProperty("--custom-brand-color");

  const frameBg = normalizeHexColor(state && state.frameBg);
  if (frameBg) root.style.setProperty("--custom-frame-bg", frameBg);
  else root.style.removeProperty("--custom-frame-bg");

  // Update theme preview brand color
  const previewBrand = document.querySelector(".theme-preview-brand");
  if (previewBrand) {
    previewBrand.style.color = brandColor || getCssHexVar("--brand") || "#9ad1ff";
  }
}

function syncPersonalizeToBackend() {
  if (!manageMode) return;
  const state = loadJson(STORAGE_PERSONALIZE, {}) || {};
  const theme = safeStorageGet(localStorage, STORAGE_THEME) || "dark";
  const ts = nowUnixSeconds();
  saveJson(STORAGE_PERSONALIZE_VERSION, ts);
  saveJson(STORAGE_PERSONALIZE_TS, ts);
  fetchJson("/api/admin/config", {
    method: "POST",
    body: JSON.stringify({ personalize: state, theme, updated_at: ts }),
  })
    .then((res) => {
      const nextTs = normalizeUnixSeconds(res && res.updated_at);
      if (nextTs) {
        serverConfigTs = nextTs;
        saveJson(STORAGE_PERSONALIZE_TS, nextTs);
      }
    })
    .catch(() => {});
}

function initPersonalize() {
  const titleEl = document.getElementById("brandTitle");
  const subtitleEl = document.getElementById("brandSubtitle");

  const defaults = {
    titleEl,
    subtitleEl,
    defaultTitle: titleEl ? titleEl.textContent : "SkillBottle Web",
    defaultSubtitle: subtitleEl ? subtitleEl.textContent : "",
  };

  const inputTitle = document.getElementById("personalTitleInput");
  const inputSubtitle = document.getElementById("personalSubtitleInput");
  const inputBrandColor = document.getElementById("personalBrandColorInput");
  const inputFrameBg = document.getElementById("personalFrameBgInput");
  const resetBtn = document.getElementById("personalResetBtn");

  const defaultBrandColor = getCssHexVar("--brand") || "#9ad1ff";
  const defaultFrameBg = getCssHexVar("--card") || "#1a1a1a";

  // Conflict resolution: embedded (static export) < localStorage < backend
  // last-write-wins based on timestamp
  let state = loadJson(STORAGE_PERSONALIZE, null);
  if (!state || typeof state !== "object" || Object.keys(state).length === 0) {
    const embedded = getEmbeddedPersonalize();
    if (embedded && typeof embedded === "object") state = embedded;
    else state = {};
  }

  applyPersonalize(state, defaults);

  if (inputTitle) inputTitle.value = (state.title && String(state.title)) || "";
  if (inputSubtitle)
    inputSubtitle.value = (state.subtitle && String(state.subtitle)) || "";
  if (inputBrandColor)
    inputBrandColor.value = normalizeHexColor(state.brandColor) || defaultBrandColor;
  if (inputFrameBg)
    inputFrameBg.value = normalizeHexColor(state.frameBg) || defaultFrameBg;

  function persist() {
    saveJson(STORAGE_PERSONALIZE, state);
    saveJson(STORAGE_PERSONALIZE_TS, nowUnixSeconds());
    applyPersonalize(state, defaults);
    if (manageMode) {
      syncPersonalizeToBackend();
    }
  }

  if (inputTitle) {
    inputTitle.addEventListener("input", () => {
      const v = inputTitle.value.trim();
      if (v) state.title = v;
      else delete state.title;
      persist();
    });
  }

  if (inputSubtitle) {
    inputSubtitle.addEventListener("input", () => {
      const v = inputSubtitle.value.trim();
      if (v) state.subtitle = v;
      else delete state.subtitle;
      persist();
    });
  }

  if (inputBrandColor) {
    inputBrandColor.addEventListener("input", () => {
      const v = normalizeHexColor(inputBrandColor.value);
      if (v) state.brandColor = v;
      else delete state.brandColor;
      persist();
    });
  }

  if (inputFrameBg) {
    inputFrameBg.addEventListener("input", () => {
      const v = normalizeHexColor(inputFrameBg.value);
      if (v) state.frameBg = v;
      else delete state.frameBg;
      persist();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      state = {};
      safeStorageRemove(localStorage, STORAGE_PERSONALIZE);
      safeStorageRemove(localStorage, STORAGE_PERSONALIZE_TS);
      safeStorageRemove(localStorage, STORAGE_PERSONALIZE_VERSION);
      applyPersonalize(state, defaults);

      if (inputTitle) inputTitle.value = "";
      if (inputSubtitle) inputSubtitle.value = "";
      if (inputBrandColor)
        inputBrandColor.value = getCssHexVar("--brand") || defaultBrandColor;
      if (inputFrameBg)
        inputFrameBg.value = getCssHexVar("--card") || defaultFrameBg;

      if (manageMode) {
        syncPersonalizeToBackend();
      }
    });
  }
}

// --------------------------------------------------------------------------- //
// Admin / Auth
// --------------------------------------------------------------------------- //

async function fetchAdminStatus() {
  try {
    return await fetchJson("/api/admin/status");
  } catch {
    return { configured: false, source: "static" };
  }
}

async function refreshAdminUi() {
  const card = document.getElementById("adminPwdCard");
  const logoutRow = document.getElementById("adminLogoutRow");
  if (!card) return;

  if (!manageMode) {
    card.style.display = "none";
    return;
  }

  card.style.display = "block";
  if (logoutRow) logoutRow.style.display = adminToken ? "flex" : "none";

  const statusEl = document.getElementById("adminPwdStatus");
  const setBtn = document.getElementById("adminSetPwdBtn");
  const changeBtn = document.getElementById("adminChangePwdBtn");

  const st = await fetchAdminStatus();

  if (st.source === "static") {
    if (statusEl) statusEl.textContent = "管理模式需要后端支持";
    if (setBtn) setBtn.style.display = "none";
    if (changeBtn) changeBtn.style.display = "none";
    return;
  }

  if (st.source === "env") {
    if (statusEl) statusEl.textContent = "已通过环境变量配置，无法在界面修改";
    if (setBtn) setBtn.style.display = "none";
    if (changeBtn) changeBtn.style.display = "none";
    return;
  }

  if (!st.configured) {
    if (statusEl) statusEl.textContent = "未设置，可注册密码";
    if (setBtn) setBtn.style.display = "inline-flex";
    if (changeBtn) changeBtn.style.display = "none";
    return;
  }

  if (statusEl) statusEl.textContent = "已设置" + (adminToken ? "（已登录）" : "");
  if (setBtn) setBtn.style.display = "none";
  if (changeBtn) changeBtn.style.display = "inline-flex";
}

async function registerAdminPassword() {
  const p1 = prompt("未设置管理员密码，请注册（至少 8 位，需包含数字和字母）");
  if (p1 === null) return false;
  if (p1.length < 8) {
    showToast("密码至少 8 位", "error");
    return false;
  }
  if (!/[A-Za-z]/.test(p1) || !/\d/.test(p1)) {
    showToast("密码必须包含字母和数字", "error");
    return false;
  }

  const p2 = prompt("请再次输入管理员密码");
  if (p2 === null) return false;
  if (p1 !== p2) {
    showToast("两次输入不一致", "error");
    return false;
  }

  try {
    const data = await fetchJson("/api/admin/register", {
      method: "POST",
      body: JSON.stringify({ password: p1 }),
    });

    if (data && data.ok) {
      showToast("管理员密码已注册", "success");
      await refreshAdminUi();
      return true;
    }

    showToast((data && data.reason) || "注册失败", "error");
    await refreshAdminUi();
    return false;
  } catch {
    showToast("管理模式需要后端支持（请通过后端运行）", "error");
    return false;
  }
}

async function changeAdminPassword() {
  const oldPassword = prompt("请输入原管理员密码");
  if (oldPassword === null) return false;

  const p1 = prompt("请输入新管理员密码（至少 8 位，需包含数字和字母）");
  if (p1 === null) return false;
  if (p1.length < 8) {
    showToast("密码至少 8 位", "error");
    return false;
  }
  if (!/[A-Za-z]/.test(p1) || !/\d/.test(p1)) {
    showToast("密码必须包含字母和数字", "error");
    return false;
  }

  const p2 = prompt("请再次输入新管理员密码");
  if (p2 === null) return false;
  if (p1 !== p2) {
    showToast("两次输入不一致", "error");
    return false;
  }

  try {
    const data = await fetchJson("/api/admin/change", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: p1 }),
    });

    if (data && data.ok) {
      showToast("管理员密码已更新", "success");
      await refreshAdminUi();
      return true;
    }

    showToast((data && data.reason) || "修改失败", "error");
    await refreshAdminUi();
    return false;
  } catch {
    showToast("管理模式需要后端支持（请通过后端运行）", "error");
    return false;
  }
}

async function revokeCurrentToken() {
  if (!adminToken) return;
  try {
    await fetchJson("/api/admin/revoke", {
      method: "POST",
      body: JSON.stringify({ token: adminToken }),
    });
  } catch {
    // Best-effort
  }
  adminToken = null;
}

function initAdminPasswordCard() {
  const setBtn = document.getElementById("adminSetPwdBtn");
  const changeBtn = document.getElementById("adminChangePwdBtn");
  const logoutBtn = document.getElementById("adminLogoutBtn");

  if (setBtn) {
    setBtn.addEventListener("click", async () => {
      await registerAdminPassword();
    });
  }

  if (changeBtn) {
    changeBtn.addEventListener("click", async () => {
      await changeAdminPassword();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await revokeCurrentToken();
      adminToken = null;
      setManageMode(false);
      rerenderNav();
    });
  }
}

async function enterManageMode() {
  const st = await fetchAdminStatus();

  if (st.source === "static") {
    showToast("管理模式需要后端支持（请通过后端运行）", "error");
    return false;
  }

  if (!st.configured) {
    const ok = await registerAdminPassword();
    if (!ok) return false;

    // After registering, proceed to login
  }

  const password = prompt("请输入管理员密码");
  if (password === null) return false;

  try {
    const data = await fetchJson("/api/admin/verify", {
      method: "POST",
      body: JSON.stringify({ password: String(password) }),
    });

    if (data && data.ok) {
      // Token is in HttpOnly cookie – we just get confirmation
      adminToken = data.token || "cookie";
      setManageMode(true);
      if (!serverConfigTs) {
        // First-time migration: persist existing local personalize to backend.
        syncPersonalizeToBackend();
      }
      await refreshAdminUi();
      rerenderNav();
      showToast("已进入管理模式", "success");
      return true;
    }

    showToast((data && data.reason) || "管理员密码错误", "error");
    return false;
  } catch (err) {
    if (err.status === 429) {
      showToast("尝试次数过多，请稍后再试", "error");
    } else {
      showToast("管理模式需要后端支持（请通过后端运行）", "error");
    }
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Manage mode
// --------------------------------------------------------------------------- //

function setManageMode(on) {
  manageMode = !!on;
  safeStorageSet(sessionStorage, STORAGE_MANAGE, manageMode ? "1" : "0");
  safeStorageRemove(localStorage, STORAGE_MANAGE);

  document.documentElement.setAttribute("data-manage", manageMode ? "1" : "0");

  const manageCard = document.getElementById("manageCard");
  if (manageCard) manageCard.style.display = manageMode ? "block" : "none";

  const pwdCard = document.getElementById("adminPwdCard");
  if (pwdCard) {
    pwdCard.style.display = manageMode ? "block" : "none";
    if (manageMode) refreshAdminUi();
  }
}

// --------------------------------------------------------------------------- //
// Lock / unlock
// --------------------------------------------------------------------------- //

function setLocked(id, on) {
  if (!id || id === ADVANCED_ID) return;
  if (on) lockedIds.add(id);
  else lockedIds.delete(id);

  const next = {};
  for (const k of lockedIds) next[k] = true;
  saveJson(STORAGE_LOCKED, next);
}

// --------------------------------------------------------------------------- //
// Labels
// --------------------------------------------------------------------------- //

function getItemLabel(item) {
  if (!item || !item.id) return "";
  const custom =
    labels && Object.prototype.hasOwnProperty.call(labels, item.id)
      ? labels[item.id]
      : null;
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  return item.label;
}

function setItemLabel(id, label) {
  if (!id) return;
  const v = (label || "").trim();
  if (!labels || typeof labels !== "object") labels = {};

  if (!v) delete labels[id];
  else labels[id] = v;

  saveJson(STORAGE_LABELS, labels);
}

// --------------------------------------------------------------------------- //
// Navigation state
// --------------------------------------------------------------------------- //

let lastNavItems = [];
let lastNavMode = "backend";
const runningFrames = new Map(); // id -> iframe
const runningPanels = new Set(); // id
let activeId = "";

function rerenderNav() {
  renderNav(lastNavItems, lastNavMode);
}

// --------------------------------------------------------------------------- //
// Context menu
// --------------------------------------------------------------------------- //

let contextMenuEl = null;
let contextMenuItem = null;

function hideAppMenu() {
  if (!contextMenuEl) return;
  contextMenuEl.style.display = "none";
  contextMenuItem = null;
}

function ensureAppMenu() {
  if (contextMenuEl) return contextMenuEl;

  const el = document.createElement("div");
  el.id = "sbContextMenu";
  el.className = "sb-menu";
  el.setAttribute("role", "menu");
  el.innerHTML = `
    <button type="button" data-action="edit">应用编辑</button>
    <button type="button" data-action="lock">管理锁定</button>
    <div class="sb-menu-sep" aria-hidden="true"></div>
    <button type="button" data-action="fullscreen">全屏</button>
    <div class="sb-menu-sep" aria-hidden="true"></div>
    <button type="button" data-action="manage">管理模式</button>
  `.trim();

  el.addEventListener("click", async (e) => {
    const btn = e.target.closest ? e.target.closest("button[data-action]") : null;
    if (!btn) return;

    const item = contextMenuItem;
    const action = btn.getAttribute("data-action");

    hideAppMenu();
    if (!item) return;

    if (action === "edit") {
      if (!manageMode) {
        alert("请先进入管理模式");
        return;
      }
      if (item.id === ADVANCED_ID) return;

      const current = getItemLabel(item);
      const nextLabel = prompt("应用名称（留空恢复默认）", current);
      if (nextLabel === null) return;
      setItemLabel(item.id, nextLabel);
      rerenderNav();
      return;
    }

    if (action === "lock") {
      if (!manageMode) {
        alert("请先进入管理模式");
        return;
      }
      if (item.id === ADVANCED_ID) return;

      setLocked(item.id, !isLocked(item.id));
      rerenderNav();
      return;
    }

    if (action === "fullscreen") {
      if (!manageMode && isLocked(item.id)) {
        showLockedMessage(item);
        return;
      }

      openApp(item);
      setTimeout(() => {
        const advanced = getAdvancedPanel();
        if (activeId === ADVANCED_ID && advanced && advanced.requestFullscreen) {
          advanced.requestFullscreen().catch(() => {});
          return;
        }
        const iframe = runningFrames.get(activeId);
        if (iframe && iframe.requestFullscreen) iframe.requestFullscreen().catch(() => {});
      }, 0);
      return;
    }

    if (action === "manage") {
      if (manageMode) {
        openAdvanced();
        return;
      }
      await enterManageMode();
      return;
    }
  });

  document.addEventListener("click", () => hideAppMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideAppMenu();
  });
  window.addEventListener("blur", () => hideAppMenu());
  window.addEventListener("resize", () => hideAppMenu());

  document.body.appendChild(el);
  contextMenuEl = el;
  return el;
}

function showAppMenuAt(clientX, clientY, item) {
  const el = ensureAppMenu();
  contextMenuItem = item;

  const editBtn = el.querySelector('button[data-action="edit"]');
  if (editBtn) editBtn.disabled = !manageMode || item.id === ADVANCED_ID;

  const lockBtn = el.querySelector('button[data-action="lock"]');
  if (lockBtn) {
    lockBtn.disabled = !manageMode || item.id === ADVANCED_ID;
    lockBtn.classList.toggle("checked", isLocked(item.id));
  }

  const manageBtn = el.querySelector('button[data-action="manage"]');
  if (manageBtn) manageBtn.classList.toggle("checked", !!manageMode);

  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";

  const pad = 8;
  const rect = el.getBoundingClientRect();
  const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
  const maxY = Math.max(pad, window.innerHeight - rect.height - pad);

  const x = Math.min(Math.max(pad, clientX), maxX);
  const y = Math.min(Math.max(pad, clientY), maxY);

  el.style.left = x + "px";
  el.style.top = y + "px";
}

function showAppMenu(e, item) {
  e.preventDefault();
  e.stopPropagation();
  showAppMenuAt(e.clientX, e.clientY, item);
}

// --------------------------------------------------------------------------- //
// Device simulator
// --------------------------------------------------------------------------- //

let currentDeviceMode = "desktop";

function setDeviceMode(mode) {
  currentDeviceMode = mode;
  safeStorageSet(localStorage, STORAGE_DEVICE, mode);
  const container = getFramesContainer();
  if (!container) return;

  container.classList.remove("device-mobile", "device-tablet");
  if (mode === "mobile") container.classList.add("device-mobile");
  else if (mode === "tablet") container.classList.add("device-tablet");

  const desktopBtn = document.getElementById("deviceDesktop");
  const mobileBtn = document.getElementById("deviceMobile");
  const tabletBtn = document.getElementById("deviceTablet");
  if (desktopBtn) desktopBtn.classList.toggle("active", mode === "desktop");
  if (mobileBtn) mobileBtn.classList.toggle("active", mode === "mobile");
  if (tabletBtn) tabletBtn.classList.toggle("active", mode === "tablet");
}

function initDeviceSimulator() {
  const desktopBtn = document.getElementById("deviceDesktop");
  const mobileBtn = document.getElementById("deviceMobile");
  const tabletBtn = document.getElementById("deviceTablet");

  if (desktopBtn) desktopBtn.addEventListener("click", () => setDeviceMode("desktop"));
  if (mobileBtn) mobileBtn.addEventListener("click", () => setDeviceMode("mobile"));
  if (tabletBtn) tabletBtn.addEventListener("click", () => setDeviceMode("tablet"));

  const savedDevice = safeStorageGet(localStorage, STORAGE_DEVICE);
  setDeviceMode(
    savedDevice === "mobile" || savedDevice === "tablet" ? savedDevice : "desktop"
  );
}

// --------------------------------------------------------------------------- //
// Frames / viewer
// --------------------------------------------------------------------------- //

function getFramesContainer() {
  return document.getElementById("viewerFrames");
}

function getAdvancedPanel() {
  return document.getElementById("advancedPanel");
}

function hideAllViewers() {
  for (const iframe of runningFrames.values()) iframe.style.display = "none";
  const advanced = getAdvancedPanel();
  if (advanced) advanced.classList.remove("visible");
  const toolbar = document.getElementById("deviceToolbar");
  if (toolbar) toolbar.style.display = "";
}

function setActiveRow(id) {
  const rows = document.querySelectorAll(".nav-row");
  for (const row of rows) {
    row.classList.toggle("active", row.getAttribute("data-id") === id);
  }
}

function setRowRunning(id, running) {
  const row = document.querySelector(`.nav-row[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.classList.toggle("running", !!running);
}

function ensureFrame(item) {
  if (runningFrames.has(item.id)) return runningFrames.get(item.id);

  const container = getFramesContainer();
  if (!container) return null;

  const iframe = document.createElement("iframe");
  iframe.className = "viewer-frame";
  iframe.title = item.label;
  iframe.referrerPolicy = "no-referrer";
  iframe.src = item.href;

  // postMessage bridge: listen for messages from this iframe
  iframe.addEventListener("load", () => {
    try {
      iframe.contentWindow.postMessage(
        { type: "sb_ready", id: item.id },
        new URL(item.href).origin
      );
    } catch {
      // Cross-origin iframe – can't communicate, which is fine
    }
  });

  container.appendChild(iframe);
  runningFrames.set(item.id, iframe);
  setRowRunning(item.id, true);
  return iframe;
}

function ensurePanel(id) {
  if (id !== ADVANCED_ID) return;
  runningPanels.add(id);
  setRowRunning(id, true);
}

function openAdvanced() {
  if (!manageMode) return;
  ensurePanel(ADVANCED_ID);
  activeId = ADVANCED_ID;
  safeStorageSet(localStorage, STORAGE_LAST, activeId);

  hideAllViewers();
  const panel = getAdvancedPanel();
  if (panel) panel.classList.add("visible");

  setEmptyVisible(false);
  setActiveRow(activeId);

  const toolbar = document.getElementById("deviceToolbar");
  if (toolbar) toolbar.style.display = "none";
}

function openApp(item, skipHashUpdate) {
  if (!item || !item.id) return;

  if (item.kind === "advanced") {
    if (!manageMode) return;
    return openAdvanced();
  }

  if (!manageMode && isLocked(item.id)) {
    showLockedMessage(item);
    setActiveRow(item.id);
    return;
  }

  ensureFrame(item);
  activeId = item.id;
  safeStorageSet(localStorage, STORAGE_LAST, activeId);

  if (!skipHashUpdate) {
    const newHash = "/#" + item.id;
    if (location.hash !== newHash) location.hash = newHash;
  }

  hideAllViewers();
  const iframe = runningFrames.get(activeId);
  if (iframe) iframe.style.display = "block";

  setEmptyVisible(false);
  setActiveRow(activeId);
}

function stopApp(id) {
  if (id === ADVANCED_ID) {
    runningPanels.delete(id);
    setRowRunning(id, false);

    const panel = getAdvancedPanel();
    if (panel) panel.classList.remove("visible");

    if (activeId === id) {
      activeId = "";
      setActiveRow("");
      setEmptyVisible(true);
    }
    return;
  }

  if (!manageMode && isLocked(id)) return;
  const iframe = runningFrames.get(id);
  if (!iframe) return;

  try {
    iframe.src = "about:blank";
  } catch {}

  iframe.remove();
  runningFrames.delete(id);
  setRowRunning(id, false);

  if (activeId === id) {
    const remaining = [...runningFrames.keys()];
    if (remaining.length > 0) {
      activeId = remaining[0];
      hideAllViewers();
      const nextIframe = runningFrames.get(activeId);
      if (nextIframe) nextIframe.style.display = "block";
      setActiveRow(activeId);
      setEmptyVisible(false);
      return;
    }

    if (runningPanels.has(ADVANCED_ID)) {
      openAdvanced();
      return;
    }

    activeId = "";
    setActiveRow("");
    setEmptyVisible(true);
  }
}

// --------------------------------------------------------------------------- //
// Export
// --------------------------------------------------------------------------- //

async function runExportOnce() {
  const status = document.getElementById("exportStatus");
  const pathEl = document.getElementById("exportPath");
  const btn = document.getElementById("exportBtn");

  if (status) status.textContent = "正在导出…";
  if (pathEl) pathEl.textContent = "";
  if (btn) btn.disabled = true;

  try {
    const personalize = loadJson(STORAGE_PERSONALIZE, {}) || {};
    const theme =
      safeStorageGet(localStorage, STORAGE_THEME) ||
      document.documentElement.getAttribute("data-theme") ||
      "dark";

    const data = await fetchJson("/api/export", {
      method: "POST",
      body: JSON.stringify({ personalize, theme }),
    });
    if (status) status.textContent = data.ok ? "导出完成" : "导出失败";
    if (pathEl) pathEl.textContent = data.out_dir || "";
  } catch {
    if (status) status.textContent = "导出不可用（纯前端模式无法导出）";
  } finally {
    if (btn) btn.disabled = false;
  }
}

function initExport() {
  const btn = document.getElementById("exportBtn");
  if (btn) btn.addEventListener("click", () => runExportOnce());

  const zipBtn = document.getElementById("exportZipBtn");
  if (zipBtn) {
    zipBtn.addEventListener("click", () => {
      const status = document.getElementById("exportStatus");
      if (status) status.textContent = "正在打包并下载…";
      if (zipBtn) zipBtn.disabled = true;

      const a = document.createElement("a");
      a.href = "/api/export/zip";
      a.download = "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => {
        if (status) status.textContent = "打包完成";
        if (zipBtn) zipBtn.disabled = false;
      }, 3000);
    });
  }
}

// --------------------------------------------------------------------------- //
// Manifest loading (simplified priority: embedded → API)
// --------------------------------------------------------------------------- //

function getEmbeddedManifest() {
  const el = document.getElementById("sb-manifest");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}");
  } catch {
    return null;
  }
}

async function loadManifestOrApi() {
  // Priority 1: embedded manifest (static export)
  const embedded = getEmbeddedManifest();
  if (embedded && Array.isArray(embedded.items)) {
    return { items: embedded.items, mode: "static" };
  }

  // Priority 2: API (backend mode)
  if (typeof location !== "undefined" && location.protocol === "file:") {
    return { items: [], mode: "static" };
  }

  try {
    const api = await fetchJson("/api/nav", { timeoutMs: 8000 });
    return { items: api.items || [], mode: "backend" };
  } catch {
    return { items: [], mode: "static" };
  }
}

// --------------------------------------------------------------------------- //
// Navigation rendering
// --------------------------------------------------------------------------- //

function renderNav(items, mode) {
  lastNavItems = items || [];
  lastNavMode = mode || "backend";
  const empty = document.getElementById("navEmpty");
  const container = document.getElementById("navItems");
  if (!empty || !container) return;

  const exportCard = document.getElementById("exportCard");
  if (exportCard) exportCard.style.display = mode === "backend" ? "block" : "none";

  container.innerHTML = "";
  const allItems = [...(items || [])];

  if (manageMode) {
    allItems.push({ id: ADVANCED_ID, label: "高级模块", kind: "advanced" });
  }

  const navAdvanced = document.getElementById("navAdvanced");
  if (navAdvanced) {
    if (manageMode) {
      navAdvanced.style.display = "";
      const openBtn = navAdvanced.querySelector(".nav-open");
      if (openBtn) openBtn.textContent = "高级模块";
      navAdvanced.onclick = () => openAdvanced();
    } else {
      navAdvanced.style.display = "none";
    }
  }

  empty.style.display = allItems.length ? "none" : "block";
  if (!allItems.length) {
    const msg =
      mode === "backend"
        ? "目录为空。"
        : "无法加载目录：请启动后端（uvicorn app:app）或使用导出版本（result/export-*）。";
    empty.setAttribute("data-original", msg);
    empty.textContent = msg;
    setEmptyVisible(true);
    return;
  }

  for (const item of allItems) {
    if (item.id === ADVANCED_ID) continue;
    const row = document.createElement("div");
    row.className = "nav-row";
    row.setAttribute("data-id", item.id);

    if (isLocked(item.id)) row.classList.add("locked");

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "nav-open";
    const icon = item.icon ? item.icon + " " : "";
    openBtn.textContent = icon + getItemLabel(item);
    if (item.tags && item.tags.length) openBtn.title = item.tags.join(", ");
    openBtn.addEventListener("click", () => openApp(item));
    openBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "nav-more";
    moreBtn.setAttribute("aria-label", `更多：${getItemLabel(item)}`);
    moreBtn.title = "更多";
    moreBtn.textContent = "···";
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = moreBtn.getBoundingClientRect();
      showAppMenuAt(r.right, r.bottom, item);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "nav-close";
    closeBtn.setAttribute("aria-label", `停止 ${item.label}`);
    closeBtn.title = "停止运行";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isLocked(item.id)) return;
      stopApp(item.id);
    });

    row.appendChild(openBtn);
    row.appendChild(moreBtn);
    row.appendChild(closeBtn);
    container.appendChild(row);

    if (runningFrames.has(item.id) || runningPanels.has(item.id)) {
      row.classList.add("running");
    }
  }

  const last = safeStorageGet(localStorage, STORAGE_LAST);
  const preferred = allItems.find((x) => x.id === last) || allItems[0];
  openApp(preferred);
}

// --------------------------------------------------------------------------- //
// Hash router
// --------------------------------------------------------------------------- //

function restoreFromHash() {
  const hash = location.hash;
  if (!hash || !hash.startsWith("#/")) return;
  const id = hash.slice(2);
  const item = lastNavItems.find((x) => x.id === id);
  if (item) {
    openApp(item, true);
  }
}

function initHashRouter() {
  window.addEventListener("hashchange", () => {
    const hash = location.hash;
    if (!hash || !hash.startsWith("#/")) return;
    const id = hash.slice(2);
    const item = lastNavItems.find((x) => x.id === id);
    if (item && item.id !== activeId) {
      openApp(item, true);
    }
  });
}

// --------------------------------------------------------------------------- //
// Search
// --------------------------------------------------------------------------- //

function normalizeForSearch(s) {
  return String(s || "").trim().toLowerCase();
}

function itemMatchesSearch(item, query) {
  if (!query) return true;
  const q = normalizeForSearch(query);
  if (!q) return true;
  const label = normalizeForSearch(getItemLabel(item));
  const id = normalizeForSearch(item.id);
  const icon = normalizeForSearch(item.icon || "");
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => normalizeForSearch(t)).join(" ") : "";
  const all = [label, id, icon, tags].join(" ");
  return all.includes(q);
}

function applySearchFilter(query) {
  const container = document.getElementById("navItems");
  if (!container) return;
  const rows = container.querySelectorAll(".nav-row");
  let visibleCount = 0;
  for (const row of rows) {
    const id = row.getAttribute("data-id");
    const item = lastNavItems.find((x) => x.id === id);
    const match = item ? itemMatchesSearch(item, query) : true;
    row.style.display = match ? "" : "none";
    if (match) visibleCount++;
  }
  const empty = document.getElementById("navEmpty");
  if (empty) {
    if (!query) {
      empty.textContent = empty.getAttribute("data-original") || empty.textContent;
    }
    empty.style.display = visibleCount || !query ? "none" : "block";
    if (!visibleCount && query) {
      empty.textContent = `没有匹配"${query}"的项目`;
    }
  }
}

function initSearch() {
  const input = document.getElementById("searchInput");
  if (!input) return;
  input.addEventListener("input", () => {
    applySearchFilter(input.value);
  });
}

// --------------------------------------------------------------------------- //
// Server config sync
// --------------------------------------------------------------------------- //

async function loadServerConfig() {
  try {
    const data = await fetchJson("/api/config");
    if (data && data.personalize && typeof data.personalize === "object") {
      // Prefer backend for cross-device sync; in manage mode we keep last-write-wins
      const localTs = loadPersonalizeTs();
      const serverTs = normalizeUnixSeconds(data.updated_at || 0);
      if (serverTs) serverConfigTs = serverTs;
      const useServer = manageMode ? (!localTs || serverTs > localTs) : (serverTs > 0);
      if (useServer) {
        saveJson(STORAGE_PERSONALIZE, data.personalize);
        saveJson(STORAGE_PERSONALIZE_TS, serverTs);
      }
    }
    if (data && (data.theme === "light" || data.theme === "dark")) {
      applyTheme(data.theme);
    }
  } catch {
    // No server config available
  }
}

// --------------------------------------------------------------------------- //
// postMessage listener (iframe → parent)
// --------------------------------------------------------------------------- //

window.addEventListener("message", (event) => {
  // Validate origin – only accept messages from our own iframes
  // In static export mode we can't validate, so be permissive
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "sb_ping") {
    // iframe is asking if parent is here
    const iframe = [...runningFrames.entries()].find(([, f]) => f.contentWindow === event.source);
    if (iframe) {
      try {
        event.source.postMessage({ type: "sb_pong", id: iframe[0] }, "*");
      } catch {
        // Cross-origin, ignore
      }
    }
  }
});

// --------------------------------------------------------------------------- //
// Main init
// --------------------------------------------------------------------------- //

async function main() {
  initTheme();
  await loadServerConfig();
  initPersonalize();
  setManageMode(manageMode);
  initExport();
  initAdminPasswordCard();
  initHashRouter();
  initSearch();
  initDeviceSimulator();

  // Advanced panel header click to close
  const panelHead = document.getElementById("advancedPanelHead");
  if (panelHead) {
    panelHead.addEventListener("click", () => {
      if (activeId === ADVANCED_ID) {
        const panel = getAdvancedPanel();
        if (panel) panel.classList.remove("visible");
        activeId = "";
        setEmptyVisible(true);
        setActiveRow("");
        const toolbar = document.getElementById("deviceToolbar");
        if (toolbar) toolbar.style.display = "";
      }
    });
  }

  // Exit manage mode button
  const exitBtn = document.getElementById("exitManageBtn");
  if (exitBtn) {
    exitBtn.addEventListener("click", async () => {
      await revokeCurrentToken();
      adminToken = null;
      setManageMode(false);
      hideAppMenu();
      if (activeId === ADVANCED_ID) stopApp(ADVANCED_ID);
      rerenderNav();
    });
  }

  try {
    const { items, mode } = await loadManifestOrApi();
    renderNav(items, mode);
    restoreFromHash();
  } catch {
    renderNav([], "static");
  }
}

main().catch(showInitError);
