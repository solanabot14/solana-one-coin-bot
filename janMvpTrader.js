const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function getConfig(env = process.env) {
  const genesisCount = Math.max(1, Math.min(100, Number.parseInt(env.SWARM_GENESIS_COUNT || "5", 10) || 5));
  const startingCapital = Math.max(0.01, Number(env.SWARM_STARTING_CAPITAL || "10") || 10);
  return {
    slotCount: genesisCount,
    startingCapital,
    startingSlotValue: startingCapital / genesisCount,
    retentionPercent: 75,
    reinvestPercent: 50,
    pocketPercent: 25,
    reproductionPercent: 25,
    pyramidRows: 5
  };
}

function defaultDataFile(env = process.env) {
  const dir = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || __dirname;
  return path.join(path.resolve(dir), "swarmMethodologyData.json");
}

const PYRAMID_MULTIPLIERS = Object.freeze(
  Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: row + 1 }, (_, i) => i + 1)
      .concat(Array.from({ length: row }, (_, i) => row - i))
  ).flat()
);
const roundCapital = amount => Math.round((Number(amount) + Number.EPSILON) * 1e8) / 1e8;

function initialState(config = getConfig()) {
  const createdAt = new Date().toISOString();
  return {
    version: 2,
    mode: "SWARM_PYRAMID_PAPER",
    methodology: "PASCAL-25-50-25",
    createdAt,
    updatedAt: createdAt,
    genesisCapital: config.startingCapital,
    genesisCount: config.slotCount,
    initialCapital: config.startingCapital,
    realizedProfit: 0,
    pocketedProfit: 0,
    reinvestedProfit: 0,
    reproductionAllocated: 0,
    childrenCreated: 0,
    nextSlotId: config.slotCount + 1,
    slots: Array.from({ length: config.slotCount }, (_, i) => ({
      id: i + 1,
      swarmId: "G" + (i + 1),
      parentId: null,
      genesisId: "G" + (i + 1),
      generation: 0,
      localX: config.startingSlotValue,
      formationRow: null,
      formationPosition: null,
      formationMultiplier: null,
      children: [],
      nextChildIndex: 0,
      reproductionEligible: false,
      startingValue: config.startingSlotValue,
      cashBalance: config.startingSlotValue,
      reproductionBalance: 0,
      reinvestedProfit: 0,
      pocketedProfit: 0,
      realizedProfit: 0,
      position: null,
      completedTrades: 0,
      winners: 0,
      losers: 0
    })),
    executions: [],
    genealogy: []
  };
}

