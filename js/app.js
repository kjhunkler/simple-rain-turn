/* SimpleRain app shell: auto host/join, profile editing, host-owned game state. */

const APP_VERSION = "1.5.7";
const AUTO_CHANNEL = "simple-rain";
const GAME_SAVE_KEY = "simplerain-host-cache";
const MUSIC_MUTED_KEY = "simplerain-music-muted";
const MUSIC_TRACKS_KEY = "simplerain-music-tracks";
const TUTORIAL_SEEN_KEY = "simplerain-tutorial-seen";
const LOBBY_PARAM = "lobby";
const LOBBY_SCAN_TIMEOUT_MS = 2600;
const LOBBY_REFRESH_COOLDOWN_MS = 4000;
const PRESENCE_CHANNEL = `${AUTO_CHANNEL}-presence`;
const PRESENCE_HEARTBEAT_MS = 10000;
const PRESENCE_STALE_MS = 35000;
const PLAYER_HEARTBEAT_MS = 5000;
const HOST_THROTTLE_CHECK_MS = 5000;
const HOST_THROTTLE_DRIFT_MS = 12000;
const HOST_WATCHDOG_MS = 15000;
const CLIENT_WELCOME_TIMEOUT_MS = 10000;
const COLORS = ["#ff5d5d", "#ff9d4d", "#ffd24d", "#7CFC9B", "#33ddaa", "#4dd2ff", "#4d8bff", "#7766ff", "#c98cff", "#ff6fd0", "#22cc88", "#ff6600", "#aef359", "#ff8fb3", "#f5f3e7", "#c98d5f"];
const ICONS = ["🐸", "🐢", "🐟", "🦆", "🦋", "🐞", "🐝", "🦗", "🦎", "🐌", "🦀", "🦊", "🐰", "🦝", "🦉", "🐿️", "🦢", "🐠"];
const POND_ICON_SUGGESTIONS = ["🐸", "🐢", "🐟", "🦆", "🦋", "🐞", "🐝", "🦗", "🦎", "🐌", "🦀", "🐿️", "🦢", "🐠"];
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const HOST_REQUEST_COOLDOWN_MS = 60000;
const CHAT_HISTORY_LIMIT = 60;
const CHAT_MESSAGE_MAX_CHARS = 280;
const CHAT_TOAST_MS = 5200;
const CHAT_SEND_COOLDOWN_MS = 600;
const FLOWER_LOBBIES = [
  { key: "lotus", name: "Lotus", art: "lotus", color: "#f4a6cf" },
  { key: "iris", name: "Iris", art: "iris", color: "#a993ff" },
  { key: "lily", name: "Lily", art: "lily", color: "#f7f0bd" },
  { key: "orchid", name: "Orchid", art: "orchid", color: "#94d78d" },
];
const CHESS_LOBBIES = [
  { key: "pawn", name: "Pawn Pond", glyph: "♟", color: "#8ce8bc" },
  { key: "knight", name: "Knight Reeds", glyph: "♞", color: "#8ed8ff" },
  { key: "rook", name: "Rook Rock", glyph: "♜", color: "#ffb08a" },
  { key: "queen", name: "Queen Lily", glyph: "♛", color: "#d9a6ff" },
];
const GAME_MODE_KEY = "simplerain-game-mode";
const GAME_MODES = {
  flower: {
    key: "flower",
    name: "SimpleRain",
    titleHtml: "Simple<span>Rain</span>",
    tagline: "Rain on the water. A tile, a blossom, a quiet afternoon.",
    lobbySectionTitle: "Flower Lobbies",
    lobbies: FLOWER_LOBBIES,
    presetPrefix: `${AUTO_CHANNEL}-`,
    codePrefix: "",
    saveKey: GAME_SAVE_KEY,
    module: () => window.SimpleRainGame,
  },
  chess: {
    key: "chess",
    name: "SimpleChess",
    titleHtml: "Simple<span>Chess</span>",
    tagline: "Two courts across a quiet pond. Your move.",
    lobbySectionTitle: "Chess Lobbies",
    lobbies: CHESS_LOBBIES,
    presetPrefix: "simple-chess-",
    codePrefix: "chess-",
    saveKey: "simplechess-host-cache",
    module: () => window.SimpleChessGame,
  },
};

const $ = (sel) => document.querySelector(sel);
const screens = { loading: $("#screen-loading"), play: $("#screen-play") };
const canvas = $("#stage");
const ctx = canvas.getContext("2d");

let net = new PeerNet();
let presenceNet = new PeerNet();
let activeGame = null;
let hostLoopTimer = null;
let hostWatchdogTimer = null;
let hostThrottleTimer = null;
let presenceTimer = null;
let presenceSweepTimer = null;
let hostThrottleExpectedAt = 0;
let handoffTimer = null;
let clientWelcomeTimer = null;
let lastPlayersBroadcastAt = 0;
let lastHostMessageAt = 0;
let lastState = [];
let lastHostOrder = [];
let pendingGameState = null;
let migratingFromHostId = null;
let preferredNextHostId = null;
let handoffInProgress = false;
let statusText = "Starting SimpleRain...";
let myColor = "";
let nameTimer = null;
let selectedMusicTrackIds = loadSelectedMusicTracks();
let sessionChannel = initialLobbyChannel();
let showInviteAfterReady = false;
let inLobby = false;
let soloMode = false;
let hostReachability = "solo";
let lobbyScanToken = 0;
let lastLobbyRefreshAttemptAt = 0;
let pendingInvites = [];
let lastHostRequestAt = 0;
let chatHistory = [];
let chatUnread = 0;
let lastChatSentAt = 0;
let chatSeq = 0;

const players = new Map();
const peerMap = new Map();
const profiles = new Map();
const presenceRoster = new Map();
const presencePeerMap = new Map();
let usedColors = new Set();

function normalizeLobbyChannel(value) {
  try {
    const url = new URL(String(value || ""));
    value = url.searchParams.get(LOBBY_PARAM) || value;
  } catch {}
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return text || AUTO_CHANNEL;
}

function initialLobbyChannel() {
  try {
    const params = new URLSearchParams(location.search);
    const lobby = params.get(LOBBY_PARAM);
    return lobby ? normalizeLobbyChannel(lobby) : "";
  } catch {
    return "";
  }
}

function modeForChannel(channel) {
  const normalized = normalizeLobbyChannel(channel);
  const chess = GAME_MODES.chess;
  return normalized.startsWith(chess.codePrefix) || normalized.startsWith(chess.presetPrefix) || normalized === "simple-chess" ? "chess" : "flower";
}

function initialGameMode() {
  if (sessionChannel) return modeForChannel(sessionChannel);
  const stored = localStorage.getItem(GAME_MODE_KEY);
  return GAME_MODES[stored] ? stored : "flower";
}

let activeModeKey = initialGameMode();

function currentMode() {
  return GAME_MODES[activeModeKey] || GAME_MODES.flower;
}

function gameModule() {
  return currentMode().module() || window.SimpleRainGame;
}

function presetLobbyChannel(mode, lobby) {
  return `${mode.presetPrefix}${lobby.key}`;
}

function codeLobbyChannel(code) {
  return normalizeLobbyChannel(`${currentMode().codePrefix}${code}`);
}

function displayCodeForChannel(channel) {
  let code = normalizeLobbyChannel(channel);
  const chess = GAME_MODES.chess;
  if (code.startsWith(chess.codePrefix)) code = code.slice(chess.codePrefix.length);
  return code.includes("-") ? "" : code;
}

function setGameMode(key, { refreshLobbies = true } = {}) {
  if (!GAME_MODES[key]) key = "flower";
  const changed = activeModeKey !== key;
  activeModeKey = key;
  localStorage.setItem(GAME_MODE_KEY, key);
  renderModeToggle();
  renderHomeModeText();
  updateContinueButton();
  if (!changed) return;
  renderModeLobbies();
  if (refreshLobbies && !inLobby && !soloMode) refreshModeLobbies();
}

