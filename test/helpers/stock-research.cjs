exports.researchResponse = (url,symbols) => {
  const u=new URL(url);
  const json=value=>({ok:true,json:async()=>value});
  if(u.pathname==='/v2/assets')return json(symbols.map(symbol=>({symbol,name:symbol+' common stock',class:'us_equity',status:'active',exchange:'NASDAQ',tradable:true,fractionable:true})));
  if(u.pathname.includes('/screener/'))return json({gainers:[],most_actives:[]});
  if(u.pathname.endsWith('/news'))return json({news:[]});
  if(u.hostname==='www.bls.gov'||u.hostname==='www.bea.gov')return {ok:true,text:async()=> 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261201T130000Z\nSUMMARY:Fixture future release\nEND:VEVENT\nEND:VCALENDAR'};
  if(u.hostname==='www.federalreserve.gov')return {ok:true,text:async()=> '2026 FOMC Meetings<div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9</div>'};
};
