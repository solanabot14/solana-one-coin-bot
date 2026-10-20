const axios = require("axios");
const { analyzePoolCandidate } = require("./poolDiscoveryStrategy");
const CONFIG = require("./profitSniperConfig");
const {hourlyRank,compareHourly}=require("./profitSniperHourlyRank");

const DEX_API = "https://api.dexscreener.com";
const BIRDEYE_API = process.env.BIRDEYE_API_BASE_URL || "https://public-api.birdeye.so";
const MAX_TRACKED_POOLS = 180;
const BIRDEYE_REFRESH_MS = 30 * 1000;
const BIRDEYE_NEW_LISTING_LIMIT = 20;
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
    birdeye:descriptor.birdeye || null};
  return {...data,...analyzePoolCandidate(data)};
}

// Monitoring priority is based on executable activity. Discovery source decides which
// tokens enter the watchlist first; all candidates still pass the normal entry guards.
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
function finite(value) {
  const n=Number(value);
  return Number.isFinite(n) ? n : null;
}
function birdeyeRows(payload) {
  const data=payload?.data ?? payload;
  if(Array.isArray(data)) return data;
  if(Array.isArray(data?.items)) return data.items;
  if(Array.isArray(data?.tokens)) return data.tokens;
  if(Array.isArray(data?.list)) return data.list;
  return [];
}
function birdeyeAddress(row) {
  return row?.address || row?.token_address || row?.tokenAddress || row?.mint || row?.token?.address || null;
}
function birdeyeCreatedAt(row, now) {
  const sec=finite(row?.block_unix_time ?? row?.created_at ?? row?.created_time ?? row?.creation_time);
  if(sec == null) return now;
  return sec > 1e12 ? sec : sec * 1000;
}
function birdeyeMeta(row, now) {
  const createdAt=birdeyeCreatedAt(row,now);
  return {
    createdAt,
    ageMs:Math.max(0,now-createdAt),
    liquidityUsd:finite(row?.liquidity ?? row?.liquidity_usd),
    source:row?.source || row?.platform || row?.meme_platform || null,
    symbol:row?.symbol || null,
    name:row?.name || null
  };
}