function renderModeToggle() {
  for (const button of document.querySelectorAll("#mode-toggle .mode-toggle-btn")) {
    const active = button.dataset.mode === activeModeKey;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderHomeModeText() {
  const mode = currentMode();
  const title = $("#home-title");
  if (title) title.innerHTML = mode.titleHtml;
  const tagline = $("#home-tagline");
  if (tagline) tagline.textContent = mode.tagline;
  const heading = $("#flower-lobbies-title");
  if (heading) heading.textContent = mode.lobbySectionTitle;
}

function wireModeToggle() {
  for (const button of document.querySelectorAll("#mode-toggle .mode-toggle-btn")) {
    button.onclick = () => setGameMode(button.dataset.mode);
  }
}

function applyProfileColor(color) {
  profile.color = color || COLORS[0];
  if (!inLobby) myColor = profile.color;
  localStorage.setItem("simplerain-color", profile.color);
  profiles.set(MY_ID, { ...profiles.get(MY_ID), color: profile.color });
  const input = $("#input-color");
  if (input) input.value = profile.color;
  updateProfilePreview();
  broadcastProfile();
}

function applyProfileIcon(icon) {
  profile.icon = icon || randomIcon();
  localStorage.setItem("simplerain-icon", profile.icon);
  profiles.set(MY_ID, { ...profiles.get(MY_ID), icon: profile.icon });
  const input = $("#input-icon");
  if (input) input.value = profile.icon;
  updateProfilePreview();
  broadcastProfile();
}

function renderShortcutRows(colorSel, iconSel, rerender) {
  const colors = $(colorSel);
  if (colors) {
    colors.innerHTML = "";
    for (const color of COLORS) {
      const button = document.createElement("button");
      button.className = "color-shortcut";
      button.classList.toggle("selected", (profile.color || myColor) === color);
      button.type = "button";
      button.style.background = color;
      button.setAttribute("aria-label", `Use color ${color}`);
      button.onclick = () => { applyProfileColor(color); rerender(); };
      colors.appendChild(button);
    }
  }
  const icons = $(iconSel);
  if (icons) {
    icons.innerHTML = "";
    for (const icon of POND_ICON_SUGGESTIONS) {
      const button = document.createElement("button");
      button.className = "icon-shortcut";
      button.classList.toggle("selected", profile.icon === icon);
      button.type = "button";
      button.textContent = icon;
      button.onclick = () => { applyProfileIcon(icon); rerender(); };
      icons.appendChild(button);
    }
  }
}

function renderProfileShortcuts() {
  renderShortcutRows("#profile-color-shortcuts", "#profile-icon-shortcuts", renderProfileShortcuts);
}

function renderWelcomeShortcuts() {
  renderShortcutRows("#welcome-color-shortcuts", "#welcome-icon-shortcuts", renderWelcomeShortcuts);
}

function requestHostRole() {
  if (!inLobby || soloMode || net.isHost) return;
  const now = Date.now();
  const remaining = HOST_REQUEST_COOLDOWN_MS - (now - lastHostRequestAt);
  if (remaining > 0) {
    setStatus(`Wait ${Math.ceil(remaining / 1000)}s before requesting host again.`);
    return;
  }
  lastHostRequestAt = now;
  net.send({ t: "host-request", id: MY_ID, name: profile.name });
  setStatus("Host request sent.");
}

function relinquishHostRole() {
  if (!inLobby || soloMode || !net.isHost) return;
  beginHostHandoff("Relinquishing host...");
}

function randomLobbyCode() {
  let code = "";
  const values = new Uint32Array(4);
  if (crypto?.getRandomValues) crypto.getRandomValues(values);
  for (let i = 0; i < 4; i++) {
    const value = values[i] || Math.floor(Math.random() * INVITE_CODE_ALPHABET.length);
    code += INVITE_CODE_ALPHABET[value % INVITE_CODE_ALPHABET.length];
  }
  return code;
}

function inviteUrl() {
  const url = new URL(location.href);
  if (!sessionChannel || soloMode) url.searchParams.delete(LOBBY_PARAM);
  else url.searchParams.set(LOBBY_PARAM, sessionChannel);
  url.hash = "";
  return url.toString();
}

function updateLobbyUrl() {
  const url = new URL(location.href);
  if (!sessionChannel || soloMode) url.searchParams.delete(LOBBY_PARAM);
  else url.searchParams.set(LOBBY_PARAM, sessionChannel);
  history.replaceState(null, "", url.toString());
}

function clientId() {
  let id = localStorage.getItem("simplerain-client-id");
  if (!id) {
    id = "p-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("simplerain-client-id", id);
  }
  return id;
}

function broadcastPlayers(force = false) {
  if (!net.isHost) return;
  const now = Date.now();
  if (!force && now - lastPlayersBroadcastAt < PLAYER_HEARTBEAT_MS) return;
  const state = [...players.values()];
  const hostOrder = [...players.keys()];
  lastState = state;
  lastHostOrder = hostOrder;
  lastPlayersBroadcastAt = now;
  net.broadcast({ t: "players", players: state, hostOrder });
  renderPlayers();
  broadcastPresence(false);
}

function randomIcon() {
  return ICONS[Math.floor(Math.random() * ICONS.length)];
}

function storedOrRandomIcon() {
  let icon = localStorage.getItem("simplerain-icon");
  if (!icon) {
    icon = randomIcon();
    localStorage.setItem("simplerain-icon", icon);
  }
  return icon;
}

const MY_ID = clientId();
const DEFAULT_NAME = "Player " + MY_ID.slice(2, 5).toUpperCase();
const IS_NEW_USER = !localStorage.getItem("simplerain-name");
const profile = {
  name: localStorage.getItem("simplerain-name") || DEFAULT_NAME,
  icon: storedOrRandomIcon(),
  color: localStorage.getItem("simplerain-color") || "",
};
myColor = profile.color || COLORS[0];
profiles.set(MY_ID, { name: profile.name, icon: profile.icon, color: myColor });

function currentPresenceStatus() {
  if (soloMode) return "solo";
  if (inLobby && net.isHost) return "hosting";
  if (inLobby) return "joined";
  return "home";
}

function lobbyDisplayName(channel = sessionChannel) {
  if (!channel) return "";
  const modeKey = modeForChannel(channel);
  const mode = GAME_MODES[modeKey];
  const preset = mode.lobbies.find((lobby) => presetLobbyChannel(mode, lobby) === channel);
  const base = preset?.name || (displayCodeForChannel(channel) || channel).toUpperCase();
  return modeKey === "chess" ? `${base} · Chess` : base;
}

function presencePayload() {
  return {
    t: "presence-update",
    id: MY_ID,
    name: profile.name,
    icon: profile.icon,
    color: profile.color || myColor || COLORS[0],
    status: currentPresenceStatus(),
    lobby: inLobby && sessionChannel ? sessionChannel : "",
    lobbyName: inLobby && sessionChannel ? lobbyDisplayName(sessionChannel) : "",
    updatedAt: Date.now(),
  };
}

function upsertPresence(entry) {
  if (!entry?.id) return;
  presenceRoster.set(entry.id, { ...presenceRoster.get(entry.id), ...entry, updatedAt: Date.now() });
  renderPresence();
}

function broadcastPresence(force = false) {
  const payload = presencePayload();
  upsertPresence(payload);
  if (!presenceNet.peer || presenceNet._closed) return;
  if (presenceNet.isHost) {
    presenceNet.broadcast(payload);
    if (force) broadcastPresenceRoster();
  }
  else presenceNet.send(payload);
}

function presenceStatusText(entry) {
  if (entry.status === "hosting") return `Hosting ${entry.lobbyName || "a lobby"}`;
  if (entry.status === "joined") return `In ${entry.lobbyName || "a lobby"}`;
  if (entry.status === "solo") return "Playing solo";
  return "On the home screen";
}

function renderOnlinePlayerList(list, entries) {
  if (!list) return;
  list.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "lobby-left-message";
    empty.textContent = "No other players are online.";
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "online-player-row";
    const canJoin = !!entry.lobby;
    row.innerHTML = `
      <span class="online-player-avatar" style="background:${esc(entry.color || COLORS[0])}">${esc(displayIcon(entry.icon))}</span>
      <span class="online-player-main">
        <span class="online-player-name">${esc(entry.name)}</span>
        <span class="online-player-status">${esc(presenceStatusText(entry))}</span>
      </span>
      <span class="online-player-actions">
        <button class="online-join-btn" type="button" ${canJoin ? "" : "disabled"}>Join</button>
        <button class="online-invite-btn" type="button">Invite</button>
      </span>
    `;
    row.querySelector(".online-join-btn").onclick = () => joinPresencePlayer(entry.id);
    row.querySelector(".online-invite-btn").onclick = () => invitePresencePlayer(entry.id);
    list.appendChild(row);
  }
}

function renderWelcomeOnlinePlayers(entries) {
  const list = $("#welcome-online-players");
  if (!list) return;
  list.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "lobby-left-message";
    empty.textContent = "No other players are online right now.";
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "online-player-row";
    row.innerHTML = `
      <span class="online-player-avatar" style="background:${esc(entry.color || COLORS[0])}">${esc(displayIcon(entry.icon))}</span>
      <span class="online-player-main">
        <span class="online-player-name">${esc(entry.name)}</span>
        <span class="online-player-status">${esc(presenceStatusText(entry))}</span>
      </span>
    `;
    list.appendChild(row);
  }
}

function renderPresence() {
  const entries = [...presenceRoster.values()]
    .filter((entry) => entry.id !== MY_ID)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  renderOnlinePlayerList($("#home-active-players"), entries);
  renderOnlinePlayerList($("#sheet-online-players"), entries);
  renderWelcomeOnlinePlayers(entries);
}

function presenceRosterMessage() {
  return { t: "presence-roster", entries: [...presenceRoster.values()] };
}

function broadcastPresenceRoster() {
  if (!presenceNet.isHost) return;
  presenceNet.broadcast(presenceRosterMessage());
}

/* ===== Lobby text chat =====
 * Every lobby member mirrors the full history (host-stamped, trimmed to
 * CHAT_HISTORY_LIMIT). The host relays messages and seeds new joiners, and
 * because everyone holds the mirror the log survives host migration.
 */
function chatMessageId() {
  return `${MY_ID}-${Date.now().toString(36)}-${(chatSeq++).toString(36)}`;
}

function trimChatHistory() {
  if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory = chatHistory.slice(-CHAT_HISTORY_LIMIT);
}

function chatDrawerOpen() {
  return !!$("#chat-drawer")?.classList.contains("open");
}

function updateChatUnreadBadge() {
  const badge = $("#chat-unread");
  if (!badge) return;
  badge.classList.toggle("hidden", chatUnread <= 0);
  badge.textContent = chatUnread > 9 ? "9+" : String(chatUnread);
}

function chatSenderProfile(message) {
  return profiles.get(message.fromId) || { name: message.fromName || "Player", color: COLORS[0], icon: "" };
}

function chatAvatarHtml(message) {
  const sender = chatSenderProfile(message);
  return `<span class="swatch" style="background:${esc(sender.color || COLORS[0])}">${esc(displayIcon(sender.icon))}</span>`;
}

function renderChatLog() {
  const log = $("#chat-log");
  if (!log) return;
  log.innerHTML = "";
  if (!chatHistory.length) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "No messages yet. The pond is quiet.";
    log.appendChild(empty);
    return;
  }
  for (const message of chatHistory) {
    const line = document.createElement("div");
    line.className = "chat-line";
    const time = new Date(message.at || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    line.innerHTML = `
      ${chatAvatarHtml(message)}
      <span><span class="chat-line-name">${esc(message.fromName || "Player")}</span>${esc(message.text)}<span class="chat-line-time">${esc(time)}</span></span>
    `;
    log.appendChild(line);
  }
  log.scrollTop = log.scrollHeight;
}

function showChatToast(message) {
  const stack = $("#chat-toasts");
  if (!stack || chatDrawerOpen()) return;
  const toast = document.createElement("div");
  toast.className = "chat-toast";
  toast.innerHTML = `
    ${chatAvatarHtml(message)}
    <span><span class="chat-toast-name">${esc(message.fromName || "Player")}</span>${esc(message.text)}</span>
  `;
  stack.appendChild(toast);
  while (stack.children.length > 4) stack.firstChild.remove();
  setTimeout(() => {
    toast.classList.add("fading");
    setTimeout(() => toast.remove(), 550);
  }, CHAT_TOAST_MS);
}

function acceptChatMessage(message, { toast = true } = {}) {
  if (!message?.id || typeof message.text !== "string") return;
  if (chatHistory.some((existing) => existing.id === message.id)) return;
  message.text = message.text.slice(0, CHAT_MESSAGE_MAX_CHARS);
  chatHistory.push(message);
  chatHistory.sort((a, b) => (a.at || 0) - (b.at || 0));
  trimChatHistory();
  if (toast && message.fromId !== MY_ID) showChatToast(message);
  if (!chatDrawerOpen() && message.fromId !== MY_ID) {
    chatUnread++;
    updateChatUnreadBadge();
  }
  if (chatDrawerOpen()) renderChatLog();
}

function hostStampAndRelayChat(message) {
  message.at = Date.now();
  acceptChatMessage(message);
  net.broadcast({ t: "chat", message });
}

function sendChatMessage(text) {
  const trimmed = String(text || "").trim().slice(0, CHAT_MESSAGE_MAX_CHARS);
  if (!trimmed || soloMode || !inLobby) return;
  const now = Date.now();
  if (now - lastChatSentAt < CHAT_SEND_COOLDOWN_MS) return;
  lastChatSentAt = now;
  const message = { id: chatMessageId(), fromId: MY_ID, fromName: profile.name, text: trimmed, at: now };
  if (net.isHost) {
    hostStampAndRelayChat(message);
  } else {
    acceptChatMessage(message);
    net.send({ t: "chat", message });
  }
}

function openChatDrawer() {
  $("#chat-drawer")?.classList.add("open");
  chatUnread = 0;
  updateChatUnreadBadge();
  renderChatLog();
  setTimeout(() => $("#input-chat")?.focus?.(), 200);
}

function closeChatDrawer() {
  $("#chat-drawer")?.classList.remove("open");
}

function toggleChatDrawer() {
  if (chatDrawerOpen()) closeChatDrawer();
  else openChatDrawer();
}

function resetChatState() {
  chatHistory = [];
  chatUnread = 0;
  updateChatUnreadBadge();
  closeChatDrawer();
  const stack = $("#chat-toasts");
  if (stack) stack.innerHTML = "";
}

function updateChatControls() {
  const showComms = inLobby && !soloMode;
  $("#btn-chat")?.classList.toggle("hidden", !showComms);
  $("#btn-voice")?.classList.toggle("hidden", !showComms);
}

function wireChatControls() {
  const chatButton = $("#btn-chat");
  if (chatButton) chatButton.onclick = toggleChatDrawer;
  const voiceButton = $("#btn-voice");
  if (voiceButton) voiceButton.onclick = toggleVoice;
  const close = $("#btn-close-chat");
  if (close) close.onclick = closeChatDrawer;
  const form = $("#chat-form");
  if (form) {
    form.onsubmit = (event) => {
      event.preventDefault();
      const input = $("#input-chat");
      sendChatMessage(input?.value);
      if (input) input.value = "";
    };
  }
}

/* ===== Voice chat =====
 * Opt-in mesh over PeerJS media calls. Participants announce themselves to the
 * host, which broadcasts the voice roster. Later joiners call earlier members
 * (joinedAt ordering) so exactly one call exists per pair. Remote streams play
 * through plain <audio> elements so background tabs keep playing; on refocus
 * the srcObject is re-attached to drop any buffered backlog instead of
 * replaying it.
 */
