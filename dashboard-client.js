(function () {
  'use strict';

  var state = {
    api: null, swarm: null, status: null, error: null, controlNotice: null, range: 'ALL',
    chartMetric: 'CUMULATIVE P&L', compareMetric: 'NET P&L', page: 1,
    systemFilter: 'ALL', outcomeFilter: 'ALL', tokenFilter: '', selectedNode: 'G1', chartOverlays: null,
    swarmTab: 'OVERVIEW', botTab: 'OVERVIEW', selectedDay: null, calendarMonth: null
  };
  var PAGE_SIZE = 25;
  var systems = [];
  var allTrades = [];
  var allTransactions = [];
  var allRealizedEvents = [];
  var visibleTransactions = [];
  var numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  var currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

  var SIM_POOL_FEE_RATE = 0.003;
  var SIM_NETWORK_FEE_USD = 0.01;
  function impactPercent(amountUsd, liquidityUsd) {
    var amount=n(amountUsd),liquidity=n(liquidityUsd);
    if(amount===null||amount<=0||liquidity===null||liquidity<=0)return null;
    return amount/(liquidity/2+amount)*100;
  }
  function estimateTradeCosts(raw, fallback) {
    raw=raw||{};fallback=fallback||{};if(n(raw.estimatedFeesUsd)!==null&&n(raw.estimatedSlippageUsd)!==null){var f=n(raw.estimatedFeesUsd),sl=n(raw.estimatedSlippageUsd),net=n(raw.netPnl??raw.pnl??raw.pnlUsd);return {grossPnl:n(raw.grossPnl)??(net===null?null:net+f+sl),feesUsd:f,slippageUsd:sl,totalCostUsd:f+sl,netPnl:net,liquidityAvailable:true,estimated:true};}
    if(raw.costEstimateAvailable&&n(raw.estimatedFeesUsd)!==null&&n(raw.estimatedSlippageUsd)!==null){
      var savedGross=n(raw.grossPnl??raw.pnlGross??raw.pnl),savedFees=n(raw.estimatedFeesUsd),savedSlip=n(raw.estimatedSlippageUsd),savedNet=n(raw.netPnl??raw.pnl);
      if(savedGross!==null&&savedFees!==null&&savedSlip!==null)return {grossPnl:savedGross,feesUsd:savedFees,slippageUsd:savedSlip,totalCostUsd:savedFees+savedSlip,
        netPnl:savedNet===null?savedGross-savedFees-savedSlip:savedNet,liquidityAvailable:true,estimated:true};
    }
    var invested=n(raw.amountInvested??raw.invested??fallback.invested);
    var grossPnl=n(raw.pnl??fallback.pnl);
    if(invested===null||grossPnl===null)return null;
    var liquidity=n(raw.entryLiquidityUsd??fallback.entryLiquidityUsd);
    var sells=Array.isArray(raw.sells)?raw.sells:[];
    var saleValues=sells.map(function(x){return n(x.saleValue??x.amountReceived);}).filter(function(x){return x!==null&&x>=0;});
    if(!saleValues.length)saleValues=[Math.max(0,invested+grossPnl)];
    var entryImpact=impactPercent(invested,liquidity);
    var slippage=entryImpact===null?null:invested*entryImpact/100;
    if(slippage!==null)saleValues.forEach(function(value){var impact=impactPercent(value,liquidity);if(impact===null)slippage=null;else if(slippage!==null)slippage+=value*impact/100;});
    var poolFees=(invested+saleValues.reduce(function(a,b){return a+b;},0))*SIM_POOL_FEE_RATE;
    var exitCount=Math.max(1,sells.length);
    var fees=poolFees+(1+exitCount)*SIM_NETWORK_FEE_USD;
    return {grossPnl:grossPnl,feesUsd:fees,slippageUsd:slippage,totalCostUsd:slippage===null?null:fees+slippage,
      netPnl:slippage===null?null:grossPnl-fees-slippage,liquidityAvailable:liquidity!==null&&liquidity>0,estimated:true};
  }
  function simulateBotCosts(system) {
    if(system.id==='stock') {
      var trades=system.trades||[], fees=trades.reduce(function(sum,t){return sum+(n((t.sourceRecord||t).estimatedFeesUsd)||0);},0), net=trades.reduce(function(sum,t){return sum+(n(t.pnl)||0);},0);
      return {rows:[],count:trades.length,feesUsd:fees,slippageUsd:null,knownSlippageUsd:0,missingSlippage:trades.length,netPnl:net,grossPnl:null,complete:false,exchangeCosts:true};
    }
    var rows=(system.trades||[]).map(function(t){var raw=t.sourceRecord||t;var estimate=estimateTradeCosts(raw,{invested:t.invested,pnl:t.pnl,entryLiquidityUsd:t.entryLiquidityUsd});
      return estimate?{token:t.token||raw.symbol||'â',time:t.exitTime||t.time||null,...estimate}:null;}).filter(Boolean);
    var fees=rows.reduce(function(sum,x){return sum+x.feesUsd;},0);
    var knownSlippage=rows.filter(function(x){return x.slippageUsd!==null;}).reduce(function(sum,x){return sum+x.slippageUsd;},0);
    var complete=rows.every(function(x){return x.slippageUsd!==null;});
    var gross=rows.reduce(function(sum,x){return sum+x.grossPnl;},0);
    return {rows:rows,count:rows.length,feesUsd:fees,knownSlippageUsd:knownSlippage,slippageUsd:complete?knownSlippage:null,missingSlippage:rows.filter(function(x){return x.slippageUsd===null;}).length,
      netPnl:complete?gross-fees-knownSlippage:null,grossPnl:gross,complete:complete};
  }
  function costSimulationPanel(system) {
    var c=simulateBotCosts(system);if(system.id==='outcome')return '<div class="notice">Coinbase paper execution costs are already deducted from reported P&amp;L. Recorded fees '+money(c.feesUsd)+' Â· modeled slippage '+money(c.slippageUsd)+' Â· net P&amp;L '+money(c.netPnl)+'.</div>';var unit=system.label==='Swarm'?'SELL events':'completed trades';
    var note=c.count?(c.complete?'All listed '+unit.toLowerCase()+' have entry liquidity data for this estimate.':c.missingSlippage+' of '+c.count+' records lack saved entry liquidity; estimated slippage and net P&L are unavailable.'): 'No completed trade records are available for a cost estimate yet.';
    var rows=c.rows.map(function(x){return '<tr><td class="text-left">'+esc(x.token)+'</td><td>'+dateTime(x.time)+'</td><td>'+money(x.grossPnl)+'</td><td>'+money(x.feesUsd)+'</td><td>'+money(x.slippageUsd)+'</td><td class="'+signClass(x.netPnl)+'">'+money(x.netPnl)+'</td></tr>';});
    return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">SIMULATED FEES &amp; SLIPPAGE</div><div class="panel-subtitle">Reporting-only estimate Â· '+int(c.count)+' '+unit+'</div></div><span class="badge">PAPER MODEL</span></div><div class="kpi-grid">'+kpi('GROSS P&amp;L',money(c.grossPnl),'Recorded exits')+kpi((system.id==='buy-test'||system.id==='exit-test')?'EST. FEES incl. PRIORITY':'EST. NETWORK + POOL FEES',money(c.feesUsd),(system.id==='buy-test'||system.id==='exit-test')?'0.30% pool + $0.01 Solana + $0.01 priority per swap':'0.30% per swap + $0.01 per transaction')+kpi('EST. SLIPPAGE',c.complete?money(c.slippageUsd):money(c.knownSlippageUsd)+' (partial)','Approx. pool impact at trade size')+kpi('EST. NET P&amp;L',c.complete?money(c.netPnl):'Liquidity not saved','Gross P&L minus modeled costs',c.complete?signClass(c.netPnl):'neutral')+'</div><div class="footer-note">'+esc(note)+' Assumptions: 0.30% pool fee per swap, $0.01 Solana network fee per transaction, and constant-product impact from saved entry liquidity. Estimates only; existing bot rules and account balances are unchanged.</div>'+table(['TOKEN','EXIT TIME','GROSS P&amp;L','EST. FEES','EST. SLIPPAGE','EST. NET P&amp;L'],rows,'No completed trades to estimate')+'</div>';
  }
  function swarmCostSimulationSystem() {
    var executions=state.swarm&&Array.isArray(state.swarm.executions)?state.swarm.executions:[];
    var buys=new Map();executions.filter(function(x){return x.type==='BUY';}).forEach(function(x){buys.set(x.positionId||x.id,x);});
    var groups=new Map();
    executions.filter(function(x){return x.type==='SELL';}).forEach(function(sell,index){var key=sell.positionId||'unpaired-'+index;var group=groups.get(key);
      if(!group){var buy=buys.get(sell.positionId);group={buy:buy,sells:[],grossPnl:0,token:sell.symbol||'â',time:sell.time||sell.exitTime};groups.set(key,group);}
      group.sells.push(sell);group.grossPnl+=Number(sell.pnl)||0;});
    var trades=Array.from(groups.values()).map(function(group){var buy=group.buy,soldQty=group.sells.reduce(function(sum,x){return sum+(Number(x.quantitySold)||0);},0);
      var boughtQty=Number(buy&&buy.quantity)||0,share=boughtQty>0?Math.min(1,soldQty/boughtQty):1;
      var fullInvested=Number(buy&&(buy.amountInvested||buy.amount))||Number(group.sells[0].amountInvested||group.sells[0].amount)||0;
      var raw={amountInvested:fullInvested*share,pnl:group.grossPnl,entryLiquidityUsd:buy?buy.entryLiquidityUsd:group.sells[0].entryLiquidityUsd,sells:group.sells};
      return {sourceRecord:raw,token:group.token,time:group.time,invested:raw.amountInvested,pnl:raw.pnl,entryLiquidityUsd:raw.entryLiquidityUsd};});
    return {label:'Swarm',trades:trades};
  }
  function swarmCostSimulationPanel() { return costSimulationPanel(swarmCostSimulationSystem()); }
  function costSummaryPanel() {
    var entries=systems.map(function(system){return {label:system.label,sim:simulateBotCosts(system)};});
    /* Lock account is included in systems. */

    entries.push({label:'Swarm Â· V3.1',sim:simulateBotCosts(swarmCostSimulationSystem())});
    var rows=entries.map(function(entry){var c=entry.sim;return '<tr><td class="text-left"><strong>'+esc(entry.label)+'</strong></td><td>'+int(c.count)+'</td><td>'+money(c.feesUsd)+'</td><td>'+ (c.exchangeCosts?'Included in fills':c.complete?money(c.slippageUsd):money(c.knownSlippageUsd)+' (partial)')+'</td><td class="'+signClass(c.netPnl)+'">'+(c.exchangeCosts?money(c.netPnl)+' recorded':c.complete?money(c.netPnl):'Liquidity not saved')+'</td></tr>';});
    return '<div class="table-panel section-gap"><div class="table-head"><div><h2>SIMULATED FEES &amp; SLIPPAGE Â· ALL BOTS</h2><span class="sub">At-a-glance paper estimates from each botâs recorded trades</span></div><span class="badge">REPORTING ONLY</span></div>'+table(['BOT','TRADES / EVENTS','EST. FEES','EST. SLIPPAGE','EST. NET P&amp;L'],rows,'No bot records are available')+'<div class="footer-note">Solana estimates use 0.30% pool fees, $0.01 network fees and saved entry liquidity. Coinbase and Stock Bot use their own recorded paper execution costs; no Solana fees apply. âNot recordedâ means the bot feed lacks completed trades or liquidity needed for a slippage estimate. Strategy rules and current account figures are unchanged.</div></div>';
  }
  function $(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (s) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[s]; }); }
  function n(value) { if(value===null||value===undefined||value==='')return null;var x = Number(value); return Number.isFinite(x) ? x : null; }
  function money(value) { var x = n(value); return x === null ? 'Not recorded' : (x!==0&&Math.abs(x)<0.01?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:8}).format(x):currencyFmt.format(x)); }
  function pct(value) { var x = n(value); return x === null ? 'Not recorded' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%'; }
  function int(value) { var x = n(value); return x === null ? 'Not recorded' : numberFmt.format(x); }
  function signClass(value) { var x = n(value); return x === null || x === 0 ? 'neutral' : (x > 0 ? 'positive' : 'negative'); }
  function shortDate(value) { var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T12:00:00Z':value); return Number.isNaN(d.getTime()) ? 'â' : new Intl.DateTimeFormat('en-US', { timeZone:'America/Puerto_Rico', month:'short', day:'2-digit' }).format(d); }
  function dateTime(value) { var d = new Date(value); return !value || Number.isNaN(d.getTime()) ? 'Not recorded' : new Intl.DateTimeFormat('en-US', { timeZone:'America/Puerto_Rico', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(d); }
  function duration(ms) { var x = n(ms); if (x === null || x < 0) return 'Not recorded'; var m = Math.floor(x / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; }
  function metric(value, format) { return value === null || value === undefined ? 'Not recorded' : format(value); }
  function request(url, options) {
    return fetch(url, Object.assign({ cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(25000) }, options || {})).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          throw new Error(payload.error || payload.message || (url + ' returned ' + response.status));
        });
      }
      return response.json();
    });
  }

  function normalizeTrade(row, system, isLimited) {
    var normalized=OneCoinAnalytics.normalizeTrade(row,system.name,row.mode||system.mode||'PAPER');
    return Object.assign({},normalized,{systemId:system.id,sourceRecord:row,limitedHistory:!!isLimited,
      entryReason:normalized.entryReason||'Not recorded',exitReason:normalized.exitReason||'Not recorded'});
  }

  function buildSystems() {
    var api = state.api || {};
    var input = [
      { id:'v31', name:'New V3.1 Version', label:'New V3.1 Version', data:api.v31, status:state.status, mode:'PAPER' },
      { id:'candle', name:'Bit V 3.1 40% TP1', label:'Bit V 3.1 40% TP1', data:api.candleBreakout, status:api.candleBreakoutStatus, mode:'PAPER' },
      { id:'profit-sniper', name:'Profit Sniper', label:'Profit Sniper', data:api.profitSniper, status:api.profitSniperStatus, mode:'PAPER' },
      { id:'gemini', name:'Gemini Bot', label:'Gemini Bot', data:api.gemini, status:api.geminiStatus, mode:'PAPER' },
      { id:'outcome', name:'Coinbase Bot', label:'Coinbase Bot', data:api.outcomeBot, status:api.outcomeBotStatus, mode:'PAPER' },
      { id:'stock', name:'Stock Bot', label:'Stock Bot', data:api.stockBot, status:api.stockBotStatus, mode:'PAPER' }
    ];
    systems = input.map(function (s) {
      var d = s.data || {};
      var trades = Array.isArray(d.completedTradeRecords) ? d.completedTradeRecords : Array.isArray(d.completedTrades) ? d.completedTrades : (Array.isArray(d.recentTrades) ? d.recentTrades : []);
      var normalized = trades.map(function (t) { return normalizeTrade(t, s, s.limited && !Array.isArray(d.completedTradeRecords) && !Array.isArray(d.completedTrades)); });
      return Object.assign({}, s, { account:d, trades:normalized, positions:d.livePositions || (Array.isArray(d.openPositions)?d.openPositions:[]) ,
        equity:n(d.equity), totalPnl:n(d.totalPnl), totalPnlPercent:n(d.totalPnlPercent), cashBalance:n(d.cashBalance),
        running:!!(s.status && s.status.running), historyLimited:!!(s.limited && !Array.isArray(d.completedTradeRecords) && !Array.isArray(d.completedTrades)) });
    });
    allTrades = systems.reduce(function (out, s) { return out.concat(s.trades); }, []).concat(swarmTrades());
    var tx = [];
    systems.forEach(function (system) {
      var history = system.account && Array.isArray(system.account.history) ? system.account.history : null;
      if (history && history.length) {
        history.forEach(function (row) { tx.push(Object.assign(normalizeTrade(row, system, system.historyLimited), { type:row.type || 'TRADE', time:row.exitTime || row.entryTime || row.time || null })); });
      } else {
        system.trades.forEach(function (row) { tx.push(Object.assign({}, row, { type:'CLOSED TRADE', time:row.exitTime })); });
      }
    });
    swarmTransactions().forEach(function (row) {
      tx.push(Object.assign({}, row, { mode:'PAPER', limitedHistory:true }));
    });
    allTransactions = tx.sort(function (a,b) { return Date.parse(b.time || 0) - Date.parse(a.time || 0); });
    allRealizedEvents = OneCoinAnalytics.realizedSellEvents(allTransactions);
  }

  function metrics(trades) {
    var m=OneCoinAnalytics.tradeMetrics(trades);
    return Object.assign({},m,{best:m.bestTrade,worst:m.worstTrade});
  }

  function inRange(trade, range) {
    if (range === 'ALL') return true;
    var date = Date.parse(trade.exitTime || trade.time || ''); if (!Number.isFinite(date)) return false;
    var days = ({ '1D':1, '7D':7, '30D':30, '90D':90 })[range];
    return days ? date >= Date.now() - days*86400000 : true;
  }
  function events(trades) { return OneCoinAnalytics.pnlEvents(trades); }
  function daily(trades) { return OneCoinAnalytics.dailyPnl(trades,'America/Puerto_Rico'); }
  function realizedEventsFor(system) {
    var id=system&&system.id;
    var rows=allTransactions.filter(function(row){return row.systemId===id;});
    return OneCoinAnalytics.realizedSellEvents(rows);
  }
  function realizedTotal(rows) { return (rows||[]).reduce(function(sum,row){return sum+(n(row.pnl)||0);},0); }
  function todayPnl(trades) { var today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());var row=daily(trades).find(function(x){return x.date===today;});return row?row.pnl:0; }
  function chartSeries() { if(state.chartMetric==='EQUITY')return equityChartSeries();var fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit',day:'2-digit'}),seriesSystems=comparisonSystems(),dateMap={},bySystem={},days=({'1D':1,'TODAY':1,'7D':7,'30D':30,'90D':90})[state.range],cutoff=days?fmt.format(new Date(Date.now()-days*86400000)):null;seriesSystems.forEach(function(s){var sums={};events(realizedEventsFor(s)).forEach(function(e){var day=fmt.format(new Date(e.time));sums[day]=(sums[day]||0)+e.pnl;dateMap[day]=true;});bySystem[s.id]=sums;});var allDates=Object.keys(dateMap).sort(),dates=allDates.filter(function(d){return !cutoff||d>=cutoff;});if(!dates.length)return [];var chosen=seriesSystems.filter(function(s){return !state.chartOverlays||state.chartOverlays[s.id]!==false;});if(!state.chartOverlays||state.chartOverlays.total!==false)chosen.unshift({id:'total',label:'TOTAL'});return chosen.map(function(s){var running=0;if(state.chartMetric==='CUMULATIVE P&L'&&cutoff)allDates.filter(function(d){return d<cutoff;}).forEach(function(d){running+=s.id==='total'?seriesSystems.reduce(function(sum,x){return sum+(bySystem[x.id][d]||0);},0):(bySystem[s.id][d]||0);});var points=dates.map(function(day){var value=s.id==='total'?seriesSystems.reduce(function(sum,x){return sum+(bySystem[x.id][day]||0);},0):(bySystem[s.id][day]||0);if(state.chartMetric!=='DAILY P&L'){running+=value;value=running;}return {label:day,value:value};});return {label:s.label||s.name,points:points};}); }
    function overlayButtons() { var ss=comparisonSystems(),items=[{id:'total',label:'TOTAL'}].concat(ss.map(function(s){return {id:s.id,label:s.label};}));return items.map(function(x){var on=!state.chartOverlays||state.chartOverlays[x.id]!==false;return '<button class="overlay-pill '+(on?'active':'')+'" data-overlay="'+x.id+'">'+esc(x.label)+'</button>';}).join(''); }
  function svgMultiLine(series,label) { var active=series.filter(function(s){return s.points.length;});if(!active.length)return '<div class="empty"><strong>'+ (state.chartMetric==='EQUITY'?'Equity history is collected automatically from this update onward.':'No realized history for the selected range.')+'</strong></div>';var all=active.reduce(function(a,s){return a.concat(s.points.map(function(p){return p.value;}));},[]),min=Math.min.apply(null,all),max=Math.max.apply(null,all);if(min===max){min-=1;max+=1;}var w=760,h=220,pad=30,grid='';for(var z=0;z<4;z++){var y=pad+z*(h-pad*2)/3;grid+='<line x1="'+pad+'" y1="'+y+'" x2="'+(w-pad)+'" y2="'+y+'" class="chart-grid"/><text x="0" y="'+(y+3)+'" class="chart-label">'+money(max-(max-min)*z/3)+'</text>';}var paths=active.map(function(s,i){var points=s.points.map(function(p,j){return [pad+(s.points.length>1?j*(w-pad*2)/(s.points.length-1):0),h-pad-(p.value-min)/(max-min)*(h-pad*2)];});return '<path class="chart-line chart-line-'+(i%5)+'" d="'+points.map(function(p,j){return (j?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ')+'"><title>'+esc(s.label)+'</title></path>'+points.map(function(p){return '<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2" class="chart-line chart-line-'+(i%5)+'" />';}).join('');}).join('');return '<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+esc(label)+'">'+grid+paths+'</svg><div class="chart-legend">'+active.map(function(s,i){return '<span><i class="legend-'+(i%5)+'"></i>'+esc(s.label)+'</span>';}).join('')+'</div>'; }
  function byGroup(trades, key) {
    var map={}; trades.forEach(function(t){var k=key(t)||'Not recorded';(map[k]||(map[k]=[])).push(t);});
    return Object.keys(map).map(function(label){return {label:label,metrics:metrics(map[label])};}).sort(function(a,b){return (b.metrics.netPnl||0)-(a.metrics.netPnl||0);});
  }
  function exitGroups(trades) { return OneCoinAnalytics.groupByExitReason(trades).map(function(x){return {label:x.label,metrics:x};}).sort(function(a,b){return (b.metrics.netPnl||0)-(a.metrics.netPnl||0);}); }
  function currentRoute() { return location.pathname.replace(/\/$/,'') || '/'; }
  function navigate(to) { if (!to) return; history.pushState({},'',to); state.page=1; render(); window.scrollTo(0,0); }
  function setActiveNav(path) {
    document.querySelectorAll('[data-route]').forEach(function(a){var target=a.getAttribute('data-route');a.classList.toggle('active',target==='/'?path==='/':path===target||path.indexOf(target+'/')===0);});
    var parts=path.split('/').filter(Boolean).map(function(x){return x.replace(/-/g,' ').toUpperCase();});
    $('breadcrumbs').innerHTML='<a href="/" data-route="/">HOME</a>'+ (parts.length?' <span>/</span> '+parts.join(' <span>/</span> '):' <span>/</span> COMMAND CENTER');
  }
  function rangeBar(current, choices, action) {
    return '<div class="range-group">'+choices.map(function(x){return '<button data-'+action+'="'+x+'" class="'+(x===current?'active':'')+'">'+x+'</button>';}).join('')+'</div>';
  }
  function coinbaseMoversAndNewsPanel(system) {
    var account=system.account||{}, candidates=Array.isArray(account.candidates)?account.candidates:[], news=account.news||{};
    var moverRows=candidates.map(function(c){var label=c.accepted?'RECLAIM CONFIRMED':(c.reasons||[]).slice(0,2).join(' Â· ')||'Waiting';return '<tr><td class="text-left"><strong>'+esc(c.symbol)+'</strong></td><td class="'+signClass(c.dayChangePercent)+'">'+pct(c.dayChangePercent)+'</td><td>'+pct(c.hourChangePercent)+'</td><td>'+pct(c.fiveMinChangePercent)+'</td><td>'+money(c.volumeUsd)+'</td><td class="text-left">'+esc(label)+'</td></tr>';});
    var articles=(news.items||[]).slice(0,8).map(function(item){return '<tr><td class="text-left"><a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.title)+'</a><div class="sub">'+esc(item.source)+' Â· '+dateTime(item.publishedAt)+'</div></td></tr>';});
    var status=news.status==='FRESH'?'CURRENT':news.status==='PARTIAL'?'PARTIAL FEED':news.status==='UNAVAILABLE'?'UNAVAILABLE':'WAITING';
    var newsNotice=news.lastError?'<div class="footer-note">'+esc(news.lastError)+'</div>':'';
    return '<div class="grid-2 section-gap"><div class="table-panel"><div class="table-head"><div><h2>TOP DAILY MOVERS Â· COINBASE</h2><span class="sub">Up to '+int(account.dailyMoverUniverseSize||0)+' active, liquid USD spot pairs Â· rolling 24h rank</span></div><span class="badge">PAPER SCAN</span></div>'+table(['COIN','24H','1H','5M','24H USD VOL.','ENTRY CHECK'],moverRows,'No qualifying daily movers yet')+'<div class="footer-note">Entries wait for a closed 5m pullback-and-reclaim candle with volume. The bot does not buy a coin solely because it is up the most.</div></div><div class="table-panel"><div class="table-head"><div><h2>CRYPTO NEWS</h2><span class="sub">CoinDesk + Cointelegraph headlines Â· '+esc(status)+'</span></div><span class="badge">NEWS FILTER</span></div>'+table(['LATEST HEADLINES'],articles,'News feed is unavailable or has no recent headlines')+'<div class="footer-note">Explicit matching-coin risk headlines (such as an exploit, breach, delisting, or outage) pause new paper entries for that coin. Keyword checks are a simple safety filter, not sentiment analysis; headlines do not guarantee price direction.</div>'+newsNotice+'</div></div>';
  }
  function pageHead(title, subtitle, actions) {
    return '<div class="page-head"><div><div class="eyebrow">ONE COIN / PAPER OPERATIONS</div><h1>'+title+'</h1><p>'+subtitle+'</p></div><div class="head-actions">'+(actions||'')+'</div></div>';
  }
  function kpi(label,value,note,cls,primary) {
    return '<div class="kpi-card '+(primary?'kpi-primary':'')+'"><div class="kpi-label">'+label+'</div><div class="kpi-value mono '+(cls||'')+'">'+value+'</div>'+(note?'<div class="kpi-note">'+note+'</div>':'')+'</div>';
  }
  function systemIcon(id){return id==='gemini'?'G':id==='v31'?'V3':id==='candle'?'B3':id==='lab'?'LB':id==='buy-test'?'BUY':id==='exit-test'?'XT':'SW';}
  function systemRow(s) {
    var m=metrics(s.trades);
    return '<tr class="click-row" data-open-system="'+s.id+'"><td><div class="system-name"><span class="system-mark">'+systemIcon(s.id)+'</span>'+esc(s.label)+' <span class="badge">PAPER</span></div></td><td>'+int(m.trades)+'</td><td>'+int(m.wins)+'</td><td>'+int(m.losses)+'</td><td>'+metric(m.winRate,function(x){return x.toFixed(1)+'%';})+'</td><td>'+money(m.grossProfit)+'</td><td>â'+money(m.grossLoss)+'</td><td class="'+signClass(m.netPnl)+'">'+money(m.netPnl)+'</td><td>'+pct(m.returnPercent)+'</td><td>'+money(m.averageTrade)+'</td><td>'+money(m.averageWin)+'</td><td>'+money(m.averageLoss)+'</td><td>'+metric(m.profitFactor,function(x){return x===Infinity?'â':x.toFixed(2);})+'</td><td>'+money(m.best)+'</td><td>'+money(m.worst)+'</td><td>'+duration(m.averageHoldMs)+'</td><td>'+money(m.capitalDeployed)+'</td><td><span class="status-line '+(s.running?'':'offline')+'"><i></i>'+(s.running?'RUNNING':'STOPPED')+'</span></td></tr>';
  }
  function dexScreenerAddress(position, live) {
    return position.tokenAddress || live.tokenAddress || position.mint || live.mint || position.tokenMint || live.tokenMint || position.pairAddress || live.pairAddress || '';
  }
  function transactionDexScreenerAddress(trade) {
    var source=trade.sourceRecord||{}, base=trade.baseToken||source.baseToken||{}, token=trade.token&&typeof trade.token==='object'?trade.token:{};
    var position=trade.position||source.position||{};
    var candidates=[
      trade.tokenAddress,source.tokenAddress,trade.mint,source.mint,trade.mintAddress,source.mintAddress,
      trade.tokenMint,source.tokenMint,trade.baseTokenAddress,source.baseTokenAddress,base.address,token.address,
      position.tokenAddress,position.mint,position.tokenMint,
      trade.pairAddress,source.pairAddress,position.pairAddress
    ];
    for(var i=0;i<candidates.length;i++){
      var address=String(candidates[i]||'').trim();
      if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return address;
    }
    return '';
  }
  function transactionDexScreenerLink(trade) {
    if(trade.systemId==='stock') return {href:'https://finance.yahoo.com/quote/'+encodeURIComponent(trade.symbol||trade.sourceRecord?.symbol||''),label:'VIEW STOCK â',hint:'View this stock or ETF.'};
    var address=transactionDexScreenerAddress(trade);
    if(address) return {href:'https://dexscreener.com/solana/'+encodeURIComponent(address),label:'OPEN COIN ON DEXSCREENER â',hint:'Opens this coin directly on DexScreener.'};
    if(trade.systemId==='outcome')return {href:'https://www.coinbase.com/price/'+encodeURIComponent(String(trade.symbol||trade.token||'').toLowerCase()),label:'VIEW COINBASE â',hint:'Coinbase asset market'};
    var source=trade.sourceRecord||{};
    var query=trade.symbol||trade.tokenSymbol||trade.token||trade.name||trade.tokenName||source.symbol||source.tokenSymbol||source.token||source.name||source.tokenName||'';
    query=String(query).trim();
    return {href:query?'https://dexscreener.com/search?q='+encodeURIComponent(query):'https://dexscreener.com/search',
      label:query?'SEARCH DEXSCREENER â':'OPEN DEXSCREENER â',
      hint:query?'Search by token name because this older trade has no saved address. Verify the result.':'Open DexScreener search; this older trade has no saved token name or address.'};
  }
  function livePositionRow(source, item, swarmId) {
    var position=item.position||item, live=item.live||item, address=dexScreenerAddress(position,live);
    var token=position.symbol||position.name||position.tokenSymbol||live.symbol||'-';
    var link=address?'<a class="dex-link" href="https://dexscreener.com/solana/'+encodeURIComponent(address)+'" target="_blank" rel="noopener noreferrer">OPEN COIN ON DEXSCREENER â</a>':'<span class="dex-unavailable">LINK UNAVAILABLE</span>';
    if(source==='Coinbase Bot'&&!address)link='<a class="dex-link" href="https://www.coinbase.com/advanced-trade/spot/'+encodeURIComponent(position.productId||token+'-USD')+'" target="_blank" rel="noopener noreferrer">VIEW COINBASE â</a>';if(source==='Stock Bot')link='<a class="dex-link" href="https://finance.yahoo.com/quote/'+encodeURIComponent(token)+'" target="_blank" rel="noopener noreferrer">VIEW STOCK â</a>';
    var pnl=live.pnl!==undefined?live.pnl:position.pnl;
    var currentPrice=live.currentPrice??live.priceUsd??position.currentPrice??position.priceUsd;
    var closeButton=source==='Gemini Bot'&&position.id?'<button type="button" class="control-button" data-control="gemini/close-position">CLOSE GEMINI PAPER POSITION</button>':source==='Profit Sniper'&&position.id?'<button type="button" class="control-button" data-control="profit-sniper/close-position?positionId='+encodeURIComponent(position.id)+'">CLOSE PAPER POSITION</button>':'';
    return '<tr><td class="text-left">'+esc(source)+'</td><td class="text-left">'+esc(swarmId||position.genesisId||'-')+'</td><td class="text-left"><strong>'+esc(token)+'</strong><div class="live-token-address">'+(address?esc(address):'No token/pair address recorded')+'</div>'+(live.quoteWarning?'<div class="live-token-address quote-warning">ALT POOL QUOTE Â· VERIFY</div>':'')+'</td><td>'+money(position.amountInvested??position.amountInvestedUsd??position.invested??position.costBasisUsd??position.currentValue)+'</td><td>'+tradePrice(position.entryPrice??position.buyPrice)+'</td><td>'+tradePrice(currentPrice)+'</td><td class="'+signClass(pnl)+'">'+money(pnl)+'</td><td>'+pct(live.pnlPercent??position.pnlPercent)+'</td><td>'+duration(live.holdTimeMs??position.holdTimeMs)+'</td><td>'+link+(closeButton?'<div>'+closeButton+'</div>':'')+'</td></tr>';
  }
  function liveTradingPanel() {
    var rows=[];
    systems.forEach(function(system){(system.positions||[]).forEach(function(position){rows.push(livePositionRow(system.label,position,''));});});
    swarmSlots().forEach(function(slot){if(slot.position)rows.push(livePositionRow('Swarm',slot,slot.genesisId||slot.swarmId||''));});
    var closeAllButton=rows.length?'<button type="button" class="control-button" data-control="close-all-paper-positions">CLOSE ALL PAPER POSITIONS</button>':'';
    var notice=state.controlNotice?'<div class="notice">'+esc(state.controlNotice)+'</div>':'';
    return '<div class="table-panel live-trading-panel"><div class="table-head"><div><h2>LIVE TRADING NOW</h2><span class="sub">Open paper positions by bot Â· refreshed with dashboard data</span></div><span class="badge">LIVE POSITIONS</span></div>'+closeAllButton+notice+table(['BOT','GENESIS / SWARM','COIN','INVESTED','ENTRY PRICE','CURRENT PRICE','UNREALIZED P&L','RETURN','HOLD TIME','DEXSCREENER'],rows,'No open positions in the latest bot feeds')+'</div>';
  }
  function comparisonSystems() { var sw=state.swarm||{};return systems.concat([{id:'swarm',name:'Swarm',label:'Swarm Â· V3.1',mode:'PAPER',account:{startingBalance:n(sw.startingCapital)},trades:swarmTrades(),positions:swarmSlots().filter(function(x){return !!x.position;}).map(function(x){return {position:x.position,live:x.live,pnl:x.live&&x.live.pnl};}),equity:n(sw.totalCapital),totalPnl:n(sw.totalPnl),totalPnlPercent:n(sw.totalPnlPercent),running:!!sw.running,historyLimited:true}]); }
  function table(headers, rows, emptyText) {
    return '<div class="table-scroll"><table><thead><tr>'+headers.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="'+headers.length+'"><div class="empty"><strong>'+esc(emptyText||'No records available')+'</strong></div></td></tr>')+'</tbody></table></div>';
  }
  function svgLine(series, label) {
    if (!Array.isArray(series)||!series.length) return '<div class="empty"><strong>'+(label==='EQUITY'?'Equity history is collected automatically from this update onward.':'No recorded values for this period.')+'</strong></div>';
    var values=series.map(function(x){return x.value;}), min=Math.min.apply(null,values), max=Math.max.apply(null,values); if(min===max){min-=1;max+=1;}
    var w=760,h=220,pad=26, xStep=series.length>1?(w-pad*2)/(series.length-1):0;
    var points=series.map(function(d,i){return [pad+i*xStep,h-pad-(d.value-min)/(max-min)*(h-pad*2)];});
    var path=points.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ');
    var area=path+' L '+points[points.length-1][0]+' '+(h-pad)+' L '+points[0][0]+' '+(h-pad)+' Z';
    var grid=''; for(var z=0;z<4;z++){var y=pad+z*(h-pad*2)/3;grid+='<line x1="'+pad+'" y1="'+y+'" x2="'+(w-pad)+'" y2="'+y+'" class="chart-grid"/><text x="0" y="'+(y+3)+'" class="chart-label">'+money(max-(max-min)*z/3)+'</text>';}
    var dots=points.map(function(p,i){return '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="2.7" class="chart-dot"><title>'+esc(series[i].label)+': '+money(series[i].value)+'</title></circle>';}).join('');
    return '<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+esc(label)+'"><defs><linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2ad4e8" stop-opacity=".25"/><stop offset="1" stop-color="#2ad4e8" stop-opacity="0"/></linearGradient></defs>'+grid+'<path d="'+area+'" class="chart-area"/><path d="'+path+'" class="chart-line"/>'+dots+'</svg>';
  }
  function dailyBar(trades, maxDays) {
    var rows=daily(trades).slice(-maxDays), max=Math.max(1,...rows.map(function(x){return Math.abs(x.pnl);}));
    if(!rows.length)return '<div class="empty"><strong>No daily history</strong>Not recorded</div>';
    return '<div class="bar-chart">'+rows.map(function(x){var pctH=Math.max(3,Math.abs(x.pnl)/max*78);var isNeg=x.pnl<0;return '<div class="bar-col" data-day="'+x.date+'" title="'+x.date+' '+money(x.pnl)+'"><span class="bar-value '+signClass(x.pnl)+'">'+money(x.pnl)+'</span><div class="bar-track"><div class="bar-zero"></div><div class="bar '+(isNeg?'negative':'')+'" style="height:'+pctH+'%;'+(isNeg?'top:50%;':'bottom:50%;')+'"></div></div><span class="bar-day">'+shortDate(x.date)+'</span></div>';}).join('')+'</div>';
  }
  function tradesForRange() { return allTrades.filter(function(t){return inRange(t,state.range);}); }
  function liveCount() { return comparisonSystems().reduce(function(s,x){return s+(Array.isArray(x.positions)?x.positions.length:0);},0); }
  function sumKnown(values) { return values.every(function(x){return n(x)!==null;})?values.reduce(function(s,x){return s+Number(x);},0):null; }
  function sumAvailable(values) { var known=values.map(n).filter(function(x){return x!==null;});return known.length?known.reduce(function(s,x){return s+x;},0):null; }
  function positionPnl(system) { var positions=Array.isArray(system.positions)?system.positions:[];if(!positions.length)return 0;return sumKnown(positions.map(function(p){return n(p.live&&p.live.pnl!==undefined?p.live.pnl:p.pnl);})); }
  function unrealizedTotal() { return sumKnown(comparisonSystems().map(positionPnl)); }

  function renderHome() {
    var rangeTrades=tradesForRange(), m=metrics(rangeTrades);
    var portfolioSystems=comparisonSystems();
    function currentQuoteAvailable(system) { var label=health(system).label;return n(system.equity)!==null&&label!=='FEED ERROR'&&label!=='STOPPED'; }
    var equityValues=portfolioSystems.map(function(s){return currentQuoteAvailable(s)?n(s.equity):null;});
    var equity=sumKnown(equityValues);
    var missingEquity=portfolioSystems.filter(function(s){return !currentQuoteAvailable(s);}).map(function(s){var quote=n(s.equity)!==null;return (s.label||s.name)+(quote?' ('+health(s).label.toLowerCase()+')':' (no current quote)');});
    var equityPartial=sumAvailable(equityValues);
    var equityValue=missingEquity.length?(equityPartial===null?'Not recorded':money(equityPartial)+' partial'):money(equity);
    var equitySubtitle=missingEquity.length?'Known marked value; current quote/data missing for: '+missingEquity.join(', '):'Current marked value across connected accounts';
    var realized=realizedTotal(allRealizedEvents);
    var unrealizedValues=portfolioSystems.map(function(s){return currentQuoteAvailable(s)?positionPnl(s):(s.positions&&s.positions.length?null:0);});
    var unrealized=sumKnown(unrealizedValues);
    var missingUnrealized=portfolioSystems.filter(function(s){return currentQuoteAvailable(s)?positionPnl(s)===null:!!(s.positions&&s.positions.length);}).map(function(s){return (s.label||s.name)+' ('+health(s).label.toLowerCase()+')';});
    var unrealizedValue=missingUnrealized.length?(sumAvailable(unrealizedValues)===null?'Not recorded':money(sumAvailable(unrealizedValues))+' partial'):money(unrealized);
    var unrealizedSubtitle=missingUnrealized.length?'Known open-position P&L; current quote/data missing for: '+missingUnrealized.join(', '):'Open positions';
    var pnlValues=portfolioSystems.map(function(s){return currentQuoteAvailable(s)?n(s.totalPnl):null;});
    var totalPnl=sumKnown(pnlValues);
    var missingPnl=portfolioSystems.filter(function(s){return !currentQuoteAvailable(s)||n(s.totalPnl)===null;}).map(function(s){return (s.label||s.name)+' ('+(currentQuoteAvailable(s)?'P&L unavailable':health(s).label==='FEED ERROR'?'feed error':'no current quote')+')';});
    var totalPnlValue=missingPnl.length?(sumAvailable(pnlValues)===null?'Not recorded':money(sumAvailable(pnlValues))+' partial'):money(totalPnl);
    var totalPnlSubtitle=missingPnl.length?'Known current P&L; missing quote/data for: '+missingPnl.join(', '):'Current equity less starting balance';
    var starting=sumKnown(portfolioSystems.map(function(s){return n(s.account.startingBalance)||null;}));
    var ret=starting&&totalPnl!==null?totalPnl/starting*100:null;
    var activeBots=systems.filter(function(s){return s.running;}).length;
    var sw=state.swarm||{}, slots=Array.isArray(sw.slots)?sw.slots:[];
    var activeSwarms=sw.running?slots.length:0;
    var realizedRange=allRealizedEvents.filter(function(t){return inRange(t,state.range);});var topTrades=events(realizedRange);
    var cum=0, curve=topTrades.map(function(x){cum+=x.pnl;return {label:dateTime(x.time),value:cum};});
    var equityMaybe = state.chartMetric==='EQUITY' ? (equityChartSeries().find(function(s){return s.id==='total';})||{points:[]}).points : state.chartMetric==='DAILY P&L' ? daily(realizedRange).map(function(x){return {label:x.date,value:x.pnl};}) : state.chartMetric==='REALIZED P&L' ? topTrades.map(function(x){return {label:dateTime(x.time),value:x.pnl};}) : curve;
    var dayLimit=state.range==='1D'?1:state.range==='7D'?7:state.range==='30D'?30:state.range==='90D'?90:100000;
    var systemRows=comparisonSystems().map(systemRow);
    var kpis=[
      kpi('TOTAL EQUITY',equityValue,equitySubtitle,'neutral',true),
      kpi("TODAY'S P&L",money(todayPnl(allRealizedEvents)),'Realized sale events, Puerto Rico time',signClass(todayPnl(allRealizedEvents))),
      kpi('TOTAL REALIZED P&L',money(realized),'Recorded sale events, including partial exits',signClass(realized)),
      kpi('UNREALIZED P&L',unrealizedValue,unrealizedSubtitle,signClass(unrealized)),
      kpi('ALL-TIME P&L',totalPnlValue,totalPnlSubtitle,signClass(totalPnl)),
      kpi('UNRECONCILED',money(totalPnl!==null&&realized!==null&&unrealized!==null?totalPnl-realized-unrealized:null),'All-time P&L minus realized and open P&L',signClass(totalPnl!==null&&realized!==null&&unrealized!==null?totalPnl-realized-unrealized:null)),
      kpi('RETURN',pct(ret),'Across connected accounts',signClass(ret)),
      kpi('WIN RATE',metric(m.winRate,function(x){return x.toFixed(1)+'%';}),'Selected period'),
      kpi('TOTAL TRADES',int(m.trades),'Selected period'),
      kpi('ACTIVE POSITIONS',int(liveCount()),'Across connected accounts'),
      kpi('ACTIVE BOTS',int(activeBots),'Paper bots currently running'),
      kpi('ACTIVE SWARMS',int(activeSwarms),'V3.1 Swarm instance'),
      kpi('PROFIT FACTOR',metric(m.profitFactor,function(x){return x===Infinity?'â':x.toFixed(2);}), 'Gross profit / gross loss'),
      kpi('AVG WIN',money(m.averageWin),'Per winning trade',signClass(m.averageWin)),
      kpi('AVG LOSS',money(m.averageLoss),'Per losing trade',signClass(m.averageLoss)),
      kpi('BEST TRADE',money(m.best),'Selected period',signClass(m.best)),
      kpi('WORST TRADE',money(m.worst),'Selected period',signClass(m.worst))
    ].join('');
    $('view').innerHTML=pageHead('Command Center','A live, read-only view of connected paper trading systems.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+
      liveTradingPanel()+'<div class="kpi-grid">'+kpis+'</div>'+botHealthOverview()+costSummaryPanel()+statusNotice()+
      '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">ACCOUNT PERFORMANCE</div><div class="panel-subtitle">Recorded realized P&L and equity snapshots from this update onward</div></div><div class="right segmented">'+['EQUITY','REALIZED P&L','DAILY P&L','CUMULATIVE P&L'].map(function(x){return '<button data-chart="'+x+'" class="'+(state.chartMetric===x?'active':'')+'">'+x+'</button>';}).join('')+'</div></div><div class="overlay-pills">'+overlayButtons()+'</div><div class="chart-wrap">'+svgMultiLine(chartSeries(),state.chartMetric)+'</div><div class="footer-note">Select EQUITY for measured account snapshots, or a P&L view for recorded sale events. Equity history starts with this update.</div></div><div class="panel"><div class="panel-head"><div><div class="panel-title">DAILY P&L</div><div class="panel-subtitle">Realized sale P&L, by Puerto Rico date</div></div><div class="right">'+rangeBar(state.range==='ALL'?'7D':state.range,['7D','30D','90D','ALL'],'range')+'</div></div>'+dailyBar(allRealizedEvents,dayLimit)+'</div></div>'+ 
      '<div class="table-panel"><div class="table-head"><h2>PERFORMANCE BY SYSTEM</h2><span class="sub">Click a row to open its workspace</span></div>'+table(['BOT / STRATEGY','TRADES','WINS','LOSSES','WIN RATE','GROSS PROFIT','GROSS LOSS','NET P&L','RETURN','AVG TRADE','AVG WIN','AVG LOSS','PROFIT FACTOR','BEST TRADE','WORST TRADE','AVG HOLD','CAPITAL DEPLOYED','STATUS'],systemRows,'No system records available')+'</div>'+
      '<div class="grid-2 equal"><div class="panel"><div class="panel-head"><div><div class="panel-title">WIN / LOSS CONTRIBUTION</div><div class="panel-subtitle">Count and dollar contribution are shown separately</div></div></div>'+splitContribution(rangeTrades)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">EXIT REASONS</div><div class="panel-subtitle">Historical exits, aggregated from saved transactions</div></div><a class="button small" href="/analytics" data-route="/analytics">OPEN ANALYTICS</a></div>'+smallGroupTable(exitGroups(rangeTrades),'EXIT')+'</div></div>';
  }
  function splitContribution(trades) {
    var m=metrics(trades);
    return '<div class="three-col"><div class="mini-metric"><span>WINNING TRADES</span><strong class="positive">'+int(m.wins)+'</strong><span>'+money(m.grossProfit)+' contribution</span></div><div class="mini-metric"><span>LOSING TRADES</span><strong class="negative">'+int(m.losses)+'</strong><span>â'+money(m.grossLoss)+'</span></div><div class="mini-metric"><span>BREAKEVEN</span><strong>'+int(m.breakeven)+'</strong><span>$0.00 contribution</span></div></div><div class="footer-note">Win rate alone does not describe profitability. Compare trade counts with dollar contribution.</div>';
  }
  function smallGroupTable(rows,label) {
    rows=rows.slice(0,6);
    return table([label,'TRADES','WIN RATE','NET P&L'],rows.map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td></tr>';}),'No exit records');
  }
  function statusNotice() {
    var notices = [];
    if (state.error) notices.push('<div class="notice error">One or more feeds could not be refreshed. Missing values remain unavailable; they are not treated as zero. '+esc(state.error)+'</div>');
    if (state.controlNotice) notices.push('<div class="notice">'+esc(state.controlNotice)+'</div>');
    return notices.join('');
  }

  function health(system) {
    var st=system.status||{}, a=system.account||{}, scan=st.scanDiagnostics||{};
    return {label:!system.running?'STOPPED':st.error||st.lastError||scan.error?'FEED ERROR':st.pausedForDailyLoss?'RISK PAUSE':st.sessionMode==='MARKET_CLOSED'?'MARKET CLOSED':'RUNNING',
      error:st.error||st.lastError||scan.error||null, time:st.lastPollAttemptAt||st.lastMonitorAt||st.lastScanAt||scan.updatedAt||st.lastPollAt||a.lastScanAt||null};
  }
  function botHealthPanel(system) {var h=health(system);return '<div class="notice"><strong>'+esc(h.label)+'</strong> Â· '+(h.time?'Last check '+dateTime(h.time):'Process status verified; scan timestamp not exposed')+(h.error?' Â· '+esc(h.error):'')+'</div>';}
  function botHealthOverview() {return '<div class="panel section-gap"><div class="panel-head"><div class="panel-title">BOT HEALTH Â· ALL SYSTEMS</div></div>'+table(['BOT','STATE','LAST CHECK','DETAILS'],comparisonSystems().map(function(s){var h=health(s);return '<tr><td class="text-left">'+esc(s.label)+'</td><td>'+esc(h.label)+'</td><td>'+(h.time?dateTime(h.time):'Process verified')+'</td><td class="text-left">'+esc(h.error||s.status&&s.status.statusMessage||'Active strategy filters apply')+'</td></tr>';}))+'</div>';}
  function equityChartSeries() {
    var rows=state.api&&state.api.equityHistory||[], chosen=comparisonSystems().filter(function(s){return !state.chartOverlays||state.chartOverlays[s.id]!==false;});
    if(!state.chartOverlays||state.chartOverlays.total!==false)chosen.unshift({id:'total',label:'TOTAL'});
    var days=({'1D':1,'TODAY':1,'7D':7,'30D':30,'90D':90})[state.range], cutoff=days?Date.now()-days*86400000:0;
    return chosen.map(function(s){return {id:s.id,label:s.label||s.name,points:rows.filter(function(r){return Date.parse(r.time)>=cutoff&&n(r.values[s.id])!==null;}).map(function(r){return {label:dateTime(r.time),value:r.values[s.id]};})};});
  }

  function botById(id) { return systems.find(function(s){return s.id===id;}); }
  function renderBot(path) {
    var id=path.split('/')[2]||'v31'; id=id==='candle-breakout'?'candle':id==='buy-priority-test'?'buy-test':id==='buy-priority-exit-test'?'exit-test':id; var system=botById(id);
    if(!system){$('view').innerHTML=pageHead('System unavailable','This bot is not present in the current source feed.');return;}
    var tab=(path.split('/')[3]||'overview').toUpperCase(); state.botTab=tab;
    var tabs=['OVERVIEW','LIVE','PERFORMANCE','ANALYTICS','TRANSACTIONS'];
    if(system.id==='stock')tabs.splice(2,0,'CLOSED');
    if(system.id==='profit-sniper') tabs.push('ARCHIVE');
    var base=id==='candle'?'/trading/candle-breakout':id==='buy-test'?'/trading/buy-priority-test':id==='exit-test'?'/trading/buy-priority-exit-test':id==='profit-sniper'?'/trading/profit-sniper':id==='gemini'?'/trading/gemini':id==='stock'?'/trading/stock':id==='outcome'?'/trading/outcome':'/trading/v31';
    var tabHtml='<div class="tab-row">'+tabs.map(function(x){return '<button data-route="'+base+(x==='OVERVIEW'?'':'/'+x.toLowerCase())+'" class="'+(x===tab?'active':'')+'">'+x+'</button>';}).join('')+'</div>';
    var m=metrics(system.trades), content='';
    if(tab==='OVERVIEW') content='<div class="kpi-grid">'+kpi('CURRENT EQUITY',money(system.equity),'Current account equity')+kpi('REALIZED P&L',money(realizedTotal(realizedEventsFor(system))),'Recorded sale events',signClass(realizedTotal(realizedEventsFor(system))))+kpi("TODAY'S P&L",money(todayPnl(realizedEventsFor(system))),'Realized exits')+kpi('RETURN',pct(system.totalPnlPercent),'From starting balance',signClass(system.totalPnlPercent))+kpi('WIN RATE',metric(m.winRate,function(x){return x.toFixed(1)+'%';}))+kpi('TRADES',int(m.trades),'Known closed trades')+kpi('OPEN POSITIONS',int(system.positions.length),'Currently observed')+kpi((system.id==='buy-test'||system.id==='exit-test')?'EXPECTANCY / TRADE':'AVG TRADE',money(m.averageTrade),'Per closed trade',signClass(m.averageTrade))+kpi('PROFIT FACTOR',metric(m.profitFactor,function(x){return x===Infinity?'â':x.toFixed(2);}))+'</div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">REALIZED P&L CURVE</div><div class="panel-subtitle">Built from recorded exits</div></div></div><div class="chart-wrap">'+svgLine(cumulative(system.trades),system.name)+'</div></div><div class="panel"><div class="panel-head"><div><div class="panel-title">WIN / LOSS</div><div class="panel-subtitle">Count and dollar contribution</div></div></div>'+splitContribution(system.trades)+'</div></div>';
    else if(tab==='ARCHIVE') content=renderSessionArchive(system);
    else if(tab==='LIVE') content=renderPositions(system);
    else if(tab==='PERFORMANCE') content='<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">DAILY P&L</div></div>'+dailyBar(system.trades,30)+'</div><div class="panel"><div class="panel-head"><div class="panel-title">WEEKDAY P&L</div></div>'+groupTable(byWeekday(system.trades),['DAY','TRADES','NET P&L'])+'</div></div><div class="panel section-gap"><div class="panel-head"><div class="panel-title">TRADE DISTRIBUTION</div></div>'+histogram(system.trades)+'</div>';
    else if(tab==='ANALYTICS') content=renderEntryExitAnalytics(system.trades);
    else content=renderTransactions(system.trades.map(function(t){return Object.assign({type:'CLOSED TRADE',time:t.exitTime},t);}),true);
    if(system.id==='stock'){
      if(tab==='OVERVIEW')content=stockAccountingPanel(system)+content+stockClosedPanel(system,5);
      else if(tab==='LIVE')content=renderPositions(system)+stockOpenMetrics(system);
      else if(tab==='CLOSED')content=stockClosedPanel(system);
      else if(tab==='TRANSACTIONS')content=stockFillPanel(system);
      else if(tab==='PERFORMANCE')content=stockReportsPanel(system)+content;
      else if(tab==='ANALYTICS')content=stockAccountingPanel(system)+stockReportsPanel(system)+content;
    }
    var geminiLive=system.account&&system.account.liveExecution||{}, geminiLiveStatus=geminiLive.liveEnabled?'LIVE ENTRIES ENABLED':'PAPER MODE Â· LIVE OFF';
    var control=system.id==='stock'?'<button class="button primary" data-control="stock/start">START STOCK BOT</button><button class="button danger" data-control="stock/stop">STOP STOCK BOT</button>':system.id==='v31'?'<button class="button primary" data-control="start">START NEW V3.1</button><button class="button danger" data-control="stop">STOP NEW V3.1</button>':system.id==='profit-sniper'?'<button class="button primary" data-control="profit-sniper/start">START PROFIT SNIPER</button><button class="button danger" data-control="profit-sniper/stop">STOP PROFIT SNIPER</button>':system.id==='outcome'?'<button class="button primary" data-control="outcome/start">START COINBASE BOT</button><button class="button danger" data-control="outcome/stop">STOP COINBASE BOT</button>':system.id==='gemini'?('<button class="button primary" data-control="gemini/live/start">START LIVE TRADING</button><button class="button danger" data-control="gemini/live/stop">STOP LIVE TRADING</button>'+((system.positions||[]).length?'<button class="button danger" data-control="gemini/close-position">Close Gemini position</button>':'')):'';
    $('view').innerHTML=pageHead(esc(system.name),system.id==='gemini'?system.account.strategy:system.id==='stock'?system.account.strategy:system.id==='v31'?'Original V3.1 entries Â· sell 40% of original by +20%, 40% more by +40%, trail final 20% 12% from peak Â· â10% hard stop':system.id==='candle'?'TP1 +15%: sell 40%; TP2 +30%: sell another 40% of original; final 20% trails 10% from peak':system.id==='exit-test'?'Matched New Claude entries Â· 20% at +25% Â· 20% at +60% Â· 12% trail on 60% runner':system.id==='buy-test'?'10% compounding Â· max 4 positions Â· configured token filters and staged exits':system.id==='profit-sniper'?'Trending Solana pools 10mâ24h Â· 3 slots Â· $3k liquidity Â· $500 daily volume Â· $300 5m volume Â· â¥6 trades Â· â¥15% buy transactions Â· sell 40% at +15%, another 40% at +25%, trail final 20% by 12% from high Â· â8% hard stop Â· 30% exact-pool LP lock; exact mint and pool':system.id==='outcome'?'Daily Coinbase movers Â· wait for a 5m pullback reclaim with volume Â· stop below pullback Â· breakeven at +1R Â· trail 2.5% after +1.5R Â· 4h max hold Â· six paper slots, $10 initial size, +10% after net wins (max $25)':'Paper account Â· read-only analytics',control+'<span class="badge">'+(system.id==='gemini'?esc(geminiLiveStatus):'PAPER')+'</span>')+botHealthPanel(system)+(system.id==='profit-sniper'?profitSniperStatusPanel(system):'')+(system.id==='stock'?'<div class="notice">'+esc(system.status.statusMessage)+' Â· '+esc(system.account.simulation)+' Â· IEX data covers one exchange. Overnight gaps may exceed the stop trigger.</div>':'')+tabHtml+content+(system.id==='stock'&&tab==='OVERVIEW'?stockResearchPanel(system):'')+(system.id==='gemini'&&tab==='OVERVIEW'?'<div class="notice">'+esc(geminiLiveStatus)+' Â· '+esc(geminiLive.reason||'')+' Â· '+esc(system.status.activity||'SCANNING')+' Â· Last quote '+(system.status.lastQuoteAt?dateTime(system.status.lastQuoteAt):'Awaiting quote')+'</div>':'')+(system.id==='outcome'&&tab==='OVERVIEW'?coinbaseMoversAndNewsPanel(system):'')+(tab==='OVERVIEW'?(system.id==='stock'?'<div class="notice">Paper costs already deducted: bid/ask spread + 0.05% slippage and 0.01% fee allowance per side. No Solana fees. Maximum observed drawdown: '+pct(system.account.maxDrawdownPercent)+'</div>':costSimulationPanel(system)):'')+(system.historyLimited?'<div class="notice">This feed currently exposes its 15 most recent trades only. Full historical analytics need a read-only history feed.</div>':'');
  }
  // Stock-only accounting views use the paper ledger directly, without DEX fee estimates.
  function stockUsd(value){var x=n(value);return x===null?'â':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(x);}
  function stockQuantity(value){var x=n(value);return x===null?'â':esc(x.toFixed(8).replace(/0+$/,'').replace(/\.$/,''));}
  function stockRows(system,kind){
    var rows=(kind==='fills'?system.account.history:system.account.completedTrades)||[],f=state.stockFilters||{};
    return rows.filter(function(r){
      var symbol=String(r.symbol||'').toUpperCase(),p=n(r.pnlUsd??r.pnl),t=r.exitTime||r.time||r.entryTime;
      if(f.symbol&&!symbol.includes(f.symbol.toUpperCase()))return false;
      if(f.outcome==='WIN'&&!(p>0))return false;if(f.outcome==='LOSS'&&!(p<0))return false;
      if(f.from&&Date.parse(t)<Date.parse(f.from+'T00:00:00-04:00'))return false;
      if(f.to&&Date.parse(t)>=Date.parse(f.to+'T00:00:00-04:00')+86400000)return false;
      return true;
    }).slice().sort(function(a,b){return Date.parse(b.exitTime||b.time||b.entryTime)-Date.parse(a.exitTime||a.time||a.entryTime);});
  }
  function stockFilterBar(){
    var f=state.stockFilters||{};
    return '<div class="filter-row section-gap"><input class="input" data-stock-filter="symbol" placeholder="Stock symbol" aria-label="Stock symbol" value="'+esc(f.symbol||'')+'"><select class="select" data-stock-filter="outcome" aria-label="Stock outcome"><option value="ALL">All outcomes</option><option value="WIN" '+(f.outcome==='WIN'?'selected':'')+'>Winners</option><option value="LOSS" '+(f.outcome==='LOSS'?'selected':'')+'>Losers</option></select><input type="date" class="input" data-stock-filter="from" aria-label="From date, Puerto Rico time" value="'+esc(f.from||'')+'"><input type="date" class="input" data-stock-filter="to" aria-label="Through date, Puerto Rico time" value="'+esc(f.to||'')+'"><button class="button small" data-stock-clear>RESET FILTERS</button></div>';
  }
  function stockPaging(length){
    var pages=Math.max(1,Math.ceil(length/PAGE_SIZE));state.stockPage=Math.min(state.stockPage||1,pages);
    return '<div class="pagination"><span>'+int(length)+' records Â· page '+state.stockPage+' of '+pages+'</span><button data-stock-page="prev" '+(state.stockPage<=1?'disabled':'')+'>PREVIOUS</button><button data-stock-page="next" '+(state.stockPage>=pages?'disabled':'')+'>NEXT</button></div>';
  }
  function stockAccountingPanel(system){
    var d=system.account,h=d.history||[],buys=h.filter(function(r){return r.type==='BUY';}),sells=h.filter(function(r){return r.type==='SELL';});
    function total(rows,fn){return rows.reduce(function(sum,r){return sum+(n(fn(r))||0);},0);}
    var invested=total(buys,function(r){return r.amountInvested??r.costBasisUsd;}),received=total(sells,function(r){return r.saleValueUsd;}),realized=total(sells,function(r){return r.pnlUsd;});
    var feeValues=buys.map(function(r){return n(r.entryFeeUsd);}).concat(sells.map(function(r){return n(r.saleGrossUsd)!==null&&n(r.saleValueUsd)!==null?r.saleGrossUsd-r.saleValueUsd:null;}));
    var fees=feeValues.every(function(x){return x!==null;})?feeValues.reduce(function(s,v){return s+v;},0):null;
    var unrealized=total(d.livePositions||[],function(r){return r.live&&r.live.pnl;}),risk=d.riskSession||{};
    return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">STOCK ACCOUNTING Â· PAPER</div><div class="panel-subtitle">USD Â· costs already included in net P&L Â· original history preserved</div></div></div><div class="kpi-grid">'+kpi('STARTING CAPITAL',stockUsd(d.startingBalanceUsd))+kpi('AVAILABLE CASH',stockUsd(d.cashBalance))+kpi('TOTAL BOUGHT',stockUsd(invested),'Cumulative entry investment including commissions')+kpi('TOTAL RECEIVED',stockUsd(received),'Net proceeds from all partial and final sales')+kpi('REALIZED NET P&L',stockUsd(realized),'All recorded sale fills',signClass(realized))+kpi('UNREALIZED P&L',stockUsd(unrealized),'Open positions after modeled exit costs',signClass(unrealized))+kpi('SIMULATED COMMISSIONS',stockUsd(fees),'Entry and exit fees counted once')+kpi('MAX ACCOUNT DRAWDOWN',pct(d.maxDrawdownPercent),'Observed account equity drawdown')+'</div><div class="notice">Daily loss threshold: '+stockUsd(risk.lossLimitUsd)+' (2.5% of opening equity '+stockUsd(risk.capitalUsd)+') Â· '+esc(risk.halted?'HALTED FOR THE DAY':'No daily halt')+' Â· Next entry '+stockUsd(d.nextTradeSizeUsd)+' Â· Max '+int(d.maxOpenPositions)+' positions</div><div class="notice">Slippage '+esc(d.estimatedSlippagePercentPerSide)+'% and commission allowance '+esc(d.estimatedFeePercentPerSide)+'% per side; spread is additional. These are paper assumptions. Historical missing cost breakdowns and trade extremes display â.</div></div>';
  }
  function stockTradeDetails(r,system){
    var fills=(system.account.history||[]).filter(function(x){return x.positionId===(r.positionId||r.id);}).sort(function(a,b){return Date.parse(a.time)-Date.parse(b.time);});
    var fields=[['Entry time',dateTime(r.entryTime)],['Final exit time',dateTime(r.exitTime)],['Quantity',stockQuantity(r.quantity)],['Holding time',duration(r.holdTimeMs)],['Entry signal',esc(r.entryReason)],['Exit reason',esc(r.exitReason||r.reason)],['P&L before all costs',stockUsd(r.pnlWithoutCostsUsd)],['Commissions (round trip)',stockUsd(r.estimatedFeesUsd)],['Slippage (round trip)',stockUsd(r.estimatedSlippageUsd)],['Spread cost',stockUsd(r.estimatedSpreadUsd)],['Total costs',stockUsd(r.totalCostsUsd)],['Net P&L',stockUsd(r.pnlUsd)],['Maximum drawdown',pct(r.maxDrawdownPercent)],['Maximum run-up',pct(r.maxRunUpPercent)],['Maximum adverse excursion',pct(r.maxAdverseExcursionPercent)],['Observation coverage',esc(r.excursionCoverage||'Historic trade extremes were not recorded')]];
    var entry=r.entryMetrics||{};fields.push(['Entry ATR%',pct(entry.atrPercent)],['Same-time relative volume',entry.timeRelativeVolume==null?'â':esc(Number(entry.timeRelativeVolume).toFixed(2))+'Ã'],['Entry spread',pct(entry.spreadPercent)]);
    return '<details><summary>DETAILS Â· '+fills.length+' fills</summary>'+table(['METRIC','VALUE'],fields.map(function(f){return '<tr><td class="text-left">'+f[0]+'</td><td class="text-left">'+f[1]+'</td></tr>';}))+'<div class="notice">Observed quote extremes may miss moves between checks. Legacy missing fields are not zero.</div>'+table(['TIME (PR)','FILL','QUANTITY','FILL PRICE','INVESTED / RECEIVED','NET P&L','EXIT REASON'],fills.map(function(x){return '<tr><td>'+esc(dateTime(x.time))+'</td><td>'+esc(x.type)+(x.partial?' Â· PARTIAL':'')+'</td><td>'+stockQuantity(x.quantity)+'</td><td>'+stockUsd(x.type==='BUY'?x.entryPrice:x.exitPrice)+'</td><td>'+stockUsd(x.type==='BUY'?x.amountInvested:x.saleValueUsd)+'</td><td>'+stockUsd(x.type==='BUY'?null:x.pnlUsd)+'</td><td>'+esc(x.type==='BUY'?x.entryReason:x.exitReason||x.reason)+'</td></tr>';}),'No matching fills')+'</details>';
  }
  function stockClosedPanel(system,preview){
    var list=stockRows(system,'closed'),pagination=preview?'':stockPaging(list.length),start=preview?0:((state.stockPage||1)-1)*PAGE_SIZE,shown=list.slice(start,start+(preview||PAGE_SIZE));
    var rows=shown.map(function(r){return '<tr><td class="text-left"><strong>'+esc(r.symbol)+'</strong><br><a class="dex-link" href="https://finance.yahoo.com/quote/'+encodeURIComponent(r.symbol)+'" target="_blank" rel="noopener noreferrer">STOCK CHART â</a></td><td>'+stockUsd(r.entryPrice)+'</td><td>'+stockUsd(r.exitPrice)+'</td><td>'+stockUsd(r.amountInvested)+'</td><td>'+stockUsd(r.saleValueUsd)+'</td><td>'+stockUsd(r.estimatedFeesUsd)+'</td><td class="'+signClass(r.pnlUsd)+'">'+stockUsd(r.pnlUsd)+'</td><td>'+pct(r.pnlPercent)+'</td><td class="text-left">'+stockTradeDetails(r,system)+'</td></tr>';});
    return (preview?'':stockFilterBar())+'<div class="table-panel section-gap"><div class="table-head"><div><h2>CLOSED STOCK TRANSACTIONS</h2><span class="sub">One row per completed position Â· entry/exit prices are simulated fills Â· partial sales grouped once</span></div>'+(preview?'<button class="button small" data-route="/trading/stock/closed">VIEW ALL CLOSED</button>':'<button class="button small" data-stock-export="closed">EXPORT STOCK CSV</button>')+'</div>'+table(['STOCK','BUY PRICE','AVG SELL PRICE','INVESTED + ENTRY FEE','NET RECEIVED','COMMISSIONS','NET PROFIT / LOSS','RETURN','FULL TRADE DETAILS'],rows,'No closed stock trades match these filters')+pagination+'</div>';
  }
  function stockFillPanel(system){
    var list=stockRows(system,'fills'),paging=stockPaging(list.length),start=((state.stockPage||1)-1)*PAGE_SIZE;
    var rows=list.slice(start,start+PAGE_SIZE).map(function(r){var buy=r.type==='BUY',gross=n(r.saleGrossUsd),net=n(r.saleValueUsd),fee=buy?r.entryFeeUsd:gross!==null&&net!==null?gross-net:null;return '<tr><td>'+esc(dateTime(r.time))+'</td><td>'+esc(r.symbol)+'</td><td>'+esc(r.type)+(r.partial?' Â· PARTIAL':r.type==='SELL'?' Â· FINAL':'')+'</td><td>'+stockQuantity(r.quantity)+'</td><td>'+stockUsd(buy?r.entryPrice:r.exitPrice)+'</td><td>'+stockUsd(buy?r.amountInvested:null)+'</td><td>'+stockUsd(buy?null:r.saleValueUsd)+'</td><td>'+stockUsd(fee)+'</td><td class="'+signClass(r.pnlUsd)+'">'+stockUsd(buy?null:r.pnlUsd)+'</td><td class="text-left">'+esc(buy?r.entryReason:r.exitReason||r.reason)+'</td></tr>';});
    return stockFilterBar()+'<div class="table-panel section-gap"><div class="table-head"><div><h2>ALL STOCK BUY / SELL FILLS</h2><span class="sub">Every purchase, partial sale and final exit Â· timestamps in Puerto Rico time</span></div><button class="button small" data-stock-export="fills">EXPORT STOCK FILLS CSV</button></div>'+table(['TIME (PR)','STOCK','FILL','QUANTITY','FILL PRICE','INVESTED','NET RECEIVED','FILL COMMISSION','REALIZED NET P&L','REASON'],rows,'No matching stock fills')+paging+'<div class="footer-note">Fill commission shows only that fill. Closed-trade commissions include both sides. Sell P&L already allocates entry costs proportionally.</div></div>';
  }
  function stockReportsPanel(system){
    var r=system.account.reports||{};
    function report(title,rows){return '<div class="table-panel section-gap"><div class="table-head"><h2>'+title+'</h2><span class="sub">New York trading dates Â· partial exits count toward realized P&L; trade count uses completed positions</span></div>'+table(['PERIOD START','CLOSED TRADES','WINS','LOSSES','WIN RATE','NET P&L','AVG WIN','AVG LOSS','BEFORE COSTS','COSTS'],(rows||[]).map(function(x){return '<tr><td>'+esc(x.periodStart)+'</td><td>'+int(x.trades)+'</td><td>'+int(x.wins)+'</td><td>'+int(x.losses)+'</td><td>'+pct(x.winRatePercent)+'</td><td class="'+signClass(x.netPnlUsd)+'">'+stockUsd(x.netPnlUsd)+'</td><td>'+stockUsd(x.averageWinUsd)+'</td><td>'+stockUsd(x.averageLossUsd)+'</td><td>'+stockUsd(x.pnlWithoutCostsUsd)+'</td><td>'+stockUsd(x.costsUsd)+'</td></tr>';}),'No period records yet')+'</div>';}
    var reasons=[];[['TODAY',r.today],['THIS WEEK',r.thisWeek]].forEach(function(pair){Object.entries(pair[1]&&pair[1].pnlByExitReason||{}).forEach(function(e){reasons.push('<tr><td>'+pair[0]+'</td><td>'+esc(e[0])+'</td><td>'+int(e[1].fills)+'</td><td class="'+signClass(e[1].netPnlUsd)+'">'+stockUsd(e[1].netPnlUsd)+'</td><td>'+stockUsd(e[1].pnlWithoutCostsUsd)+'</td></tr>');});});
    return report('DAILY STOCK REPORT',r.daily)+report('WEEKLY STOCK REPORT Â· MONDAY START',r.weekly)+'<div class="table-panel section-gap"><div class="table-head"><h2>STOCK P&L BY EXIT REASON</h2></div>'+table(['PERIOD','EXIT REASON','SALE FILLS','NET P&L','BEFORE COSTS'],reasons,'No stock exits yet')+'</div>';
  }
  function stockOpenMetrics(system){
    var rows=(system.account.livePositions||[]).map(function(item){var p=item.position||{},slip=Number(system.account.estimatedSlippagePercentPerSide)/100,fee=Number(system.account.estimatedFeePercentPerSide)/100,floor=p.quantity?p.costBasisUsd/p.quantity/((1-slip)*(1-fee))*1.0005:null,trail=p.partialTaken?Math.max(floor,(p.runnerHighestPrice||p.highestPrice)*.9925):null;return '<tr><td>'+esc(p.symbol)+'</td><td>'+stockQuantity(p.quantity)+'</td><td>'+esc(dateTime(p.entryTime))+'</td><td>'+stockUsd(p.entryFeeUsd)+'</td><td>'+stockUsd(p.entryPrice*.988)+'</td><td>'+stockUsd(p.entryPrice*1.015)+'</td><td>'+stockUsd(trail)+'</td><td>'+esc(p.partialTaken?'50% sold; trailing active':'Waiting for +1.5%')+'</td><td>'+pct(p.maxDrawdownPercent)+'</td><td>'+pct(p.maxRunUpPercent)+'</td><td>'+esc(p.pendingExitReason||p.entryReason)+'</td></tr>';});
    return '<div class="table-panel section-gap"><div class="table-head"><h2>OPEN STOCK RISK & COSTS</h2></div>'+table(['STOCK','SHARES REMAINING','ENTRY TIME (PR)','REMAINING ENTRY FEE','INITIAL STOP TRIGGER','PARTIAL TARGET','RUNNER TRIGGER','EXIT STAGE','MAX DRAWDOWN','MAX RUN-UP','SIGNAL / PENDING EXIT'],rows,'No open stock positions')+'<div class="footer-note">Trigger levels are not guaranteed fill prices. Historical gaps or delayed quotes can worsen execution.</div></div>';
  }
  function exportStockCsv(kind){
    var system=botById('stock');if(!system)return;
    var rows=stockRows(system,kind),keys=['symbol','positionId','type','partial','quantity','entryTime','exitTime','time','entryPrice','exitPrice','amountInvested','saleValueUsd','fillCommissionUsd','commissionScope','estimatedFeesUsd','estimatedSlippageUsd','estimatedSpreadUsd','totalCostsUsd','pnlWithoutCostsUsd','pnlUsd','pnlPercent','holdTimeMs','maxDrawdownPercent','maxRunUpPercent','maxAdverseExcursionPercent','entryReason','exitReason','excursionCoverage'];
    var lines=[keys].concat(rows.map(function(r){return keys.map(function(k){if(k==='commissionScope')return kind==='closed'?'ROUND_TRIP':r.type==='BUY'?'ENTRY_ONLY':'ALLOCATED_ENTRY_AND_EXIT';if(k==='fillCommissionUsd')return kind==='closed'?null:r.type==='BUY'?r.entryFeeUsd:n(r.saleGrossUsd)!==null&&n(r.saleValueUsd)!==null?r.saleGrossUsd-r.saleValueUsd:null;return r[k];});}));
    var csv='\uFEFF'+lines.map(function(row){return row.map(csvCell).join(',');}).join('\r\n'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');
    link.href=url;link.download='stock-'+kind+'-'+new Date().toISOString().slice(0,10)+'.csv';document.body.appendChild(link);link.click();link.remove();window.setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  function stockResearchPanel(system) {
    var a=system.account.premarketAnalysis;
    var d=system.account.scanDiagnostics;
    var filters=system.account.scannerFilters;
    var filterNotice=filters?'<div class="notice">DAILY ATR: '+pct(filters.minAtrPercent)+'â'+pct(filters.maxAtrPercent)+' Â· SAME-TIME IEX VOLUME: â¥'+esc(filters.minTimeRelativeVolume)+'Ã usual Â· MAX SPREAD: '+pct(filters.maxSpreadPercent)+' Â· AVG DAILY TRADED VALUE: â¥'+money(filters.minAverageDailyDollarVolume)+' Â· Historical reference: '+esc(d&&d.baselineSessionDate||'loading')+'</div>':'';
    var skipped=(system.account.rejections||[]).map(function(r){var m=r.metrics||{};return '<tr><td>'+esc(r.symbol)+'</td><td>'+pct(m.atrPercent)+'</td><td>'+(m.timeRelativeVolume==null?'â':esc(Number(m.timeRelativeVolume).toFixed(2))+'Ã')+'</td><td class="text-left">'+esc(r.reason)+'</td></tr>';});
    var scan='<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">LIVE STOCK SCANNER</div><div class="panel-subtitle">'+int(system.account.watchlistSize)+' stocks / ETFs including Ford Â· updated '+esc(dateTime(system.account.lastScanAt))+'</div></div></div><div class="notice">'+esc(system.status.statusMessage)+' Â· '+int(d&&d.scanned)+' checked Â· '+int(d&&d.qualified)+' qualified Â· '+int(d&&d.entered)+' new entries this scan</div>'+(d?'<div class="notice">Watchlist: '+esc((d.watchlist||[]).join(', '))+'</div>':'')+table(['STOCK / ETF','DAILY ATR %','VOLUME VS USUAL','LATEST SKIPPED-ENTRY REASON'],skipped,'Waiting for first regular-session scan')+'</div>';
    var sizing='<div class="notice">NEXT ENTRY: '+money(system.account.nextTradeSizeUsd)+' Â· +10% size after a net winning completed trade Â· $20 cap Â· reset $10 after loss Â· one re-entry per stock daily; none after a stop loss</div>'+filterNotice+scan;
    if(!a)return sizing+'<div class="notice">Premarket research starts at 4am New York time on trading days.</div>';
    var rows=(a.rankings||[]).slice(0,10).map(function(r){return '<tr><td class="text-left">'+esc(r.symbol)+'</td><td>'+priceValue(r.lastPrice)+'</td><td>'+pct(r.gapPercent)+'</td><td>'+money(r.dollarVolume)+'</td><td>'+int(r.dataAgeMinutes)+' min</td><td>'+esc(r.stale?'STALE':r.longWatchCandidate?'LONG WATCH':'OBSERVE')+'</td></tr>';});
    return sizing+'<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">PREMARKET OPPORTUNITY WATCHLIST</div><div class="panel-subtitle">'+esc(a.sessionDate||'')+' Â· Consolidated data delayed at least 16 minutes Â· research only</div></div></div><div class="notice">'+esc(a.error||a.status||'')+' Â· Updated '+esc(dateTime(a.lastUpdatedAt||a.lastAttemptAt))+'</div>'+table(['STOCK / ETF','DELAYED PRICE','GAP VS PRIOR CLOSE','PREMARKET VALUE','DATA AGE','WATCH STATUS'],rows,'Waiting for premarket data')+'</div>';
  }
  function renderSessionArchive(system) {
    var sessions=system.account.archivedSessions||[];
    var excluded=(system.account.excludedTradeAudits||[]).map(function(audit){
      return '<tr><td>'+esc(audit.history?.[0]?.symbol||'')+'</td><td>'+esc(audit.tokenAddress)+'</td><td>'+esc(audit.reason)+'</td><td>'+int(audit.history?.length||0)+'</td></tr>';
    });
    var excludedEvents=(system.account.excludedTradeAudits||[]).flatMap(function(audit){return (audit.history||[]).map(function(row){
      return '<tr><td>'+esc(dateTime(row.exitTime||row.entryTime))+'</td><td>'+esc(row.symbol)+'</td><td>'+esc(row.type)+'</td><td>'+money(row.amountInvested)+'</td><td>'+money(row.saleValue)+'</td><td>'+money(row.pnl)+'</td><td>'+esc(row.reason||'')+'</td></tr>';
    });});
    return '<div class="notice">Previous sessions and excluded paper trades are preserved for research and excluded from fresh account statistics. Open positions are archived snapshots, not completed sales.</div>'+
      '<div class="table-panel"><div class="table-head"><h2>EXCLUDED PAPER TRADES</h2></div>'+table(['TOKEN','MINT','REASON','EVENTS'],excluded,'No excluded trades')+table(['TIME','TOKEN','TYPE','INVESTED','RECEIVED','P&L','EXIT'],excludedEvents,'No excluded events')+'</div>'+sessions.map(function(session){
      var rows=(session.history||[]).map(function(row){return '<tr><td>'+esc(dateTime(row.exitTime||row.entryTime))+'</td><td>'+esc(row.symbol)+'</td><td>'+esc(row.tokenAddress)+'</td><td>'+esc(row.pairAddress||'')+'</td><td>'+esc(row.type)+'</td><td>'+money(row.amountInvested)+'</td><td>'+money(row.saleValue)+'</td><td>'+money(row.pnl)+'</td><td>'+esc(row.reason||'')+'</td></tr>';});
      var open=session.positions||(session.position?[session.position]:[]);
      return '<div class="table-panel"><div class="table-head"><h2>ARCHIVED SESSION '+esc(dateTime(session.archivedAt))+'</h2><span>Starting '+money(session.startingBalance)+' / cash '+money(session.cashBalance)+' / '+rows.length+' records</span></div>'+table(['TIME','TOKEN','MINT','POOL','TYPE','INVESTED','RECEIVED','P&L','EXIT'],rows,'No historical transactions')+'<div class="notice">Open snapshots: '+esc(open.map(function(p){return p.symbol+' ['+p.tokenAddress+'] quantity '+p.quantity;}).join('; ')||'None')+'</div></div>';
    }).join('');
  }
  function cumulative(trades) { var es=events(trades), total=0;return es.map(function(e){total+=e.pnl;return {label:dateTime(e.time),value:total};}); }
  function profitSniperStatusPanel(system) {
    var status=system.status||{},scan=status.scanDiagnostics||{},verification=status.entryVerification||{},check=verification.lastCheck;
    var source=scan.source||'GeckoTerminal new, trending and top pools + DexScreener + RugCheck';
    var candidateCount=scan.momentumQualified==null?'â':int(scan.momentumQualified);
    var pools=scan.recentPools==null?'â':int(scan.recentPools);
    var last=scan.updatedAt?dateTime(scan.updatedAt):'Waiting for first scan';
    var error=scan.error?'<div class="notice">'+esc(scan.error)+'</div>':'';
    var lockFloor=status.minimumLiquidityLockPercent==null?'â':esc(status.minimumLiquidityLockPercent)+'%';
    var lockPolicy=status.allowUnknownLiquidityLockInPaper?'Unknown allowed':'Unknown blocks';
    var minimumLiquidity=status.minimumLiquidityUsd==null?'not reported':'$'+Number(status.minimumLiquidityUsd).toLocaleString('en-US');
    var verificationNote=verification.confirmationMs?'<div class="footer-note">Compounding paper entries Â· fresh pool checks with a 7.5-second confirmation wait Â· '+minimumLiquidity+' minimum liquidity Â· reject drops over 20% Â· exact pool lock and reserves required'+(check?' Â· Last check: '+esc(check.symbol)+' â '+esc(check.reason):'')+'</div>':'';
    return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">PROFIT SNIPER Â· SCANNER</div><div class="panel-subtitle">'+esc(source)+'</div></div><span class="badge">'+(status.running?'SCANNING':'STOPPED')+'</span></div><div class="kpi-grid">'+kpi('AUTO SCAN',status.running?'ON':'OFF','Every 30 seconds')+kpi('POSITION CHECK',esc((Number(status.positionMonitorIntervalMs)||5000)/1000)+' sec','Up to 3 open slots')+kpi('LP LOCK FLOOR',lockFloor,'RugCheck confirmed Â· '+lockPolicy)+kpi('RECENT POOLS',pools,'Trending and top pools within the 10-minute to 24-hour window')+kpi('MOMENTUM QUALIFIED',candidateCount,'Awaiting pool verification')+kpi('LAST SCAN',esc(last),'Puerto Rico time')+'</div>'+error+verificationNote+'</div>';
  }
  function renderPositions(system) {
    if(system.id==='stock'){
      var stockRows=system.positions.map(function(item){
        var p=item.position||item,l=item.live||item,symbol=p.symbol||'-';
        return '<tr><td class="text-left"><strong>'+esc(symbol)+'</strong></td><td>'+money(p.costBasisUsd)+'</td><td>'+tradePrice(p.entryPrice)+'</td><td>'+tradePrice(l.priceUsd)+'</td><td class="'+signClass(l.pnl)+'">'+money(l.pnl)+'</td><td>'+pct(l.pnlPercent)+'</td><td>'+duration(l.holdTimeMs)+'</td><td><a class="dex-link" href="https://finance.yahoo.com/quote/'+encodeURIComponent(symbol)+'" target="_blank" rel="noopener noreferrer">VIEW STOCK â</a></td></tr>';
      });
      return '<div class="table-panel live-trading-panel"><div class="table-head"><div><h2>OPEN STOCK POSITIONS Â· '+esc(system.label)+'</h2><span class="sub">Stocks and ETFs currently held in paper trading</span></div><span class="badge">PAPER</span></div>'+table(['STOCK / ETF','INVESTED','ENTRY PRICE','CURRENT PRICE','UNREALIZED P&L','RETURN','HOLD TIME','STOCK CHART'],stockRows,'No open stock positions right now')+'</div>';
    }
    var rows=system.positions.map(function(x){return livePositionRow(system.label,x,'');});
    return '<div class="table-panel live-trading-panel"><div class="table-head"><div><h2>LIVE TRADING NOW Â· '+esc(system.label)+'</h2><span class="sub">Coins currently held by this bot</span></div><span class="badge">PAPER</span></div>'+table(['BOT','GENESIS / SWARM','COIN','INVESTED','ENTRY PRICE','CURRENT PRICE','UNREALIZED P&L','RETURN','HOLD TIME','DEXSCREENER'],rows,'This bot has no open position right now')+'</div>';
  }
  function tradePrice(value) { var price=n(value);return price===null||price<=0?'Not recorded':'$'+price.toFixed(8); }

  function groupTable(groups,headers) {
    return table(headers,groups.map(function(g){var cells=[g.label,int(g.metrics?g.metrics.trades:g.trades)];if(headers.length===3)cells.push(money(g.metrics?g.metrics.netPnl:g.pnl));return '<tr>'+cells.map(function(c,i){return '<td class="'+(i===0?'text-left':'')+'">'+c+'</td>';}).join('')+'</tr>';}),'No records');
  }
  function histogram(trades) {
    var buckets=[['â¤ â50%',-Infinity,-50],['â50% to â20%',-50,-20],['â20% to 0%',-20,0],['0% to 20%',0,20],['20% to 50%',20,50],['â¥ 50%',50,Infinity]];
    return table(['RETURN BUCKET','TRADES','NET P&L'],buckets.map(function(b){var rows=trades.filter(function(t){return t.returnPercent!=null&&t.returnPercent>=b[1]&&t.returnPercent<b[2];});var m=metrics(rows);return '<tr><td class="text-left">'+b[0]+'</td><td>'+int(m.trades)+'</td><td class="'+signClass(m.netPnl)+'">'+money(m.netPnl)+'</td></tr>';}),'No completed trades');
  }
  function renderEntryExitAnalytics(trades) {
    var entries=byGroup(trades,function(t){return t.entryReason;}), exits=exitGroups(trades);
    var times=byTime(trades);
    var token=byGroup(trades,function(t){return t.token;});
    return '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">ENTRY SIGNAL PERFORMANCE</div><div class="panel-subtitle">Existing recorded entry labels only</div></div></div>'+table(['ENTRY','TRADES','WINS','LOSSES','WIN RATE','NET P&L','AVG RETURN','PF'],entries.map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+int(x.metrics.wins)+'</td><td>'+int(x.metrics.losses)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+pct(x.metrics.averageReturn)+'</td><td>'+metric(x.metrics.profitFactor,function(v){return v===Infinity?'â':v.toFixed(2);})+'</td></tr>';}),'No entry labels persisted')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">EXIT REASON ANALYTICS</div><div class="panel-subtitle">Aggregated from recorded sale events</div></div></div>'+table(['EXIT REASON','TRADES','WIN RATE','TOTAL P&L','AVG P&L','AVG RETURN','AVG HOLD'],exits.map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+money(x.metrics.averageTrade)+'</td><td>'+pct(x.metrics.averageReturn)+'</td><td>'+duration(x.metrics.averageHoldMs)+'</td></tr>';}),'No exit labels persisted')+'</div></div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY HOUR</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(times.hours,['HOUR','TRADES','NET P&L'])+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY DAY OF WEEK</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(times.weekdays,['DAY','TRADES','NET P&L'])+'</div></div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">TOKEN LEADERBOARD</div><div class="panel-subtitle">Most profitable tokens from recorded completed trades</div></div></div>'+table(['TOKEN','TRADES','WINS','LOSSES','WIN RATE','CAPITAL','NET P&L','AVG HOLD','BEST','WORST'],token.map(function(x){var rows=trades.filter(function(t){return t.token===x.label;}),m=x.metrics;return '<tr class="click-row" data-route="/transactions?token='+encodeURIComponent(x.label)+'"><td class="text-left">'+esc(x.label)+'</td><td>'+int(m.trades)+'</td><td>'+int(m.wins)+'</td><td>'+int(m.losses)+'</td><td>'+metric(m.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td>'+money(m.capitalDeployed)+'</td><td class="'+signClass(m.netPnl)+'">'+money(m.netPnl)+'</td><td>'+duration(m.averageHoldMs)+'</td><td>'+money(m.best)+'</td><td>'+money(m.worst)+'</td></tr>'; }),'No token history')+'</div>';
  }
  function byTime(trades) {
    var hourFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',hour:'2-digit',hourCycle:'h23'}),dayFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',weekday:'long'});
    var hours={},weekdays={};events(trades).forEach(function(e){var d=new Date(e.time),h=hourFmt.format(d)+':00',w=dayFmt.format(d);(hours[h]||(hours[h]=[])).push(e.trade);(weekdays[w]||(weekdays[w]=[])).push(e.trade);});
    return {hours:Object.keys(hours).sort().map(function(k){return {label:k,metrics:metrics(hours[k])};}),weekdays:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].filter(function(k){return weekdays[k];}).map(function(k){return {label:k,metrics:metrics(weekdays[k])};})};
  }

  function renderAnalytics() {
    var t=tradesForRange(),m=metrics(t), botMetric=state.compareMetric;
    var rows=comparisonSystems().map(function(s){var sm=metrics(s.trades.filter(function(x){return inRange(x,state.range);}));var value=botMetric==='NET P&L'?money(sm.netPnl):botMetric==='RETURN %'?pct(sm.returnPercent):botMetric==='WIN RATE'?metric(sm.winRate,function(x){return x.toFixed(1)+'%';}):botMetric==='TRADE COUNT'?int(sm.trades):metric(sm.profitFactor,function(x){return x===Infinity?'â':x.toFixed(2);});return '<tr class="click-row" data-open-system="'+s.id+'"><td class="text-left">'+esc(s.label)+'</td><td>'+value+'</td><td>'+int(sm.trades)+'</td><td class="'+signClass(sm.netPnl)+'">'+money(sm.netPnl)+'</td></tr>';});
    $('view').innerHTML=pageHead('Analytics','Compare results and inspect why recorded trades won or lost.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">BOT PERFORMANCE COMPARISON</div><div class="panel-subtitle">Metric selector changes the comparison measure</div></div><div class="right segmented">'+['NET P&L','RETURN %','WIN RATE','PROFIT FACTOR','TRADE COUNT'].map(function(x){return '<button data-compare="'+x+'" class="'+(x===botMetric?'active':'')+'">'+x+'</button>';}).join('')+'</div></div>'+table(['BOT / STRATEGY','SELECTED METRIC','TRADES','NET P&L'],rows,'No completed trades')+'</div>'+comparisonBars()+'<div class="grid-2 section-gap"><div class="panel"><div class="panel-head"><div><div class="panel-title">ENTRY SIGNAL PERFORMANCE</div><div class="panel-subtitle">Which recorded entry categories returned money</div></div></div>'+table(['ENTRY','TRADES','WIN RATE','NET P&L','AVG RETURN'],byGroup(t,function(x){return x.entryReason;}).map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+pct(x.metrics.averageReturn)+'</td></tr>';}),'No entry labels persisted')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">EXIT REASONS</div><div class="panel-subtitle">P&L contribution by recorded exit</div></div></div>'+table(['EXIT','TRADES','WIN RATE','NET P&L','AVG HOLD'],exitGroups(t).map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+duration(x.metrics.averageHoldMs)+'</td></tr>';}),'No exit labels persisted')+'</div></div><div class="grid-2 section-gap"><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY HOUR</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(byTime(t).hours,['HOUR','TRADES','NET P&L'])+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY DAY OF WEEK</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(byTime(t).weekdays,['DAY','TRADES','NET P&L'])+'</div></div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">WIN / LOSS / BREAKEVEN CONTRIBUTION</div></div></div>'+splitContribution(t)+'</div>';
  }

  function comparisonBars() { var rows=comparisonSystems().map(function(s){var m=metrics(s.trades.filter(function(t){return inRange(t,state.range);})),v=state.compareMetric==='NET P&L'?m.netPnl:state.compareMetric==='RETURN %'?m.returnPercent:state.compareMetric==='WIN RATE'?m.winRate:state.compareMetric==='TRADE COUNT'?m.trades:m.profitFactor;return {label:s.label,value:v};}),finite=rows.map(function(x){return Math.abs(n(x.value)||0);}),max=Math.max(1,...finite);return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">BOT PERFORMANCE CHART</div><div class="panel-subtitle">'+esc(state.compareMetric)+' Â· selected time range</div></div></div><div class="metric-bar-list">'+rows.map(function(x){var v=n(x.value),width=x.value===Infinity?100:v===null?0:Number.isFinite(v)?Math.max(2,Math.abs(v)/max*100):100;return '<div class="metric-bar-row"><span>'+esc(x.label)+'</span><div class="metric-bar-track"><i class="'+signClass(v)+'" style="width:'+width+'%"></i></div><strong class="'+signClass(v)+'">'+(v===null?(x.value===Infinity?'â':'Not recorded'):state.compareMetric==='TRADE COUNT'?int(v):state.compareMetric==='RETURN %'||state.compareMetric==='WIN RATE'?pct(v):state.compareMetric==='PROFIT FACTOR'&&v===Infinity?'â':money(v))+'</strong></div>';}).join('')+'</div></div>'; }
  function swarmSlots() { return state.swarm && Array.isArray(state.swarm.slots) ? state.swarm.slots : []; }
  function families() { var map={};swarmSlots().forEach(function(s){var id=s.genesisId||s.swarmId; if(id && /^G\d+$/.test(id))(map[id]||(map[id]=[])).push(s);});return Array.from(new Set(['G1','G2','G3','G4','G5'].concat(Object.keys(map)))).sort().map(function(id){return {id:id,slots:map[id]||[]};}); }
  function renderSwarm(path) {
    var bits=path.split('/').filter(Boolean), tab=(bits[1]||'overview').replace(/-/g,' ').toUpperCase();state.swarmTab=tab;
    var sw=state.swarm||{}, slots=swarmSlots(), familiesList=families();
    var tabs=['OVERVIEW','GENESIS','LIVE SWARMS','GENEALOGY','REPRODUCTION','PERFORMANCE','TRANSACTIONS'];
    var html='<div class="tab-row">'+tabs.map(function(x){return '<button data-route="/swarm/'+x.toLowerCase().replace(/ /g,'-')+'" class="'+(x===tab?'active':'')+'">'+x+'</button>';}).join('')+'</div>';
    if(tab==='OVERVIEW') html='<div class="kpi-grid">'+kpi('TOTAL SWARMS',int(sw.totalSwarms),'Tracked swarms')+kpi('ACTIVE SWARMS',sw.running?int(slots.length):'0',sw.running?'Running':'Stopped')+kpi('ATTACKING',int(slots.filter(function(s){return !!s.position;}).length),'Open positions')+kpi('GROWING',int(slots.filter(function(s){return s.growthStatus==='GROWING_TOWARD_NEXT_CHILD';}).length),'Working toward next child')+kpi('TOTAL SWARM EQUITY',money(sw.totalCapital),'Current capital')+kpi("TODAY'S SWARM P&L",money(todayPnl(realizedEventsFor({id:'swarm'}))),'Realized exits')+kpi('ALL-TIME SWARM P&L',money(sw.totalPnl),'Current equity less starting capital',signClass(sw.totalPnl))+kpi('POCKETED PROFIT',money(sw.pocketedProfit),'All time')+kpi('REINVESTED PROFIT',money(sw.reinvestedProfit),'All time')+kpi('CHILD CAPITAL',money(sw.reproductionAllocated),'All time')+kpi('TOTAL CHILDREN',int(sw.childrenCreated),'All generations')+kpi('MAX GENERATION',int(Math.max(0,...slots.map(function(s){return n(s.generation)||0;}))),'Observed descendants')+'</div><div class="section-title">GENESIS FAMILIES</div><div class="family-grid">'+familiesList.map(familyCard).join('')+'</div><div class="grid-2 section-gap"><div class="panel"><div class="panel-head"><div><div class="panel-title">SWARM MONEY FLOW</div><div class="panel-subtitle">Existing allocation methodology Â· observed ledger totals</div></div></div>'+flowPanel(sw)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">NEXT REPRODUCTION OPPORTUNITIES</div><div class="panel-subtitle">25% of pre-spawn capital remains protected</div></div></div>'+reproductionList(slots.slice(0,6))+'</div></div>';
    else if(tab==='GENESIS') { var selectedFamily=bits[2]&&familiesList.find(function(f){return f.id===bits[2];});if(selectedFamily){var fm=familyMetrics(selectedFamily.slots);html='<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">'+esc(selectedFamily.id)+' FAMILY</div><div class="panel-subtitle">Totals use recorded swarm genealogy and account fields.</div></div><span class="badge">PAPER</span></div><div class="kpi-grid">'+kpi('FAMILY EQUITY',money(fm.equity))+kpi('FAMILY P&L',money(fm.pnl),null,signClass(fm.pnl))+kpi('DESCENDANTS',int(fm.descendants))+kpi('TRADES',int(fm.trades))+kpi('WIN RATE',metric(fm.winRate,function(x){return x.toFixed(1)+'%';}))+kpi('MAX GENERATION',int(fm.maxGen))+'</div><div class="section-title">FAMILY SWARMS</div>'+swarmTable(selectedFamily.slots)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">FAMILY LINEAGE</div><div class="panel-subtitle">Select a recorded swarm to inspect its children and reproduction plan.</div></div></div>'+table(['SWARM','PARENT','GENERATION','LOCAL X','CAPITAL','REALIZED P&L','CHILDREN'],selectedFamily.slots.map(function(s){return '<tr class="click-row" data-route="/swarm/genealogy/'+encodeURIComponent(s.swarmId)+'"><td class="text-left">'+esc(s.swarmId)+'</td><td>'+esc(s.parentId||'ROOT')+'</td><td>'+int(s.generation)+'</td><td>'+money(s.localX)+'</td><td>'+money(s.capital)+'</td><td class="'+signClass(s.realizedProfit)+'">'+money(s.realizedProfit)+'</td><td>'+int((s.children||[]).length)+'</td></tr>'; }),'Family records are unavailable in the current feed.')+'</div></div>';}else html='<div class="family-grid">'+familiesList.map(familyCard).join('')+'</div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">GENESIS FAMILY COMPARISON</div><div class="panel-subtitle">Family totals are grouped by the stored genesisId.</div></div></div>'+familyTable(familiesList)+'</div>'; }
    else if(tab==='LIVE SWARMS') html=swarmTable(slots.filter(function(s){return s.position;}));
    else if(tab==='GENEALOGY') html=genealogyView(bits[2]||state.selectedNode);
    else if(tab==='REPRODUCTION') html=reproductionView(slots.find(function(s){return s.swarmId===(bits[2]||state.selectedNode);})||slots[0]);
    else if(tab==='PERFORMANCE') html=swarmPerformance(slots);
    else html=renderTransactions(swarmTransactions(),true);
    $('view').innerHTML=pageHead('Swarm','Every swarm is an independent root with its own reproduction plan. '+(sw.running?'RUNNING':'STOPPED'),'<span class="badge">'+esc(sw.mode||'PAPER')+'</span>')+html+(tab==='OVERVIEW'?swarmCostSimulationPanel():'');
  }
  function swarmTrades() {
    var rows=state.swarm&&state.swarm.executions||[];
    return rows.filter(function(r){return !!r.closedTrade;}).map(function(r){
      var t=Object.assign({},r.closedTrade,{pnl:r.closedTrade.realizedPnl,entryLiquidityUsd:r.entryLiquidityUsd});
      return normalizeTrade(t,{name:'Swarm',id:'swarm'},true);
    });
  }
  function swarmTransactions() {
    var x=state.swarm&&Array.isArray(state.swarm.executions)?state.swarm.executions:[];
    return x.map(function(r){
      var closed=r.closedTrade||{}, buy=(state.swarm.executions||[]).find(function(b){return b.type==='BUY'&&b.positionId===r.positionId;})||{};var type=String(r.type||'TRADE').toUpperCase(),saleValue=n(r.saleValue??r.amountReceived),pnl=n(r.pnl);
      var invested=n(r.amountInvested??r.invested??r.amount);
      if(type==='SELL'&&invested===null&&saleValue!==null&&pnl!==null)invested=saleValue-pnl;
      var returnPercent=n(r.pnlPercent??r.returnPercent);
      if(type==='SELL'&&returnPercent===null&&invested!==null&&invested>0&&pnl!==null)returnPercent=pnl/invested*100;
      return Object.assign({},r,{system:'Swarm Â· V3.1',systemId:'swarm',type:type,time:r.time||null,exitTime:r.exitTime||r.time||null,
        entryTime:r.entryTime||closed.entryTime||buy.time||null,entryPrice:r.entryPrice||closed.entryPrice||buy.price||null,exitPrice:type==='SELL'?r.price:null,holdTimeMs:type==='SELL'&&(r.entryTime||closed.entryTime||buy.time)?Date.parse(r.time)-Date.parse(r.entryTime||closed.entryTime||buy.time):null,token:r.symbol||'-',pnl:pnl,invested:invested,amountInvested:invested,saleValue:saleValue,amountReceived:saleValue,
        returnPercent:returnPercent,exitReason:r.reason||'Not recorded',entryReason:r.entrySignal||'Not recorded'});
    });
  }
  function familyCard(f) { var m=familyMetrics(f.slots);return '<div class="family-card" data-route="/swarm/genesis/'+f.id+'"><h3>'+f.id+'</h3><strong class="'+signClass(m.pnl)+'">'+money(m.pnl)+'</strong><small>FAMILY EQUITY '+money(m.equity)+'</small><small>'+int(m.descendants)+' DESCENDANTS Â· '+int(m.trades)+' TRADES</small><small>MAX GEN '+int(m.maxGen)+' Â· WIN RATE '+metric(m.winRate,function(x){return x.toFixed(1)+'%';})+'</small></div>'; }
  function familyMetrics(slots) { var sum=function(key){var values=slots.map(function(x){return n(x[key]);}).filter(function(x){return x!==null;});return values.length?values.reduce(function(a,b){return a+b;},0):null;},pnl=sum('realizedProfit'),equity=sum('capital'),trades=sum('completedTrades'),wins=sum('winners'),gens=slots.map(function(x){return n(x.generation);}).filter(function(x){return x!==null;});var root=slots.find(function(s){return !s.parentId;});var basis=n(root&&root.localX);return {returnPercent:basis>0&&equity!==null?(equity-basis)/basis*100:null,pnl:pnl,equity:equity,descendants:slots.length?Math.max(0,slots.length-1):null,trades:trades,wins:wins,winRate:trades>0&&wins!==null?wins/trades*100:null,maxGen:gens.length?Math.max.apply(null,gens):null}; }
  function familyTable(fs) { return table(['GENESIS','FAMILY EQUITY','FAMILY P&L','RETURN','DESCENDANTS','TRADES','WIN RATE','MAX GEN'],fs.map(function(f){var m=familyMetrics(f.slots);return '<tr class="click-row" data-route="/swarm/genesis/'+f.id+'"><td class="text-left">'+f.id+'</td><td>'+money(m.equity)+'</td><td class="'+signClass(m.pnl)+'">'+money(m.pnl)+'</td><td>'+pct(m.returnPercent)+'</td><td>'+int(m.descendants)+'</td><td>'+int(m.trades)+'</td><td>'+metric(m.winRate,function(x){return x.toFixed(1)+'%';})+'</td><td>'+int(m.maxGen)+'</td></tr>'; }),'No Genesis swarms found'); }
  function flowPanel(sw) { var f=sw.profitAllocation||{reinvest:50,pocket:25,reproduction:25};return '<div class="split-flow"><div class="split-item"><span>REINVEST Â· '+int(f.reinvest)+'%</span><strong>'+money(sw.reinvestedProfit)+'</strong></div><div class="split-item"><span>POCKET Â· '+int(f.pocket)+'%</span><strong>'+money(sw.pocketedProfit)+'</strong></div><div class="split-item"><span>CHILD FUND Â· '+int(f.reproduction)+'%</span><strong>'+money(sw.reproductionAllocated)+'</strong></div></div><div class="footer-note">Accounting reflects the existing Swarm records; this view does not change allocation behavior.</div>'; }
  function reproductionList(slots) { var rows=slots.map(function(s){var next=s.nextChild||{};var pass=!!(s.reproductionEligible||next.eligible);return '<tr class="click-row" data-route="/swarm/reproduction/'+encodeURIComponent(s.swarmId)+'"><td class="text-left">'+esc(s.swarmId)+'</td><td>'+money(s.localX)+'</td><td>'+int(next.multiplier)+'</td><td>'+money(next.cost)+'</td><td>'+money(s.capital)+'</td><td><span class="badge '+(pass?'':'amber')+'">'+(pass?'PASS':'GROWING')+'</span></td></tr>';});return table(['SWARM','LOCAL X','NEXT MULTIPLIER','REQUIRED CAPITAL','CURRENT CAPITAL','75% GATE'],rows,'No swarm records'); }
  function swarmTable(slots) { return '<div class="table-panel"><div class="table-head"><h2>LIVE SWARMS</h2><span class="sub">Current position and capital state</span></div>'+table(['SWARM','PARENT','GENESIS','GENERATION','LOCAL X','TOKEN','INVESTED','UNREALIZED P&L','STATUS'],slots.map(function(s){return '<tr class="click-row" data-route="/swarm/reproduction/'+encodeURIComponent(s.swarmId)+'"><td class="text-left">'+esc(s.swarmId)+'</td><td>'+esc(s.parentId||'ROOT')+'</td><td>'+esc(s.genesisId||'-')+'</td><td>'+int(s.generation)+'</td><td>'+money(s.localX)+'</td><td>'+esc(s.position&&s.position.symbol||'-')+'</td><td>'+money(s.position&&s.position.amountInvested)+'</td><td class="'+signClass(s.live&&s.live.pnl)+'">'+money(s.live&&s.live.pnl)+'</td><td>'+esc(s.growthStatus||'ACTIVE')+'</td></tr>'; }),'No open Swarm positions')+'</div>'; }
  function genealogyView(id) { var slots=swarmSlots(),node=slots.find(function(s){return s.swarmId===id;});if(!node)return '<div class="notice">This swarm is not present in the currently loaded state.</div>';state.selectedNode=id;var children=(node.children||[]).map(function(cid){return slots.find(function(s){return s.swarmId===cid;});}).filter(Boolean);var crumb=[];var cur=node;while(cur){crumb.unshift(cur.swarmId);cur=slots.find(function(s){return s.swarmId===cur.parentId;});}var rows=children.map(function(s){return '<div class="tree-node" data-route="/swarm/genealogy/'+encodeURIComponent(s.swarmId)+'"><span class="tree-toggle">âº</span><b>'+esc(s.swarmId)+'</b><span class="muted">X '+money(s.localX)+'</span><span class="muted">GEN '+int(s.generation)+'</span><span class="muted" style="margin-left:auto">'+int((s.children||[]).length)+' CHILDREN</span></div>';});return '<div class="panel"><div class="panel-head"><div><div class="panel-title">GENEALOGY</div><div class="panel-subtitle">Loaded node: '+crumb.map(esc).join(' &gt; ')+'</div></div><a class="button small" href="/swarm/genesis/'+encodeURIComponent(node.genesisId||'G1')+'" data-route="/swarm/genesis">FAMILY ROOT</a></div><div class="tree-node selected"><span class="tree-toggle">â</span><b>'+esc(node.swarmId)+'</b><span class="muted">LOCAL X '+money(node.localX)+'</span><span class="muted">OWN PYRAMID Â· '+Math.max(0,25-(node.nextChildIndex||0))+' CHILD SLOTS LEFT</span></div><div class="tree-indent">'+(rows.length?rows.join(''):'<div class="empty"><strong>No recorded descendants yet</strong>Children load only when this node exists in saved lineage.</div>')+'</div></div>'; }
  function reproductionView(s) { if(!s)return '<div class="empty"><strong>No Swarm state available</strong>Not recorded</div>';var next=s.nextChild||{},current=n(s.capital),cost=n(next.cost),after=current!==null&&cost!==null?current-cost:null,ret=current&&after!==null?after/current*100:null,gate=!!(s.reproductionEligible||next.eligible);return '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">REPRODUCTION INSPECTOR</div><div class="panel-subtitle">Selected swarm '+esc(s.swarmId)+'</div></div><span class="badge '+(gate?'':'amber')+'">'+(gate?'75% GATE PASS':'GROWING TOWARD NEXT CHILD')+'</span></div><div class="four-col">'+kpi('PARENT',esc(s.parentId||'ROOT'))+kpi('GENESIS',esc(s.genesisId||'-'))+kpi('GENERATION',int(s.generation))+kpi('LOCAL X',money(s.localX))+kpi('CURRENT CAPITAL',money(s.capital))+kpi('REALIZED P&L',money(s.realizedProfit),null,signClass(s.realizedProfit))+kpi('REINVESTED PROFIT',money(s.reinvestedProfit))+kpi('POCKETED PROFIT',money(s.pocketedProfit))+kpi('CHILD CAPITAL',money(s.reproductionBalance))+kpi('NEXT MULTIPLIER',int(next.multiplier))+kpi('REQUIRED CHILD CAPITAL',money(cost))+kpi('PRE-SPAWN CAPITAL',money(next.parentCapital||s.capital))+kpi('POST-SPAWN CAPITAL',money(after))+kpi('POST-SPAWN RETENTION',pct(ret))+'</div><div class="section-title">75% RETENTION GATE</div><div class="retention-bar"><i style="width:'+Math.max(0,Math.min(100,ret||0))+'%"></i></div><p class="footer-note">When the next child is not eligible, this swarm remains operational and continues trading. Current status is derived from the existing reproduction data.</p></div><div class="panel"><div class="panel-head"><div><div class="panel-title">NEXT CHILD SLOT</div><div class="panel-subtitle">This plan belongs to '+esc(s.swarmId)+'; the swarm is outside the plan.</div></div></div>'+reproductionList([s])+'</div></div>'; }
  function swarmPerformance(slots) { var byGen={},byX={},byMulti={};slots.forEach(function(s){var g='Generation '+(s.generation||0),x=(s.localX||0)+' local X',m=(s.formationMultiplier||1)+'X';(byGen[g]||(byGen[g]=[])).push(s);(byX[x]||(byX[x]=[])).push(s);(byMulti[m]||(byMulti[m]=[])).push(s);});var tableFor=function(map){return table(['GROUP','SWARMS','TRADES','REALIZED P&L','EQUITY'],Object.keys(map).map(function(k){var list=map[k],p=list.reduce(function(a,s){return a+(n(s.realizedProfit)||0);},0),e=list.reduce(function(a,s){return a+(n(s.capital)||0);},0),t=list.reduce(function(a,s){return a+(n(s.completedTrades)||0);},0);return '<tr><td class="text-left">'+esc(k)+'</td><td>'+int(list.length)+'</td><td>'+int(t)+'</td><td class="'+signClass(p)+'">'+money(p)+'</td><td>'+money(e)+'</td></tr>'; }),'No Swarm records');};return '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY GENESIS</div></div></div>'+familyTable(families())+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY GENERATION</div></div></div>'+tableFor(byGen)+'</div></div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY LOCAL X</div></div></div>'+tableFor(byX)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY FORMATION MULTIPLIER</div></div></div>'+tableFor(byMulti)+'</div></div>'+swarmTable(slots); }

  function transactionRow(t,index) {
    var rowId=t.positionId||t.id||index,type=String(t.type||'TRADE').toUpperCase();
    var closed=type==='SELL'||type==='CLOSED TRADE'||type==='CLOSED'||(!!t.exitTime&&type!=='BUY');
    var dex=closed?transactionDexScreenerLink(t):null;
    var dexLink=closed?'<a class="dex-link" data-dex-link href="'+esc(dex.href)+'" title="'+esc(dex.hint)+'" aria-label="'+esc(dex.label)+'" target="_blank" rel="noopener noreferrer">'+dex.label+'</a>':'';
    var token=esc(t.token||t.symbol||t.name||'-');
    var buy=type==='BUY',invested=t.invested??t.amountInvested??t.amount,received=t.saleValue??t.amountReceived,pnl=t.pnl,returnPercent=t.pnlPercent??t.returnPercent;
    return '<tr class="click-row" data-transaction="'+esc(rowId)+'" data-tx-index="'+index+'"><td>'+dateTime(t.time||t.exitTime||t.entryTime)+'</td><td class="text-left">'+esc(t.system||'-')+'</td><td class="text-left">'+esc(t.swarmId||'-')+'</td><td class="text-left"><strong>'+token+'</strong>'+(closed?'<div class="closed-dex-link">'+dexLink+'</div>':'')+'</td><td>'+esc(t.type||'TRADE')+'</td><td>'+money(invested)+'</td><td>'+(buy?'â':money(received))+'</td><td class="'+signClass(pnl)+'">'+(buy?'â':money(pnl))+'</td><td>'+(buy?'â':pct(returnPercent))+'</td><td class="text-left">'+esc(t.entryReason||'Not recorded')+'</td><td class="text-left">'+esc(t.exitReason||t.reason||'Not recorded')+'</td></tr>';
  }
  function renderTransactions(source, compact) {
    var list=(source||allTransactions).slice();
    var params=new URLSearchParams(location.search), q=(params.get('q')||'').toLowerCase();
    if(state.systemFilter!=='ALL')list=list.filter(function(t){return t.systemId===state.systemFilter||t.system===state.systemFilter;});
    if(state.outcomeFilter==='WIN')list=list.filter(function(t){return n(t.pnl)>0;});
    if(state.outcomeFilter==='LOSS')list=list.filter(function(t){return n(t.pnl)<0;});
    if(state.outcomeFilter==='BREAKEVEN')list=list.filter(function(t){return n(t.pnl)===0;});
    if(state.tokenFilter||params.get('token')){var tokenQuery=(params.get('token')||state.tokenFilter).toLowerCase();list=list.filter(function(t){return (t.token||t.symbol||'').toLowerCase().includes(tokenQuery)||(t.tokenAddress||'').toLowerCase().includes(tokenQuery);});}
    ['dateFrom','dateTo','strategy','swarmId','genesisId','generation','entryReason','exitReason','returnMin','returnMax','pnlMin','pnlMax'].forEach(function(key){var val=params.get(key);if(!val)return;list=list.filter(function(t){if(key==='dateFrom'||key==='dateTo'){var tm=Date.parse(t.time||t.exitTime||t.entryTime||'');return Number.isFinite(tm)&&(key==='dateFrom'?tm>=Date.parse(val+'T00:00:00'):tm<Date.parse(val+'T00:00:00')+86400000);}if(key==='returnMin')return n(t.returnPercent??t.pnlPercent)!==null&&n(t.returnPercent??t.pnlPercent)>=Number(val);if(key==='returnMax')return n(t.returnPercent??t.pnlPercent)!==null&&n(t.returnPercent??t.pnlPercent)<=Number(val);if(key==='pnlMin')return n(t.pnl)!==null&&n(t.pnl)>=Number(val);if(key==='pnlMax')return n(t.pnl)!==null&&n(t.pnl)<=Number(val);if(key==='generation')return String(t.generation??'')===val;return String(t[key]??'')===val;});});
    var dayFilter=params.get('day');if(dayFilter){var fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit',day:'2-digit'});list=list.filter(function(t){var tm=t.time||t.exitTime||t.entryTime;return tm&&fmt.format(new Date(tm))===dayFilter;});}
    if(q)list=list.filter(function(t){return JSON.stringify(t).toLowerCase().includes(q);});
    var pages=Math.max(1,Math.ceil(list.length/PAGE_SIZE));state.page=Math.min(state.page,pages);visibleTransactions=list;
    var start=(state.page-1)*PAGE_SIZE, shown=list.slice(start,start+PAGE_SIZE);
    var rows=shown.map(function(t,i){return transactionRow(t,start+i);});
    var qv=function(key){return esc(params.get(key)||'');};
    var valueOptions=function(key){var vals=Array.from(new Set(allTransactions.map(function(t){return String(t[key]??'');}).filter(Boolean))).sort();return '<option value="">All '+key.replace(/([A-Z])/g,' $1').toLowerCase()+'</option>'+vals.map(function(v){return '<option value="'+esc(v)+'" '+(params.get(key)===v?'selected':'')+'>'+esc(v)+'</option>';}).join('');};
    return (compact?'':'<div class="filter-row section-gap"><input id="tokenFilter" class="input" placeholder="Filter token / mint" value="'+esc(params.get('token')||state.tokenFilter)+'"><select id="systemFilter" class="select"><option value="ALL">All systems</option>'+systems.map(function(s){return '<option value="'+s.id+'" '+(state.systemFilter===s.id?'selected':'')+'>'+esc(s.label)+'</option>';}).join('')+'<option value="swarm" '+(state.systemFilter==='swarm'?'selected':'')+'>Swarm</option></select><select class="select" data-filter="strategy">'+valueOptions('strategy')+'</select><select class="select" data-filter="mode">'+valueOptions('mode')+'</select><select id="outcomeFilter" class="select"><option value="ALL">All outcomes</option><option value="WIN" '+(state.outcomeFilter==='WIN'?'selected':'')+'>Win</option><option value="LOSS" '+(state.outcomeFilter==='LOSS'?'selected':'')+'>Loss</option><option value="BREAKEVEN" '+(state.outcomeFilter==='BREAKEVEN'?'selected':'')+'>Breakeven</option></select><input type="date" class="input" data-filter="dateFrom" value="'+qv('dateFrom')+'" aria-label="From date"><input type="date" class="input" data-filter="dateTo" value="'+qv('dateTo')+'" aria-label="To date"><select class="select" data-filter="swarmId">'+valueOptions('swarmId')+'</select><select class="select" data-filter="genesisId">'+valueOptions('genesisId')+'</select><select class="select" data-filter="generation">'+valueOptions('generation')+'</select><select class="select" data-filter="entryReason">'+valueOptions('entryReason')+'</select><select class="select" data-filter="exitReason">'+valueOptions('exitReason')+'</select><input type="number" step="0.01" class="input" data-filter="returnMin" placeholder="Min return %" value="'+qv('returnMin')+'"><input type="number" step="0.01" class="input" data-filter="returnMax" placeholder="Max return %" value="'+qv('returnMax')+'"><input type="number" step="0.01" class="input" data-filter="pnlMin" placeholder="Min P&L" value="'+qv('pnlMin')+'"><input type="number" step="0.01" class="input" data-filter="pnlMax" placeholder="Max P&L" value="'+qv('pnlMax')+'"><input id="searchFilter" class="input" placeholder="Search existing transaction fields"></div>')+
      '<div class="table-panel section-gap"><div class="table-head"><h2>TRANSACTION LEDGER</h2><span class="sub">'+int(list.length)+' rows Â· page '+state.page+' of '+pages+'</span><div class="table-tools"><button class="button small" data-export="csv">EXPORT CSV</button></div></div>'+table(['TIME','BOT / STRATEGY','SWARM','TOKEN','TYPE','INVESTED','RECEIVED','P&L','RETURN','ENTRY','EXIT'],rows,'No transactions found')+'<div class="pagination"><span>Showing '+(list.length?start+1:0)+'â'+Math.min(start+PAGE_SIZE,list.length)+' of '+list.length+'</span><button data-page="prev" '+(state.page<=1?'disabled':'')+'>PREVIOUS</button><button data-page="next" '+(state.page>=pages?'disabled':'')+'>NEXT</button></div></div>'+(list.some(function(t){return t.limitedHistory;})?'<div class="notice">At least one source only exposes recent trades. Earlier records are unavailable in its current read-only feed.</div>':'');
  }
  function streakMetrics(trades) { var rows=trades.filter(function(t){return n(t.pnl)!==null&&t.exitTime;}).slice().sort(function(a,b){return Date.parse(a.exitTime)-Date.parse(b.exitTime);}),wins=0,losses=0,maxWins=0,maxLosses=0;rows.forEach(function(t){if(t.pnl>0){wins++;losses=0;maxWins=Math.max(maxWins,wins);}else if(t.pnl<0){losses++;wins=0;maxLosses=Math.max(maxLosses,losses);}else{wins=0;losses=0;}});return {currentWins:rows.length&&rows[rows.length-1].pnl>0?wins:0,currentLosses:rows.length&&rows[rows.length-1].pnl<0?losses:0,maxWins:maxWins,maxLosses:maxLosses}; }
  function calendarMarkup(trades) { var month=state.calendarMonth;if(!month){var now=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit'}).format(new Date());month=now;state.calendarMonth=month;}var bits=month.split('-'),year=Number(bits[0]),mon=Number(bits[1]),first=new Date(Date.UTC(year,mon-1,1)),offset=(first.getUTCDay()+6)%7,count=new Date(Date.UTC(year,mon,0)).getUTCDate(),pnl={};daily(trades).forEach(function(x){pnl[x.date]=x.pnl;});var cells=Array.from({length:offset},function(){return '<div class="calendar-blank"></div>';});for(var day=1;day<=count;day++){var key=year+'-'+String(mon).padStart(2,'0')+'-'+String(day).padStart(2,'0'),v=pnl[key],klass=v===undefined?'':signClass(v);cells.push('<div class="calendar-day '+klass+'" '+(v===undefined?'':'data-day="'+key+'" title="Open transactions for '+key+'"')+'><span>'+day+'</span><strong>'+(v===undefined?'â':money(v))+'</strong></div>');}var prev=new Date(Date.UTC(year,mon-2,1)).toISOString().slice(0,7),next=new Date(Date.UTC(year,mon,1)).toISOString().slice(0,7);return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">REALIZED P&L CALENDAR</div><div class="panel-subtitle">Recorded sale P&L Â· select a day to open its transactions</div></div><div class="calendar-nav"><button class="button small" data-calendar-month="'+prev+'">â</button><input type="month" class="input" data-calendar-month-select value="'+month+'"><button class="button small" data-calendar-month="'+next+'">â</button></div></div><div class="calendar-weekdays">'+['MON','TUE','WED','THU','FRI','SAT','SUN'].map(function(x){return '<span>'+x+'</span>';}).join('')+'</div><div class="calendar-grid">'+cells.join('')+'</div></div>'; }
  function renderReports() {
    var t=tradesForRange(),m=metrics(t),realizedPeriod=allRealizedEvents.filter(function(e){return inRange(e,state.range);}),realizedPnl=realizedTotal(realizedPeriod);
    var bots=comparisonSystems().map(function(s){return {name:s.label,value:realizedTotal(realizedEventsFor(s))};}).filter(function(x){return x.value!==null;}).sort(function(a,b){return b.value-a.value;});
    var tokens=byGroup(t,function(x){return x.token;}).filter(function(x){return x.metrics.netPnl!==null;}).sort(function(a,b){return b.metrics.netPnl-a.metrics.netPnl;});
    var swarms=swarmSlots().slice().sort(function(a,b){return (n(b.realizedProfit)||0)-(n(a.realizedProfit)||0);});
    var rankingRows=[];
    if(bots.length){rankingRows.push('<tr><td class="text-left">BEST BOT</td><td class="text-left">'+esc(bots[0].name)+'</td><td class="positive">'+money(bots[0].value)+'</td></tr>');rankingRows.push('<tr><td class="text-left">WORST BOT</td><td class="text-left">'+esc(bots[bots.length-1].name)+'</td><td class="negative">'+money(bots[bots.length-1].value)+'</td></tr>');}
    if(tokens.length){rankingRows.push('<tr><td class="text-left">BEST TOKEN</td><td class="text-left">'+esc(tokens[0].label)+'</td><td class="positive">'+money(tokens[0].metrics.netPnl)+'</td></tr>');rankingRows.push('<tr><td class="text-left">WORST TOKEN</td><td class="text-left">'+esc(tokens[tokens.length-1].label)+'</td><td class="negative">'+money(tokens[tokens.length-1].metrics.netPnl)+'</td></tr>');}
    if(swarms.length){rankingRows.push('<tr><td class="text-left">BEST SWARM</td><td class="text-left">'+esc(swarms[0].swarmId)+'</td><td class="positive">'+money(swarms[0].realizedProfit)+'</td></tr>');rankingRows.push('<tr><td class="text-left">WORST SWARM</td><td class="text-left">'+esc(swarms[swarms.length-1].swarmId)+'</td><td class="negative">'+money(swarms[swarms.length-1].realizedProfit)+'</td></tr>');}
    $('view').innerHTML=pageHead('Reports','Period summaries from actual saved records. No estimated history.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+'<div class="kpi-grid">'+kpi('STARTING EQUITY',money(sumKnown(comparisonSystems().map(function(s){return n(s.account.startingBalance)||null;}))))+kpi('ENDING EQUITY',money(sumKnown(comparisonSystems().map(function(s){return s.equity;}))))+kpi('NET P&L',money(realizedPnl),'Recorded sale events',signClass(realizedPnl))+kpi('CLOSED-TRADE RETURN',pct(m.returnPercent),null,signClass(m.returnPercent))+kpi('TRADES',int(m.trades))+kpi('WIN RATE',metric(m.winRate,function(x){return x.toFixed(1)+'%';}))+kpi('PROFIT FACTOR',metric(m.profitFactor,function(x){return x===Infinity?'â':x.toFixed(2); }))+kpi('AVERAGE WIN',money(m.averageWin))+kpi('AVERAGE LOSS',money(m.averageLoss))+kpi('LARGEST WIN',money(m.best))+kpi('LARGEST LOSS',money(m.worst))+kpi('CURRENT WIN STREAK',int(streakMetrics(t).currentWins))+kpi('CURRENT LOSS STREAK',int(streakMetrics(t).currentLosses))+kpi('AVG CAPITAL AT RISK',function(){var vals=t.filter(function(x){return n(x.pnl)!==null;}).map(function(x){return n(x.invested);});return vals.length&&vals.every(function(x){return x!==null;})?money(vals.reduce(function(a,b){return a+b;},0)/vals.length):'Not recorded';}())+'</div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">BEST / WORST SYSTEMS</div><div class="panel-subtitle">Bot, token, and individual Swarm results</div></div></div>'+table(['RANK','BOT / TOKEN / SWARM','NET P&L'],rankingRows,'Not enough history')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">DRAWDOWN</div><div class="panel-subtitle">Realized P&L proxy; historical equity snapshots are unavailable</div></div></div>' +realizedDrawdown(realizedPeriod)+'</div></div>'+calendarMarkup(allRealizedEvents);
  }
    function realizedDrawdown(trades) { var d=OneCoinAnalytics.drawdownFromRealizedPnl(trades);if(!d)return '<div class="empty"><strong>Not recorded</strong>Equity history is collected automatically from this update onward.</div>';return '<div class="two-col"><div class="mini-metric"><span>CURRENT REALIZED DRAWDOWN</span><strong>'+money(d.currentDrawdown)+'</strong></div><div class="mini-metric"><span>MAX REALIZED DRAWDOWN</span><strong>'+money(d.maxDrawdown)+'</strong></div></div><p class="footer-note">Drawdown basis: '+esc(d.basis)+'. It is a realized P&L proxy, not an equity curve.</p>'; }
    function renderSettings() {
    var sw=state.swarm||{};var rows=comparisonSystems().map(function(s){return '<tr><td class="text-left">'+esc(s.label)+'</td><td><span class="badge">PAPER</span></td><td>'+esc(s.running?'RUNNING':'STOPPED')+'</td><td>'+int(s.trades.length)+(s.historyLimited?' recent':'')+'</td></tr>';});
    $('view').innerHTML=pageHead('Settings','Data sources and dashboard refresh preferences.')+'<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">CONNECTED SYSTEMS</div><div class="panel-subtitle">Source status from current read-only feeds</div></div></div>'+table(['SYSTEM','MODE','STATUS','KNOWN HISTORY'],rows,'No connected systems')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">DATA QUALITY</div><div class="panel-subtitle">Known persistence limits</div></div></div><div class="notice">Recorded execution costs appear where available; older trades may lack saved liquidity.</div><div class="notice">Equity snapshots are saved every five minutes from this update onward. Earlier equity marks and historical price candles are unavailable.</div><div class="notice">Swarm exposes its full saved ledger, capped at 2,000 events; older removed events cannot be recovered.</div><label class="filter-row"><input type="checkbox" id="autoRefresh" checked> Auto-refresh read-only data every 30 seconds</label></div></div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">REFRESH</div><div class="panel-subtitle">Refresh analytics only; this does not change bot behavior</div></div><button class="button primary" data-action="refresh">REFRESH NOW</button></div><div class="footer-note">Dashboard time display: America/Puerto_Rico. All sources currently identify as paper trading.</div></div>';
  }

  function render() {
    buildSystems(); var path=currentRoute();setActiveNav(path);
    $('navSwarmCount').textContent=state.swarm?String(state.swarm.totalSwarms||0):'â';
    $('connectionText').textContent=state.error?'PARTIAL FEED':'CONNECTED';$('connectionText').parentNode.className='connection '+(state.error?'error':'connected');
    if(path==='/')renderHome();
    else if(path.indexOf('/trading/')===0)renderBot(path);
    else if(path==='/swarm'||path.indexOf('/swarm/')===0)renderSwarm(path);
    else if(path==='/analytics')renderAnalytics();
    else if(path==='/transactions'){$('view').innerHTML=pageHead('Transactions','Searchable ledger of available paper trading records.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+renderTransactions();}
    else if(path==='/reports')renderReports();
    else if(path==='/settings')renderSettings();
    else {$('view').innerHTML=pageHead('Page not found','Choose a workspace from the sidebar.');}
  }

  var refreshInFlight = null;
  function loadData() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = Promise.allSettled([request('/api/data'),request('/api/swarm'),request('/api/status')]).then(function(results){
      state.error=null;
      if(results[0].status==='fulfilled')state.api=results[0].value;else state.error='Bot history feed unavailable.';
      if(results[1].status==='fulfilled')state.swarm=results[1].value;else state.error=(state.error?state.error+' ':'')+'Swarm feed unavailable.';
      if(results[2].status==='fulfilled')state.status=results[2].value;else state.error=(state.error?state.error+' ':'')+'V3.1 status unavailable.';
      $('lastUpdated').textContent='Updated '+new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',hour:'2-digit',minute:'2-digit'}).format(new Date());
      render();
    }).finally(function () { refreshInFlight = null; });
    return refreshInFlight;
  }

  function openTransaction(index) {
    var list=visibleTransactions,t=list[index];if(!t)return;
    var raw=t.sourceRecord||t;
    var entryPrice=t.entryPrice??t.buyPrice??raw.entryPrice??raw.buyPrice??t.price;
    var fields=[['Bot / strategy',t.system],['Strategy',t.strategy],['Mode',t.mode||'PAPER'],['Swarm ID',t.swarmId||'Not applicable'],['Parent',t.parentId||'Not recorded'],['Genesis',t.genesisId||'Not recorded'],['Generation',t.generation],['Token',t.token||t.symbol],['Entry time',dateTime(t.entryTime)],['Exit time',dateTime(t.exitTime||t.time)],['Hold duration',duration(t.holdMs)],['Capital invested',money(t.invested||t.amountInvested||t.amount)],['Entry price',priceValue(entryPrice)],['Exit price',priceValue(t.exitPrice||t.price)],['Amount received',money(t.saleValue||t.amountReceived)],['Estimated fees',t.estimatedFeesUsd==null?'Not recorded':money(t.estimatedFeesUsd)],['Estimated slippage',t.estimatedSlippageUsd==null?'Not recorded':money(t.estimatedSlippageUsd)],['Gross P&L',t.grossPnl==null&&t.pnlGross==null?'Not recorded':money(t.grossPnl??t.pnlGross)],['Net P&L',money(t.netPnl??t.pnl)],['Return',pct(t.returnPercent??t.pnlPercent)],['Entry reason',t.entryReason||'Not recorded'],['Exit reason',t.exitReason||t.reason||'Not recorded']];
    var raw=t.sourceRecord||t;
    $('detailDrawer').innerHTML='<div class="drawer-top"><div><div class="eyebrow">TRANSACTION DETAIL</div><h2>'+esc(t.token||t.symbol||'Trade')+'</h2></div><button class="icon-button" data-action="close-drawer">Ã</button></div><div class="detail-grid">'+fields.map(function(x){return '<div class="detail-field"><span>'+esc(x[0])+'</span><strong>'+esc(x[1]===null||x[1]===undefined?'Not recorded':x[1])+'</strong></div>';}).join('')+'</div><details class="raw-record"><summary>ALL SAVED TRANSACTION FIELDS</summary><pre>'+esc(JSON.stringify(raw,null,2))+'</pre></details><div class="footer-note">Transaction detail uses fields present in saved records. No missing values are estimated.</div>';
    $('drawerBackdrop').classList.remove('hidden');$('detailDrawer').classList.add('open');$('detailDrawer').setAttribute('aria-hidden','false');
  }
  function priceValue(value) { var x=n(value);return x===null?'Not recorded':'$'+x.toFixed(8); }
    function closeDrawer() {$('drawerBackdrop').classList.add('hidden');$('detailDrawer').classList.remove('open');$('detailDrawer').setAttribute('aria-hidden','true');}
  function routeForSystem(id) { return id==='v31'?'/trading/v31':id==='candle'?'/trading/candle-breakout':id==='buy-test'?'/trading/buy-priority-test':id==='exit-test'?'/trading/buy-priority-exit-test':id==='profit-sniper'?'/trading/profit-sniper':id==='stock'?'/trading/stock':id==='outcome'?'/trading/outcome':id==='gemini'?'/trading/gemini':id==='swarm'?'/swarm':'/trading/v31'; }

  function csvCell(value) {
    if(value===null||value===undefined)return '';
    var textValue=String(value);
    if(typeof value==='string'&&/^\s*[=+@-]/.test(textValue))textValue="'"+textValue;
    return '"'+textValue.replace(/"/g,'""')+'"';
  }
  function exportCsv() {
    var rows=Array.isArray(visibleTransactions)?visibleTransactions:[];
    var headers=['TIME','BOT / STRATEGY','STRATEGY','MODE','TOKEN','TOKEN ADDRESS','PAIR ADDRESS','TYPE','SWARM','GENESIS','ENTRY TIME','EXIT TIME','HOLD MINUTES','INVESTED USD','RECEIVED USD','ENTRY PRICE','EXIT PRICE','FEES USD','SLIPPAGE USD','GROSS P&L USD','NET P&L USD','RETURN %','ENTRY REASON','EXIT REASON'];
    var csvRows=[headers].concat(rows.map(function(trade){
      var source=trade.sourceRecord||{};
      var field=function(keys){
        for(var i=0;i<keys.length;i++){
          var key=keys[i];
          if(trade[key]!==undefined&&trade[key]!==null&&trade[key]!=='')return trade[key];
          if(source[key]!==undefined&&source[key]!==null&&source[key]!=='')return source[key];
        }
        return '';
      };
      var holdMs=field(['holdMs','holdTimeMs']);
      var holdMinutes=holdMs===''?'':(Number(holdMs)/60000).toFixed(2);
      return [
        field(['time','exitTime','entryTime']),field(['system','systemId']),field(['strategy','strategyVersion']),field(['mode']),
        field(['token','symbol','name']),field(['tokenAddress','mint','tokenMint']),field(['pairAddress']),field(['type']),
        field(['swarmId']),field(['genesisId']),field(['entryTime']),field(['exitTime']),holdMinutes,
        field(['invested','amountInvested','amount']),field(['saleValue','amountReceived']),field(['entryPrice','buyPrice']),
        field(['exitPrice','sellPrice']),field(['estimatedFeesUsd','feesUsd','actualFeesUsd']),
        field(['estimatedSlippageUsd','slippageUsd']),field(['grossPnl','pnlGross']),field(['netPnl','pnl']),
        field(['returnPercent','pnlPercent']),field(['entryReason','entrySignal']),field(['exitReason','reason'])
      ];
    }));
    var csv='\uFEFF'+csvRows.map(function(row){return row.map(csvCell).join(',');}).join('\r\n');
    var blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    var url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;
    link.download='transactions-'+new Date().toISOString().slice(0,10)+'.csv';
    link.style.display='none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }

  document.addEventListener('click',function(event){
    var stockExport=event.target.closest('[data-stock-export]');if(stockExport){exportStockCsv(stockExport.getAttribute('data-stock-export'));return;}
    var stockPage=event.target.closest('[data-stock-page]');if(stockPage){state.stockPage=Math.max(1,(state.stockPage||1)+(stockPage.getAttribute('data-stock-page')==='next'?1:-1));render();return;}
    if(event.target.closest('[data-stock-clear]')){state.stockFilters={};state.stockPage=1;render();return;}
    if(event.target.closest('[data-dex-link]'))return;
    var routeEl=event.target.closest('[data-route]');if(routeEl){event.preventDefault();navigate(routeEl.getAttribute('data-route'));$('sidebar').classList.remove('open');return;}
    var range=event.target.closest('[data-range]');if(range){state.range=range.getAttribute('data-range');state.page=1;render();return;}
    var chart=event.target.closest('[data-chart]');if(chart){state.chartMetric=chart.getAttribute('data-chart');render();return;}
    var compare=event.target.closest('[data-compare]');if(compare){state.compareMetric=compare.getAttribute('data-compare');render();return;}
    var overlay=event.target.closest('[data-overlay]');if(overlay){state.chartOverlays=state.chartOverlays||{};var overlayId=overlay.getAttribute('data-overlay');state.chartOverlays[overlayId]=state.chartOverlays[overlayId]===false;render();return;}
    var open=event.target.closest('[data-open-system]');if(open){var destination=routeForSystem(open.getAttribute('data-open-system'));navigate(destination);return;}
    var tx=event.target.closest('[data-tx-index]');if(tx){openTransaction(Number(tx.getAttribute('data-tx-index')));return;}
    var day=event.target.closest('[data-day]');if(day){state.selectedDay=day.getAttribute('data-day');state.systemFilter='ALL';state.outcomeFilter='ALL';navigate('/transactions?day='+encodeURIComponent(state.selectedDay));return;}
    var pg=event.target.closest('[data-page]');if(pg){state.page=Math.max(1,state.page+(pg.getAttribute('data-page')==='next'?1:-1));render();return;}
    var action=event.target.closest('[data-action]');if(action){var act=action.getAttribute('data-action');if(act==='close-drawer')closeDrawer();if(act==='refresh')loadData();return;}
    var control=event.target.closest('[data-control]');if(control){
      var verb=control.getAttribute('data-control');
      if(verb==='gemini/close-position'&&!window.confirm('Close the open Gemini paper position at the current market price?'))return;
      if(verb==='gemini/live/start'&&!window.confirm('Start live Gemini trading? This allows new real $5 wallet trades.'))return;
      if(verb==='gemini/live/stop'&&!window.confirm('Stop new live Gemini entries? Any real open position will remain exit-managed.'))return;
      control.disabled=true;
      request('/api/'+verb,{method:'POST',headers:{'x-bot-control':'1'}})
        .then(function(result){
          if(verb==='close-all-paper-positions'){
            var failures=(result.results||[]).filter(function(row){return !row.success;}).length;
            state.controlNotice=failures
              ? 'Closed '+int(result.closedCount)+' paper positions; '+int(failures)+' could not be closed.'
              : 'Closed '+int(result.closedCount)+' open paper positions.';
          } else if(verb==='gemini/live/start'||verb==='gemini/live/stop'){
            state.controlNotice=result.message||'Gemini live trading setting updated.';
          } else if(verb==='gemini/close-position'){
            state.controlNotice=result.message||'Gemini position closed in paper mode.';
          } else if(verb==='gemini/close-position') {
            state.controlNotice=result.message||'Gemini paper position closed.';
          } else {
            state.controlNotice=result.writeOff
              ? (result.symbol||'Position')+' closed in paper mode with $0 recovery because no tradable liquidity was available; the slot is free.'
              : (result.symbol||'Position')+' closed in paper mode; the slot is free.';
          }
          return loadData();
        })
        .catch(function(error){
          state.controlNotice=error.message||'Paper close failed. The position remains open.';
          render();
        })
        .finally(function(){if(control.isConnected)control.disabled=false;});
      return;
    }
    var exportButton=event.target.closest('[data-export]');if(exportButton){exportCsv();return;}
  });
  document.addEventListener('change',function(event){
    if(event.target.matches('[data-stock-filter]')){state.stockFilters=state.stockFilters||{};state.stockFilters[event.target.getAttribute('data-stock-filter')]=event.target.value;state.stockPage=1;render();return;}
    if(event.target.matches('[data-filter]')){var url=new URL(location.href),filterKey=event.target.getAttribute('data-filter');if(event.target.value)url.searchParams.set(filterKey,event.target.value);else url.searchParams.delete(filterKey);history.replaceState({},'',url);state.page=1;render();return;}
    if(event.target.id==='systemFilter'){state.systemFilter=event.target.value;state.page=1;render();}
    if(event.target.id==='outcomeFilter'){state.outcomeFilter=event.target.value;state.page=1;render();}
    if(event.target.id==='tokenFilter'){var tokenUrl=new URL(location.href);tokenUrl.searchParams.delete('token');history.replaceState({},'',tokenUrl);state.tokenFilter=event.target.value;state.page=1;render();}
    if(event.target.id==='searchFilter'){var u=new URL(location.href);u.searchParams.set('q',event.target.value);history.replaceState({},'',u);state.page=1;render();}
    if(event.target.id==='autoRefresh'){state.autoRefresh=event.target.checked;}
  });
  window.addEventListener('popstate',render);
  $('refreshButton').addEventListener('click',loadData);
  $('menuToggle').addEventListener('click',function(){$('sidebar').classList.toggle('open');});
  $('drawerBackdrop').addEventListener('click',closeDrawer);
  loadData();
  document.addEventListener('visibilitychange',function(){if(!document.hidden && state.autoRefresh!==false)loadData();});
  window.addEventListener('online',function(){if(state.autoRefresh!==false)loadData();});
  setInterval(function(){if(!document.hidden && state.autoRefresh!==false)loadData();},30000);
})();



