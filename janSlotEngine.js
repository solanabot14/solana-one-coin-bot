const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { groupCompletedTrades } = require("./dashboardData");
const { sendTelegramMessage } = require("./telegram");

function parseTargets(value) {
	const parsed = String(value || "10,50,100,150")
		.split(",")
		.map(Number)
		.filter(n => Number.isFinite(n) && n > 0)
		.sort((a, b) => a - b);
	return [...new Set(parsed.length ? parsed : [10, 50, 100, 150])];
}

function getConfig(env = process.env) {
	const slotCount = Math.max(1, Math.min(50, Number.parseInt(env.JAN_SLOT_COUNT || "5", 10) || 5));
	const startingSlotValue = Math.max(0.01, Number(env.JAN_SLOT_START || 2) || 2);
	const targets = parseTargets(env.JAN_SLOT_TARGETS);
	return { slotCount, startingSlotValue, targets };
}

function defaultDataFile(env = process.env) {
	const directory = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
	return path.join(path.resolve(directory), "janSlotData.json");
}

function createInitialState(config = getConfig()) {
	return {
		version: 1,
		mode: "SHADOW_PAPER",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		slotCount: config.slotCount,
		startingSlotValue: config.startingSlotValue,
		targets: [...config.targets],
		nextSlotIndex: 0,
		tradesReplayed: 0,
		processedTradeKeys: [],
		slots: Array.from({ length: config.slotCount }, (_, index) => ({
			id: index + 1,
			startingValue: config.startingSlotValue,
			balance: config.startingSlotValue,
			trades: 0,
			winners: 0,
			losers: 0,
			milestonesReached: [],
			lastSymbol: null,
			lastReturnPercent: null,
			lastTradeAt: null
		}))
	};
}

function tradeKey(trade) {
	return String(
		trade.positionId ||
		[trade.tokenAddress || trade.symbol, trade.entryTime, trade.exitTime].join("|")
	);
}

function currentTarget(slot, targets) {
	return targets.find(target => !slot.milestonesReached.includes(target)) ?? null;
}

function dashboardState(state) {
	const totalCapital = state.slots.reduce((sum, slot) => sum + Number(slot.balance || 0), 0);
	const startingCapital = state.slotCount * state.startingSlotValue;
	return {
		mode: state.mode,
		slotCount: state.slotCount,
		startingSlotValue: state.startingSlotValue,
		startingCapital,
		totalCapital,
		totalPnl: totalCapital - startingCapital,
		totalReturnPercent: startingCapital > 0 ? (totalCapital - startingCapital) / startingCapital * 100 : 0,
		targets: [...state.targets],
		tradesReplayed: state.tradesReplayed,
		slots: state.slots.map(slot => {
			const target = currentTarget(slot, state.targets);
			const previousTarget = [...state.targets].reverse().find(t => slot.milestonesReached.includes(t)) || 0;
			const denominator = target == null ? Math.max(slot.balance, state.targets.at(-1) || 1) : Math.max(0.01, target - previousTarget);
			const numerator = target == null ? denominator : Math.max(0, slot.balance - previousTarget);
			return {
				...slot,
				currentTarget: target,
				previousTarget,
				progressPercent: Math.min(100, numerator / denominator * 100),
				allTargetsComplete: target == null
			};
		}),
		targetProgress: state.targets.map(target => ({
			target,
			reachedBy: state.slots.filter(slot => slot.milestonesReached.includes(target)).length,
			totalSlots: state.slotCount
		}))
	};
}