const voice = {
  on: false,
  pending: false,
  stream: null,
  muted: true,
  channelActive: false,
  silentAudioCtx: null,
  silentSource: null,
  joinedAt: 0,
  roster: new Map(), // appId -> { id, peerId, joinedAt }
  states: new Map(), // appId -> { muted }
  calls: new Map(), // appId -> MediaConnection
  audios: new Map(), // appId -> HTMLAudioElement
  analysers: new Map(), // appId -> { ctx, analyser, data, source }
  speaking: new Set(), // appIds currently speaking
  levelTimer: null,
  keepAliveTimer: null,
};

voice.states.set(MY_ID, { muted: voice.muted });

function anyVoiceUnmuted() {
  return [...voice.states.values()].some((entry) => entry && !entry.muted);
}

function voiceEntry() {
  return { id: MY_ID, peerId: net.peer?.id || "", joinedAt: voice.joinedAt };
}

function voiceStateMessage() {
  return { t: "voice-state", muted: voice.muted, entry: voice.on ? voiceEntry() : null };
}

function createSilentVoiceStream() {
  stopSilentVoiceStream();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("AudioContext unavailable");
  const ctx = new AudioCtx();
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  const source = ctx.createOscillator();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(dest);
  source.start();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  voice.silentAudioCtx = ctx;
  voice.silentSource = source;
  return dest.stream;
}

function stopSilentVoiceStream() {
  if (voice.silentSource) {
    try { voice.silentSource.stop(); } catch {}
    try { voice.silentSource.disconnect(); } catch {}
    voice.silentSource = null;
  }
  if (voice.silentAudioCtx) {
    voice.silentAudioCtx.close().catch(() => {});
    voice.silentAudioCtx = null;
  }
}

function stopVoiceStream() {
  if (voice.stream) {
    for (const track of voice.stream.getTracks()) { try { track.stop(); } catch {} }
    voice.stream = null;
  }
  stopSilentVoiceStream();
}

async function openVoiceStream() {
  stopVoiceStream();
  if (voice.muted) return createSilentVoiceStream();
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    voice.muted = true;
    voice.states.set(MY_ID, { muted: true });
    return createSilentVoiceStream();
  }
}

function voiceRosterMessage() {
  return { t: "voice-roster", entries: [...voice.roster.values()] };
}

function broadcastVoiceRoster() {
  if (!net.isHost) return;
  net.broadcast(voiceRosterMessage());
  syncVoiceMesh();
}

function applyVoiceControl(active) {
  voice.channelActive = !!active;
  if (voice.channelActive) {
    joinVoice();
  } else {
    voice.roster.clear();
    leaveVoice(true);
    renderSpeakingIndicators();
  }
  updateVoiceButton();
}

function syncHostVoiceControl() {
  if (!net.isHost) return;
  const active = anyVoiceUnmuted();
  voice.channelActive = active;
  net.broadcast({ t: "voice-control", active });
  if (active) {
    joinVoice();
  } else {
    voice.roster.clear();
    net.broadcast(voiceRosterMessage());
    leaveVoice(true);
  }
}

function announceVoiceState() {
  voice.states.set(MY_ID, { muted: voice.muted });
  if (net.isHost) {
    if (voice.on) voice.roster.set(MY_ID, voiceEntry());
    else voice.roster.delete(MY_ID);
    syncHostVoiceControl();
    broadcastVoiceRoster();
  } else {
    net.send(voiceStateMessage());
  }
}

async function joinVoice() {
  if (voice.on || voice.pending || soloMode || !inLobby) return;
  voice.pending = true;
  updateVoiceButton();
  try {
    voice.stream = await openVoiceStream();
  } catch {
    voice.pending = false;
    updateVoiceButton();
    setStatus("Voice chat unavailable. Check browser permissions.");
    return;
  }
  voice.pending = false;
  voice.on = true;
  voice.joinedAt = Date.now();
  if (!voice.muted) attachSpeakingAnalyser(MY_ID, voice.stream);
  announceVoiceState();
  startVoiceLevelLoop();
  startVoiceKeepAlive();
  updateVoiceButton();
  setStatus(voice.muted ? "Voice chat on. You are muted." : "Voice chat on.");
}

function leaveVoice(silent = false) {
  const wasOn = voice.on || voice.pending;
  voice.on = false;
  voice.pending = false;
  stopVoiceStream();
  for (const call of voice.calls.values()) { try { call.close(); } catch {} }
  voice.calls.clear();
  for (const audio of voice.audios.values()) detachVoiceAudio(audio);
  voice.audios.clear();
  for (const id of [...voice.analysers.keys()]) detachSpeakingAnalyser(id);
  voice.speaking.clear();
  stopVoiceLevelLoop();
  stopVoiceKeepAlive();
  if (voiceAnalysisCtx) {
    voiceAnalysisCtx.close().catch(() => {});
    voiceAnalysisCtx = null;
  }
  renderSpeakingIndicators();
  if (wasOn && inLobby && !silent) announceVoiceState();
  updateVoiceButton();
}

async function restartVoiceChannel() {
  if (!voice.on && !voice.channelActive) return;
  const shouldRejoin = voice.channelActive;
  leaveVoice(true);
  if (shouldRejoin) await joinVoice();
}

async function setVoiceMuted(muted) {
  if (soloMode || !inLobby || voice.pending) return;
  if (voice.muted === muted) return;
  voice.muted = muted;
  voice.states.set(MY_ID, { muted });
  updateVoiceButton();
  if (voice.on) await restartVoiceChannel();
  announceVoiceState();
  setStatus(voice.muted ? "Microphone muted." : "Microphone on.");
}

function toggleVoice() {
  setVoiceMuted(!voice.muted);
}

function updateVoiceButton() {
  const button = $("#btn-voice");
  if (!button) return;
  button.classList.toggle("voice-on", !voice.muted);
  button.classList.toggle("voice-pending", voice.pending);
  button.setAttribute("aria-pressed", String(!voice.muted));
  button.setAttribute("aria-label", voice.muted ? "Unmute microphone" : "Mute microphone");
}

function applyVoiceRoster(entries) {
  voice.roster = new Map((entries || []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  rekeyVoicePeers();
  syncVoiceMesh();
}

/* If a call was answered before the roster arrived it is keyed by raw PeerJS
 * id; once the roster maps that peer to an app id, move the entries over so
 * speaking indicators line up with player pills.
 */
function rekeyVoicePeers() {
  for (const entry of voice.roster.values()) {
    if (!entry.peerId || entry.peerId === entry.id) continue;
    for (const map of [voice.calls, voice.audios, voice.analysers]) {
      if (map.has(entry.peerId) && !map.has(entry.id)) {
        map.set(entry.id, map.get(entry.peerId));
        map.delete(entry.peerId);
      }
    }
    if (voice.speaking.has(entry.peerId)) {
      voice.speaking.delete(entry.peerId);
      voice.speaking.add(entry.id);
    }
  }
}

/* Later joiners call earlier members so each pair has exactly one call. */
function syncVoiceMesh() {
  if (!voice.on || !voice.stream) return;
  const mine = voice.roster.get(MY_ID);
  if (!mine) return;
  for (const entry of voice.roster.values()) {
    if (entry.id === MY_ID || !entry.peerId) continue;
    if (voice.calls.has(entry.id)) continue;
    const iAmLater = (mine.joinedAt || 0) > (entry.joinedAt || 0) || ((mine.joinedAt || 0) === (entry.joinedAt || 0) && MY_ID > entry.id);
    if (!iAmLater) continue;
    const call = net.call(entry.peerId, voice.stream);
    if (call) wireVoiceCall(entry.id, call);
  }
  for (const [appId, call] of [...voice.calls]) {
    if (!voice.roster.has(appId)) {
      try { call.close(); } catch {}
      dropVoicePeer(appId);
    }
  }
}

function appIdForPeerId(peerId) {
  for (const entry of voice.roster.values()) {
    if (entry.peerId === peerId) return entry.id;
  }
  return peerMap.get(peerId) || null;
}

function wireVoiceCall(appId, call) {
  voice.calls.set(appId, call);
  call.on("stream", (remoteStream) => {
    playVoiceStream(appId, remoteStream);
    attachSpeakingAnalyser(appId, remoteStream);
  });
  call.on("close", () => dropVoicePeer(appId));
  call.on("error", () => dropVoicePeer(appId));
}

function answerVoiceCall(call) {
  if (!voice.on || !voice.stream) {
    try { call.close(); } catch {}
    return;
  }
  const appId = appIdForPeerId(call.peer) || call.peer;
  const existing = voice.calls.get(appId);
  if (existing && existing !== call) { try { existing.close(); } catch {} }
  try { call.answer(voice.stream); } catch { return; }
  wireVoiceCall(appId, call);
}

function dropVoicePeer(appId) {
  voice.calls.delete(appId);
  const audio = voice.audios.get(appId);
  if (audio) detachVoiceAudio(audio);
  voice.audios.delete(appId);
  detachSpeakingAnalyser(appId);
  voice.speaking.delete(appId);
  renderSpeakingIndicators();
}

function detachVoiceAudio(audio) {
  try { audio.pause(); } catch {}
  audio.srcObject = null;
  audio.remove();
}

function playVoiceStream(appId, stream) {
  const sink = $("#voice-audio-sink");
  if (!sink) return;
  let audio = voice.audios.get(appId);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    sink.appendChild(audio);
    voice.audios.set(appId, audio);
  }
  audio.srcObject = stream;
  audio.play().catch(() => {});
}

/* After host migration the Peer object (and every media call) is replaced,
 * but the local mic stream survives. Clear stale calls and re-announce with
 * the fresh peer id so the mesh rebuilds.
 */
function restoreVoiceAfterReconnect() {
  voice.states.set(MY_ID, { muted: voice.muted });
  if (voice.on || voice.stream) {
    for (const call of voice.calls.values()) { try { call.close(); } catch {} }
    voice.calls.clear();
    for (const [appId, audio] of voice.audios) {
      detachVoiceAudio(audio);
      detachSpeakingAnalyser(appId);
    }
    voice.audios.clear();
    voice.speaking.clear();
    if (!voice.muted) attachSpeakingAnalyser(MY_ID, voice.stream);
  }
  if (net.isHost) {
    voice.roster.clear();
    if (voice.on) voice.roster.set(MY_ID, voiceEntry());
    syncHostVoiceControl();
    broadcastVoiceRoster();
  } else {
    if (voice.channelActive && !voice.on) joinVoice();
    announceVoiceState();
  }
  renderSpeakingIndicators();
}

/* ===== Speaking detection ===== */
const VOICE_SPEAKING_THRESHOLD = 0.045;
const VOICE_SPEAKING_HOLD_MS = 450;
const VOICE_LEVEL_INTERVAL_MS = 160;
let voiceAnalysisCtx = null;

function voiceAnalysisContext() {
  if (!voiceAnalysisCtx || voiceAnalysisCtx.state === "closed") {
    voiceAnalysisCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (voiceAnalysisCtx.state === "suspended") voiceAnalysisCtx.resume().catch(() => {});
  return voiceAnalysisCtx;
}

function attachSpeakingAnalyser(appId, stream) {
  detachSpeakingAnalyser(appId);
  try {
    const ctx = voiceAnalysisContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    voice.analysers.set(appId, { analyser, source, data: new Uint8Array(analyser.fftSize), lastLoudAt: 0 });
  } catch {}
}

function detachSpeakingAnalyser(appId) {
  const entry = voice.analysers.get(appId);
  if (!entry) return;
  try { entry.source.disconnect(); } catch {}
  voice.analysers.delete(appId);
  voice.speaking.delete(appId);
}

function startVoiceLevelLoop() {
  stopVoiceLevelLoop();
  voice.levelTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [appId, entry] of voice.analysers) {
      entry.analyser.getByteTimeDomainData(entry.data);
      let sum = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const v = (entry.data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / entry.data.length);
      if (rms > VOICE_SPEAKING_THRESHOLD) entry.lastLoudAt = now;
      const speaking = now - entry.lastLoudAt < VOICE_SPEAKING_HOLD_MS;
      if (speaking !== voice.speaking.has(appId)) {
        if (speaking) voice.speaking.add(appId);
        else voice.speaking.delete(appId);
        changed = true;
      }
    }
    if (changed) renderSpeakingIndicators();
  }, VOICE_LEVEL_INTERVAL_MS);
}

