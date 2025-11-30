const WS_PORT = 30003;
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
    postJson("/api/admin/topic", { topicId: topicSelect.value || null });
  });

  visibilitySelect.addEventListener("change", () => {
    postJson("/api/admin/visibility", { mode: visibilitySelect.value });
  });

  startBtn.addEventListener("click", () => postJson("/api/admin/start"));
  stopBtn.addEventListener("click", () => postJson("/api/admin/stop"));
  resetBtn.addEventListener("click", () => postJson("/api/admin/reset"));

  initializeName();
  fetchState();
  connectSocket();
  updateViewMode();
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
    return;
  }

  questionEl.textContent = topic.question;
  const hasOptions = renderOptions(topic);
  renderNotice(topic, hasOptions);
  updateStatusPill(topic.status, `status-${topic.status}`);
  updateChart(topic);
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
    viewToggleBtn.textContent = "Zurueck zur Abstimmung";
  } else {
    votePanel.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    viewToggleBtn.textContent = "Adminbereich anzeigen";
  }
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
  } else {
    updateNameBadge();
    nameModalOpen.classList.add("hidden");
    openNameModal();
  }
}

function setVoterName(value) {
  voterName = value;
  storeName(voterName);
  updateNameBadge();
  nameModalOpen.classList.remove("hidden");
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

function handleAdminUnlock(event) {
  event.preventDefault();
  if (adminUnlocked) {
    return;
  }
  const value = adminPasswordInput.value.trim();
  if (value === ADMIN_PASSWORD) {
    adminUnlocked = true;
    adminLocked.classList.add("hidden");
    adminControls.classList.remove("hidden");
    adminPassHint.textContent = "";
    adminPasswordInput.value = "";
    adminDetails.open = true;
  } else {
    adminPassHint.textContent = "Falsches Passwort";
    adminPasswordInput.value = "";
    adminPasswordInput.focus();
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

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
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
  const labels = topic.options.map((option) => decorateLabel(option, topic));
  const data = topic.options.map((option) => topic.totals?.[option.id] || 0);
  const palette = [
    "#1d4ed8",
    "#f97316",
    "#10b981",
    "#a855f7",
    "#0ea5e9",
    "#6366f1",
    "#ef4444"
  ];

  destroyChart();
  chartInstance = new Chart(chartCanvas, {
    type: topic.chartType === "bar" ? "bar" : "pie",
    data: {
      labels,
      datasets: [
        {
          label: "Stimmen",
          data,
          backgroundColor: labels.map((_, index) => palette[index % palette.length]),
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

function decorateLabel(option, topic) {
  const names = topic.names?.[option.id] || [];
  if (topic.visibility === "public" && names.length) {
    const labelText = names.join(", ");
    return [option.label, labelText];
  }
  return option.label;
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
