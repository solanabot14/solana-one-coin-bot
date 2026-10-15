"use strict";

const FEEDS = [
  { source:"CoinDesk", url:"https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml", hosts:["coindesk.com"] },
  { source:"Cointelegraph", url:"https://cointelegraph.com/rss", hosts:["cointelegraph.com"] }
];
const CACHE_MS = 5 * 60 * 1000;
const FRESH_MS = 8 * 60 * 60 * 1000;
const RISK_TERMS = /\b(hack(?:ed)?|exploit(?:ed)?|stolen|theft|security breach|breach|delist(?:ed|ing)?|suspend(?:ed|sion)?|bankrupt(?:cy)?|insolven(?:t|cy)|withdrawals? halted|network outage|chain halt|protocol attack|compromised)\b/i;
const ASSET_NAMES = {
  BTC:["bitcoin"], ETH:["ethereum","ether"], SOL:["solana"], XRP:["ripple","xrp"], ADA:["cardano"],
  DOGE:["dogecoin"], LINK:["chainlink"], AVAX:["avalanche"], DOT:["polkadot"], LTC:["litecoin"],
  BCH:["bitcoin cash"], UNI:["uniswap"], XLM:["stellar"], ATOM:["cosmos"], NEAR:["near protocol"],
  FIL:["filecoin"], ICP:["internet computer"], APT:["aptos"], SUI:["sui"], OP:["optimism"], ARB:["arbitrum"],
  ALGO:["algorand"], AAVE:["aave"], HBAR:["hedera"], SHIB:["shiba inu"], PEPE:["pepe"], ETC:["ethereum classic"]
};

function decodeXml(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&#x([\da-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16)))
    .replace(/&#(\d+);/g,(_,num)=>String.fromCodePoint(Number(num)))
    .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
    .replace(/&apos;|&#39;/g,"'").replace(/&amp;/g,"&");
}
function cleanText(value) {
  return decodeXml(value).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
}
function tag(item, name) {
  const match=item.match(new RegExp("<(?:\\w+:)?"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?"+name+"\\s*>","i"));
  return match?cleanText(match[1]):"";
}
function safeLink(value, feed) {
  try {
    const url=new URL(decodeXml(value));
    if(url.protocol!=="https:"||!feed.hosts.some(host=>url.hostname===host||url.hostname.endsWith("."+host)))return null;
    return url.toString();
  } catch { return null; }
}
function parseFeed(xml, feed, now=Date.now()) {
  const items=[];
  for(const match of String(xml||"").matchAll(/<(?:\w+:)?item\b[^>]*>([\s\S]*?)<\/(?:\w+:)?item\s*>/gi)){
    const item=match[1],title=tag(item,"title"),url=safeLink(tag(item,"link"),feed);
    if(!title||!url)continue;
    const published=Date.parse(tag(item,"pubDate")||tag(item,"published")||tag(item,"updated"));
    items.push({title,url,summary:tag(item,"description")||tag(item,"summary"),source:feed.source,
      publishedAt:new Date(Number.isFinite(published)?published:now).toISOString()});
  }
  return items;
}
function createCoinbaseNews({fetchImpl=globalThis.fetch,now=()=>Date.now()}={}) {
  let snapshot={status:"WAITING",items:[],updatedAt:null,lastError:null};
  let fetchedAt=0,refreshing=null;
  async function refresh({force=false}={}) {
    if(!force&&snapshot.updatedAt&&now()-fetchedAt<CACHE_MS)return getState();
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      const results=await Promise.allSettled(FEEDS.map(async feed=>{
        const response=await fetchImpl(feed.url,{signal:AbortSignal.timeout(6000),headers:{Accept:"application/rss+xml, application/xml, text/xml","User-Agent":"CoinbaseBot-Paper/1.0"}});
        if(!response.ok)throw new Error(feed.source+" news HTTP "+response.status);
        return parseFeed(await response.text(),feed,now());
      }));
      const successful=results.filter(x=>x.status==="fulfilled").flatMap(x=>x.value);
      const failures=results.filter(x=>x.status==="rejected").map(x=>x.reason&&x.reason.message||"News source unavailable");
      successful.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
      snapshot={status:successful.length?(failures.length?"PARTIAL":"FRESH"):"UNAVAILABLE",
        items:successful.filter(x=>now()-Date.parse(x.publishedAt)<=24*60*60*1000).slice(0,40),
        updatedAt:new Date(now()).toISOString(),lastError:failures.length?failures.join("; "):null};
      fetchedAt=now();return getState();
    })().finally(()=>{refreshing=null;});
    return refreshing;
  }
  function getState(){return structuredClone(snapshot);}
  function riskForProduct(productId) {
    const symbol=String(productId||"").split("-")[0].toUpperCase();
    const aliases=[...(ASSET_NAMES[symbol]||[])];
    if(symbol.length>=4)aliases.push(symbol);
    const nowMs=now();
    for(const item of snapshot.items){
      if(nowMs-Date.parse(item.publishedAt)>FRESH_MS)continue;
      const text=(item.title+" "+item.summary).toLowerCase();
      const mentions=aliases.some(alias=>new RegExp("\\b"+alias.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","i").test(text));
      const match=text.match(RISK_TERMS);
      if(mentions&&match)return {title:item.title,url:item.url,source:item.source,publishedAt:item.publishedAt,term:match[0]};
    }
    return null;
  }
  return {refresh,getState,riskForProduct};
}
module.exports={createCoinbaseNews,parseFeed};