function stopVoiceLevelLoop() {
  clearInterval(voice.levelTimer);
  voice.levelTimer = null;
}

function renderSpeakingIndicators() {
  document.querySelectorAll(".swatch[data-pid]").forEach((el) => {
    el.classList.toggle("speaking", voice.speaking.has(el.dataset.pid));
  });
}

/* ===== Background-tab voice continuity =====
 * Remote audio plays through <audio> elements, which browsers keep running in
 * hidden tabs (unlike AudioContext, which throttles and then dumps the backlog
 * on refocus — the annoying "catch up" effect). While hidden, a watchdog
 * revives any element the browser paused. On refocus, re-attaching srcObject
 * discards whatever buffered backlog remains so playback resumes live instead
 * of replaying missed audio.
 */
const VOICE_KEEPALIVE_MS = 2000;

function startVoiceKeepAlive() {
  stopVoiceKeepAlive();
  voice.keepAliveTimer = setInterval(() => {
    if (!voice.on) return;
    for (const audio of voice.audios.values()) {
      if (audio.paused && audio.srcObject) audio.play().catch(() => {});
    }
  }, VOICE_KEEPALIVE_MS);
}

function stopVoiceKeepAlive() {
  clearInterval(voice.keepAliveTimer);
  voice.keepAliveTimer = null;
}

function flushVoiceBacklog() {
  if (!voice.on) return;
  for (const audio of voice.audios.values()) {
    const stream = audio.srcObject;
    if (!stream) continue;
    audio.srcObject = null;
    audio.srcObject = stream;
    audio.play().catch(() => {});
  }
  if (voiceAnalysisCtx?.state === "suspended") voiceAnalysisCtx.resume().catch(() => {});
}

function wireVoiceVisibility() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flushVoiceBacklog();
  });
}

function inviteLobbyChannel() {
  if (inLobby && sessionChannel) return sessionChannel;
  const input = $("#input-home-lobby-code");
  const channel = normalizeLobbyChannel(input?.value || newLobbyChannel());
  if (input) input.value = channel.toUpperCase().slice(0, 4);
  pendingGameState = null;
  activeGame?.destroy?.();
  activeGame = null;
  connectToLobby(channel, true, true);
  return channel;
}

function invitePresencePlayer(toId) {
  const entry = presenceRoster.get(toId);
  if (!entry) return;
  const channel = inviteLobbyChannel();
  const invite = {
    t: "presence-invite",
    toId,
    fromId: MY_ID,
    fromName: profile.name,
    fromIcon: profile.icon,
    lobby: channel,
    lobbyName: lobbyDisplayName(channel),
    sentAt: Date.now(),
  };
  sendPresenceInvite(invite);
  setStatus(`Invited ${entry.name} to ${invite.lobbyName}.`);
}

function joinPresencePlayer(toId) {
  const entry = presenceRoster.get(toId);
  if (!entry?.lobby) return;
  closeProfileSheet();
  connectToLobby(entry.lobby, false, false);
}

function sendPresenceInvite(invite) {
  if (presenceNet.isHost) {
    if (invite.toId === MY_ID) handlePresenceInvite(invite);
    const peerId = presencePeerMap.get(invite.toId);
    if (peerId) presenceNet.sendTo(peerId, invite);
  } else {
    presenceNet.send(invite);
  }
}

function handlePresenceInvite(invite) {
  if (!invite || invite.toId !== MY_ID) return;
  pendingInvites.push(invite);
  const join = confirm(`${invite.fromName || "Someone"} invited you to ${invite.lobbyName || invite.lobby}. Join now?`);
  if (join) connectToLobby(invite.lobby, false, false);
}

function sweepPresenceRoster() {
  const now = Date.now();
  let changed = false;
  for (const [id, entry] of presenceRoster) {
    if (id === MY_ID) continue;
    if (now - (entry.updatedAt || 0) <= PRESENCE_STALE_MS) continue;
    presenceRoster.delete(id);
    presencePeerMap.delete(id);
    changed = true;
  }
  if (changed) {
    renderPresence();
    broadcastPresenceRoster();
  }
}

function startPresenceTimers() {
  clearInterval(presenceTimer);
  clearInterval(presenceSweepTimer);
  broadcastPresence(true);
  presenceTimer = setInterval(() => broadcastPresence(false), PRESENCE_HEARTBEAT_MS);
  presenceSweepTimer = setInterval(sweepPresenceRoster, PRESENCE_HEARTBEAT_MS);
}

function wirePresenceEvents() {
  presenceNet.on("ready", () => {
    presencePeerMap.clear();
    upsertPresence(presencePayload());
    startPresenceTimers();
    broadcastPresenceRoster();
  });

  presenceNet.on("connected", () => {
    startPresenceTimers();
  });

  presenceNet.on("peer-leave", (peerId) => {
    for (const [id, mappedPeerId] of presencePeerMap) {
      if (mappedPeerId !== peerId) continue;
      presencePeerMap.delete(id);
      presenceRoster.delete(id);
    }
    renderPresence();
    broadcastPresenceRoster();
  });

  presenceNet.on("host-closed", () => {
    presencePeerMap.clear();
    presenceNet.migrate(PRESENCE_CHANNEL, false);
  });

  presenceNet.on("message", ({ from, data }) => {
    if (data?.t === "presence-update") {
      if (presenceNet.isHost && from !== "host") {
        presencePeerMap.set(data.id, from);
        upsertPresence(data);
        presenceNet.sendTo(from, presenceRosterMessage());
        broadcastPresenceRoster();
      } else {
        upsertPresence(data);
      }
    } else if (data?.t === "presence-roster") {
      for (const entry of data.entries || []) upsertPresence(entry);
    } else if (data?.t === "presence-invite") {
      if (presenceNet.isHost && data.toId !== MY_ID) {
        const peerId = presencePeerMap.get(data.toId);
        if (peerId) presenceNet.sendTo(peerId, data);
      } else {
        handlePresenceInvite(data);
      }
    }
  });

  presenceNet.on("error", (err) => console.warn("Presence connection issue", err));
}

function show(name) {
  for (const key in screens) screens[key].classList.toggle("active", key === name);
}

function setStatus(text) {
  statusText = text;
  const el = $("#connection-status");
  if (el) el.textContent = text;
}

function setHostReachability(value) {
  hostReachability = value;
  if (!net.isHost) return;
  if (value === "confirmed") setStatus(`Hosting ${currentMode().name} - reachable`);
  else if (value === "suspect") setStatus(`Hosting ${currentMode().name} - connection may be throttled`);
  else setStatus(`Hosting ${currentMode().name} - waiting for first connection`);
}

function availableMusicTracks() {
  return window.SimpleRainGame?.musicTracks || [];
}

function loadSelectedMusicTracks() {
  const validIds = new Set(availableMusicTracks().map((track) => track.id));
  try {
    const saved = JSON.parse(localStorage.getItem(MUSIC_TRACKS_KEY) || "null");
    if (Array.isArray(saved)) return saved.filter((id) => validIds.has(id));
  } catch {}
  if (localStorage.getItem(MUSIC_MUTED_KEY) === "1") return [];
  const firstTrack = availableMusicTracks()[0];
  return firstTrack ? [firstTrack.id] : [];
}

function saveSelectedMusicTracks() {
  localStorage.setItem(MUSIC_TRACKS_KEY, JSON.stringify(selectedMusicTrackIds));
  localStorage.setItem(MUSIC_MUTED_KEY, selectedMusicTrackIds.length ? "0" : "1");
}

function setSelectedMusicTracks(ids) {
  const validIds = new Set(availableMusicTracks().map((track) => track.id));
  selectedMusicTrackIds = [...new Set(ids)].filter((id) => validIds.has(id));
  saveSelectedMusicTracks();
  activeGame?.setMusicTracks?.(selectedMusicTrackIds);
}

function displayIcon(icon) {
  return icon || "🐸";
}

function firstEmoji(value) {
  const text = String(value || "").trim();
  const match = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/u);
  return match ? match[0] : "";
}

