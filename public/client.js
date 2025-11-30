const WS_PORT = Number(window.__WS_PORT || 3003);
const CHART_COLORS = ["#1d4ed8", "#f97316", "#10b981", "#a855f7", "#0ea5e9", "#6366f1", "#ef4444"];
const NAME_STORAGE_KEY = "abstimmungName";
const ADMIN_PASSWORD = "abc";

const nameForm = document.getElementById("name-form");
const nameInput = document.getElementById("name-input");
const nameDisplay = document.getElementById("name-display");
const questionEl = document.getElementById("question");
const optionsForm = document.getElementById("options-form");
const voteNotice = document.getElementById("vote-notice");
const statusPill = document.getElementById("status-pill");
const topicSelect = document.getElementById("topic-select");
const visibilitySelect = document.getElementById("visibility-select");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const resetBtn = document.getElementById("reset-btn");
const optionTemplate = document.getElementById("option-template");
const chartCanvas = document.getElementById("results-chart");
const namesLegend = document.getElementById("names-legend");
const viewToggleBtn = document.getElementById("view-toggle-btn");
const votePanel = document.getElementById("vote-panel");
const adminPanel = document.getElementById("admin-panel");
const globalCountdown = document.getElementById("global-countdown");
const closingOverlay = document.getElementById("closing-overlay");
const closingOverlayNumber = document.getElementById("closing-overlay-number");
const nameModal = document.getElementById("name-modal");
const nameModalOpen = document.getElementById("name-modal-open");
const nameCancelBtn = document.getElementById("name-cancel-btn");
const adminDetails = document.getElementById("admin-details");
const adminLocked = document.getElementById("admin-locked");
const adminControls = document.getElementById("admin-controls");
const adminPassForm = document.getElementById("admin-pass-form");
const adminPasswordInput = document.getElementById("admin-password");
const adminPassHint = document.getElementById("admin-pass-hint");

let voterName = "";
let socket;
let reconnectTimer;
let chartInstance;
let currentState;
let adminUnlocked = false;
let adminToken = null;
let adminView = false;
let closingTicker = null;
let closingTopicId = null;
const localSelections = new Map();

function init() {
  nameForm.addEventListener("submit", handleNameSubmit);
  nameModalOpen.addEventListener("click", openNameModal);
  nameCancelBtn.addEventListener("click", handleNameCancel);
  nameModal.addEventListener("click", (event) => {
    if (event.target === nameModal && voterName) {
      closeNameModal();
    }
  });

  adminPassForm.addEventListener("submit", handleAdminUnlock);

  viewToggleBtn.addEventListener("click", () => {
    adminView = !adminView;
    updateViewMode();
  });

  topicSelect.addEventListener("change", () => {
    postJson("/api/admin/topic", { topicId: topicSelect.value || null }, { requireAdmin: true });
  });

  visibilitySelect.addEventListener("change", () => {
    postJson("/api/admin/visibility", { mode: visibilitySelect.value }, { requireAdmin: true });
  });

  startBtn.addEventListener("click", () => postJson("/api/admin/start", null, { requireAdmin: true }));
  stopBtn.addEventListener("click", () => postJson("/api/admin/stop", null, { requireAdmin: true }));
  resetBtn.addEventListener("click", () => postJson("/api/admin/reset", null, { requireAdmin: true }));

  initializeName();
  fetchState();
  connectSocket();
  updateViewMode();
}

function setNameCancelEnabled(enabled) {
  nameCancelBtn.disabled = !enabled;
  nameCancelBtn.classList.toggle("hidden", !enabled);
}