function createJanSlotEngine({
	dataFile = defaultDataFile(),
	io = fs,
	config = getConfig(),
	notifier = sendTelegramMessage
} = {}) {
	let state = null;
	let existed = io.existsSync(dataFile);

	function validate(candidate) {
		if (!candidate || !Array.isArray(candidate.slots) || !Array.isArray(candidate.processedTradeKeys)) {
			throw new Error("Invalid Jan slot state.");
		}
		return candidate;
	}

	function load() {
		if (state) return state;
		if (existed) {
			state = validate(JSON.parse(io.readFileSync(dataFile, "utf8")));
		} else {
			state = createInitialState(config);
		}
		return state;
	}

	function save(next) {
		next.updatedAt = new Date().toISOString();
		io.mkdirSync(path.dirname(dataFile), { recursive: true });
		const temp = dataFile + "." + process.pid + "." + randomUUID() + ".tmp";
		try {
			io.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: "wx", flush: true });
			io.renameSync(temp, dataFile);
		} finally {
			if (io.existsSync(temp)) io.unlinkSync(temp);
		}
		state = next;
		existed = true;
	}

	async function notifyMilestone(slot, milestone) {
		const next = currentTarget(slot, state.targets);
		const lines = [
			"JAN SLOT SYSTEM | MILESTONE",
			`Slot: ${slot.id}`,
			`Reached: $${milestone.toFixed(2)}`,
			`Current balance: $${slot.balance.toFixed(2)}`,
			next == null ? "Status: Final configured milestone reached" : `Next target: $${next.toFixed(2)}`,
			`Trades in slot: ${slot.trades}`
		];
		return notifier(lines.join("\n"));
	}

	async function applyTrade(trade, { notify = true } = {}) {
		load();
		const key = tradeKey(trade);
		if (state.processedTradeKeys.includes(key)) return false;
		const returnPercent = Number(trade.pnlPercent);
		if (!Number.isFinite(returnPercent)) return false;

		const next = structuredClone(state);
		const slot = next.slots[next.nextSlotIndex % next.slots.length];
		const before = slot.balance;
		slot.balance = Math.max(0, slot.balance * Math.max(0, 1 + returnPercent / 100));
		slot.trades++;
		if (returnPercent > 0) slot.winners++;
		else if (returnPercent < 0) slot.losers++;
		slot.lastSymbol = trade.symbol || "-";
		slot.lastReturnPercent = returnPercent;
		slot.lastTradeAt = trade.exitTime || trade.entryTime || new Date().toISOString();

		const newlyReached = next.targets.filter(target =>
			before < target &&
			slot.balance >= target &&
			!slot.milestonesReached.includes(target)
		);
		slot.milestonesReached.push(...newlyReached);
		slot.milestonesReached.sort((a, b) => a - b);

		next.processedTradeKeys.push(key);
		if (next.processedTradeKeys.length > 10000) {
			next.processedTradeKeys = next.processedTradeKeys.slice(-10000);
		}
		next.nextSlotIndex = (next.nextSlotIndex + 1) % next.slots.length;
		next.tradesReplayed++;
		save(next);

		if (notify) {
			for (const milestone of newlyReached) {
				await notifyMilestone(state.slots.find(s => s.id === slot.id), milestone);
			}
		}
		return true;
	}

	async function syncFromPortfolio(portfolio, { notify = true } = {}) {
		load();
		const completed = groupCompletedTrades(portfolio?.history || [], portfolio?.position || null)
			.sort((a, b) => new Date(a.exitTime || a.entryTime) - new Date(b.exitTime || b.entryTime));
		let applied = 0;
		for (const trade of completed) {
			if (await applyTrade(trade, { notify })) applied++;
		}
		return applied;
	}

	async function initializeFromPortfolio(portfolio) {
		load();
		if (!existed || state.tradesReplayed === 0) {
			await syncFromPortfolio(portfolio, { notify: false });
		}
		return dashboardState(state);
	}

	return {
		initializeFromPortfolio,
		syncFromPortfolio,
		applyCompletedTrade: applyTrade,
		getState: () => structuredClone(load()),
		getDashboardState: () => dashboardState(load()),
		getDataFile: () => dataFile
	};
}

let singleton;
function current() {
	return singleton ||= createJanSlotEngine();
}

module.exports = {
	createJanSlotEngine,
	getConfig,
	defaultDataFile,
	createInitialState,
	dashboardState,
	initializeFromPortfolio: (...args) => current().initializeFromPortfolio(...args),
	syncFromPortfolio: (...args) => current().syncFromPortfolio(...args),
	getState: () => current().getState(),
	getDashboardState: () => current().getDashboardState()
};