function pickColor() {
  for (const color of COLORS) {
    if (!usedColors.has(color)) {
      usedColors.add(color);
      return color;
    }
  }
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function addPlayer(id, name, peerId, icon, preferredColor) {
  if (players.has(id)) {
    if (peerId) peerMap.set(peerId, id);
    return players.get(id);
  }
  const color = preferredColor && !usedColors.has(preferredColor) ? preferredColor : pickColor();
  usedColors.add(color);
  const player = { id, name, color, icon: icon || randomIcon() };
  players.set(id, player);
  profiles.set(id, { name: player.name, color: player.color, icon: player.icon });
  if (peerId) peerMap.set(peerId, id);
  return player;
}

function getVisiblePlayers() {
  return soloMode || net.isHost ? [...players.values()] : lastState;
}

function currentPlayer() {
  return getVisiblePlayers().find((player) => player.id === MY_ID) || {
    id: MY_ID,
    name: profile.name,
    color: profile.color || myColor || COLORS[0],
    icon: profile.icon,
  };
}

function playerPillHtml(player, hostId) {
  const crown = player.id === hostId ? `<span class="host-crown" aria-hidden="true">♛</span>` : "";
  const speaking = voice.speaking.has(player.id) ? " speaking" : "";
  return `<span class="swatch${speaking}" data-pid="${esc(player.id)}" style="background:${player.color}">${crown}${esc(displayIcon(player.icon))}</span>${esc(player.name)}`;
}

function renderPlayers() {
  const list = $("#player-list");
  if (!list) return;
  const visible = getVisiblePlayers();
  const hostId = soloMode ? null : net.isHost ? MY_ID : lastHostOrder[0];
  list.innerHTML = "";
  for (const player of visible.filter((player) => player.id !== MY_ID)) {
    const li = document.createElement("li");
    li.classList.toggle("host-player", player.id === hostId);
    li.innerHTML = playerPillHtml(player, hostId);
    list.appendChild(li);
  }
  renderProfileButtons(hostId);
}

function renderProfileButton(hostId = soloMode ? null : net.isHost ? MY_ID : lastHostOrder[0], selector = "#btn-profile") {
  const button = $(selector);
  if (!button) return;
  const player = currentPlayer();
  button.classList.toggle("host-player", player.id === hostId);
  button.innerHTML = playerPillHtml(player, hostId);
}

function renderProfileButtons(hostId = soloMode ? null : net.isHost ? MY_ID : lastHostOrder[0]) {
  renderProfileButton(hostId, "#btn-profile");
  renderProfileButton(hostId, "#btn-home-profile");
}

function loadCachedGameState() {
  try { return JSON.parse(localStorage.getItem(currentMode().saveKey) || "null")?.state || null; } catch { return null; }
}

function saveCachedGameState(state) {
  if (!state) return;
  try { localStorage.setItem(currentMode().saveKey, JSON.stringify({ savedAt: Date.now(), state })); } catch {}
  updateContinueButton();
}

function clearCachedGameState() {
  try { localStorage.removeItem(currentMode().saveKey); } catch {}
  updateContinueButton();
}

function hasCachedGameState() {
  return !!loadCachedGameState();
}

function updateContinueButton() {
  $("#btn-continue-game")?.classList.toggle("hidden", !hasCachedGameState());
}

function snapshotGame() {
  return activeGame?.getSnapshot ? activeGame.getSnapshot() : null;
}

function broadcastGameState(state, peerId = null) {
  if (!net.isHost || !state) return;
  const msg = { t: "game-state", state };
  if (peerId) net.sendTo(peerId, msg);
  else net.broadcast(msg);
}

function gameHostApi() {
  return {
    canvas,
    myId: MY_ID,
    isHost: () => soloMode || net.isHost,
    getPlayers: () => getVisiblePlayers(),
    getProfile: (id) => profiles.get(id),
    isSpeaking: (id) => voice.speaking.has(id ?? MY_ID),
    isMusicMuted: () => selectedMusicTrackIds.length === 0,
    getSelectedMusicTracks: () => selectedMusicTrackIds.slice(),
    sendInput: (input) => {
      if (soloMode) activeGame?.onPeerInput?.(MY_ID, input);
      else net.send({ t: "game-input", input });
    },
    sendEvent: (event) => {
      if (soloMode) return;
      if (net.isHost) net.broadcast({ t: "game-event", id: MY_ID, event });
      else net.send({ t: "game-event", event });
    },
    broadcastState: (state) => {
      if (soloMode) {
        saveCachedGameState(state);
        return;
      }
      if (!net.isHost) return;
      saveCachedGameState(state);
      broadcastGameState(state);
    },
  };
}

function updateMusicButton() {
  renderMusicPicker();
}

function musicPickerLabel() {
  const tracks = availableMusicTracks();
  if (!selectedMusicTrackIds.length) return "Music: None";
  if (selectedMusicTrackIds.length === 1) return tracks.find((track) => track.id === selectedMusicTrackIds[0])?.name || "Music: 1 track";
  return `Music: ${selectedMusicTrackIds.length} tracks`;
}

function renderMusicPicker() {
  const button = $("#btn-music-picker");
  const menu = $("#music-picker-menu");
  if (!button || !menu) return;
  const tracks = availableMusicTracks();
  button.textContent = musicPickerLabel();
  menu.innerHTML = tracks.map((track) => `
    <div class="music-track-row">
      <label class="music-track-choice">
        <input type="checkbox" value="${esc(track.id)}" ${selectedMusicTrackIds.includes(track.id) ? "checked" : ""} />
        <span>
          <strong>${esc(track.name)}</strong>
          <small>${esc(track.mood || "Loop")}</small>
        </span>
      </label>
      <button class="music-sample-btn" type="button" data-track-id="${esc(track.id)}">Sample</button>
    </div>`).join("") || `<p class="music-empty">No music tracks available.</p>`;
}

function toggleMusicPicker() {
  const picker = $("#music-picker");
  const button = $("#btn-music-picker");
  if (!picker || !button) return;
  const open = !picker.classList.contains("open");
  picker.classList.toggle("open", open);
  button.setAttribute("aria-expanded", String(open));
}

function wireMusicPicker() {
  const button = $("#btn-music-picker");
  if (button) button.onclick = toggleMusicPicker;
  const menu = $("#music-picker-menu");
  if (!menu) return;
  menu.onchange = (event) => {
    if (event.target?.type !== "checkbox") return;
    const selected = [...menu.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
    setSelectedMusicTracks(selected);
    renderMusicPicker();
  };
  menu.onclick = (event) => {
    const sample = event.target?.closest?.(".music-sample-btn");
    if (!sample) return;
    event.preventDefault();
    if (activeGame?.sampleMusicTrack) activeGame.sampleMusicTrack(sample.dataset.trackId);
    else window.SimpleRainGame?.previewTrack?.(sample.dataset.trackId);
  };
}

function updateInvitePanel() {
  const url = inviteUrl();
  const invitePanel = document.querySelector(".invite-panel");
  invitePanel?.classList.toggle("hidden", soloMode);
  const code = $("#invite-code");
  if (code) code.textContent = sessionChannel || "solo";
  const link = $("#invite-link");
  if (link) link.value = url;
  const qr = $("#invite-qr");
  if (qr) qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(url)}`;
}

function updateLobbyControls() {
  const playing = inLobby || soloMode;
  $("#lobby-active-controls")?.classList.toggle("hidden", !playing);
  $("#lobby-left-controls")?.classList.toggle("hidden", playing);
  $("#home-lobby-controls")?.classList.toggle("hidden", false);
  const homeCode = $("#input-home-lobby-code");
  const sessionCode = sessionChannel ? displayCodeForChannel(sessionChannel) : "";
  if (homeCode && !homeCode.value && sessionCode) homeCode.value = sessionCode.toUpperCase();
  updateHostControlButtons();
  updateChatControls();
}

function lobbyInfoPayload() {
  const visible = getVisiblePlayers();
  return {
    t: "lobby-info",
    channel: sessionChannel,
    name: lobbyDisplayName(sessionChannel) || sessionChannel,
    hostName: profile.name,
    hostId: MY_ID,
    playerCount: visible.length || players.size || 1,
    players: visible.map((player) => ({ id: player.id, name: player.name, icon: player.icon, color: player.color })),
    isHost: net.isHost,
    reachability: hostReachability,
    version: APP_VERSION,
  };
}

function lobbyStatusText(info) {
  if (!info) return "Checking - available if empty";
  if (!info.active) return "Open - become host";
  const count = Number(info.playerCount || info.players?.length || 1);
  return `Active - ${count} ${count === 1 ? "player" : "players"}`;
}

function lobbyCardMeta(info) {
  if (info?.active) return lobbyInfoSummary(info);
  if (info) return "No host found. Tap to host this flower lobby.";
  return "Tap anytime. If no host answers, you become host.";
}

function flowerArt(lobby) {
  if (lobby.art === "lotus") {
    return `
      <svg class="flower-svg lotus-svg" viewBox="0 0 64 64" aria-hidden="true">
        <ellipse class="lotus-leaf" cx="21" cy="48" rx="15" ry="7" transform="rotate(-12 21 48)" />
        <ellipse class="lotus-leaf" cx="43" cy="48" rx="15" ry="7" transform="rotate(12 43 48)" />
        <path class="lotus-petal" d="M32 8 C24 19 24 31 32 42 C40 31 40 19 32 8 Z" />
        <path class="lotus-petal" d="M21 17 C19 30 23 39 32 44 C34 31 30 22 21 17 Z" />
        <path class="lotus-petal" d="M43 17 C45 30 41 39 32 44 C30 31 34 22 43 17 Z" />
        <path class="lotus-petal lotus-front" d="M32 24 C24 31 22 40 32 51 C42 40 40 31 32 24 Z" />
        <circle class="flower-center" cx="32" cy="39" r="4" />
      </svg>
    `;
  }
  if (lobby.art === "iris") {
    return `
      <svg class="flower-svg iris-svg" viewBox="0 0 64 64" aria-hidden="true">
        <path class="iris-fall" d="M32 31 C19 34 14 46 18 56 C27 55 33 47 32 31 Z" />
        <path class="iris-fall" d="M32 31 C45 34 50 46 46 56 C37 55 31 47 32 31 Z" />
        <path class="iris-standard" d="M32 30 C20 21 20 10 32 5 C44 10 44 21 32 30 Z" />
        <path class="iris-standard" d="M31 31 C20 27 11 18 15 9 C27 10 32 20 31 31 Z" />
        <path class="iris-standard" d="M33 31 C44 27 53 18 49 9 C37 10 32 20 33 31 Z" />
        <path class="flower-stem" d="M32 34 C31 43 31 52 32 61" />
        <circle class="flower-center" cx="32" cy="31" r="4" />
      </svg>
    `;
  }
  if (lobby.art === "lily") {
    return `
      <svg class="flower-svg lily-svg" viewBox="0 0 64 64" aria-hidden="true">
        <path class="lily-petal" d="M32 8 C23 20 24 33 32 42 C40 33 41 20 32 8 Z" />
        <path class="lily-petal" d="M20 16 C17 29 22 39 32 43 C32 30 28 21 20 16 Z" />
        <path class="lily-petal" d="M44 16 C47 29 42 39 32 43 C32 30 36 21 44 16 Z" />
        <path class="lily-petal" d="M13 31 C22 27 31 31 35 42 C22 45 15 40 13 31 Z" />
        <path class="lily-petal" d="M51 31 C42 27 33 31 29 42 C42 45 49 40 51 31 Z" />
        <path class="flower-stem" d="M32 39 C31 47 31 54 32 61" />
        <circle class="flower-center" cx="32" cy="38" r="4" />
      </svg>
    `;
  }
  if (lobby.art === "clover") {
    return `
      <svg class="flower-svg clover-svg" viewBox="0 0 64 64" aria-hidden="true">
        <path class="clover-leaf" d="M32 30 C20 18 20 7 32 8 C44 7 44 18 32 30 Z" />
        <path class="clover-leaf" d="M30 32 C18 44 7 44 8 32 C7 20 18 20 30 32 Z" />
        <path class="clover-leaf" d="M34 32 C46 20 57 20 56 32 C57 44 46 44 34 32 Z" />
        <path class="clover-leaf" d="M32 34 C44 46 44 57 32 56 C20 57 20 46 32 34 Z" />
        <path class="flower-stem" d="M34 38 C37 48 34 55 25 61" />
      </svg>
    `;
  }
  if (lobby.art === "anemone") {
    return `
      <svg class="flower-svg anemone-svg" viewBox="0 0 64 64" aria-hidden="true">
        ${Array.from({ length: 10 }, (_, i) => `<ellipse class="anemone-petal" cx="32" cy="18" rx="6" ry="14" transform="rotate(${i * 36} 32 32)" />`).join("")}
        <circle class="anemone-center" cx="32" cy="32" r="9" />
        <circle class="flower-center" cx="32" cy="32" r="4" />
      </svg>
    `;
  }
  if (lobby.art === "poppy") {
    return `
      <svg class="flower-svg poppy-svg" viewBox="0 0 64 64" aria-hidden="true">
        <path class="poppy-petal" d="M31 31 C17 29 10 18 18 9 C30 6 34 17 31 31 Z" />
        <path class="poppy-petal" d="M33 31 C47 29 54 18 46 9 C34 6 30 17 33 31 Z" />
        <path class="poppy-petal" d="M31 33 C17 35 10 46 18 55 C30 58 34 47 31 33 Z" />
        <path class="poppy-petal" d="M33 33 C47 35 54 46 46 55 C34 58 30 47 33 33 Z" />
        <circle class="poppy-center" cx="32" cy="32" r="8" />
        <circle class="flower-center" cx="32" cy="32" r="3" />
      </svg>
    `;
  }
  if (lobby.art === "aster") {
    return `
      <svg class="flower-svg aster-svg" viewBox="0 0 64 64" aria-hidden="true">
        ${Array.from({ length: 14 }, (_, i) => `<ellipse class="aster-petal" cx="32" cy="15" rx="4" ry="14" transform="rotate(${i * 25.714} 32 32)" />`).join("")}
        <circle class="flower-center" cx="32" cy="32" r="8" />
      </svg>
    `;
  }
  if (lobby.art === "orchid") {
    return `
      <svg class="flower-svg orchid-svg" viewBox="0 0 64 64" aria-hidden="true">
        <ellipse class="orchid-petal" cx="32" cy="17" rx="10" ry="15" />
        <ellipse class="orchid-petal" cx="18" cy="31" rx="9" ry="14" transform="rotate(-42 18 31)" />
        <ellipse class="orchid-petal" cx="46" cy="31" rx="9" ry="14" transform="rotate(42 46 31)" />
        <ellipse class="orchid-petal" cx="25" cy="43" rx="8" ry="12" transform="rotate(34 25 43)" />
        <ellipse class="orchid-petal" cx="39" cy="43" rx="8" ry="12" transform="rotate(-34 39 43)" />
        <path class="orchid-lip" d="M24 34 C29 29 35 29 40 34 C39 45 35 52 32 55 C29 52 25 45 24 34 Z" />
        <circle class="flower-center" cx="32" cy="35" r="4" />
      </svg>
    `;
  }
  return "";
}

function lobbyCardArt(lobby) {
  if (lobby.glyph) return `<span class="chess-glyph" aria-hidden="true">${esc(lobby.glyph)}</span>`;
  return flowerArt(lobby);
}

function renderModeLobbies(results = new Map()) {
  const list = $("#flower-lobby-list");
  if (!list) return;
  const mode = currentMode();
  list.innerHTML = "";
  for (const lobby of mode.lobbies) {
    const channel = presetLobbyChannel(mode, lobby);
    const info = results.get(channel);
    const button = document.createElement("button");
    button.className = "flower-lobby-card";
    button.type = "button";
    button.style.setProperty("--flower", lobby.color);
    button.dataset.channel = channel;
    button.innerHTML = `
      <span class="flower-art" aria-hidden="true">${lobbyCardArt(lobby)}</span>
      <span class="flower-lobby-content">
        <span class="flower-lobby-name">${esc(lobby.name)}</span>
        <span class="flower-lobby-status">${esc(lobbyStatusText(info))}</span>
        <span class="flower-lobby-meta">${esc(lobbyCardMeta(info))}</span>
      </span>
    `;
    button.onclick = () => joinPresetLobby(lobby);
    list.appendChild(button);
  }
}

function lobbyInfoSummary(info) {
  const names = (info.players || []).map((player) => player.name).filter(Boolean).slice(0, 3);
  const reachability = info.reachability === "confirmed" ? "reachable" : info.reachability === "suspect" ? "suspect" : "unconfirmed";
  if (names.length) return `Host: ${info.hostName || names[0]} · ${reachability} · ${names.join(", ")}`;
  return info.hostName ? `Host: ${info.hostName} · ${reachability}` : `Version ${info.version || "unknown"}`;
}

async function refreshModeLobbies() {
  const now = Date.now();
  const remaining = LOBBY_REFRESH_COOLDOWN_MS - (now - lastLobbyRefreshAttemptAt);
  if (remaining > 0) {
    setStatus(`Please wait ${Math.ceil(remaining / 1000)}s before refreshing lobbies again.`);
    return;
  }
  lastLobbyRefreshAttemptAt = now;
  const token = ++lobbyScanToken;
  const mode = currentMode();
  const refresh = $("#btn-refresh-lobbies");
  refresh?.setAttribute("disabled", "disabled");
  setStatus(`Checking ${mode.lobbySectionTitle.toLowerCase()}...`);
  const results = new Map();
  renderModeLobbies(results);
  for (const lobby of mode.lobbies) {
    if (token !== lobbyScanToken || mode !== currentMode()) return;
    const channel = presetLobbyChannel(mode, lobby);
    const info = await net.probe(channel, LOBBY_SCAN_TIMEOUT_MS);
    if (token !== lobbyScanToken || mode !== currentMode()) return;
    results.set(channel, info);
    renderModeLobbies(results);
  }
  refresh?.removeAttribute("disabled");
  setStatus("Choose how to play.");
}

function enterHomeScreen(refreshLobbies = true) {
  show("loading");
  setStatus("Choose how to play.");
  if (!sessionChannel) setHomeInviteCode(randomLobbyCode());
  updateLobbyControls();
  updateContinueButton();
  if (refreshLobbies) refreshModeLobbies();
  broadcastPresence(false);
}

async function copyInviteLink() {
  const url = inviteUrl();
  try {
    await navigator.clipboard?.writeText(url);
  } catch {
    const input = $("#invite-link");
    input?.select?.();
    document.execCommand?.("copy");
  }
}

async function shareInviteLink() {
  const url = inviteUrl();
  const text = `Join my ${currentMode().name} lobby: ${url}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: `${currentMode().name} lobby`, text, url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  location.href = `sms:?&body=${encodeURIComponent(text)}`;
}

function refreshCachedPwaFiles() {
  const button = $("#btn-refresh-cache");
  if (!navigator.serviceWorker?.controller) {
    setStatus("PWA cache is not active yet. Reload once, then try again.");
    return;
  }

  button?.setAttribute("disabled", "disabled");
  setStatus("Refreshing cached PWA files...");
  const channel = new MessageChannel();
  const timeout = setTimeout(() => {
    button?.removeAttribute("disabled");
    setStatus("Cache refresh timed out. Try reloading.");
  }, 12000);

  channel.port1.onmessage = (event) => {
    clearTimeout(timeout);
    button?.removeAttribute("disabled");
    if (event.data?.ok) setStatus(`Cached files refreshed. Version ${event.data.version || APP_VERSION} is ready.`);
    else setStatus(`Cache refresh failed: ${event.data?.error || "unknown error"}`);
  };

  navigator.serviceWorker.controller.postMessage({ type: "REFRESH_APP_SHELL" }, [channel.port2]);
}

function wireManageControls() {
  const reset = $("#btn-reset");
  if (reset) reset.onclick = resetGame;
  wireMusicPicker();
  wireChatControls();
  const leave = $("#btn-leave-lobby");
  if (leave) leave.onclick = leaveLobby;
  const leaveTop = $("#btn-leave-lobby-top");
  if (leaveTop) leaveTop.onclick = leaveLobby;
  const requestHost = $("#btn-request-host");
  if (requestHost) requestHost.onclick = requestHostRole;
  const relinquishHost = $("#btn-relinquish-host");
  if (relinquishHost) relinquishHost.onclick = relinquishHostRole;
  const copy = $("#btn-copy-invite");
  if (copy) copy.onclick = copyInviteLink;
  const share = $("#btn-share-invite");
  if (share) share.onclick = shareInviteLink;
  const host = $("#btn-host-lobby");
  if (host) host.onclick = hostNewLobby;
  const solo = $("#btn-play-solo");
  if (solo) solo.onclick = startSoloGame;
  const continueGame = $("#btn-continue-game");
  if (continueGame) continueGame.onclick = continueSavedGame;
  const refresh = $("#btn-refresh-lobbies");
  if (refresh) refresh.onclick = refreshModeLobbies;
  const refreshCache = $("#btn-refresh-cache");
  if (refreshCache) refreshCache.onclick = refreshCachedPwaFiles;
  const homeJoin = $("#btn-home-join-lobby");
  if (homeJoin) homeJoin.onclick = joinLobbyFromHomeCode;
}

function updateHostControlButtons() {
  const request = $("#btn-request-host");
  const relinquish = $("#btn-relinquish-host");
  const showHostTools = inLobby && !soloMode;
  request?.classList.toggle("hidden", !showHostTools || net.isHost);
  relinquish?.classList.toggle("hidden", !showHostTools || !net.isHost);
}

function maybeShowTutorial() {
  if (localStorage.getItem(TUTORIAL_SEEN_KEY)) return;
  const overlay = $("#tutorial-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  const done = $("#btn-tutorial-done");
  if (done) done.onclick = dismissTutorial;
}

function dismissTutorial() {
  localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  $("#tutorial-overlay")?.classList.add("hidden");
}

function startGame(initialState = null) {
  activeGame?.destroy?.();
  activeGame = gameModule().create(gameHostApi(), initialState);
  activeGame.setMusicTracks?.(selectedMusicTrackIds);
  activeGame.start?.();
  if (activeModeKey === "flower") maybeShowTutorial();
  if (pendingGameState) {
    activeGame.onState?.(pendingGameState);
    pendingGameState = null;
  }
  if (soloMode) {
    saveCachedGameState(snapshotGame());
  } else if (net.isHost) {
    const state = snapshotGame();
    saveCachedGameState(state);
    broadcastGameState(state);
  }
}

function newLobbyChannel() {
  return randomLobbyCode().toLowerCase();
}

function startSoloGame() {
  startLocalGame(null, true, "Playing solo");
}

function continueSavedGame() {
  const cached = loadCachedGameState();
  if (!cached) {
    updateContinueButton();
    setStatus("No saved game found.");
    return;
  }
  startLocalGame(cached, false, "Continuing saved game");
}

function startLocalGame(initialState, fresh, status) {
  stopHostLoop();
  stopHostThrottleMonitor();
  stopHostWatchdog();
  clearHandoffTimer();
  clearClientWelcomeTimer();
  resetChatState();
  leaveVoice(true);
  voice.roster.clear();
  net.destroy();
  soloMode = true;
  inLobby = false;
  sessionChannel = "";
  hostReachability = "solo";
  players.clear();
  peerMap.clear();
  usedColors.clear();
  lastState = [];
  lastHostOrder = [];
  pendingGameState = null;
  addPlayer(MY_ID, profile.name, null, profile.icon, profile.color);
  lastState = [...players.values()];
  lastHostOrder = [MY_ID];
  updateLobbyUrl();
  updateLobbyControls();
  if (fresh) clearCachedGameState();
  startGame(initialState);
  renderPlayers();
  show("play");
  setStatus(status);
  broadcastPresence(true);
}

function leaveLobby() {
  if (soloMode) saveCachedGameState(snapshotGame());
  stopHostLoop();
  stopHostWatchdog();
  clearHandoffTimer();
  clearClientWelcomeTimer();
  resetChatState();
  leaveVoice(true);
  voice.roster.clear();
  voice.states.clear();
  voice.states.set(MY_ID, { muted: voice.muted });
  voice.channelActive = false;
  players.clear();
  peerMap.clear();
  usedColors.clear();
  lastState = [];
  lastHostOrder = [];
  lastPlayersBroadcastAt = 0;
  pendingGameState = null;
  migratingFromHostId = null;
  activeGame?.destroy?.();
  activeGame = null;
  net.destroy();
  inLobby = false;
  soloMode = false;
  sessionChannel = "";
  hostReachability = "solo";
  showInviteAfterReady = false;
  updateLobbyUrl();
  enterHomeScreen(true);
  broadcastPresence(true);
  closeProfileSheet();
}

function connectToLobby(channel, preferHost = false, openInviteWhenReady = false) {
  const nextChannel = normalizeLobbyChannel(channel);
  if (nextChannel !== sessionChannel) resetChatState();
  sessionChannel = nextChannel;
  setGameMode(modeForChannel(nextChannel), { refreshLobbies: false });
  soloMode = false;
  hostReachability = "unconfirmed";
  inLobby = true;
  handoffInProgress = false;
  clearHandoffTimer();
  clearClientWelcomeTimer();
  stopHostWatchdog();
  showInviteAfterReady = openInviteWhenReady;
  updateLobbyUrl();
  updateInvitePanel();
  updateLobbyControls();
  show("loading");
  setStatus(preferHost ? `Hosting a new ${currentMode().name} lobby...` : `Finding a ${currentMode().name} session...`);
  broadcastPresence(true);
  net.migrate(sessionChannel, preferHost);
  setTimeout(() => broadcastPresence(true), 500);
}

function hostNewLobby() {
  pendingGameState = null;
  activeGame?.destroy?.();
  activeGame = null;
  const code = newLobbyChannel();
  const input = $("#input-home-lobby-code");
  if (input) input.value = code.toUpperCase();
  connectToLobby(codeLobbyChannel(code), true, true);
}

function rejoinGlobalLobby() {
  connectToLobby(AUTO_CHANNEL, false, false);
}

function joinPresetLobby(lobby) {
  pendingGameState = null;
  activeGame?.destroy?.();
  activeGame = null;
  connectToLobby(presetLobbyChannel(currentMode(), lobby), false, false);
}

function joinLobbyFromCode() {
  const code = $("#input-lobby-code")?.value;
  connectToLobby(code || AUTO_CHANNEL, false, false);
}

function joinLobbyFromHomeCode() {
  const code = $("#input-home-lobby-code")?.value;
  connectToLobby(codeLobbyChannel(code || newLobbyChannel()), false, false);
}

function initializeHomeInviteCode() {
  const input = $("#input-home-lobby-code");
  if (!input || input.value) return;
  setHomeInviteCode((sessionChannel && displayCodeForChannel(sessionChannel)) || randomLobbyCode());
}

function setHomeInviteCode(code) {
  const input = $("#input-home-lobby-code");
  if (!input) return;
  input.value = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function ensureGameStarted(initialState = null) {
  if (!activeGame) startGame(initialState);
  else if (initialState) activeGame.onState?.(initialState);
}

function resetGame() {
  if (!confirm(`Reset the current ${currentMode().name} game for everyone?`)) return;
  closeProfileSheet();
  clearCachedGameState();
  if (net.isHost) {
    activeGame?.restart?.();
    const state = snapshotGame();
    saveCachedGameState(state);
    broadcastGameState(state);
  } else {
    net.send({ t: "reset-game" });
  }
}

function openProfileSheet() {
  const input = $("#input-name");
  if (input) input.value = profile.name;
  const color = $("#input-color");
  if (color) color.value = profile.color || myColor || COLORS[0];
  const icon = $("#input-icon");
  if (icon) icon.value = profile.icon;
  updateProfilePreview();
  updateMusicButton();
  updateInvitePanel();
  updateLobbyControls();
  updateHostControlButtons();
  renderProfileShortcuts();
  wireManageControls();
  $("#sheet-profile")?.classList.add("open");
}

function closeProfileSheet() {
  $("#sheet-profile")?.classList.remove("open");
  window.SimpleRainGame?.stopPreview?.();
}

function maybeShowWelcomeModal() {
  if (!IS_NEW_USER) return;
  const modal = $("#welcome-modal");
  if (!modal) return;
  const input = $("#input-welcome-name");
  if (input) input.value = "";
  renderWelcomeShortcuts();
  renderPresence();
  updateProfilePreview();
  modal.classList.remove("hidden");
  setTimeout(() => input?.focus?.(), 250);
}

function completeWelcome(startSolo) {
  const input = $("#input-welcome-name");
  const name = input?.value.trim();
  profile.name = name || profile.name || DEFAULT_NAME;
  localStorage.setItem("simplerain-name", profile.name);
  profiles.set(MY_ID, { ...profiles.get(MY_ID), name: profile.name });
  updateProfilePreview();
  broadcastProfile();
  $("#welcome-modal")?.classList.add("hidden");
  if (startSolo) startSoloGame();
}

function updateProfilePreview() {
  const color = profile.color || myColor || COLORS[0];
  const dot = $("#preview-dot");
  if (dot) {
    dot.style.background = color;
    dot.textContent = displayIcon(profile.icon);
    dot.title = profile.icon;
  }
  const name = $("#preview-name");
  if (name) name.textContent = profile.name;
  const menuDot = $("#menu-profile-dot");
  if (menuDot) {
    menuDot.style.background = color;
    menuDot.textContent = displayIcon(profile.icon);
    menuDot.title = profile.name;
  }
  renderProfileButtons();
  const homeDot = $("#home-profile-dot");
  if (homeDot) {
    homeDot.style.background = color;
    homeDot.textContent = displayIcon(profile.icon);
    homeDot.title = profile.name;
  }
  const welcomeDot = $("#welcome-preview-dot");
  if (welcomeDot) {
    welcomeDot.style.background = color;
    welcomeDot.textContent = displayIcon(profile.icon);
    welcomeDot.title = profile.name;
  }
}

function broadcastProfile() {
  if (soloMode) {
    const me = players.get(MY_ID);
    if (!me) return;
    usedColors.delete(me.color);
    me.name = profile.name;
    me.icon = profile.icon;
    if (profile.color) me.color = profile.color;
    usedColors.add(me.color);
    myColor = me.color;
    profiles.set(MY_ID, { name: me.name, color: me.color, icon: me.icon });
    activeGame?.onPlayerList?.();
    renderPlayers();
    broadcastPresence(true);
    return;
  }
  if (net.isHost) {
    const me = players.get(MY_ID);
    if (!me) return;
    usedColors.delete(me.color);
    me.name = profile.name;
    me.icon = profile.icon;
    if (profile.color && (!usedColors.has(profile.color) || me.color === profile.color)) me.color = profile.color;
    usedColors.add(me.color);
    myColor = me.color;
    profiles.set(MY_ID, { name: me.name, color: me.color, icon: me.icon });
    net.broadcast({ t: "profile", id: MY_ID, name: me.name, color: me.color, icon: me.icon });
    broadcastPlayers(true);
    activeGame?.onPlayerList?.();
    renderPlayers();
    broadcastPresence(true);
  } else {
    net.send({ t: "profile", name: profile.name, icon: profile.icon, preferredColor: profile.color });
    broadcastPresence(true);
  }
}

function handleGameInput(id, input) {
  if (!net.isHost || !activeGame) return;
  activeGame.onPeerInput?.(id, input);
}

function handleGameState(state) {
  if (!activeGame) pendingGameState = state;
  else activeGame.onState?.(state);
  saveCachedGameState(state);
}

function startHostLoop() {
  clearInterval(hostLoopTimer);
  hostLoopTimer = setInterval(() => {
    broadcastPlayers(false);
  }, PLAYER_HEARTBEAT_MS);
}

function stopHostLoop() {
  clearInterval(hostLoopTimer);
  hostLoopTimer = null;
}

function startHostThrottleMonitor() {
  stopHostThrottleMonitor();
  hostThrottleExpectedAt = Date.now() + HOST_THROTTLE_CHECK_MS;
  hostThrottleTimer = setInterval(() => {
    const now = Date.now();
    const drift = now - hostThrottleExpectedAt;
    hostThrottleExpectedAt = now + HOST_THROTTLE_CHECK_MS;
    if (!net.isHost || !document.hidden || drift < HOST_THROTTLE_DRIFT_MS) return;
    console.warn(`Host tab timer throttling detected (${Math.round(drift)}ms drift).`);
    setHostReachability("suspect");
    broadcastPlayers(true);
    const state = snapshotGame();
    if (state) {
      saveCachedGameState(state);
      broadcastGameState(state);
    }
  }, HOST_THROTTLE_CHECK_MS);
}

function stopHostThrottleMonitor() {
  clearInterval(hostThrottleTimer);
  hostThrottleTimer = null;
  hostThrottleExpectedAt = 0;
}

function clearHandoffTimer() {
  clearTimeout(handoffTimer);
  handoffTimer = null;
}

function clearClientWelcomeTimer() {
  clearTimeout(clientWelcomeTimer);
  clientWelcomeTimer = null;
}

function markHostAlive() {
  lastHostMessageAt = Date.now();
}

function startHostWatchdog() {
  stopHostWatchdog();
  markHostAlive();
  hostWatchdogTimer = setInterval(() => {
    if (!inLobby || net.isHost || !lastHostMessageAt) return;
    if (Date.now() - lastHostMessageAt >= HOST_WATCHDOG_MS) beginHostHandoff("Host timed out. Rejoining...");
  }, 5000);
}

function stopHostWatchdog() {
  clearInterval(hostWatchdogTimer);
  hostWatchdogTimer = null;
  lastHostMessageAt = 0;
}

function beginHostHandoff(message) {
  if (handoffInProgress || !inLobby) return;
  handoffInProgress = true;
  clearClientWelcomeTimer();
  setStatus(message);
  migratingFromHostId = net.isHost ? MY_ID : lastHostOrder[0] || null;
  pendingGameState = snapshotGame() || loadCachedGameState();
  let remainingOrder = migratingFromHostId ? lastHostOrder.filter((id) => id !== migratingFromHostId) : [MY_ID];
  if (preferredNextHostId && remainingOrder.includes(preferredNextHostId)) {
    remainingOrder = [preferredNextHostId, ...remainingOrder.filter((id) => id !== preferredNextHostId)];
  }
  const myIndex = remainingOrder.indexOf(MY_ID);
  const preferHost = myIndex === 0;
  const delay = myIndex < 0 ? 300 : myIndex * 700;
  stopHostLoop();
  stopHostThrottleMonitor();
  stopHostWatchdog();
  clearHandoffTimer();
  const state = snapshotGame();
  if (state) {
    pendingGameState = state;
    saveCachedGameState(state);
    broadcastGameState(state);
  }
  if (net.isHost) net.broadcast({ t: "host-relinquish", fromId: MY_ID, state: pendingGameState, hostOrder: remainingOrder });
  handoffTimer = setTimeout(() => net.migrate(sessionChannel, preferHost), delay);
}

function startClientWelcomeTimer() {
  clearClientWelcomeTimer();
  clientWelcomeTimer = setTimeout(() => {
    if (net.isHost || handoffInProgress || lastState.some((player) => player.id === MY_ID)) return;
    beginHostHandoff("Host did not answer. Rejoining...");
  }, CLIENT_WELCOME_TIMEOUT_MS);
}

function queueStateForPeer(peerId) {
  let attempts = 0;
  const send = () => {
    const state = snapshotGame();
    if (state) broadcastGameState(state, peerId);
    else if (attempts++ < 10) setTimeout(send, 250);
  };
  setTimeout(send, 0);
}

function wireNetEvents() {
  net.on("ready", () => {
    if (soloMode) return;
    inLobby = true;
    handoffInProgress = false;
    clearHandoffTimer();
    clearClientWelcomeTimer();
    stopHostWatchdog();
    setHostReachability(hostReachability === "confirmed" ? "confirmed" : "unconfirmed");
    players.clear();
    peerMap.clear();
    usedColors.clear();
    if (lastState.length) {
      for (const player of lastState) {
        if (player.id === migratingFromHostId) continue;
        players.set(player.id, player);
        usedColors.add(player.color);
        profiles.set(player.id, { name: player.name, color: player.color, icon: player.icon });
      }
    }
    addPlayer(MY_ID, profile.name, null, profile.icon, profile.color);
    voice.states = new Map([[MY_ID, { muted: voice.muted }]]);
    migratingFromHostId = null;
    preferredNextHostId = null;
    lastState = [...players.values()];
    lastHostOrder = [...players.keys()];
    startHostLoop();
    startHostThrottleMonitor();
    ensureGameStarted(pendingGameState || loadCachedGameState());
    renderPlayers();
    show("play");
    updateInvitePanel();
    updateLobbyControls();
    restoreVoiceAfterReconnect();
    if (showInviteAfterReady) {
      showInviteAfterReady = false;
      openProfileSheet();
    }
    broadcastPresence(true);
  });

  net.on("connected", () => {
    if (soloMode) return;
    inLobby = true;
    handoffInProgress = false;
    clearHandoffTimer();
    clearClientWelcomeTimer();
    setStatus(`Joining ${currentMode().name}...`);
    net.send({ t: "hello", id: MY_ID, name: profile.name, icon: profile.icon, preferredColor: profile.color });
    startHostWatchdog();
    startClientWelcomeTimer();
    updateInvitePanel();
    updateLobbyControls();
    restoreVoiceAfterReconnect();
    broadcastPresence(true);
  });

  net.on("lobby-probe", ({ reply, close }) => {
    reply(lobbyInfoPayload());
    setTimeout(close, 60);
  });

  net.on("peer-join", () => renderPlayers());

  net.on("peer-leave", (peerId) => {
    const id = peerMap.get(peerId);
    const player = id && players.get(id);
    if (player) usedColors.delete(player.color);
    if (id) players.delete(id);
    peerMap.delete(peerId);
    if (id) voice.states.delete(id);
    if (id && voice.roster.has(id)) {
      voice.roster.delete(id);
      dropVoicePeer(id);
    }
    syncHostVoiceControl();
    broadcastVoiceRoster();
    activeGame?.onPlayerList?.();
    const state = snapshotGame();
    if (state) {
      saveCachedGameState(state);
      broadcastGameState(state);
    }
    broadcastPlayers(true);
    renderPlayers();
  });

  net.on("host-closed", () => {
    if (soloMode) return;
    beginHostHandoff("Host left. Rejoining...");
  });

  net.on("message", ({ from, data }) => {
    if (from === "host") markHostAlive();
    if (net.isHost) handleHostMessage(from, data);
    else handleClientMessage(data);
  });

  net.on("media-call", (call) => answerVoiceCall(call));

  net.on("media-close", (peerId) => {
    const appId = appIdForPeerId(peerId);
    if (appId) dropVoicePeer(appId);
  });

  net.on("error", (err) => {
    console.error(err);
    if (soloMode) return;
    if (!inLobby || handoffInProgress) return;
    setStatus("Connection issue. Retrying...");
    beginHostHandoff("Connection issue. Rejoining...");
  });
}

function handleHostMessage(peerId, msg) {
  if (msg.t === "hello") {
    const player = addPlayer(msg.id, msg.name, peerId, msg.icon, msg.preferredColor);
    setHostReachability("confirmed");
    net.sendTo(peerId, { t: "welcome", color: player.color });
    net.sendTo(peerId, { t: "players", players: [...players.values()], hostOrder: [...players.keys()] });
    voice.states.set(player.id, { muted: true });
    net.sendTo(peerId, { t: "voice-control", active: voice.channelActive });
    if (chatHistory.length) net.sendTo(peerId, { t: "chat-history", messages: chatHistory });
    queueStateForPeer(peerId);
    activeGame?.onPlayerList?.();
    broadcastPlayers(true);
    renderPlayers();
  } else if (msg.t === "chat") {
    const id = peerMap.get(peerId);
    if (!id || !msg.message || msg.message.fromId !== id) return;
    hostStampAndRelayChat(msg.message);
  } else if (msg.t === "voice-state") {
    const id = peerMap.get(peerId);
    if (!id) return;
    voice.states.set(id, { muted: msg.muted !== false });
    if (msg.entry && msg.entry.id === id) voice.roster.set(id, { ...msg.entry, peerId });
    else voice.roster.delete(id);
    syncHostVoiceControl();
    broadcastVoiceRoster();
  } else if (msg.t === "game-input") {
    const id = peerMap.get(peerId);
    if (id) handleGameInput(id, msg.input);
  } else if (msg.t === "game-event") {
    const id = peerMap.get(peerId);
    if (!id) return;
    activeGame?.onPeerEvent?.(id, msg.event);
    net.broadcast({ t: "game-event", id, event: msg.event });
  } else if (msg.t === "profile") {
    const id = peerMap.get(peerId);
    const player = id && players.get(id);
    if (!player) return;
    usedColors.delete(player.color);
    player.name = msg.name || player.name;
    player.icon = msg.icon || player.icon;
    if (msg.preferredColor && !usedColors.has(msg.preferredColor)) player.color = msg.preferredColor;
    usedColors.add(player.color);
    profiles.set(id, { name: player.name, color: player.color, icon: player.icon });
    net.sendTo(peerId, { t: "profile", id, name: player.name, color: player.color, icon: player.icon });
    net.broadcast({ t: "profile", id, name: player.name, color: player.color, icon: player.icon });
    broadcastPlayers(true);
    activeGame?.onPlayerList?.();
    renderPlayers();
  } else if (msg.t === "reset-game") {
    clearCachedGameState();
    activeGame?.restart?.();
    const state = snapshotGame();
    saveCachedGameState(state);
    broadcastGameState(state);
  } else if (msg.t === "host-request") {
    const requester = peerMap.get(peerId);
    if (!requester) return;
    const state = snapshotGame();
    if (state) broadcastGameState(state);
    preferredNextHostId = requester;
    lastHostOrder = [MY_ID, requester, ...lastHostOrder.filter((id) => id !== MY_ID && id !== requester)];
    net.broadcast({ t: "players", players: [...players.values()], hostOrder: lastHostOrder });
    beginHostHandoff(`${msg.name || "A player"} requested host. Rejoining...`);
  }
}

function handleClientMessage(msg) {
  if (msg.t === "welcome") {
    myColor = msg.color;
    profile.color = msg.color;
    profiles.set(MY_ID, { ...profiles.get(MY_ID), color: myColor });
    updateProfilePreview();
  } else if (msg.t === "players") {
    lastState = msg.players || [];
    lastHostOrder = msg.hostOrder || [];
    for (const player of lastState) profiles.set(player.id, { name: player.name, color: player.color, icon: player.icon });
    if (lastState.some((player) => player.id === MY_ID)) {
      clearClientWelcomeTimer();
      setStatus(`Joined ${currentMode().name}`);
      ensureGameStarted(loadCachedGameState());
      show("play");
      updateLobbyControls();
      announceVoiceState();
    }
    renderPlayers();
  } else if (msg.t === "profile") {
    profiles.set(msg.id, { name: msg.name, color: msg.color, icon: msg.icon });
    if (msg.id === MY_ID) {
      myColor = msg.color;
      profile.color = msg.color;
      localStorage.setItem("simplerain-color", msg.color);
      updateProfilePreview();
      const color = $("#input-color");
      if (color) color.value = msg.color;
    }
    const player = lastState.find((p) => p.id === msg.id);
    if (player) {
      player.name = msg.name;
      player.color = msg.color;
      player.icon = msg.icon;
    }
    renderPlayers();
  } else if (msg.t === "game-state") {
    handleGameState(msg.state);
  } else if (msg.t === "game-event") {
    if (msg.id && msg.id !== MY_ID) activeGame?.onPeerEvent?.(msg.id, msg.event);
  } else if (msg.t === "chat") {
    if (msg.message) acceptChatMessage(msg.message);
  } else if (msg.t === "chat-history") {
    for (const message of msg.messages || []) acceptChatMessage(message, { toast: false });
    if (chatDrawerOpen()) renderChatLog();
  } else if (msg.t === "voice-roster") {
    applyVoiceRoster(msg.entries);
  } else if (msg.t === "voice-control") {
    applyVoiceControl(msg.active);
  } else if (msg.t === "host-exiting") {
    beginHostHandoff("Host left. Rejoining...");
  } else if (msg.t === "host-relinquish") {
    if (msg.state) handleGameState(msg.state);
    if (msg.hostOrder) lastHostOrder = msg.hostOrder;
    beginHostHandoff("Host is transferring. Rejoining...");
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) worker.postMessage({ type: "SKIP_WAITING" });
      });
    });
  } catch (error) {
    console.warn("Service worker unavailable", error);
  }
}

