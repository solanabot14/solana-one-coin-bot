const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function parseTargets(value) {
  const targets = String(value || "10,50,100,150").split(",").map(Number)
    .filter(n => Number.isFinite(n) && n > 0).sort((a,b) => a-b);
  return [...new Set(targets.length ? targets : [10,50,100,150])];
}

function getConfig(env = process.env) {
  return {
    slotCount: Math.max(1, Math.min(20, Number.parseInt(env.JAN_MVP_SLOT_COUNT || "5", 10) || 5)),
    startingSlotValue: Math.max(0.01, Number(env.JAN_MVP_SLOT_START || 2) || 2),
    splitThreshold: Math.max(0.01, Number(env.SWARM_SPLIT_THRESHOLD || 10) || 10),
    postSplitTarget: Math.max(0.01, Number(env.SWARM_POST_SPLIT_TARGET || 100) || 100),
    childSlotValue: Math.max(0.01, Number(env.SWARM_CHILD_SLOT_VALUE || 2) || 2),
    targets: parseTargets(env.JAN_MVP_TARGETS)
  };
}

function defaultDataFile(env = process.env) {
  const dir = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "janMvpData.json");
}

function initialState(config = getConfig()) {
  return {
    version: 1,
    mode: "JAN_MVP_LIVE_PAPER",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    targets: [config.splitThreshold, config.postSplitTarget],
    initialCapital: config.slotCount * config.startingSlotValue,
    slots: Array.from({ length: config.slotCount }, (_, i) => ({
      id: i + 1,
      startingValue: config.startingSlotValue,
      cashBalance: config.startingSlotValue,
      position: null,
      milestonesReached: [],
      splitDone: false,
      parentSlotId: null,
      generation: 0,
      completedTrades: 0,
      winners: 0,
      losers: 0
    })),
    executions: []
  };
}