function createDexDiscovery({ httpGet = (...args) => axios.get(...args), clock = Date.now } = {}) {
  const feeds = new Map(), tracked = new Map();
  let diagnostics = null, cursor = 0;
  let birdeyeCache={until:0,rows:[],error:null,status:"idle"};

  async function dexGet(url, signal) {
    return (await httpGet(url,{timeout:10000,signal})).data;
  }
  async function feed(path, signal) {
    const old=feeds.get(path);
    if(old && clock()<old.until) return old.rows;
    const rows=await dexGet(DEX_API+path,signal);
    const solana=(Array.isArray(rows)?rows:[]).filter(row=>row?.chainId==="solana" && row.tokenAddress);
    feeds.set(path,{until:clock()+60000,rows:solana});
    return solana;
  }
  async function birdeyeNewListings(signal) {
    if(clock()<birdeyeCache.until) return birdeyeCache.rows;
    const apiKey=String(process.env.BIRDEYE_API_KEY||"").trim();
    if(!apiKey) {
      birdeyeCache={until:clock()+BIRDEYE_REFRESH_MS,rows:[],error:"BIRDEYE_API_KEY not configured",status:"disabled"};
      return [];
    }
    try {
      const response=await httpGet(BIRDEYE_API+`/defi/v2/tokens/new_listing?limit=${BIRDEYE_NEW_LISTING_LIMIT}&meme_platform_enabled=true`,{
        timeout:10000,signal,
        headers:{accept:"application/json","x-chain":"solana","X-API-KEY":apiKey}
      });
      const payload=response?.data;
      if(payload?.success===false) throw new Error(payload?.message || "Birdeye request failed");
      const now=clock();
      const byAddress=new Map();
      for(const row of birdeyeRows(payload)) {
        const address=birdeyeAddress(row);
        if(!address) continue;
        const meta=birdeyeMeta(row,now);
        if(meta.ageMs>CONFIG.MAX_PAIR_AGE_MS) continue;
        byAddress.set(address,{address,meta});
      }
      const rows=[...byAddress.values()].sort((a,b)=>a.meta.createdAt-b.meta.createdAt).reverse();
      birdeyeCache={until:clock()+BIRDEYE_REFRESH_MS,rows,error:null,status:"ok"};
      return rows;
    } catch(error) {
      const status=error?.response?.status;
      const detail=error?.response?.data?.message || error?.response?.data?.error || error.message;
      birdeyeCache={until:clock()+BIRDEYE_REFRESH_MS,rows:[],error:`${status?`HTTP ${status} `:""}${detail}`,status:"fallback"};
      return [];
    }
  }

  async function discoverCandidates({signal} = {}) {
    const errors=[];
    const [birdeye,result]=await Promise.all([
      birdeyeNewListings(signal),
      Promise.allSettled(FEEDS.map(path=>feed(path,signal)))
    ]);
    const lists=result.map((row,index)=>{
      if(row.status==="fulfilled") return row.value;
      errors.push({source:FEEDS[index],error:row.reason.message});
      return [];
    });
    if(birdeyeCache.error) errors.push({source:"BIRDEYE_NEW_LISTINGS",error:birdeyeCache.error});

    // Birdeye new listings always get first watchlist priority. DexScreener fills the
    // remaining capacity and is also the automatic fallback if Birdeye is unavailable.
    const birdeyeByToken=new Map(birdeye.map(row=>[row.address,row.meta]));
    const birdeyeAddresses=birdeye.map(row=>row.address);
    const dexAddresses=[];
    const dexSeen=new Set();
    for(let i=0;i<Math.max(0,...lists.map(rows=>rows.length));i++) {
      for(const rows of lists) if(rows[i] && !dexSeen.has(rows[i].tokenAddress)) {
        dexSeen.add(rows[i].tokenAddress);
        dexAddresses.push(rows[i].tokenAddress);
      }
    }
    const remaining=Math.max(0,MAX_TRACKED_POOLS-birdeyeAddresses.length);
    const rotated=dexAddresses.length ? [...dexAddresses.slice(cursor%dexAddresses.length),...dexAddresses.slice(0,cursor%dexAddresses.length)] : [];
    const selected=[...birdeyeAddresses,...rotated.filter(address=>!birdeyeByToken.has(address)).slice(0,remaining)];
    cursor += remaining;

    const tokenRequests=[];
    for(let i=0;i<selected.length;i+=30)
      tokenRequests.push(dexGet(DEX_API+"/tokens/v1/solana/"+selected.slice(i,i+30).join(","),signal));
    const tokenResults=await Promise.allSettled(tokenRequests);
    const now=clock();
    for(const row of tokenResults) {
      if(row.status!=="fulfilled") { errors.push({source:"token quotes",error:row.reason.message}); continue; }
      for(const pair of Array.isArray(row.value)?row.value:[]) {
        const age=now-Number(pair?.pairCreatedAt);
        if(pair?.chainId!=="solana" || !pair.pairAddress || !pair.baseToken?.address || !selected.includes(pair.baseToken.address) ||
            !Number.isFinite(age) || age<0 || age>CONFIG.MAX_PAIR_AGE_MS) continue;
        const meta=birdeyeByToken.get(pair.baseToken.address)||null;
        tracked.set(pair.pairAddress,{
          poolAddress:pair.pairAddress,
          tokenAddress:pair.baseToken.address,
          createdAt:Number(pair.pairCreatedAt),
          discoverySource:meta?"BIRDEYE_NEW_LISTING":"DEXSCREENER_PUBLIC_FEEDS",
          birdeye:meta,
          activity:activity(pair)
        });
      }
    }

    for(const [key,pool] of tracked) if(now-pool.createdAt>CONFIG.MAX_PAIR_AGE_MS) tracked.delete(key);
    const descriptors=[...tracked.values()].sort(compareActivity).slice(0,MAX_TRACKED_POOLS);
    const retained=new Set(descriptors.map(row=>row.poolAddress));
    for(const key of tracked.keys()) if(!retained.has(key)) tracked.delete(key);

    const requests=[];
    for(let i=0;i<descriptors.length;i+=30)
      requests.push(dexGet(DEX_API+"/latest/dex/pairs/solana/"+descriptors.slice(i,i+30).map(row=>row.poolAddress).join(","),signal));
    const pairResults=await Promise.allSettled(requests);
    const candidates=[];
    for(const row of pairResults) {
      if(row.status!=="fulfilled") { errors.push({source:"exact pair quotes",error:row.reason.message}); continue; }
      for(const pair of row.value?.pairs||[]) {
        const descriptor=tracked.get(pair.pairAddress);
        if(!descriptor) continue;
        const mapped=mapLaunchPair(pair,descriptor);
        if(mapped && clock()-mapped.pairCreatedAt<=CONFIG.MAX_PAIR_AGE_MS) {
          descriptor.activity=activity(pair);
          candidates.push(mapped);
        }
      }
    }

    diagnostics={
      updatedAt:new Date(clock()).toISOString(),
      source:"Birdeye new listings first + DexScreener exact-pair confirmation/fallback",
      birdeyeEnabled:Boolean(String(process.env.BIRDEYE_API_KEY||"").trim()),
      birdeyeStatus:birdeyeCache.status,
      birdeyeTokens:birdeye.length,
      birdeyeRefreshMs:BIRDEYE_REFRESH_MS,
      exactTrending5mRanking:false,
      exactTrending1hRanking:false,
      ranking:"Birdeye fresh meme listings first; DexScreener 5m activity confirms execution quality",
      monitoringCapacity:MAX_TRACKED_POOLS,
      activePools:candidates.filter(coin=>activity({liquidity:{usd:coin.liquidityUsd},volume:{m5:coin.volume5m},txns:{m5:{buys:coin.buys5m,sells:coin.sells5m}}}).active).length,
      rankingWeights:{volume1h:40,transactions1h:30,buyShare1h:20,priceChange1h:10},
      topHourly:candidates.sort(compareHourly).slice(0,10).map(coin=>({
        symbol:coin.symbol,tokenAddress:coin.tokenAddress,pairAddress:coin.pairAddress,
        discoverySource:coin.discoverySource,birdeye:coin.birdeye,...hourlyRank(coin)
      })),
      historicalSource:"Locally observed DexScreener price snapshots",
      poolsReceived:tracked.size,poolsTracked:descriptors.length,tokensConsidered:selected.length,
      sourceErrors:errors,error:candidates.length?null:errors[0]?.error||null
    };
    console.log("PROFIT SNIPER DISCOVERY | "+JSON.stringify(diagnostics));
    return signal?.aborted?[]:candidates;
  }

  return {discoverCandidates,getScanDiagnostics:()=>diagnostics};
}

const discovery=createDexDiscovery();
module.exports={createDexDiscovery,...discovery};