navigator.serviceWorker?.addEventListener("controllerchange", () => location.reload());

function destroyPeerForPageExit(reason) {
  if (!net.isHost) return;
  try {
    const state = snapshotGame();
    if (state) saveCachedGameState(state);
    net.broadcast({ t: "host-exiting", reason });
  } catch {}
  try { net.destroy(); } catch {}
}

function wirePageLifecycle() {
  window.addEventListener("pagehide", () => destroyPeerForPageExit("pagehide"), { capture: true });
  window.addEventListener("beforeunload", () => destroyPeerForPageExit("beforeunload"), { capture: true });
  document.addEventListener("freeze", () => destroyPeerForPageExit("freeze"));
  wireVoiceVisibility();
  document.addEventListener("visibilitychange", () => {
    if (!net.isHost) return;
    if (document.hidden) {
      broadcastPlayers(true);
      const state = snapshotGame();
      if (state) {
        saveCachedGameState(state);
        broadcastGameState(state);
      }
      return;
    }
    setStatus(`Hosting ${currentMode().name}`);
    lastPlayersBroadcastAt = 0;
    broadcastPlayers(true);
  });
}

function syncCanvasSize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return rect;
}

function drawLoadingFrame() {
  if (activeGame) return;
  const rect = syncCanvasSize();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const grad = ctx.createLinearGradient(0, 0, 0, rect.height);
  grad.addColorStop(0, "#10283a");
  grad.addColorStop(0.45, "#173d4d");
  grad.addColorStop(1, "#0d202d");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#eaf6ff";
  ctx.font = "700 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(statusText, rect.width / 2, rect.height / 2);
}

