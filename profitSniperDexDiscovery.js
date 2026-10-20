const axios = require("axios");
const crypto = require("node:crypto");
const { analyzePoolCandidate } = require("./poolDiscoveryStrategy");
const CONFIG = require("./profitSniperConfig");
const {hourlyRank,compareHourly}=require("./profitSniperHourlyRank");
const API = "https://api.dexscreener.com";
const GMGN_API = "https://openapi.gmgn.ai";
const MAX_TRACKED_POOLS = 180;
const MAX_GMGN_TOKENS = 90;
const GMGN_REFRESH_MS = 60 * 1000;
const FEEDS = ["/token-boosts/top/v1", "/token-boosts/latest/v1",
  "/token-profiles/latest/v1", "/token-profiles/recent-updates/v1",
  "/community-takeovers/latest/v1"];

function mapLaunchPair(pair, descriptor) {
  if(pair.chainId!=="solana" || pair.pairAddress!==descriptor.poolAddress ||
      pair.baseToken?.address!==descriptor.tokenAddress) return null;
  const data={chainId:pair.chainId,name:pair.baseToken.name,symbol:pair.baseToken.symbol,
    priceUsd:pair.priceUsd,liquidityUsd:pair.liquidity?.usd,volume5m:pair.volume?.m5,
    volume24h:pair.volume?.h24,volume1h:pair.volume?.h1,priceChange5m:pair.priceChange?.m5,
    priceChange1h:pair.priceChange?.h1,priceChange24h:pair.priceChange?.h24,
    buys5m:pair.txns?.m5?.buys,sells5m:pair.txns?.m5?.sells,
    buys1h:pair.txns?.h1?.buys,sells1h:pair.txns?.h1?.sells,
    tokenAddress:descriptor.tokenAddress,pairAddress:descriptor.poolAddress,
    pairCreatedAt:descriptor.createdAt,discoverySource:descriptor.discoverySource,
    gmgn:descriptor.gmgn || null};
  return {...data,...analyzePoolCandidate(data)};
}

// Allocate monitoring to current executable activity, not an hour-old pump.
// These are discovery priorities only; every entry still passes all guards.
function activity(pair) {
  const liquidity = Number(pair?.liquidity?.usd);
  const volume = Number(pair?.volume?.m5);
  const transactions = Number(pair?.txns?.m5?.buys) + Number(pair?.txns?.m5?.sells);
  const active = Number.isFinite(liquidity) && liquidity >= CONFIG.MIN_LIQUIDITY_USD &&
    Number.isFinite(volume) && volume >= CONFIG.MIN_VOLUME_5M_USD &&
    Number.isFinite(transactions) && transactions >= CONFIG.MIN_TRANSACTIONS_5M;
  return {active, score: Number.isFinite(volume) && Number.isFinite(transactions) ?
    Math.log10(1 + Math.max(0, volume)) + Math.log10(1 + Math.max(0, transactions)) : 0};
}
function compareActivity(a, b) {
  return Number(b.activity.active) - Number(a.activity.active) ||
    b.activity.score - a.activity.score;
}