function createJanMvpTrader({ dataFile = defaultDataFile(), io = fs, config = getConfig() } = {}) {
  config = { ...getConfig(), ...config };
  let state = null;

  function validate(data) {
    if (!data || !Array.isArray(data.slots) || !Array.isArray(data.executions) || !Array.isArray(data.genealogy)) {
      throw new Error("Invalid Swarm methodology account.");
    }
    for (const slot of data.slots) {
      for (const key of ["cashBalance", "reproductionBalance", "localX"]) {
        if (!Number.isFinite(Number(slot[key])) || Number(slot[key]) < 0) throw new Error("Invalid Swarm " + key + ".");
      }
    }
    return data;
  }

  function load() {
    if (state) return state;
    if (io.existsSync(dataFile)) state = validate(JSON.parse(io.readFileSync(dataFile, "utf8")));
    else state = initialState(config);

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

  function childMetadata(childIndex) {
    let index = childIndex;
    for (let row = 0; row < 5; row++) {
      const width = row * 2 + 1;
      if (index < width) return { row: row + 1, position: index + 1, multiplier: PYRAMID_MULTIPLIERS[childIndex] };
      index -= width;
    }
    return null;
  }

  function allocateProfit(data, slot, pnl) {
    if (!(pnl > 0)) {
      slot.realizedProfit += pnl;
      data.realizedProfit += pnl;
      return;
    }
    const reinvest = roundCapital(pnl * config.reinvestPercent / 100);
    const pocket = roundCapital(pnl * config.pocketPercent / 100);
    const reproduction = roundCapital(pnl * config.reproductionPercent / 100);
    slot.cashBalance = roundCapital(slot.cashBalance - pocket - reproduction);
    slot.reproductionBalance = roundCapital(slot.reproductionBalance + reproduction);
    slot.reinvestedProfit = roundCapital(slot.reinvestedProfit + reinvest);
    slot.pocketedProfit = roundCapital(slot.pocketedProfit + pocket);
    slot.realizedProfit = roundCapital(slot.realizedProfit + pnl);
    data.realizedProfit = roundCapital(data.realizedProfit + pnl);
    data.reinvestedProfit = roundCapital(data.reinvestedProfit + reinvest);
    data.pocketedProfit = roundCapital(data.pocketedProfit + pocket);
    data.reproductionAllocated = roundCapital(data.reproductionAllocated + reproduction);
  }

  function reproduce(data, parent) {
    const created = [];
    while (parent.nextChildIndex < PYRAMID_MULTIPLIERS.length) {
      const formation = childMetadata(parent.nextChildIndex);
      const childCost = roundCapital(Number(parent.localX) * formation.multiplier);
      const invested = parent.position ? Number(parent.position.amountInvested) : 0;
      const preSpawnCapital = Number(parent.cashBalance) + Number(parent.reproductionBalance) + invested;
      const hasFunding = Number(parent.reproductionBalance) + 1e-9 >= childCost;
      const protectedAfterSpawn = preSpawnCapital - childCost >= preSpawnCapital * config.retentionPercent / 100 - 1e-9;
      parent.reproductionEligible = hasFunding && protectedAfterSpawn;
      parent.nextChild = {
        ...formation,
        cost: childCost,
        reproductionBalance: Number(parent.reproductionBalance),
        parentCapital: preSpawnCapital,
        eligible: parent.reproductionEligible
      };
      if (!parent.reproductionEligible) break;

      const id = Number(data.nextSlotId++);
      const swarmId = parent.swarmId + "." + (parent.nextChildIndex + 1);
      const child = {
        id,
        swarmId,
        parentId: parent.swarmId,
        parentSlotId: parent.id,
        genesisId: parent.genesisId,
        generation: Number(parent.generation) + 1,
        localX: childCost,
        formationRow: formation.row,
        formationPosition: formation.position,
        formationMultiplier: formation.multiplier,
        children: [],
        nextChildIndex: 0,
        reproductionEligible: false,
        startingValue: childCost,
        cashBalance: childCost,
        reproductionBalance: 0,
        reinvestedProfit: 0,
        pocketedProfit: 0,
        realizedProfit: 0,
        position: null,
        completedTrades: 0,
        winners: 0,
        losers: 0
      };
      parent.reproductionBalance = Math.max(0, roundCapital(parent.reproductionBalance - childCost));
      parent.children.push(swarmId);
      parent.nextChildIndex++;
      parent.reproductionEligible = false;
      data.slots.push(child);
      data.childrenCreated++;
      data.genealogy.push({
        type: "CHILD_CREATED",
        parentId: parent.swarmId,
        genesisId: parent.genesisId,
        childId: swarmId,
        slotId: id,
        generation: child.generation,
        localX: child.localX,
        formationRow: formation.row,
        formationPosition: formation.position,
        formationMultiplier: formation.multiplier,
        fundedAmount: childCost,
        parentCapitalBefore: preSpawnCapital,
        parentCapitalAfter: preSpawnCapital - childCost,
        time: new Date().toISOString()
      });
      created.push(child);
    }
    return created;
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
      realizedPnl: 0,
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
      price, amount, amountInvested:amount, entryLiquidityUsd:slot.position.entryLiquidityUsd, time:slot.position.entryTime,
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
    pos.realizedPnl = Number(pos.realizedPnl || 0) + pnl;
    allocateProfit(next, slot, pnl);
    pos.quantity -= quantitySold;
    pos.amountInvested -= costBasisSold;
    if (options.takeProfit) pos[options.takeProfit] = true;

    const execution = {
      type:"SELL", slotId:slot.id, positionId:pos.id, symbol:pos.symbol,
      tokenAddress:pos.tokenAddress,
      price:currentPrice, percentSold:percentToSell, quantitySold, amountInvested:costBasisSold,
      entryLiquidityUsd:pos.entryLiquidityUsd, saleValue, amountReceived:saleValue, pnl,
      pnlPercent: costBasisSold > 0 ? pnl / costBasisSold * 100 : 0,
      profitAllocation: pnl > 0 ? {
        reinvested: pnl * config.reinvestPercent / 100,
        pocketed: pnl * config.pocketPercent / 100,
        reproduction: pnl * config.reproductionPercent / 100
      } : { reinvested: 0, pocketed: 0, reproduction: 0 },
      reason:options.reason || "MANUAL", time:new Date().toISOString()
    };

    let closedTrade = null;
    if (percentToSell === 100) {
      const entryAmount = Number(pos.originalAmountInvested || 0);
      const finalCash = slot.cashBalance + slot.reproductionBalance;
      const returnPercent = entryAmount > 0 ? Number(pos.realizedPnl || 0) / entryAmount * 100 : 0;
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
        realizedPnl: Number(pos.realizedPnl || 0),
        pocketedProfit: Number(slot.pocketedProfit || 0),
        reproductionBalance: Number(slot.reproductionBalance || 0)
      };
      execution.closedTrade = closedTrade;
      slot.position = null;
    }

    const children = reproduce(next, slot);
    if (closedTrade && children.length) closedTrade.childrenCreated = children.map(child => child.swarmId);
    if (children.length) execution.childrenCreated = children.map(child => child.swarmId);
    next.executions.push(execution);
    if (next.executions.length > 2000) next.executions = next.executions.slice(-2000);
    save(next);

    if (closedTrade) {
      const audit = {
        event: "TRADE_AUDIT_CLOSED",
        mode: "SWARM",
        slotId: closedTrade.slotId,
        positionId: closedTrade.positionId,
        symbol: closedTrade.symbol,
        tokenAddress: closedTrade.tokenAddress,
        entryTime: closedTrade.entryTime,
        exitTime: closedTrade.exitTime,
        entryPrice: closedTrade.entryPrice,
        exitPrice: closedTrade.exitPrice,
        highestPrice: closedTrade.highestPrice,
        returnPercent: closedTrade.returnPercent,
        exitReason: closedTrade.reason,
        entryVolume5m: closedTrade.entryVolume5m,
        entryVolume1h: closedTrade.entryVolume1h,
        entryVolume24h: closedTrade.entryVolume24h,
        entryVolumeLiquidity5mPercent: closedTrade.entryCurrentActivity?.volumeLiquidity5mPercent ?? null,
        discoverySources: closedTrade.entryDiscoverySources,
        smartMoney: closedTrade.entrySmartMoney,
        postPump: closedTrade.entryPostPump,
        preDiscoveryPump: closedTrade.entryPreDiscoveryPump,
        marketDataIntegrity: closedTrade.entryMarketDataIntegrity
      };
      console.log("TRADE_AUDIT " + JSON.stringify(audit));
    }

    return { success:true, execution:structuredClone(execution), closedTrade, childrenCreated:children.map(child => child.swarmId) };
  }

  function dashboardState() {
    const data = structuredClone(load());
    const activeCapital = data.slots.reduce((sum, slot) =>
      sum + Number(slot.cashBalance || 0) + Number(slot.reproductionBalance || 0) +
        Number(slot.position?.amountInvested || 0), 0);
    const pocketedProfit = Number(data.pocketedProfit || 0);
    const totalEquity = activeCapital + pocketedProfit;
    const startingCapital = Number(data.genesisCapital || data.initialCapital) || config.startingCapital;
    return {
      mode:data.mode,
      methodology:data.methodology,
      genesisCount:data.genesisCount,
      genesisCapital:data.genesisCapital,
      pyramidMultipliers:[...PYRAMID_MULTIPLIERS],
      reproductionRetentionPercent:config.retentionPercent,
      profitAllocation:{ reinvest:config.reinvestPercent, pocket:config.pocketPercent, reproduction:config.reproductionPercent },
      totalSwarms:data.slots.length,
      childrenCreated:data.childrenCreated,
      slotCount:data.slots.length,
      startingCapital,
      totalCapital:totalEquity,
      activeCapital,
      pocketedProfit,
      reinvestedProfit:Number(data.reinvestedProfit || 0),
      reproductionAllocated:Number(data.reproductionAllocated || 0),
      realizedProfit:Number(data.realizedProfit || 0),
      totalPnl:totalEquity-startingCapital,
      tradesReplayed:data.slots.reduce((sum,s)=>sum+Number(s.completedTrades||0),0),
      genealogy:data.genealogy.slice(-200).reverse(),
      executions:[...data.executions].slice(-100).reverse(),
      slots:data.slots.map(slot => {
        const formation = childMetadata(Number(slot.nextChildIndex || 0));
        const nextChildCost = formation ? Number(slot.localX) * formation.multiplier : 0;
        const capital = Number(slot.cashBalance || 0) + Number(slot.reproductionBalance || 0) +
          Number(slot.position?.amountInvested || 0);
        const eligible = Boolean(formation &&
          Number(slot.reproductionBalance || 0) >= nextChildCost &&
          capital - nextChildCost >= capital * config.retentionPercent / 100);
        return { ...slot, capital, nextChild:formation ? { ...formation, cost:nextChildCost } : null,
          reproductionEligible:eligible, growthStatus:formation ? "GROWING_TOWARD_NEXT_CHILD" : "PYRAMID_COMPLETE" };
      })
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