function render() {
  drawLoadingFrame();
  requestAnimationFrame(render);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

$("#btn-profile")?.addEventListener("click", openProfileSheet);
$("#btn-home-profile")?.addEventListener("click", openProfileSheet);
$("#btn-close-profile")?.addEventListener("click", closeProfileSheet);
$("#input-name")?.addEventListener("input", (event) => {
  profile.name = event.target.value.trim() || DEFAULT_NAME;
  localStorage.setItem("simplerain-name", profile.name);
  profiles.set(MY_ID, { ...profiles.get(MY_ID), name: profile.name });
  updateProfilePreview();
  clearTimeout(nameTimer);
  nameTimer = setTimeout(broadcastProfile, 350);
});
$("#input-color")?.addEventListener("input", (event) => {
  applyProfileColor(event.target.value || COLORS[0]);
});
$("#input-icon")?.addEventListener("input", (event) => {
  const emoji = firstEmoji(event.target.value);
  if (!emoji) {
    event.target.value = "";
    return;
  }
  event.target.value = emoji;
  applyProfileIcon(emoji);
});
$("#input-home-lobby-code")?.addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
});
$("#input-welcome-name")?.addEventListener("input", (event) => {
  profile.name = event.target.value.trim() || DEFAULT_NAME;
  profiles.set(MY_ID, { ...profiles.get(MY_ID), name: profile.name });
  updateProfilePreview();
});
$("#input-welcome-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") completeWelcome(false);
});
$("#btn-welcome-solo")?.addEventListener("click", () => completeWelcome(true));
$("#btn-welcome-browse")?.addEventListener("click", () => completeWelcome(false));
document.addEventListener("click", (event) => {
  const picker = $("#music-picker");
  if (!picker?.classList.contains("open") || picker.contains(event.target)) return;
  picker.classList.remove("open");
  $("#btn-music-picker")?.setAttribute("aria-expanded", "false");
});
function seedRainLayer() {
  const layer = $("#rain-layer");
  if (!layer || layer.childElementCount) return;
  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (prefersReduced) return;
  const count = 44;
  for (let i = 0; i < count; i++) {
    const drop = document.createElement("i");
    const dur = 2.6 + Math.random() * 3.4;
    drop.style.left = `${Math.random() * 104 - 2}%`;
    drop.style.animationDuration = `${dur.toFixed(2)}s`;
    drop.style.animationDelay = `${(-Math.random() * dur).toFixed(2)}s`;
    drop.style.opacity = (0.25 + Math.random() * 0.55).toFixed(2);
    drop.style.height = `${(7 + Math.random() * 9).toFixed(1)}vh`;
    layer.appendChild(drop);
  }
}

$("#menu-version").textContent = `Version ${APP_VERSION}`;
seedRainLayer();
updateProfilePreview();
updateMusicButton();
initializeHomeInviteCode();
updateLobbyUrl();
updateInvitePanel();
updateLobbyControls();
updateContinueButton();
wireManageControls();
wireModeToggle();
renderModeToggle();
renderHomeModeText();

wireNetEvents();
wirePresenceEvents();
wirePageLifecycle();
registerServiceWorker();
renderPresence();
renderModeLobbies();
enterHomeScreen(true);
maybeShowWelcomeModal();
presenceNet.migrate(PRESENCE_CHANNEL, false);
render();
