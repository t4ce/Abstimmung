const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");

const HTTP_PORT = Number(process.env.HTTP_PORT) || 3002;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "abc";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
 
const topics = [
	{
		id: "vote1",
		title: "Snacks to go",
		question: "Lieblings Süßigkeit?",
		chartType: "pie",
		implemented: true,
		options: [
			{ id: "cake", label: "Kuchen" },
			{ id: "ice", label: "Eiscreme" },
			{ id: "donut", label: "Donut mit Perlen" }
		]
	},		
	{
		id: "vote2",
		title: "Mehr direkte Demokratie",
		question: "Mehr direkte Abstimmungen?",
		chartType: "bar",
		implemented: true,
		options: [
			{ id: "yes", label: "Ja" },
			{ id: "no", label: "Nein" }
		]
	},
	{
		id: "vote3",
		title: "Zukunftsparteien",
		question: "Welche Zukunftspartei klingt am besten?",
		chartType: "pie",
		implemented: true,
		options: [
			{ id: "neon", label: "Neon Kollektiv" },
			{ id: "orbit", label: "Orbit Allianz" },
			{ id: "flux", label: "Flux Bewegung" },
			{ id: "pulse", label: "Puls Forum" }
		]
	},
	{
		id: "vote4",
		title: "Ethereum Acronym",
		question: "Wofuer steht Ethereum eurer Meinung nach?",
		chartType: "pie",
		implemented: true,
		options: [
			{ id: "money", label: "Digitales Geld/Waehrung" },
			{ id: "security", label: "Sicherheitsschicht" },
			{ id: "protocol", label: "Protokoll + Zustandsmaschine" },
			{ id: "algorithm", label: "Algorithmus/Berechnung im Netz" },
			{ id: "vm", label: "Virtueller Computer" }
		]
	},
	{
		id: "vote5",
		title: "Oekobilanz Blockchain",
		question: "Wie bewertet ihr die Oekobilanz von Blockchain?",
		chartType: "pie",
		implemented: true,
		options: [
			{ id: "regulate", label: "Wir muessen regulieren" },
			{ id: "self", label: "Loest sich durch effizientere Ansaetze" },
			{ id: "compare", label: "Vergleichbar zu Finanzsektor" }
		]
	},
	...Array.from({ length: 7 }).map((_, idx) => ({
		id: `placeholder${idx + 4}`,
		title: `Platzhalter ${idx + 4}`,
		question: "Thema folgt",
		chartType: "pie",
		implemented: false,
		options: []
	}))
];

const topicState = new Map();
const closingTimers = new Map();

topics.forEach((topic) => {
	topicState.set(topic.id, {
		status: topic.implemented ? "idle" : "disabled",
		visibility: "private",
		closingEndsAt: null,
		votes: new Map()
	});
});

let activeTopicId = null;
const adminSessions = new Map();

function createAdminSession() {

	const token = crypto.randomBytes(24).toString("hex");
	const expiresAt = Date.now() + 60 * 60 * 1000;
	adminSessions.set(token, expiresAt);
	return { token, expiresAt };
}

function validateAdminToken(token) {
	if (!token) {
		return false;
	}
	const expiresAt = adminSessions.get(token);
	if (!expiresAt) {
		return false;
	}
	if (expiresAt < Date.now()) {
		adminSessions.delete(token);
		return false;
	}
	return true;
}