function handleAdminUnauthorized(message) {
  adminUnlocked = false;
  adminToken = null;
  adminControls.classList.add("hidden");
  adminLocked.classList.remove("hidden");
  adminPassHint.textContent = message || "Session abgelaufen. Bitte erneut anmelden.";
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.hostname}:${WS_PORT}`);

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      updateState(msg.payload);
    }
  };

  socket.onclose = scheduleReconnect;
  socket.onerror = () => socket.close();
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(connectSocket, 2000);
}

async function fetchState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) return;
    const payload = await response.json();
    updateState(payload);
  } catch (error) {
    console.error("Konnte Zustand nicht laden", error);
  }
}

function updateState(payload) {
  currentState = payload;
  renderAdminControls();
  renderVoteSection();
}

function renderVoteSection() {
  if (!currentState || !currentState.activeTopicId) {
    questionEl.textContent = "Noch keine Abstimmung ausgewaehlt.";
    optionsForm.innerHTML = "";
    voteNotice.textContent = "Warten auf Start durch die Moderation.";
    updateStatusPill("", "status-idle");
    stopClosingTicker();
    destroyChart();
    return;
  }

  const topic = currentState.topics.find((entry) => entry.id === currentState.activeTopicId);
  if (!topic) {
    questionEl.textContent = "Thema nicht gefunden.";
    clearNamesLegend();
    return;
  }

  questionEl.textContent = topic.question;
  const hasOptions = renderOptions(topic);
  renderNotice(topic, hasOptions);
  updateStatusPill(topic.status, `status-${topic.status}`);
  updateChart(topic);
  renderNamesLegend(topic);
}

function renderOptions(topic) {
  optionsForm.innerHTML = "";
  if (!topic.options.length) {
    return false;
  }

  const canVote = Boolean(voterName) && topic.status === "open";
  topic.options.forEach((option) => {
    const node = optionTemplate.content.cloneNode(true);
    const label = node.querySelector("label");
    const input = node.querySelector("input");
    const span = node.querySelector("span");

    input.value = option.id;
    input.disabled = !canVote;
    input.checked = localSelections.get(topic.id) === option.id;
    span.textContent = option.label;

    input.addEventListener("change", () => {
      localSelections.set(topic.id, option.id);
      submitVote(topic.id, option.id);
    });

    optionsForm.appendChild(label);
  });

  return true;
}

function renderNotice(topic, hasOptions) {
  if (!hasOptions) {
    voteNotice.textContent = "Dieses Thema ist noch in Vorbereitung.";
    stopClosingTicker();
    return;
  }
  if (!voterName) {
    voteNotice.textContent = 'Bitte zuerst unten rechts auf "Name aendern" klicken.';
    stopClosingTicker();
    return;
  }
  if (topic.status === "idle") {
    voteNotice.textContent = "Warten auf Start durch die Moderation.";
    stopClosingTicker();
    return;
  }
  if (topic.status === "closing") {
    showCountdownMessage(topic);
    return;
  }
  if (topic.status === "closed") {
    voteNotice.textContent = "Abstimmung wurde beendet. Ergebnis bleibt sichtbar.";
    stopClosingTicker();
    return;
  }
  voteNotice.textContent = "Du kannst jederzeit eine andere Option waehlen.";
  stopClosingTicker();
}

function updateStatusPill(status, className) {
  statusPill.className = `status-pill ${className}`;
  const mapping = {
    idle: "wartet",
    open: "live",
    closed: "beendet",
    disabled: "inaktiv",
    closing: "endet"
  };
  statusPill.textContent = mapping[status] || "";
}

function renderAdminControls() {
  if (!currentState) {
    return;
  }
  topicSelect.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "Keine Auswahl";
  topicSelect.appendChild(noneOption);

  currentState.topics.forEach((topic) => {
    const option = document.createElement("option");
    option.value = topic.id;
    option.textContent = topic.implemented ? topic.title : `${topic.title} (folgt)`;
    option.disabled = !topic.implemented;
    topicSelect.appendChild(option);
  });

  topicSelect.value = currentState.activeTopicId || "";

  const active = currentState.topics.find((t) => t.id === currentState.activeTopicId);
  const status = active?.status || "disabled";
  const running = ["open", "closing"].includes(status);
  topicSelect.disabled = running;
  startBtn.disabled = !active || status !== "idle";
  stopBtn.disabled = !active || status !== "open";
  resetBtn.disabled = !active || status === "disabled";
  visibilitySelect.value = active?.visibility || "private";
  visibilitySelect.disabled = !active || status === "disabled";
}

function updateViewMode() {
  if (adminView) {
    votePanel.classList.add("hidden");
    adminPanel.classList.remove("hidden");
    viewToggleBtn.setAttribute("aria-label", "Zurueck zur Abstimmung");
  } else {
    votePanel.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    viewToggleBtn.setAttribute("aria-label", "Adminbereich anzeigen");
  }
  viewToggleBtn.textContent = "";
}

function handleNameSubmit(event) {
  event.preventDefault();
  const value = nameInput.value.trim();
  if (!value) {
    return;
  }
  setVoterName(value);
}

function handleNameCancel() {
  if (!voterName) {
    nameInput.focus();
    return;
  }
  nameInput.value = voterName;
  closeNameModal();
}

function openNameModal() {
  nameModal.classList.remove("hidden");
  nameInput.value = voterName || "";
  setTimeout(() => nameInput.focus(), 50);
}

function closeNameModal() {
  nameModal.classList.add("hidden");
}

function initializeName() {
  const stored = readStoredName();
  if (stored) {
    voterName = stored;
    updateNameBadge();
    nameModalOpen.classList.remove("hidden");
    nameInput.value = stored;
    setNameCancelEnabled(true);
  } else {
    updateNameBadge();
    nameModalOpen.classList.add("hidden");
    setNameCancelEnabled(false);
    openNameModal();
  }
}

function setVoterName(value) {
  voterName = value;
  storeName(voterName);
  updateNameBadge();
  nameModalOpen.classList.remove("hidden");
  setNameCancelEnabled(true);
  closeNameModal();
  renderVoteSection();
}

function updateNameBadge() {
  if (voterName) {
    nameDisplay.textContent = `Angemeldet als: ${voterName}`;
  } else {
    nameDisplay.textContent = "Noch kein Name gesetzt.";
  }
}

async function handleAdminUnlock(event) {
  event.preventDefault();
  if (adminUnlocked) {
    return;
  }
  const value = adminPasswordInput.value.trim();
  if (!value) {
    adminPassHint.textContent = "Passwort erforderlich";
    adminPasswordInput.focus();
    return;
  }
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value })
    });
    if (!response.ok) {
      adminPassHint.textContent = "Falsches Passwort";
      adminPasswordInput.value = "";
      adminPasswordInput.focus();
      return;
    }
    const data = await response.json();
    adminToken = data.token;
    adminUnlocked = true;
    adminLocked.classList.add("hidden");
    adminControls.classList.remove("hidden");
    adminPassHint.textContent = "";
    adminPasswordInput.value = "";
    adminDetails.open = true;
  } catch (error) {
    adminPassHint.textContent = "Verbindung fehlgeschlagen";
  }
}

async function submitVote(topicId, optionId) {
  if (!voterName) {
    return;
  }
  try {
    const response = await fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId, optionId, voterName })
    });
    if (!response.ok) {
      const message = await response.json().catch(() => ({ message: "Fehler" }));
      voteNotice.textContent = message.message || "Fehler beim Speichern";
    }
  } catch (error) {
    voteNotice.textContent = "Verbindung nicht verfuegbar.";
  }
}

async function postJson(url, body, { requireAdmin = false } = {}) {
  try {
    if (requireAdmin && !adminToken) {
      handleAdminUnauthorized("Session erforderlich. Bitte erneut anmelden.");
      return;
    }
    const headers = { "Content-Type": "application/json" };
    if (requireAdmin && adminToken) {
      headers["X-Admin-Token"] = adminToken;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {})
    });
    if (response.status === 401) {
      handleAdminUnauthorized("Session abgelaufen. Bitte erneut anmelden.");
      return;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ message: "Fehler" }));
      console.warn(payload.message || "Aktion fehlgeschlagen");
    }
  } catch (error) {
    console.error("Aktion fehlgeschlagen", error);
  }
}

function updateChart(topic) {
  if (!topic || !topic.options.length) {
    destroyChart();
    return;
  }
  const labels = topic.options.map((option) => option.label);
  const data = topic.options.map((option) => topic.totals?.[option.id] || 0);

  destroyChart();
  chartInstance = new Chart(chartCanvas, {
    type: topic.chartType === "bar" ? "bar" : "pie",
    data: {
      labels,
      datasets: [
        {
          label: "Stimmen",
          data,
          backgroundColor: labels.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]),
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales:
        topic.chartType === "bar"
          ? { y: { beginAtZero: true, ticks: { precision: 0, stepSize: 1 } } }
          : {}
    }
  });
}

function destroyChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

function clearNamesLegend() {
  if (namesLegend) {
    namesLegend.innerHTML = "";
    namesLegend.classList.add("hidden");
  }
}

function renderNamesLegend(topic) {
  if (!namesLegend) {
    return;
  }
  const isPublic = topic.visibility === "public";
  const hasNames = topic.options.some((option) => (topic.names?.[option.id] || []).length);
  if (!isPublic || !hasNames) {
    clearNamesLegend();
    return;
  }

  namesLegend.innerHTML = "";
  topic.options.forEach((option, index) => {
    const names = topic.names?.[option.id] || [];
    if (!names.length) {
      return;
    }
    const row = document.createElement("div");
    row.className = "names-legend-row";

    const indicator = document.createElement("span");
    indicator.className = "names-legend-indicator";
    indicator.style.backgroundColor = CHART_COLORS[index % CHART_COLORS.length];

    const textWrapper = document.createElement("div");
    textWrapper.className = "names-legend-text";

    const labelEl = document.createElement("div");
    labelEl.className = "names-legend-label";
    labelEl.textContent = option.label;

    const namesEl = document.createElement("div");
    namesEl.className = "names-legend-names";
    namesEl.textContent = names.join(", ");

    textWrapper.appendChild(labelEl);
    textWrapper.appendChild(namesEl);

    row.appendChild(indicator);
    row.appendChild(textWrapper);
    namesLegend.appendChild(row);
  });

  namesLegend.classList.toggle("hidden", !namesLegend.childElementCount);
}

function showCountdownMessage(topic) {
  const message = 'Abstimmung endet in <span class="countdown-number"></span> Sekunden...';
  voteNotice.innerHTML = message;
  globalCountdown.innerHTML = message;
  globalCountdown.classList.remove("hidden");
  voteNotice.classList.add("countdown-message");
  globalCountdown.classList.add("countdown-message");
  if (closingOverlay) {
    closingOverlay.classList.remove("hidden");
  }
  updateCountdownDisplays(topic);
  startClosingTicker(topic);
}

function getRemainingSeconds(topic) {
  if (!topic.closingEndsAt) {
    return 0;
  }
  const diff = Math.max(0, topic.closingEndsAt - Date.now());
  return Math.ceil(diff / 1000);
}

function updateCountdownDisplays(topic) {
  const seconds = getRemainingSeconds(topic);
  const nodes = [
    voteNotice.querySelector(".countdown-number"),
    globalCountdown.querySelector(".countdown-number"),
    closingOverlayNumber
  ].filter(Boolean);
  nodes.forEach((span) => {
    span.textContent = seconds;
  });
}

function startClosingTicker(topic) {
  if (closingTicker && closingTopicId === topic.id) {
    return;
  }
  stopClosingTicker();
  closingTopicId = topic.id;
  closingTicker = setInterval(() => {
    const updatedTopic = currentState?.topics.find((entry) => entry.id === closingTopicId);
    if (!updatedTopic || updatedTopic.status !== "closing") {
      stopClosingTicker();
      return;
    }
    updateCountdownDisplays(updatedTopic);
  }, 250);
}

function stopClosingTicker() {
  if (closingTicker) {
    clearInterval(closingTicker);
    closingTicker = null;
  }
  closingTopicId = null;
  globalCountdown.classList.add("hidden");
  globalCountdown.textContent = "";
  voteNotice.classList.remove("countdown-message");
  globalCountdown.classList.remove("countdown-message");
  if (closingOverlay) {
    closingOverlay.classList.add("hidden");
  }
  if (closingOverlayNumber) {
    closingOverlayNumber.textContent = "";
  }
}

function readStoredName() {
  try {
    return sessionStorage.getItem(NAME_STORAGE_KEY) || "";
  } catch (error) {
    return "";
  }
}

function storeName(value) {
  try {
    sessionStorage.setItem(NAME_STORAGE_KEY, value);
  } catch (error) {
    // Storage ggf. deaktiviert
  }
}

init();
