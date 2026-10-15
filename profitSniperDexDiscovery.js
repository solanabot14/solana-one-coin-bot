const axios = require("axios");
const { analyzePoolCandidate } = require("./poolDiscoveryStrategy");
const CONFIG = require("./profitSniperConfig");
const {hourlyRank,compareHourly}=require("./profitSniperHourlyRank");
const API = "https://api.dexscreener.com";
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
    pairCreatedAt:descriptor.createdAt,discoverySource:descriptor.discoverySource};
  return {...data,...analyzePoolCandidate(data)};
}

function activity(pair) {
  return hourlyRank({volume1h:pair?.volume?.h1,buys1h:pair?.txns?.h1?.buys,
    sells1h:pair?.txns?.h1?.sells,priceChange1h:pair?.priceChange?.h1}).score;
}

function createDexDiscovery({ httpGet = (...args) => axios.get(...args), clock = Date.now } = {}) {
  const feeds = new Map(), tracked = new Map();
  let diagnostics = null, cursor = 0;
  async function get(url, signal) { return (await httpGet(url, {timeout: 10000, signal})).data; }
  async function feed(path, signal) {
    const old = feeds.get(path);
    if (old && clock() < old.until) return old.rows;
    const rows = await get(API + path, signal);
    const solana = (Array.isArray(rows) ? rows : []).filter(row => row?.chainId === "solana" && row.tokenAddress);
    feeds.set(path, {until: clock() + 60000, rows: solana});
    return solana;
  }
  async function discoverCandidates({signal} = {}) {
    const errors = [];
    const result = await Promise.allSettled(FEEDS.map(path => feed(path, signal)));
    const lists = result.map((row, index) => {
      if (row.status === "fulfilled") return row.value;
      errors.push({source: FEEDS[index], error: row.reason.message}); return [];
    });
    // Interleave sources so profiles are not displaced by the first boost feed.
    const addresses = new Set();
    for (let i=0; i<Math.max(0,...lists.map(rows=>rows.length)); i++)
      for (const rows of lists) if (rows[i]) addresses.add(rows[i].tokenAddress);
    const all = [...addresses];
    const rotated = all.length ? [...all.slice(cursor % all.length), ...all.slice(0,cursor % all.length)] : [];
    const selected = rotated.slice(0,90); cursor += selected.length;
    const tokenRequests = [];
    for (let i=0; i<selected.length; i+=30)
      tokenRequests.push(get(API + "/tokens/v1/solana/" + selected.slice(i,i+30).join(","), signal));
    const tokenResults = await Promise.allSettled(tokenRequests);
    const now = clock();
    for (const row of tokenResults) {
      if (row.status !== "fulfilled") {errors.push({source:"token quotes",error:row.reason.message});continue;}
      for (const pair of Array.isArray(row.value) ? row.value : []) {
        const age = now - Number(pair?.pairCreatedAt);
        if (pair?.chainId !== "solana" || !pair.pairAddress || !pair.baseToken?.address ||
            !Number.isFinite(age) || age < 0 || age > CONFIG.MAX_PAIR_AGE_MS) continue;
        tracked.set(pair.pairAddress, {poolAddress:pair.pairAddress, tokenAddress:pair.baseToken.address,
          createdAt:Number(pair.pairCreatedAt), discoverySource:"DEXSCREENER_PUBLIC_FEEDS", activity:activity(pair)});
      }
    }
    for (const [key,pool] of tracked) if (now-pool.createdAt > CONFIG.MAX_PAIR_AGE_MS) tracked.delete(key);
    const descriptors = [...tracked.values()].sort((a,b)=>b.activity-a.activity).slice(0,90);
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
    diagnostics={updatedAt:new Date(clock()).toISOString(),source:"DexScreener public feeds + fresh exact pairs",
      exactTrending5mRanking:false, exactTrending1hRanking:false,
      ranking:"Custom 1h activity; 5m entry confirmation",
      rankingWeights:{volume1h:40,transactions1h:30,buyShare1h:20,priceChange1h:10},
      topHourly:candidates.sort(compareHourly).slice(0,10).map(coin=>({symbol:coin.symbol,
        tokenAddress:coin.tokenAddress,pairAddress:coin.pairAddress,...hourlyRank(coin)})),
      historicalSource:"Locally observed DexScreener price snapshots",
      poolsReceived:tracked.size,poolsTracked:descriptors.length,tokensConsidered:selected.length,
      sourceErrors:errors,error:candidates.length ? null : errors[0]?.error || null};
    console.log("PROFIT SNIPER DEXSCREENER DISCOVERY | "+JSON.stringify(diagnostics));
    return signal?.aborted ? [] : candidates;
  }
  return {discoverCandidates,getScanDiagnostics:()=>diagnostics};
}
const discovery=createDexDiscovery();
module.exports={createDexDiscovery,...discovery};
