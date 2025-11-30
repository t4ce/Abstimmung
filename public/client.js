const CHART_COLORS = ["#1d4ed8", "#f97316", "#10b981", "#a855f7", "#0ea5e9", "#6366f1", "#ef4444"];
const NAME_STORAGE_KEY = "abstimmungName";
const ADMIN_TOKEN_STORAGE_KEY = "abstimmungAdminToken";
const ADMIN_PASSWORD = "abc";

const SUPPORTED_CHART_TYPES = ["pie", "doughnut", "bar", "radar"];

const nameForm = document.getElementById("name-form");
const nameInput = document.getElementById("name-input");
const nameDisplay = document.getElementById("name-display");
const questionLineEl = document.getElementById("question-line");
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
const closingHint = document.getElementById("closing-hint");
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
let pollTimer = null;
let pollInFlight = false;
const localSelections = new Map();
const POLL_INTERVAL_MS = 500;
let lastStateSignature = "";
let closingHintTimer = null;
let closingHintTopicId = null;
let closingHintDeadline = 0;
const CLOSING_HINT_DURATION_MS = 5000;

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
    postJson(
      "/api/admin/topic",
      { topicId: topicSelect.value || null },
      { requireAdmin: true, refreshOnSuccess: true }
    );
  });

  visibilitySelect.addEventListener("change", () => {
    postJson(
      "/api/admin/visibility",
      { mode: visibilitySelect.value },
      { requireAdmin: true, refreshOnSuccess: true }
    );
  });

  startBtn.addEventListener("click", () =>
    postJson("/api/admin/start", null, { requireAdmin: true, refreshOnSuccess: true })
  );
  stopBtn.addEventListener("click", () =>
    postJson("/api/admin/stop", null, { requireAdmin: true, refreshOnSuccess: true })
  );
  resetBtn.addEventListener("click", () =>
    postJson("/api/admin/reset", null, { requireAdmin: true, refreshOnSuccess: true })
  );

  initializeName();
  initializeAdminState();
  fetchState();
  connectSocket();
  startStatePolling();
  updateViewMode();
}

function setNameCancelEnabled(enabled) {
  nameCancelBtn.disabled = !enabled;
  nameCancelBtn.classList.toggle("hidden", !enabled);
}

function handleAdminUnauthorized(message) {
  adminUnlocked = false;
  adminToken = null;
  clearStoredAdminToken();
  adminControls.classList.add("hidden");
  adminLocked.classList.remove("hidden");
  adminPassHint.textContent = message || "Session abgelaufen. Bitte erneut anmelden.";
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

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

function startStatePolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(pollState, POLL_INTERVAL_MS);
}

async function pollState() {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    updateState(payload);
  } catch (error) {
    // silently ignore; WebSocket should recover as well
  } finally {
    pollInFlight = false;
  }
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
  const signature = computeStateSignature(payload);
  if (signature === lastStateSignature) {
    currentState = payload;
    return;
  }
  lastStateSignature = signature;
  currentState = payload;
  pruneLocalSelections(payload);
  renderAdminControls();
  renderVoteSection();
}

function pruneLocalSelections(state) {
  if (!state) {
    return;
  }
  state.topics.forEach((topic) => {
    if (topic.status === "idle" || topic.status === "disabled") {
      localSelections.delete(topic.id);
    }
  });
}

function computeStateSignature(state) {
  if (!state) {
    return "";
  }
  const simplified = {
    activeTopicId: state.activeTopicId,
    topics: state.topics.map((topic) => ({
      id: topic.id,
      status: topic.status,
      visibility: topic.visibility,
      closingEndsAt: topic.closingEndsAt,
      chartType: topic.chartType,
      question: topic.question,
      options: topic.options.map((option) => ({
        id: option.id,
        label: option.label,
        total: topic.totals?.[option.id] || 0,
        names: (topic.names?.[option.id] || []).slice()
      }))
    }))
  };
  return JSON.stringify(simplified);
}

function renderVoteSection() {
  if (!currentState || !currentState.activeTopicId) {
    questionLineEl.textContent = "Noch keine Abstimmung ausgewaehlt.";
    optionsForm.innerHTML = "";
    voteNotice.textContent = "Warten auf Start durch die Moderation.";
    updateStatusPill("", "status-idle");
    stopClosingHint();
    destroyChart();
    return;
  }

  const topic = currentState.topics.find((entry) => entry.id === currentState.activeTopicId);
  if (!topic) {
    questionLineEl.textContent = "Thema nicht gefunden.";
    clearNamesLegend();
    return;
  }

  questionLineEl.textContent = topic.question;
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

  syncLocalSelection(topic);

  const canVote = Boolean(voterName) && ["open", "closing"].includes(topic.status);
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
    stopClosingHint();
    return;
  }
  if (!voterName) {
    voteNotice.textContent = 'Bitte zuerst unten rechts auf "Name aendern" klicken.';
    stopClosingHint();
    return;
  }
  if (topic.status === "idle") {
    voteNotice.textContent = "Warten auf Start durch die Moderation.";
    stopClosingHint();
    return;
  }
  if (topic.status === "closing") {
    voteNotice.textContent = "Abstimmung endet gleich. Du kannst bis zum Ablauf noch wechseln.";
    startClosingHint(topic.id);
    return;
  }
  if (topic.status === "closed") {
    voteNotice.textContent = "Abstimmung wurde beendet. Ergebnis bleibt sichtbar.";
    stopClosingHint();
    return;
  }
  voteNotice.textContent = "Du kannst jederzeit eine andere Option waehlen.";
  stopClosingHint();
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
  adminPanel.classList.toggle("hidden", !adminView);
  viewToggleBtn.setAttribute(
    "aria-label",
    adminView ? "Adminbereich ausblenden" : "Adminbereich anzeigen"
  );
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
    storeAdminToken(adminToken);
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