function ensureAdmin(req, res) {
	const token = req.get("x-admin-token");
	if (!validateAdminToken(token)) {
		res.status(401).json({ message: "Admin nicht angemeldet" });
		return false;
	}
	return true;
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const sockets = new Set();

wss.on("connection", (socket) => {
	sockets.add(socket);
	socket.send(JSON.stringify({ type: "state", payload: buildStatePayload() }));

	socket.on("close", () => sockets.delete(socket));
	socket.on("error", () => sockets.delete(socket));
});

function sanitizeName(input) {
	return (input || "").trim();
}

function normalizeKey(name) {
	return sanitizeName(name).toLowerCase();
}

function getTopicRecord(topicId) {
	return topicState.get(topicId);
}

function clearClosingTimer(topicId) {
	const timer = closingTimers.get(topicId);
	if (timer) {
		clearTimeout(timer);
		closingTimers.delete(topicId);
	}
	const record = getTopicRecord(topicId);
	if (record) {
		record.closingEndsAt = null;
	}
}

function scheduleClosing(topicId) {
	clearClosingTimer(topicId);
	const record = getTopicRecord(topicId);
	if (!record) {
		return;
	}
	record.closingEndsAt = Date.now() + 5000;
	const timer = setTimeout(() => {
		const currentRecord = getTopicRecord(topicId);
		if (!currentRecord) {
			return;
		}
		currentRecord.status = "closed";
		currentRecord.closingEndsAt = null;
		closingTimers.delete(topicId);
		broadcastState();
	}, 5000);
	closingTimers.set(topicId, timer);
}

function getTopicTotals(topic) {
	if (!topic || !topic.implemented) {
		return {};
	}

	const record = getTopicRecord(topic.id);
	const totals = Object.fromEntries(topic.options.map((opt) => [opt.id, 0]));
	if (!record) {
		return totals;
	}

	record.votes.forEach((vote) => {
		if (vote.optionId in totals) {
			totals[vote.optionId] += 1;
		}
	});

	return totals;
}

function getNamesByOption(topic) {
	const record = getTopicRecord(topic.id);
	if (!record) {
		return {};
	}
	const collection = Object.fromEntries(topic.options.map((opt) => [opt.id, []]));
	record.votes.forEach((vote) => {
		if (collection[vote.optionId]) {
			collection[vote.optionId].push(vote.displayName);
		}
	});
	return collection;
}

function buildStatePayload() {
	return {
		activeTopicId,
		topics: topics.map((topic) => ({
			id: topic.id,
			title: topic.title,
			question: topic.question,
			chartType: topic.chartType,
			implemented: topic.implemented,
			options: topic.options,
			status: topicState.get(topic.id)?.status || "disabled",
			visibility: topicState.get(topic.id)?.visibility || "private",
			closingEndsAt: topicState.get(topic.id)?.closingEndsAt || null,
			totals: getTopicTotals(topic),
			names:
				topicState.get(topic.id)?.visibility === "public" && topic.implemented
					? getNamesByOption(topic)
					: null
		}))
	};
}

function broadcastState() {
	const payload = JSON.stringify({ type: "state", payload: buildStatePayload() });
	sockets.forEach((socket) => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(payload);
		}
	});
}

app.get("/api/state", (_req, res) => {
	res.json(buildStatePayload());
});

app.post("/api/vote", (req, res) => {
	const { topicId, optionId, voterName } = req.body || {};

	if (!activeTopicId || topicId !== activeTopicId) {
		return res.status(400).json({ message: "Keine aktive Abstimmung" });
	}

	if (!optionId) {
		return res.status(400).json({ message: "Auswahl fehlt" });
	}

	const activeTopic = topics.find((topic) => topic.id === topicId);
	const record = getTopicRecord(topicId);

	if (!activeTopic || !activeTopic.implemented || !record || record.status !== "open") {
		return res.status(400).json({ message: "Abstimmung nicht geoeffnet" });
	}

	const cleanName = sanitizeName(voterName);
	if (!cleanName) {
		return res.status(400).json({ message: "Name wird benoetigt" });
	}

	const optionExists = activeTopic.options.some((option) => option.id === optionId);
	if (!optionExists) {
		return res.status(400).json({ message: "Ungueltige Auswahl" });
	}

	record.votes.set(normalizeKey(cleanName), { optionId, displayName: cleanName });

	broadcastState();
	return res.json({ message: "Stimme gespeichert" });
});

app.post("/api/admin/login", (req, res) => {
	const { password } = req.body || {};
	if (!password || password !== ADMIN_PASSWORD) {
		return res.status(401).json({ message: "Falsches Passwort" });
	}
	const session = createAdminSession();
	return res.json(session);
});