function createJanMvpTrader({ dataFile = defaultDataFile(), io = fs, config = getConfig() } = {}) {
  config = { ...getConfig(), ...config };
  let state = null;

  function validate(data) {
    if (!data || !Array.isArray(data.slots) || !Array.isArray(data.executions) || !Array.isArray(data.targets)) {
      throw new Error("Invalid Jan MVP account.");
    }
    for (const slot of data.slots) {
      if (!Number.isFinite(Number(slot.cashBalance)) || Number(slot.cashBalance) < 0) throw new Error("Invalid Jan MVP slot balance.");
    }
    return data;
  }

  function load() {
    if (state) return state;
    if (io.existsSync(dataFile)) state = validate(JSON.parse(io.readFileSync(dataFile, "utf8")));
    else state = initialState(config);

    state.targets = [config.splitThreshold, config.postSplitTarget];
    if (!Number.isFinite(Number(state.initialCapital)) || Number(state.initialCapital) <= 0) {
      const rootSlots = state.slots.filter(slot => slot.parentSlotId == null);
      state.initialCapital = rootSlots.reduce((sum, slot) => sum + Number(slot.startingValue || 0), 0) ||
        config.slotCount * config.startingSlotValue;
    }
    for (const slot of state.slots) {
      if (typeof slot.splitDone !== "boolean") slot.splitDone = false;
      if (slot.parentSlotId === undefined) slot.parentSlotId = null;
      if (!Number.isFinite(Number(slot.generation))) slot.generation = 0;
    }
    return state;
  }

  function save(next) {
    next.updatedAt = new Date().toISOString();
    io.mkdirSync(path.dirname(dataFile), { recursive: true });
    const temp = dataFile + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      io.writeFileSync(temp, JSON.stringify(next, null, 2), { flag:"wx", flush:true });
      io.renameSync(temp, dataFile);
    } finally {
      if (io.existsSync(temp)) io.unlinkSync(temp);
    }
    state = next;
  }

  function slotById(data, slotId) {
    return data.slots.find(s => s.id === Number(slotId));
  }

  function positionKey(position) {
    return position?.id || null;
  }

  function buy(slotId, coin, options = {}) {
    load();
    const next = structuredClone(state);
    const slot = slotById(next, slotId);
    if (!slot) return { success:false, message:"Slot not found." };
    if (slot.position) return { success:false, message:"Slot already has a position." };
    const price = Number(coin.priceUsd);
    if (!Number.isFinite(price) || price <= 0 || !coin.tokenAddress) return { success:false, message:"Invalid token or price." };
    const amount = Number(slot.cashBalance);
    if (!(amount > 0)) return { success:false, message:"Slot has no cash." };

    const buys5m = Number(coin.buys5m) || 0;
    const sells5m = Number(coin.sells5m) || 0;
    const total = buys5m + sells5m;
    const buyRatio = total ? buys5m / total : 0;

    slot.cashBalance = 0;
    slot.position = {
      id: randomUUID(),
      slotId: slot.id,
      symbol: coin.symbol,
      name: coin.name,
      tokenAddress: coin.tokenAddress,
      pairAddress: coin.pairAddress || null,
      entryPrice: price,
      quantity: amount / price,
      amountInvested: amount,
      originalAmountInvested: amount,
      firstTakeProfitDone: false,
      secondTakeProfitDone: false,
      highestPrice: price,
      entryTime: new Date().toISOString(),
      strategyVersion: "JAN-MVP-V1",
      riskManagementVersion: "V3.4",
      entryScore: Number(coin.score) || 0,
      entrySignal: coin.signal || null,
      entryPriceChange5m: Number(coin.priceChange5m) || 0,
      entryPriceChange1h: Number(coin.priceChange1h) || 0,
      entryPriceChange24h: Number(coin.priceChange24h) || 0,
      entryLiquidityUsd: Number(coin.liquidityUsd) || 0,
      entryVolume5m: Number(coin.volume5m) || 0,
      entryVolume1h: Number(coin.volume1h) || 0,
      entryVolume24h: Number(coin.volume24h) || 0,
      entryDiscoverySources: Array.isArray(coin.discoverySources) ? [...coin.discoverySources] : [],
      entryCurrentActivity: coin.currentActivity ? structuredClone(coin.currentActivity) : null,
      entryPostPump: coin.postPump ? structuredClone(coin.postPump) : null,
      entryPreDiscoveryPump: coin.preDiscoveryPump ? structuredClone(coin.preDiscoveryPump) : null,
      entryMarketDataIntegrity: coin.marketDataIntegrity ? structuredClone(coin.marketDataIntegrity) : null,
      entrySmartMoney: coin.smartMoney ? structuredClone(coin.smartMoney) : null,
      entryBuys5m: buys5m,
      entrySells5m: sells5m,
      entryBuyRatio: buyRatio,
      source: options.source || null,
      sourceOgPositionId: options.sourceOgPositionId || null
    };
    next.executions.push({
      type:"BUY", slotId:slot.id, positionId:slot.position.id, symbol:slot.position.symbol,
      tokenAddress:slot.position.tokenAddress,
      price, amount, time:slot.position.entryTime,
      source: options.source || null,
      sourceOgPositionId: options.sourceOgPositionId || null
    });
    if (next.executions.length > 2000) next.executions = next.executions.slice(-2000);
    save(next);
    return { success:true, trade:structuredClone(slot.position) };
  }

  function updateHigh(slotId, expectedPosition, price) {
    load();
    const slot = slotById(state, slotId);
    if (!slot?.position || positionKey(slot.position) !== expectedPosition || !(Number(price) > 0)) return false;
    if (Number(price) <= Number(slot.position.highestPrice || slot.position.entryPrice)) return true;
    const next = structuredClone(state);
    slotById(next, slotId).position.highestPrice = Number(price);
    save(next);
    return true;
  }

  function sell(slotId, currentPrice, percentToSell = 100, options = {}) {
    load();
    currentPrice = Number(currentPrice);
    percentToSell = Number(percentToSell);
    const currentSlot = slotById(state, slotId);
    const p = currentSlot?.position;
    if (!p) return { success:false, message:"No position in slot." };
    if (options.expectedPosition && positionKey(p) !== options.expectedPosition) return { success:false, message:"Position changed." };
    if (!(currentPrice > 0) || !(percentToSell > 0 && percentToSell <= 100)) return { success:false, message:"Invalid sale." };
    if (options.takeProfit && p[options.takeProfit]) return { success:false, message:"Take profit already done." };

    const next = structuredClone(state);
    const slot = slotById(next, slotId);
    const pos = slot.position;
    const quantitySold = pos.quantity * percentToSell / 100;
    const costBasisSold = pos.amountInvested * percentToSell / 100;
    const saleValue = quantitySold * currentPrice;
    const pnl = saleValue - costBasisSold;

    slot.cashBalance += saleValue;
    pos.quantity -= quantitySold;
    pos.amountInvested -= costBasisSold;
    if (options.takeProfit) pos[options.takeProfit] = true;

    const execution = {
      type:"SELL", slotId:slot.id, positionId:pos.id, symbol:pos.symbol,
      tokenAddress:pos.tokenAddress,
      price:currentPrice, percentSold:percentToSell, saleValue, pnl,
      pnlPercent: costBasisSold > 0 ? pnl / costBasisSold * 100 : 0,
      reason:options.reason || "MANUAL", time:new Date().toISOString()
    };

    let closedTrade = null;
    let newlyReached = [];
    if (percentToSell === 100) {
      const entryAmount = Number(pos.originalAmountInvested || 0);
      const finalCash = slot.cashBalance;
      const returnPercent = entryAmount > 0 ? (finalCash - entryAmount) / entryAmount * 100 : 0;
      const beforeMilestones = new Set(slot.milestonesReached || []);
      newlyReached = next.targets.filter(target => finalCash >= target && !beforeMilestones.has(target));
      slot.milestonesReached = [...beforeMilestones, ...newlyReached].sort((a,b)=>a-b);
      slot.completedTrades++;
      if (returnPercent > 0) slot.winners++;
      else if (returnPercent < 0) slot.losers++;
      closedTrade = {
        slotId: slot.id,
        positionId: pos.id,
        symbol: pos.symbol,
        tokenAddress: pos.tokenAddress,
        entryPrice: pos.entryPrice,
        exitPrice: currentPrice,
        invested: entryAmount,
        endingBalance: finalCash,
        returnPercent,
        reason: execution.reason,
        entryTime: pos.entryTime,
        exitTime: execution.time,
        highestPrice: pos.highestPrice,
        entryVolume5m: pos.entryVolume5m ?? null,
        entryVolume1h: pos.entryVolume1h ?? null,
        entryVolume24h: pos.entryVolume24h ?? null,
        entryDiscoverySources: Array.isArray(pos.entryDiscoverySources) ? [...pos.entryDiscoverySources] : [],
        entryCurrentActivity: pos.entryCurrentActivity ? structuredClone(pos.entryCurrentActivity) : null,
        entryPostPump: pos.entryPostPump ? structuredClone(pos.entryPostPump) : null,
        entryPreDiscoveryPump: pos.entryPreDiscoveryPump ? structuredClone(pos.entryPreDiscoveryPump) : null,
        entryMarketDataIntegrity: pos.entryMarketDataIntegrity ? structuredClone(pos.entryMarketDataIntegrity) : null,
        entrySmartMoney: pos.entrySmartMoney ? structuredClone(pos.entrySmartMoney) : null,
        milestonesReached: [...newlyReached]
      };
      execution.closedTrade = closedTrade;
      slot.position = null;

      if (
        !slot.splitDone &&
        finalCash >= config.splitThreshold &&
        finalCash >= config.childSlotValue * 2
      ) {
        const nextId = () =>
          next.slots.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;

        const childIds = [];
        for (let i = 0; i < 2; i++) {
          const childId = nextId();
          childIds.push(childId);
          next.slots.push({
            id: childId,
            startingValue: config.childSlotValue,
            cashBalance: config.childSlotValue,
            position: null,
            milestonesReached: [],
            splitDone: true,
            parentSlotId: slot.id,
            generation: Number(slot.generation || 0) + 1,
            completedTrades: 0,
            winners: 0,
            losers: 0
          });
        }

        slot.cashBalance -= config.childSlotValue * 2;
        slot.splitDone = true;

        next.executions.push({
          type:"SPLIT",
          slotId:slot.id,
          childSlotIds:childIds,
          amount:config.childSlotValue * 2,
          remainingBalance:slot.cashBalance,
          time:new Date().toISOString()
        });

        closedTrade.split = {
          childSlotIds: childIds,
          childSlotValue: config.childSlotValue,
          remainingBalance: slot.cashBalance
        };
      }
    }

    next.executions.push(execution);
    if (next.executions.length > 2000) next.executions = next.executions.slice(-2000);
    save(next);
    return { success:true, execution:structuredClone(execution), closedTrade, newlyReached };
  }

  function dashboardState() {
    const data = structuredClone(load());
    let totalEquity = 0;
    for (const slot of data.slots) totalEquity += Number(slot.cashBalance || 0) + Number(slot.position?.amountInvested || 0);
    const startingCapital = Number(data.initialCapital) || config.slotCount * config.startingSlotValue;
    return {
      mode:data.mode,
      targets:[config.splitThreshold, config.postSplitTarget],
      slotCount:data.slots.length,
      startingCapital,
      totalCapital:totalEquity,
      totalPnl:totalEquity-startingCapital,
      tradesReplayed:data.slots.reduce((sum,s)=>sum+Number(s.completedTrades||0),0),
      executions:[...data.executions].slice(-100).reverse(),
      slots:data.slots.map(slot => {
        const nextTarget = slot.splitDone ? config.postSplitTarget : config.splitThreshold;
        const previousTarget = slot.splitDone ? config.splitThreshold : 0;
        const balanceForProgress = Number(slot.cashBalance || 0) + Number(slot.position?.amountInvested || 0);
        const base = Math.max(0.01, nextTarget - previousTarget);
        const progress = Math.max(0, Math.min(100, (balanceForProgress - previousTarget) / base * 100));
        return { ...slot, currentTarget:nextTarget, previousTarget, progressPercent:progress };
      }),
      targetProgress:[config.splitThreshold, config.postSplitTarget].map(target => ({
        target,
        reachedBy:data.slots.filter(s => {
          const equity = Number(s.cashBalance || 0) + Number(s.position?.amountInvested || 0);
          return target === config.splitThreshold ? s.splitDone || equity >= target : equity >= target;
        }).length,
        totalSlots:data.slots.length
      }))
    };
  }

  return {
    buy, sell, updateHigh, positionKey,
    getState:()=>structuredClone(load()),
    getDashboardState:dashboardState,
    getDataFile:()=>dataFile
  };
}

module.exports = { createJanMvpTrader, getConfig, defaultDataFile, initialState };
