"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createCoinbaseNews,parseFeed}=require("../coinbaseNews");

test("news parses safe headlines and flags matching recent security risks",async()=>{
  const now=Date.parse("2026-10-14T16:00:00.000Z");
  const xml=`<rss><channel><item><title>Solana protocol reports an exploit affecting a bridge</title><link>https://www.coindesk.com/markets/solana-exploit/</link><description><![CDATA[An incident involving Solana.]]></description><pubDate>Wed, 14 Oct 2026 15:30:00 GMT</pubDate></item><item><title>Unsafe link</title><link>javascript:alert(1)</link><pubDate>Wed, 14 Oct 2026 15:20:00 GMT</pubDate></item></channel></rss>`;
  const feed={source:"CoinDesk",url:"https://www.coindesk.com/arc/outboundfeeds/rss/",hosts:["coindesk.com"]};
  assert.equal(parseFeed(xml,feed,now).length,1);
  const news=createCoinbaseNews({now:()=>now,fetchImpl:async url=>({ok:true,status:200,text:async()=>url.includes("cointelegraph")?"<rss><channel/></rss>":xml})});
  const state=await news.refresh({force:true});
  assert.equal(state.status,"FRESH");
  assert.equal(news.riskForProduct("SOL-USD").term,"exploit");
  assert.equal(news.riskForProduct("BTC-USD"),null);
});

test("stale news does not trigger an old risk flag",async()=>{
  let now=Date.parse("2026-10-14T16:00:00.000Z");
  const xml=`<rss><channel><item><title>XRP exploit reported</title><link>https://cointelegraph.com/news/xrp-exploit</link><pubDate>Wed, 14 Oct 2026 15:30:00 GMT</pubDate></item></channel></rss>`;
  const news=createCoinbaseNews({now:()=>now,fetchImpl:async url=>({ok:true,status:200,text:async()=>url.includes("cointelegraph")?xml:"<rss><channel/></rss>"})});
  await news.refresh({force:true});
  now+=9*60*60*1000;
  assert.equal(news.riskForProduct("XRP-USD"),null);
});