app.post("/api/admin/topic", (req, res) => {
	if (!ensureAdmin(req, res)) {
		return;
	}
	const { topicId } = req.body || {};
	const currentRecord = activeTopicId ? getTopicRecord(activeTopicId) : null;
	const voteRunning = currentRecord && ["open", "closing"].includes(currentRecord.status);
	if (voteRunning && topicId !== activeTopicId) {
		return res.status(400).json({ message: "Abstimmung laeuft. Bitte zuerst stoppen." });
	}

	if (!topicId) {
		activeTopicId = null;
		broadcastState();
		return res.json({ message: "Keine aktive Abstimmung" });
	}

	const topic = topics.find((entry) => entry.id === topicId);

	if (!topic) {
		return res.status(404).json({ message: "Abstimmung unbekannt" });
	}

	if (!topic.implemented) {
		return res.status(400).json({ message: "Dieses Thema ist noch nicht aktiv" });
	}

	activeTopicId = topicId;
	broadcastState();
	return res.json({ message: "Aktive Abstimmung gesetzt" });
});

app.post("/api/admin/start", (req, res) => {
	if (!ensureAdmin(req, res)) {
		return;
	}
	if (!activeTopicId) {
		return res.status(400).json({ message: "Kein Thema ausgewaehlt" });
	}

	const record = getTopicRecord(activeTopicId);
	if (!record) {
		return res.status(400).json({ message: "Zustand fehlt" });
	}

	if (record.status === "disabled") {
		return res.status(400).json({ message: "Thema ist nicht aktiv" });
	}

	if (record.status === "closed") {
		return res.status(400).json({ message: "Bitte zuerst zuruecksetzen" });
	}

	if (record.status === "open") {
		return res.status(200).json({ message: "Bereits gestartet" });
	}

	clearClosingTimer(activeTopicId);
	record.status = "open";
	broadcastState();
	return res.json({ message: "Abstimmung gestartet" });
});

app.post("/api/admin/stop", (req, res) => {
	if (!ensureAdmin(req, res)) {
		return;
	}
	if (!activeTopicId) {
		return res.status(400).json({ message: "Kein Thema ausgewaehlt" });
	}

	const record = getTopicRecord(activeTopicId);
	if (!record || record.status !== "open") {
		return res.status(400).json({ message: "Abstimmung laeuft nicht" });
	}

	record.status = "closing";
	scheduleClosing(activeTopicId);
	broadcastState();
	return res.json({ message: "Abstimmung schliesst" });
});

app.post("/api/admin/reset", (req, res) => {
	if (!ensureAdmin(req, res)) {
		return;
	}
	if (!activeTopicId) {
		return res.status(400).json({ message: "Kein Thema ausgewaehlt" });
	}

	const record = getTopicRecord(activeTopicId);
	if (!record) {
		return res.status(400).json({ message: "Zustand fehlt" });
	}

	if (record.status === "disabled") {
		return res.status(400).json({ message: "Thema ist nicht aktiv" });
	}

	record.votes = new Map();
	record.status = "idle";
	record.visibility = "private";
	clearClosingTimer(activeTopicId);
	activeTopicId = null;
	broadcastState();
	return res.json({ message: "Abstimmung zurueckgesetzt" });
}); 

app.post("/api/admin/visibility", (req, res) => {
	if (!ensureAdmin(req, res)) {
		return;
	}
	const { mode } = req.body || {};
	if (!activeTopicId) {
		return res.status(400).json({ message: "Kein Thema ausgewaehlt" });
	}

	if (!["public", "private"].includes(mode)) {
		return res.status(400).json({ message: "Ungueltiger Modus" });
	}

	const record = getTopicRecord(activeTopicId);
	if (!record || record.status === "disabled") {
		return res.status(400).json({ message: "Thema ist nicht aktiv" });
	}

	record.visibility = mode;
	broadcastState();
	return res.json({ message: "Sichtbarkeit aktualisiert" });
});

app.use((req, res) => {
	res.status(404).json({ message: "Route nicht gefunden" });
});

server.listen(HTTP_PORT, () => {
	console.log(`Server hoert auf Port ${HTTP_PORT}`);
});

 