function gmgnAddress(row) {
  return row?.address || row?.token_address || row?.tokenAddress || row?.token?.address || row?.base_token_address || null;
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function gmgnScore(row) {
  // Smart money/KOL are priority signals, not hard entry gates. This keeps the
  // scanner early while still preferring higher-quality capital flow.
  const smart = num(row?.smart_degen_count);
  const kol = num(row?.renowned_count);
  const volume = num(row?.volume_1h || row?.volume_24h);
  const swaps = num(row?.swaps_1h || row?.swaps_24h);
  const rug = num(row?.rug_ratio);
  const bundler = num(row?.bundler_trader_amount_rate || row?.bundler_rate);
  const insider = num(row?.rat_trader_amount_rate || row?.insider_ratio);
  return smart * 5 + kol * 3 + Math.log10(1 + Math.max(0, volume)) +
    Math.log10(1 + Math.max(0, swaps)) - (rug + bundler + insider) * 4;
}
function gmgnMeta(row, section) {
  return {
    section,
    smartMoney:num(row?.smart_degen_count),
    kol:num(row?.renowned_count),
    rugRatio:num(row?.rug_ratio),
    bundlerRate:num(row?.bundler_trader_amount_rate || row?.bundler_rate),
    insiderRate:num(row?.rat_trader_amount_rate || row?.insider_ratio),
    holders:num(row?.holder_count),
    score:gmgnScore(row)
  };
}

function createDexDiscovery({
  httpGet = (...args) => axios.get(...args),
  httpPost = (...args) => axios.post(...args),
  clock = Date.now
} = {}) {
  const feeds = new Map(), tracked = new Map();
  let diagnostics = null, cursor = 0;
  let gmgnCache = {until:0, rows:[], error:null};
  async function get(url, signal) { return (await httpGet(url, {timeout: 10000, signal})).data; }
  async function feed(path, signal) {
    const old = feeds.get(path);
    if (old && clock() < old.until) return old.rows;
    const rows = await get(API + path, signal);
    const solana = (Array.isArray(rows) ? rows : []).filter(row => row?.chainId === "solana" && row.tokenAddress);
    feeds.set(path, {until: clock() + 60000, rows: solana});
    return solana;
  }
  async function gmgnTrenches(signal) {
    if (clock() < gmgnCache.until) return gmgnCache.rows;
    const apiKey = String(process.env.GMGN_API_KEY || "").trim();
    if (!apiKey) {
      gmgnCache={until:clock()+GMGN_REFRESH_MS,rows:[],error:"GMGN_API_KEY not configured; using free DexScreener fallback"};
      return [];
    }
    const timestamp=Math.floor(clock()/1000);
    const clientId=crypto.randomUUID();
    const url=GMGN_API+"/v1/trenches?chain=sol&timestamp="+timestamp+"&client_id="+encodeURIComponent(clientId);
    // Safe discovery lane. Smart money is used for ranking instead of a hard gate,
    // so a token can be caught before the first labeled smart wallet arrives.
    const section={
      filters:["offchain","onchain"],launchpad_platform_v2:true,limit:80,
      quote_address_type:[4,5,3,1,13,0],
      max_rug_ratio:0.30,max_bundler_rate:0.30,max_insider_ratio:0.30,
      min_volume_24h:500
    };
    try {
      const response=await httpPost(url,{version:"v2",new_creation:{...section},near_completion:{...section},completed:{...section}},
        {timeout:10000,signal,headers:{"X-APIKEY":apiKey,"Content-Type":"application/json","User-Agent":"profit-sniper/1.0"}});
      const envelope=response?.data;
      if (envelope?.code != null && Number(envelope.code)!==0)
        throw new Error(`GMGN code=${envelope.code} ${envelope.error || envelope.message || "request failed"}`);
      const data=envelope?.data ?? envelope ?? {};
      const groups=[
        ["new_creation",data.new_creation],
        ["near_completion",data.near_completion || data.pump],
        ["completed",data.completed]
      ];
      const byAddress=new Map();
      for(const [sectionName,list] of groups) for(const row of Array.isArray(list)?list:[]) {
        const address=gmgnAddress(row);
        if(!address) continue;
        const candidate={address,meta:gmgnMeta(row,sectionName)};
        const old=byAddress.get(address);
        if(!old || candidate.meta.score>old.meta.score) byAddress.set(address,candidate);
      }
      const rows=[...byAddress.values()].sort((a,b)=>b.meta.score-a.meta.score).slice(0,MAX_GMGN_TOKENS);
      gmgnCache={until:clock()+GMGN_REFRESH_MS,rows,error:null};
      return rows;
    } catch(error) {
      gmgnCache={until:clock()+GMGN_REFRESH_MS,rows:[],error:error.message};
      return [];
    }
  }
  async function discoverCandidates({signal} = {}) {
    const errors = [];
    const [gmgnRows,result] = await Promise.all([
      gmgnTrenches(signal),
      Promise.allSettled(FEEDS.map(path => feed(path, signal)))
    ]);
    const lists = result.map((row, index) => {
      if (row.status === "fulfilled") return row.value;
      errors.push({source: FEEDS[index], error: row.reason.message}); return [];
    });
    if(gmgnCache.error) errors.push({source:"GMGN_TRENCHES",error:gmgnCache.error});

    // GMGN gets first discovery priority. DexScreener feeds then fill remaining
    // capacity and remain the zero-cost fallback if GMGN is unavailable/rate-limited.
    const gmgnByToken=new Map(gmgnRows.map(row=>[row.address,row.meta]));
    const dexAddresses=[];
    const dexSeen=new Set();
    for (let i=0; i<Math.max(0,...lists.map(rows=>rows.length)); i++)
      for (const rows of lists) if (rows[i] && !dexSeen.has(rows[i].tokenAddress)) {
        dexSeen.add(rows[i].tokenAddress); dexAddresses.push(rows[i].tokenAddress);
      }
    const gmgnAddresses=gmgnRows.map(row=>row.address);
    const remaining=Math.max(0,MAX_TRACKED_POOLS-gmgnAddresses.length);
    const rotated=dexAddresses.length ? [...dexAddresses.slice(cursor % dexAddresses.length), ...dexAddresses.slice(0,cursor % dexAddresses.length)] : [];
    const selected=[...gmgnAddresses,...rotated.filter(address=>!gmgnByToken.has(address)).slice(0,remaining)];
    cursor += remaining;

    const tokenRequests = [];
    for (let i=0; i<selected.length; i+=30)
      tokenRequests.push(get(API + "/tokens/v1/solana/" + selected.slice(i,i+30).join(","), signal));
    const tokenResults = await Promise.allSettled(tokenRequests);
    const now = clock();
    for (const row of tokenResults) {
      if (row.status !== "fulfilled") {errors.push({source:"token quotes",error:row.reason.message});continue;}
      for (const pair of Array.isArray(row.value) ? row.value : []) {
        const age = now - Number(pair?.pairCreatedAt);
        if (pair?.chainId !== "solana" || !pair.pairAddress || !pair.baseToken?.address || !selected.includes(pair.baseToken.address) ||
            !Number.isFinite(age) || age < 0 || age > CONFIG.MAX_PAIR_AGE_MS) continue;
        const meta=gmgnByToken.get(pair.baseToken.address) || null;
        tracked.set(pair.pairAddress, {poolAddress:pair.pairAddress, tokenAddress:pair.baseToken.address,
          createdAt:Number(pair.pairCreatedAt), discoverySource:meta?"GMGN_TRENCHES":"DEXSCREENER_PUBLIC_FEEDS",
          gmgn:meta,activity:activity(pair)});
      }
    }
    for (const [key,pool] of tracked) if (now-pool.createdAt > CONFIG.MAX_PAIR_AGE_MS) tracked.delete(key);
    const descriptors = [...tracked.values()].sort(compareActivity).slice(0,MAX_TRACKED_POOLS);
    const retained = new Set(descriptors.map(row=>row.poolAddress));
    for (const key of tracked.keys()) if (!retained.has(key)) tracked.delete(key);
    const requests=[];
    for(let i=0;i<descriptors.length;i+=30)
      requests.push(get(API+"/latest/dex/pairs/solana/"+descriptors.slice(i,i+30).map(row=>row.poolAddress).join(","),signal));
    const pairResults=await Promise.allSettled(requests);
    const candidates=[];
    for(const row of pairResults) {
      if(row.status!=="fulfilled"){errors.push({source:"exact pair quotes",error:row.reason.message});continue;}
      for(const pair of row.value?.pairs || []) {
        const descriptor=tracked.get(pair.pairAddress);
        if(!descriptor)continue;
        const mapped=mapLaunchPair(pair,descriptor);
        if(mapped && clock()-mapped.pairCreatedAt <= CONFIG.MAX_PAIR_AGE_MS) {
          descriptor.activity=activity(pair); candidates.push(mapped);
        }
      }
    }
    diagnostics={updatedAt:new Date(clock()).toISOString(),source:"GMGN Trenches + DexScreener exact pairs/fallback",
      gmgnEnabled:Boolean(String(process.env.GMGN_API_KEY||"").trim()),gmgnTokens:gmgnRows.length,
      gmgnRefreshMs:GMGN_REFRESH_MS,gmgnFreeTierFriendly:true,
      exactTrending5mRanking:false, exactTrending1hRanking:false,
      ranking:"GMGN safe discovery + smart-money/KOL priority; current 5m activity confirmation",
      monitoringCapacity:MAX_TRACKED_POOLS,
      activePools:candidates.filter(coin=>activity({liquidity:{usd:coin.liquidityUsd},
        volume:{m5:coin.volume5m},txns:{m5:{buys:coin.buys5m,sells:coin.sells5m}}}).active).length,
      rankingWeights:{gmgnSmartMoney:5,gmgnKol:3,gmgnRiskPenalty:4,volume1h:40,transactions1h:30,buyShare1h:20,priceChange1h:10},
      topHourly:candidates.sort(compareHourly).slice(0,10).map(coin=>({symbol:coin.symbol,
        tokenAddress:coin.tokenAddress,pairAddress:coin.pairAddress,discoverySource:coin.discoverySource,gmgn:coin.gmgn,...hourlyRank(coin)})),
      historicalSource:"Locally observed DexScreener price snapshots",
      poolsReceived:tracked.size,poolsTracked:descriptors.length,tokensConsidered:selected.length,
      sourceErrors:errors,error:candidates.length ? null : errors[0]?.error || null};
    console.log("PROFIT SNIPER DISCOVERY | "+JSON.stringify(diagnostics));
    return signal?.aborted ? [] : candidates;
  }
  return {discoverCandidates,getScanDiagnostics:()=>diagnostics};
}
const discovery=createDexDiscovery();
module.exports={createDexDiscovery,...discovery};