async function postJson(url, body, { requireAdmin = false, refreshOnSuccess = false } = {}) {
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
      return;
    }
    if (refreshOnSuccess) {
      fetchState();
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
  const colors = labels.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]);
  const chartType = resolveChartType(topic.chartType);
  const isCompact = window.matchMedia("(max-width: 640px)").matches;
  const legendPosition = isCompact ? "bottom" : "right";
  const legendBoxSize = isCompact ? 12 : 16;
  const legendFontSize = isCompact ? 11 : 13;
  const layoutPadding = isCompact ? 8 : 16;
  const optionsConfig = buildChartOptions(chartType, {
    legendPosition,
    legendBoxSize,
    legendFontSize,
    layoutPadding
  });
  const datasetConfig = buildDatasetConfig(chartType, data, colors);

  const requiresRebuild =
    !chartInstance ||
    chartInstance.config.type !== chartType ||
    chartInstance.data.labels.length !== labels.length ||
    chartInstance.data.labels.some((label, index) => label !== labels[index]);

  if (requiresRebuild) {
    destroyChart();
    chartInstance = new Chart(chartCanvas, {
      type: chartType,
      data: {
        labels,
        datasets: [datasetConfig]
      },
      options: optionsConfig
    });
    return;
  }

  chartInstance.data.labels = labels;
  const dataset = chartInstance.data.datasets[0];
  Object.assign(dataset, datasetConfig, { data });
  chartInstance.options = optionsConfig;
  chartInstance.update();
}

function resolveChartType(requestedType) {
  return SUPPORTED_CHART_TYPES.includes(requestedType) ? requestedType : "pie";
}

function buildChartOptions(chartType, { legendPosition, legendBoxSize, legendFontSize, layoutPadding }) {
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    layout: { padding: layoutPadding },
    plugins: {
      legend: {
        position: chartType === "radar" ? "bottom" : legendPosition,
        align: "center",
        labels: {
          boxWidth: legendBoxSize,
          boxHeight: legendBoxSize,
          color: "#0f172a",
          font: { size: legendFontSize }
        }
      }
    }
  };

  if (chartType === "bar") {
    options.scales = {
      y: { beginAtZero: true, ticks: { precision: 0, stepSize: 1 } }
    };
  } else if (chartType === "radar") {
    options.scales = {
      r: {
        beginAtZero: true,
        ticks: { precision: 0, stepSize: 1 },
        grid: { color: "#e2e8f0" },
        angleLines: { color: "#e2e8f0" }
      }
    };
  } else {
    options.scales = {};
  }

  if (chartType === "doughnut") {
    options.cutout = "55%";
  }

  return options;
}

function buildDatasetConfig(chartType, data, colors) {
  if (chartType === "radar") {
    const borderColor = colors[0] || CHART_COLORS[0];
    return {
      label: "Stimmen",
      data,
      backgroundColor: hexToRgba(borderColor, 0.15),
      borderColor,
      pointBackgroundColor: colors,
      pointBorderColor: "#ffffff",
      borderWidth: 2,
      fill: true
    };
  }

  const config = {
    label: "Stimmen",
    data,
    backgroundColor: colors,
    borderWidth: 1
  };

  if (chartType === "bar") {
    config.borderRadius = 6;
  }

  return config;
}

function hexToRgba(hex, alpha) {
  if (typeof hex !== "string") {
    return `rgba(29, 78, 216, ${alpha})`;
  }
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    return `rgba(29, 78, 216, ${alpha})`;
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

function initializeAdminState() {
  const storedToken = readStoredAdminToken();
  if (!storedToken) {
    return;
  }
  adminToken = storedToken;
  adminUnlocked = true;
  adminLocked.classList.add("hidden");
  adminControls.classList.remove("hidden");
}

function readStoredAdminToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch (error) {
    return null;
  }
}

function storeAdminToken(token) {
  try {
    if (token) {
      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch (error) {
    // Storage ggf. deaktiviert
  }
}

function clearStoredAdminToken() {
  storeAdminToken(null);
}

function syncLocalSelection(topic) {
  const currentSelection = localSelections.get(topic.id);
  if (currentSelection === undefined) {
    return;
  }
  const optionStillExists = topic.options.some((option) => option.id === currentSelection);
  const shouldClear = !optionStillExists || ["idle", "disabled"].includes(topic.status);
  if (shouldClear) {
    localSelections.delete(topic.id);
  }
}

function startClosingHint(topicId) {
  if (closingHintTimer && closingHintTopicId === topicId) {
    return;
  }
  stopClosingHint();
  closingHintTopicId = topicId;
  closingHintDeadline = Date.now() + CLOSING_HINT_DURATION_MS;
  updateClosingHintMessage();
  closingHintTimer = setInterval(updateClosingHintMessage, 250);
}

function updateClosingHintMessage() {
  const remainingMs = Math.max(0, closingHintDeadline - Date.now());
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (closingHint) {
    closingHint.textContent = `Noch ${remainingSeconds}s`;
    closingHint.classList.remove("hidden");
  }
  if (remainingMs <= 0) {
    stopClosingHint();
  }
}

function stopClosingHint() {
  if (closingHintTimer) {
    clearInterval(closingHintTimer);
    closingHintTimer = null;
  }
  closingHintTopicId = null;
  closingHintDeadline = 0;
  if (closingHint) {
    closingHint.classList.add("hidden");
    closingHint.textContent = "";
  }
}

init();
