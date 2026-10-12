(function () {
  'use strict';

  var state = {
    api: null, swarm: null, status: null, error: null, range: 'ALL',
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
    raw=raw||{};fallback=fallback||{};
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
    var rows=(system.trades||[]).map(function(t){var raw=t.sourceRecord||t;var estimate=estimateTradeCosts(raw,{invested:t.invested,pnl:t.pnl,entryLiquidityUsd:t.entryLiquidityUsd});
      return estimate?{token:t.token||raw.symbol||'—',time:t.exitTime||t.time||null,...estimate}:null;}).filter(Boolean);
    var fees=rows.reduce(function(sum,x){return sum+x.feesUsd;},0);
    var knownSlippage=rows.filter(function(x){return x.slippageUsd!==null;}).reduce(function(sum,x){return sum+x.slippageUsd;},0);
    var complete=rows.length>0&&rows.every(function(x){return x.slippageUsd!==null;});
    var gross=rows.reduce(function(sum,x){return sum+x.grossPnl;},0);
    return {rows:rows,count:rows.length,feesUsd:fees,slippageUsd:complete?knownSlippage:null,missingSlippage:rows.filter(function(x){return x.slippageUsd===null;}).length,
      netPnl:complete?gross-fees-knownSlippage:null,grossPnl:gross,complete:complete};
  }
  function costSimulationPanel(system) {
    var c=simulateBotCosts(system),unit=system.label==='Swarm'?'SELL events':'completed trades';
    var note=c.count?(c.complete?'All listed '+unit.toLowerCase()+' have entry liquidity data for this estimate.':c.missingSlippage+' of '+c.count+' records lack saved entry liquidity; estimated slippage and net P&L are unavailable.'): 'No completed trade records are available for a cost estimate yet.';
    var rows=c.rows.map(function(x){return '<tr><td class="text-left">'+esc(x.token)+'</td><td>'+dateTime(x.time)+'</td><td>'+money(x.grossPnl)+'</td><td>'+money(x.feesUsd)+'</td><td>'+money(x.slippageUsd)+'</td><td class="'+signClass(x.netPnl)+'">'+money(x.netPnl)+'</td></tr>';});
    return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">SIMULATED FEES &amp; SLIPPAGE</div><div class="panel-subtitle">Reporting-only estimate · '+int(c.count)+' '+unit+'</div></div><span class="badge">PAPER MODEL</span></div><div class="kpi-grid">'+kpi('GROSS P&amp;L',money(c.grossPnl),'Recorded exits')+kpi((system.id==='buy-test'||system.id==='exit-test')?'EST. FEES incl. PRIORITY':'EST. NETWORK + POOL FEES',money(c.feesUsd),(system.id==='buy-test'||system.id==='exit-test')?'0.30% pool + $0.01 Solana + $0.01 priority per swap':'0.30% per swap + $0.01 per transaction')+kpi('EST. SLIPPAGE',c.complete?money(c.slippageUsd):'NOT ENOUGH DATA','Approx. pool impact at trade size')+kpi('EST. NET P&amp;L',c.complete?money(c.netPnl):'NOT ENOUGH DATA','Gross P&L minus modeled costs',c.complete?signClass(c.netPnl):'neutral')+'</div><div class="footer-note">'+esc(note)+' Assumptions: 0.30% pool fee per swap, $0.01 Solana network fee per transaction, and constant-product impact from saved entry liquidity. Estimates only; existing bot rules and account balances are unchanged.</div>'+table(['TOKEN','EXIT TIME','GROSS P&amp;L','EST. FEES','EST. SLIPPAGE','EST. NET P&amp;L'],rows,'No completed trades to estimate')+'</div>';
  }
  function swarmCostSimulationSystem() {
    var executions=state.swarm&&Array.isArray(state.swarm.executions)?state.swarm.executions:[];
    var buys=new Map();executions.filter(function(x){return x.type==='BUY';}).forEach(function(x){buys.set(x.positionId||x.id,x);});
    var groups=new Map();
    executions.filter(function(x){return x.type==='SELL';}).forEach(function(sell,index){var key=sell.positionId||'unpaired-'+index;var group=groups.get(key);
      if(!group){var buy=buys.get(sell.positionId);group={buy:buy,sells:[],grossPnl:0,token:sell.symbol||'—',time:sell.time||sell.exitTime};groups.set(key,group);}
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
    var lockData=state.api&&state.api.buyPriorityLock85||{};
    var lockSystem={id:'buy-lock85',name:'V3.1 BUY Priority Test · 80% LP Lock',label:'V3.1 BUY Priority Test · 80% Lock'};
    lockSystem.trades=(lockData.completedTrades||[]).map(function(t){return normalizeTrade(t,lockSystem,false);});
    entries.push({label:lockSystem.label,sim:simulateBotCosts(lockSystem)});
    entries.push({label:'Swarm · V3.1',sim:simulateBotCosts(swarmCostSimulationSystem())});
    var rows=entries.map(function(entry){var c=entry.sim;return '<tr><td class="text-left"><strong>'+esc(entry.label)+'</strong></td><td>'+int(c.count)+'</td><td>'+money(c.count?c.feesUsd:null)+'</td><td>'+ (c.count&&c.complete?money(c.slippageUsd):'NOT ENOUGH DATA')+'</td><td class="'+signClass(c.netPnl)+'">'+(c.count&&c.complete?money(c.netPnl):'NOT ENOUGH DATA')+'</td></tr>';});
    return '<div class="table-panel section-gap"><div class="table-head"><div><h2>SIMULATED FEES &amp; SLIPPAGE · ALL BOTS</h2><span class="sub">At-a-glance paper estimates from each bot’s recorded trades</span></div><span class="badge">REPORTING ONLY</span></div>'+table(['BOT','TRADES / EVENTS','EST. NETWORK + POOL FEES','EST. SLIPPAGE','EST. NET P&amp;L'],rows,'No bot records are available')+'<div class="footer-note">Assumptions: 0.30% pool fee per swap, $0.01 network fee per transaction, and approximate price impact using saved entry liquidity. “Not enough data” means the bot feed lacks completed trades or liquidity needed for a slippage estimate. Strategy rules and current account figures are unchanged.</div></div>';
  }
  function $(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (s) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[s]; }); }
  function n(value) { if(value===null||value===undefined||value==='')return null;var x = Number(value); return Number.isFinite(x) ? x : null; }
  function money(value) { var x = n(value); return x === null ? 'NOT ENOUGH DATA' : currencyFmt.format(x); }
  function pct(value) { var x = n(value); return x === null ? 'NOT ENOUGH DATA' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%'; }
  function int(value) { var x = n(value); return x === null ? 'NOT ENOUGH DATA' : numberFmt.format(x); }
  function signClass(value) { var x = n(value); return x === null || x === 0 ? 'neutral' : (x > 0 ? 'positive' : 'negative'); }
  function shortDate(value) { var d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { timeZone:'America/Puerto_Rico', month:'short', day:'2-digit' }).format(d); }
  function dateTime(value) { var d = new Date(value); return Number.isNaN(d.getTime()) ? 'NOT ENOUGH DATA' : new Intl.DateTimeFormat('en-US', { timeZone:'America/Puerto_Rico', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(d); }
  function duration(ms) { var x = n(ms); if (x === null || x < 0) return 'NOT ENOUGH DATA'; var m = Math.floor(x / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; }
  function metric(value, format) { return value === null || value === undefined ? 'NOT ENOUGH DATA' : format(value); }
  function request(url, options) {
    return fetch(url, Object.assign({ cache:'no-store', credentials:'same-origin' }, options || {})).then(function (response) {
      if (!response.ok) throw new Error(url + ' returned ' + response.status);
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
      { id:'v31', name:'V3.1', label:'V3.1 Original', data:api.v31, status:state.status, mode:'PAPER' },
      { id:'candle', name:'Bit V 3.1 40% TP1', label:'Bit V 3.1 40% TP1', data:api.candleBreakout, status:api.candleBreakoutStatus, mode:'PAPER' },
      { id:'lab', name:'B3.1 Lab', label:'B3.1 Lab', data:api.profitabilityLab, status:{ running:api.profitabilityLab && api.profitabilityLab.running }, mode:'PAPER', limited:true },
      { id:'buy-test', name:'New Claude Strategy', label:'New Claude Strategy', data:api.buyPriorityTest, status:api.buyPriorityTestStatus, mode:'PAPER' },
      { id:'exit-test', name:'New Claude Exit Test', label:'New Claude Exit Test', data:api.buyPriorityExitTest, status:api.buyPriorityExitTestStatus, mode:'PAPER' }
    ];
    systems = input.map(function (s) {
      var d = s.data || {};
      var trades = Array.isArray(d.completedTrades) ? d.completedTrades : (Array.isArray(d.recentTrades) ? d.recentTrades : []);
      var normalized = trades.map(function (t) { return normalizeTrade(t, s, s.limited && !d.completedTrades); });
      return Object.assign({}, s, { account:d, trades:normalized, positions:d.livePositions || d.openPositions || [],
        equity:n(d.equity), totalPnl:n(d.totalPnl), totalPnlPercent:n(d.totalPnlPercent), cashBalance:n(d.cashBalance),
        running:!!(s.status && s.status.running), historyLimited:!!(s.limited && !d.completedTrades) });
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
  function todayPnl(trades) { var today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());var row=daily(trades).find(function(x){return x.date===today;});return row?row.pnl:null; }
  function chartSeries() { if(state.chartMetric==='EQUITY')return [];var fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit',day:'2-digit'}),seriesSystems=comparisonSystems(),dateMap={},bySystem={},days=({'1D':1,'TODAY':1,'7D':7,'30D':30,'90D':90})[state.range],cutoff=days?fmt.format(new Date(Date.now()-days*86400000)):null;seriesSystems.forEach(function(s){var sums={};events(realizedEventsFor(s)).forEach(function(e){var day=fmt.format(new Date(e.time));sums[day]=(sums[day]||0)+e.pnl;dateMap[day]=true;});bySystem[s.id]=sums;});var allDates=Object.keys(dateMap).sort(),dates=allDates.filter(function(d){return !cutoff||d>=cutoff;});if(!dates.length)return [];var chosen=seriesSystems.filter(function(s){return !state.chartOverlays||state.chartOverlays[s.id]!==false;});if(!state.chartOverlays||state.chartOverlays.total!==false)chosen.unshift({id:'total',label:'TOTAL'});return chosen.map(function(s){var running=0;if(state.chartMetric==='CUMULATIVE P&L'&&cutoff)allDates.filter(function(d){return d<cutoff;}).forEach(function(d){running+=s.id==='total'?seriesSystems.reduce(function(sum,x){return sum+(bySystem[x.id][d]||0);},0):(bySystem[s.id][d]||0);});var points=dates.map(function(day){var value=s.id==='total'?seriesSystems.reduce(function(sum,x){return sum+(bySystem[x.id][day]||0);},0):(bySystem[s.id][day]||0);if(state.chartMetric!=='DAILY P&L'){running+=value;value=running;}return {label:day,value:value};});return {label:s.label||s.name,points:points};}); }
    function overlayButtons() { var ss=comparisonSystems(),items=[{id:'total',label:'TOTAL'}].concat(ss.map(function(s){return {id:s.id,label:s.label};}));return items.map(function(x){var on=!state.chartOverlays||state.chartOverlays[x.id]!==false;return '<button class="overlay-pill '+(on?'active':'')+'" data-overlay="'+x.id+'">'+esc(x.label)+'</button>';}).join(''); }
  function svgMultiLine(series,label) { var active=series.filter(function(s){return s.points.length;});if(!active.length)return '<div class="empty"><strong>'+ (state.chartMetric==='EQUITY'?'Historical equity snapshots were not persisted.':'No realized history for the selected range.')+'</strong>NOT ENOUGH DATA</div>';var all=active.reduce(function(a,s){return a.concat(s.points.map(function(p){return p.value;}));},[]),min=Math.min.apply(null,all),max=Math.max.apply(null,all);if(min===max){min-=1;max+=1;}var w=760,h=220,pad=30,grid='';for(var z=0;z<4;z++){var y=pad+z*(h-pad*2)/3;grid+='<line x1="'+pad+'" y1="'+y+'" x2="'+(w-pad)+'" y2="'+y+'" class="chart-grid"/><text x="0" y="'+(y+3)+'" class="chart-label">'+money(max-(max-min)*z/3)+'</text>';}var paths=active.map(function(s,i){var points=s.points.map(function(p,j){return [pad+(s.points.length>1?j*(w-pad*2)/(s.points.length-1):0),h-pad-(p.value-min)/(max-min)*(h-pad*2)];});return '<path class="chart-line chart-line-'+(i%5)+'" d="'+points.map(function(p,j){return (j?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ')+'"><title>'+esc(s.label)+'</title></path>';}).join('');return '<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+esc(label)+'">'+grid+paths+'</svg><div class="chart-legend">'+active.map(function(s,i){return '<span><i class="legend-'+(i%5)+'"></i>'+esc(s.label)+'</span>';}).join('')+'</div>'; }
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
  function pageHead(title, subtitle, actions) {
    return '<div class="page-head"><div><div class="eyebrow">ONE COIN / PAPER OPERATIONS</div><h1>'+title+'</h1><p>'+subtitle+'</p></div><div class="head-actions">'+(actions||'')+'</div></div>';
  }
  function kpi(label,value,note,cls,primary) {
    return '<div class="kpi-card '+(primary?'kpi-primary':'')+'"><div class="kpi-label">'+label+'</div><div class="kpi-value mono '+(cls||'')+'">'+value+'</div>'+(note?'<div class="kpi-note">'+note+'</div>':'')+'</div>';
  }
  function systemIcon(id){return id==='v31'?'V3':id==='candle'?'B3':id==='lab'?'LB':id==='buy-test'?'BUY':id==='exit-test'?'XT':'SW';}
  function systemRow(s) {
    var m=metrics(s.trades);
    return '<tr class="click-row" data-open-system="'+s.id+'"><td><div class="system-name"><span class="system-mark">'+systemIcon(s.id)+'</span>'+esc(s.label)+' <span class="badge">PAPER</span></div></td><td>'+int(m.trades)+'</td><td>'+int(m.wins)+'</td><td>'+int(m.losses)+'</td><td>'+metric(m.winRate,function(x){return x.toFixed(1)+'%';})+'</td><td>'+money(m.grossProfit)+'</td><td>−'+money(m.grossLoss)+'</td><td class="'+signClass(m.netPnl)+'">'+money(m.netPnl)+'</td><td>'+pct(m.returnPercent)+'</td><td>'+money(m.averageTrade)+'</td><td>'+money(m.averageWin)+'</td><td>'+money(m.averageLoss)+'</td><td>'+metric(m.profitFactor,function(x){return x===Infinity?'∞':x.toFixed(2);})+'</td><td>'+money(m.best)+'</td><td>'+money(m.worst)+'</td><td>'+duration(m.averageHoldMs)+'</td><td>'+money(m.capitalDeployed)+'</td><td><span class="status-line '+(s.running?'':'offline')+'"><i></i>'+(s.running?'RUNNING':'STOPPED')+'</span></td></tr>';
  }
  function dexScreenerAddress(position, live) {
    return position.pairAddress || live.pairAddress || position.tokenAddress || live.tokenAddress || position.mint || live.mint || position.tokenMint || live.tokenMint || '';
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
    var address=transactionDexScreenerAddress(trade);
    if(address) return {href:'https://dexscreener.com/solana/'+encodeURIComponent(address),label:'OPEN DEXSCREENER ↗',hint:'Opens this token or pair directly on DexScreener.'};
    var source=trade.sourceRecord||{};
    var query=trade.symbol||trade.tokenSymbol||trade.token||trade.name||trade.tokenName||source.symbol||source.tokenSymbol||source.token||source.name||source.tokenName||'';
    query=String(query).trim();
    return {href:query?'https://dexscreener.com/search?q='+encodeURIComponent(query):'https://dexscreener.com/search',
      label:query?'SEARCH DEXSCREENER ↗':'OPEN DEXSCREENER ↗',
      hint:query?'Search by token name because this older trade has no saved address. Verify the result.':'Open DexScreener search; this older trade has no saved token name or address.'};
  }
  function livePositionRow(source, item, swarmId) {
    var position=item.position||item, live=item.live||item, address=dexScreenerAddress(position,live);
    var token=position.symbol||position.name||position.tokenSymbol||live.symbol||'-';
    var link=address?'<a class="dex-link" href="https://dexscreener.com/solana/'+encodeURIComponent(address)+'" target="_blank" rel="noopener noreferrer">OPEN DEXSCREENER ↗</a>':'<span class="dex-unavailable">LINK UNAVAILABLE</span>';
    var pnl=live.pnl!==undefined?live.pnl:position.pnl;
    var currentPrice=live.currentPrice??live.priceUsd??position.currentPrice??position.priceUsd;
    return '<tr><td class="text-left">'+esc(source)+'</td><td class="text-left">'+esc(swarmId||position.genesisId||'-')+'</td><td class="text-left"><strong>'+esc(token)+'</strong><div class="live-token-address">'+(address?esc(address):'No token/pair address recorded')+'</div></td><td>'+money(position.amountInvested||position.invested||position.currentValue)+'</td><td>'+tradePrice(position.entryPrice??position.buyPrice)+'</td><td>'+tradePrice(currentPrice)+'</td><td class="'+signClass(pnl)+'">'+money(pnl)+'</td><td>'+pct(live.pnlPercent??position.pnlPercent)+'</td><td>'+duration(live.holdTimeMs??position.holdTimeMs)+'</td><td>'+link+'</td></tr>';
  }
  function liveTradingPanel() {
    var rows=[];
    systems.forEach(function(system){(system.positions||[]).forEach(function(position){rows.push(livePositionRow(system.label,position,''));});});
    swarmSlots().forEach(function(slot){if(slot.position)rows.push(livePositionRow('Swarm',slot,slot.genesisId||slot.swarmId||''));});
    return '<div class="table-panel live-trading-panel"><div class="table-head"><div><h2>LIVE TRADING NOW</h2><span class="sub">Open paper positions by bot · refreshed with dashboard data</span></div><span class="badge">LIVE POSITIONS</span></div>'+table(['BOT','GENESIS / SWARM','COIN','INVESTED','ENTRY PRICE','CURRENT PRICE','UNREALIZED P&L','RETURN','HOLD TIME','DEXSCREENER'],rows,'No open positions in the latest bot feeds')+'</div>';
  }
  function comparisonSystems() { var sw=state.swarm||{};return systems.concat([{id:'swarm',name:'Swarm',label:'Swarm · V3.1',mode:'PAPER',account:{startingBalance:n(sw.startingCapital)},trades:swarmTrades(),positions:swarmSlots().filter(function(x){return !!x.position;}).map(function(x){return {position:x.position,live:x.live,pnl:x.live&&x.live.pnl};}),equity:n(sw.totalCapital),totalPnl:n(sw.totalPnl),totalPnlPercent:n(sw.totalPnlPercent),running:!!sw.running,historyLimited:true}]); }
  function table(headers, rows, emptyText) {
    return '<div class="table-scroll"><table><thead><tr>'+headers.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="'+headers.length+'"><div class="empty"><strong>'+esc(emptyText||'No records available')+'</strong>NOT ENOUGH DATA</div></td></tr>')+'</tbody></table></div>';
  }
  function svgLine(series, label) {
    if (!Array.isArray(series)||!series.length) return '<div class="empty"><strong>'+(label==='EQUITY'?'Historical equity snapshots were not persisted.':'No recorded values for this period.')+'</strong>NOT ENOUGH DATA</div>';
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
    if(!rows.length)return '<div class="empty"><strong>No daily history</strong>NOT ENOUGH DATA</div>';
    return '<div class="bar-chart">'+rows.map(function(x){var pctH=Math.max(3,Math.abs(x.pnl)/max*78);var isNeg=x.pnl<0;return '<div class="bar-col" data-day="'+x.date+'" title="'+x.date+' '+money(x.pnl)+'"><span class="bar-value '+signClass(x.pnl)+'">'+money(x.pnl)+'</span><div class="bar-track"><div class="bar-zero"></div><div class="bar '+(isNeg?'negative':'')+'" style="height:'+pctH+'%;'+(isNeg?'top:50%;':'bottom:50%;')+'"></div></div><span class="bar-day">'+shortDate(x.date)+'</span></div>';}).join('')+'</div>';
  }
  function tradesForRange() { return allTrades.filter(function(t){return inRange(t,state.range);}); }
  function liveCount() { return comparisonSystems().reduce(function(s,x){return s+(Array.isArray(x.positions)?x.positions.length:0);},0); }
  function sumKnown(values) { return values.every(function(x){return n(x)!==null;})?values.reduce(function(s,x){return s+Number(x);},0):null; }
  function unrealizedTotal() { return sumKnown(comparisonSystems().map(function(s){var positions=Array.isArray(s.positions)?s.positions:[];if(!positions.length)return 0;return sumKnown(positions.map(function(p){return n(p.live&&p.live.pnl!==undefined?p.live.pnl:p.pnl);}));})); }

  function renderHome() {
    var rangeTrades=tradesForRange(), m=metrics(rangeTrades);
    var equity=sumKnown(comparisonSystems().map(function(s){return s.equity;}));
    var realized=realizedTotal(allRealizedEvents);
    var unrealized=unrealizedTotal();
    var totalPnl=sumKnown(comparisonSystems().map(function(s){return s.totalPnl;}));
    var starting=sumKnown(comparisonSystems().map(function(s){return n(s.account.startingBalance)||null;}));
    var ret=starting&&totalPnl!==null?totalPnl/starting*100:null;
    var activeBots=systems.filter(function(s){return s.running;}).length;
    var sw=state.swarm||{}, slots=Array.isArray(sw.slots)?sw.slots:[];
    var activeSwarms=sw.running?slots.length:0;
    var realizedRange=allRealizedEvents.filter(function(t){return inRange(t,state.range);});var topTrades=events(realizedRange);
    var cum=0, curve=topTrades.map(function(x){cum+=x.pnl;return {label:dateTime(x.time),value:cum};});
    var equityMaybe = state.chartMetric==='EQUITY' ? null : state.chartMetric==='DAILY P&L' ? daily(realizedRange).map(function(x){return {label:x.date,value:x.pnl};}) : state.chartMetric==='REALIZED P&L' ? topTrades.map(function(x){return {label:dateTime(x.time),value:x.pnl};}) : curve;
    var dayLimit=state.range==='1D'?1:state.range==='7D'?7:state.range==='30D'?30:state.range==='90D'?90:100000;
    var systemRows=comparisonSystems().map(systemRow);
    var kpis=[
      kpi('TOTAL EQUITY',money(equity),'Current marked value across connected accounts','neutral',true),
      kpi("TODAY'S P&L",money(todayPnl(allRealizedEvents)),'Realized sale events, Puerto Rico time',signClass(todayPnl(allRealizedEvents))),
      kpi('TOTAL REALIZED P&L',money(realized),'Recorded sale events, including partial exits',signClass(realized)),
      kpi('UNREALIZED P&L',money(unrealized),'Open positions',signClass(unrealized)),
      kpi('ALL-TIME P&L',money(totalPnl),'Current equity less starting balance',signClass(totalPnl)),
      kpi('UNRECONCILED',money(totalPnl!==null&&realized!==null&&unrealized!==null?totalPnl-realized-unrealized:null),'All-time P&L minus realized and open P&L',signClass(totalPnl!==null&&realized!==null&&unrealized!==null?totalPnl-realized-unrealized:null)),
      kpi('RETURN',pct(ret),'Across connected accounts',signClass(ret)),
      kpi('WIN RATE',metric(m.winRate,function(x){return x.toFixed(1)+'%';}),'Selected period'),
      kpi('TOTAL TRADES',int(m.trades),'Selected period'),
      kpi('ACTIVE POSITIONS',int(liveCount()),'Across connected accounts'),
      kpi('ACTIVE BOTS',int(activeBots),'Paper bots currently running'),
      kpi('ACTIVE SWARMS',int(activeSwarms),'V3.1 Swarm instance'),
      kpi('PROFIT FACTOR',metric(m.profitFactor,function(x){return x===Infinity?'∞':x.toFixed(2);}), 'Gross profit / gross loss'),
      kpi('AVG WIN',money(m.averageWin),'Per winning trade',signClass(m.averageWin)),
      kpi('AVG LOSS',money(m.averageLoss),'Per losing trade',signClass(m.averageLoss)),
      kpi('BEST TRADE',money(m.best),'Selected period',signClass(m.best)),
      kpi('WORST TRADE',money(m.worst),'Selected period',signClass(m.worst))
    ].join('');
    $('view').innerHTML=pageHead('Command Center','A live, read-only view of connected paper trading systems.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+
      liveTradingPanel()+'<div class="kpi-grid">'+kpis+'</div>'+costSummaryPanel()+statusNotice()+
      '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">ACCOUNT PERFORMANCE</div><div class="panel-subtitle">Transaction-derived cumulative realized P&L · historical equity snapshots unavailable</div></div><div class="right segmented">'+['EQUITY','REALIZED P&L','DAILY P&L','CUMULATIVE P&L'].map(function(x){return '<button data-chart="'+x+'" class="'+(state.chartMetric===x?'active':'')+'">'+x+'</button>';}).join('')+'</div></div><div class="overlay-pills">'+overlayButtons()+'</div><div class="chart-wrap">'+svgMultiLine(chartSeries(),state.chartMetric)+'</div><div class="footer-note">Connected sources are shown as one observed view. A historical equity curve is not stored, so this chart uses realized P&L events.</div></div><div class="panel"><div class="panel-head"><div><div class="panel-title">DAILY P&L</div><div class="panel-subtitle">Realized sale P&L, by Puerto Rico date</div></div><div class="right">'+rangeBar(state.range==='ALL'?'7D':state.range,['7D','30D','90D','ALL'],'range')+'</div></div>'+dailyBar(allRealizedEvents,dayLimit)+'</div></div>'+ 
      '<div class="table-panel"><div class="table-head"><h2>PERFORMANCE BY SYSTEM</h2><span class="sub">Click a row to open its workspace</span></div>'+table(['BOT / STRATEGY','TRADES','WINS','LOSSES','WIN RATE','GROSS PROFIT','GROSS LOSS','NET P&L','RETURN','AVG TRADE','AVG WIN','AVG LOSS','PROFIT FACTOR','BEST TRADE','WORST TRADE','AVG HOLD','CAPITAL DEPLOYED','STATUS'],systemRows,'No system records available')+'</div>'+
      '<div class="grid-2 equal"><div class="panel"><div class="panel-head"><div><div class="panel-title">WIN / LOSS CONTRIBUTION</div><div class="panel-subtitle">Count and dollar contribution are shown separately</div></div></div>'+splitContribution(rangeTrades)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">EXIT REASONS</div><div class="panel-subtitle">Historical exits, aggregated from saved transactions</div></div><a class="button small" href="/analytics" data-route="/analytics">OPEN ANALYTICS</a></div>'+smallGroupTable(exitGroups(rangeTrades),'EXIT')+'</div></div>';
  }
  function splitContribution(trades) {
    var m=metrics(trades);
    return '<div class="three-col"><div class="mini-metric"><span>WINNING TRADES</span><strong class="positive">'+int(m.wins)+'</strong><span>'+money(m.grossProfit)+' contribution</span></div><div class="mini-metric"><span>LOSING TRADES</span><strong class="negative">'+int(m.losses)+'</strong><span>−'+money(m.grossLoss)+'</span></div><div class="mini-metric"><span>BREAKEVEN</span><strong>'+int(m.breakeven)+'</strong><span>$0.00 contribution</span></div></div><div class="footer-note">Win rate alone does not describe profitability. Compare trade counts with dollar contribution.</div>';
  }
  function smallGroupTable(rows,label) {
    rows=rows.slice(0,6);
    return table([label,'TRADES','WIN RATE','NET P&L'],rows.map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td></tr>';}),'No exit records');
  }
  function statusNotice() { if(!state.error)return '';return '<div class="notice error">One or more feeds could not be refreshed. Missing values remain unavailable; they are not treated as zero. '+esc(state.error)+'</div>'; }

  function botById(id) { return systems.find(function(s){return s.id===id;}); }
  function renderBot(path) {
    var id=path.split('/')[2]||'v31'; id=id==='candle-breakout'?'candle':id==='b31-lab'?'lab':id==='buy-priority-test'?'buy-test':id==='buy-priority-exit-test'?'exit-test':id; var system=botById(id);
    if(!system){$('view').innerHTML=pageHead('System unavailable','This bot is not present in the current source feed.');return;}
    var tab=(path.split('/')[3]||'overview').toUpperCase(); state.botTab=tab;
    var tabs=['OVERVIEW','LIVE','PERFORMANCE','ANALYTICS','TRANSACTIONS'];
    var base=id==='candle'?'/trading/candle-breakout':id==='lab'?'/trading/b31-lab':id==='buy-test'?'/trading/buy-priority-test':id==='exit-test'?'/trading/buy-priority-exit-test':'/trading/v31';
    var tabHtml='<div class="tab-row">'+tabs.map(function(x){return '<button data-route="'+base+(x==='OVERVIEW'?'':'/'+x.toLowerCase())+'" class="'+(x===tab?'active':'')+'">'+x+'</button>';}).join('')+'</div>';
    var m=metrics(system.trades), content='';
    if(tab==='OVERVIEW') content='<div class="kpi-grid">'+kpi('CURRENT EQUITY',money(system.equity),'Current account equity')+kpi('REALIZED P&L',money(realizedTotal(realizedEventsFor(system))),'Recorded sale events',signClass(realizedTotal(realizedEventsFor(system))))+kpi("TODAY'S P&L",money(todayPnl(realizedEventsFor(system))),'Realized exits')+kpi('RETURN',pct(system.totalPnlPercent),'From starting balance',signClass(system.totalPnlPercent))+kpi('WIN RATE',metric(m.winRate,function(x){return x.toFixed(1)+'%';}))+kpi('TRADES',int(m.trades),'Known closed trades')+kpi('OPEN POSITIONS',int(system.positions.length),'Currently observed')+kpi((system.id==='buy-test'||system.id==='exit-test')?'EXPECTANCY / TRADE':'AVG TRADE',money(m.averageTrade),'Per closed trade',signClass(m.averageTrade))+kpi('PROFIT FACTOR',metric(m.profitFactor,function(x){return x===Infinity?'∞':x.toFixed(2);}))+'</div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">REALIZED P&L CURVE</div><div class="panel-subtitle">Built from recorded exits</div></div></div><div class="chart-wrap">'+svgLine(cumulative(system.trades),system.name)+'</div></div><div class="panel"><div class="panel-head"><div><div class="panel-title">WIN / LOSS</div><div class="panel-subtitle">Count and dollar contribution</div></div></div>'+splitContribution(system.trades)+'</div></div>';
    else if(tab==='LIVE') content=renderPositions(system);
    else if(tab==='PERFORMANCE') content='<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">DAILY P&L</div></div>'+dailyBar(system.trades,30)+'</div><div class="panel"><div class="panel-head"><div class="panel-title">WEEKDAY P&L</div></div>'+groupTable(byWeekday(system.trades),['DAY','TRADES','NET P&L'])+'</div></div><div class="panel section-gap"><div class="panel-head"><div class="panel-title">TRADE DISTRIBUTION</div></div>'+histogram(system.trades)+'</div>';
    else if(tab==='ANALYTICS') content=renderEntryExitAnalytics(system.trades);
    else content=renderTransactions(system.trades.map(function(t){return Object.assign({type:'CLOSED TRADE',time:t.exitTime},t);}),true);
    var control=system.id==='v31'?'<button class="button primary" data-control="start">START V3.1</button><button class="button danger" data-control="stop">STOP V3.1</button>':'';
    $('view').innerHTML=pageHead(esc(system.name),system.id==='candle'?'TP1 +15%: sell 40%; remaining 60% locks at +4% after +10%, trails 8%':system.id==='lab'?'Paper-only profitability experiment':system.id==='exit-test'?'Matched New Claude entries · 20% at +25% · 20% at +60% · 12% trail on 60% runner':system.id==='buy-test'?'10% compounding · max 4 positions · configured token filters and staged exits':'Paper account · read-only analytics',control+'<span class="badge">PAPER</span>')+tabHtml+content+(tab==='OVERVIEW'?costSimulationPanel(system):'')+(system.historyLimited?'<div class="notice">This feed currently exposes its 15 most recent trades only. Full historical analytics need a read-only history feed.</div>':'');
  }
  function cumulative(trades) { var es=events(trades), total=0;return es.map(function(e){total+=e.pnl;return {label:dateTime(e.time),value:total};}); }
  function renderPositions(system) {
    var rows=system.positions.map(function(x){return livePositionRow(system.label,x,'');});
    return '<div class="table-panel live-trading-panel"><div class="table-head"><div><h2>LIVE TRADING NOW · '+esc(system.label)+'</h2><span class="sub">Coins currently held by this bot</span></div><span class="badge">PAPER</span></div>'+table(['BOT','GENESIS / SWARM','COIN','INVESTED','ENTRY PRICE','CURRENT PRICE','UNREALIZED P&L','RETURN','HOLD TIME','DEXSCREENER'],rows,'This bot has no open position right now')+'</div>';
  }
  function tradePrice(value) { var price=n(value);return price===null||price<=0?'NOT ENOUGH DATA':'$'+price.toFixed(8); }

  function groupTable(groups,headers) {
    return table(headers,groups.map(function(g){var cells=[g.label,int(g.metrics?g.metrics.trades:g.trades)];if(headers.length===3)cells.push(money(g.metrics?g.metrics.netPnl:g.pnl));return '<tr>'+cells.map(function(c,i){return '<td class="'+(i===0?'text-left':'')+'">'+c+'</td>';}).join('')+'</tr>';}),'No records');
  }
  function histogram(trades) {
    var buckets=[['≤ −50%',-Infinity,-50],['−50% to −20%',-50,-20],['−20% to 0%',-20,0],['0% to 20%',0,20],['20% to 50%',20,50],['≥ 50%',50,Infinity]];
    return table(['RETURN BUCKET','TRADES','NET P&L'],buckets.map(function(b){var rows=trades.filter(function(t){return t.returnPercent!=null&&t.returnPercent>=b[1]&&t.returnPercent<b[2];});var m=metrics(rows);return '<tr><td class="text-left">'+b[0]+'</td><td>'+int(m.trades)+'</td><td class="'+signClass(m.netPnl)+'">'+money(m.netPnl)+'</td></tr>';}),'No completed trades');
  }
  function renderEntryExitAnalytics(trades) {
    var entries=byGroup(trades,function(t){return t.entryReason;}), exits=exitGroups(trades);
    var times=byTime(trades);
    var token=byGroup(trades,function(t){return t.token;});
    return '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">ENTRY SIGNAL PERFORMANCE</div><div class="panel-subtitle">Existing recorded entry labels only</div></div></div>'+table(['ENTRY','TRADES','WINS','LOSSES','WIN RATE','NET P&L','AVG RETURN','PF'],entries.map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+int(x.metrics.wins)+'</td><td>'+int(x.metrics.losses)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+pct(x.metrics.averageReturn)+'</td><td>'+metric(x.metrics.profitFactor,function(v){return v===Infinity?'∞':v.toFixed(2);})+'</td></tr>';}),'No entry labels persisted')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">EXIT REASON ANALYTICS</div><div class="panel-subtitle">Aggregated from recorded sale events</div></div></div>'+table(['EXIT REASON','TRADES','WIN RATE','TOTAL P&L','AVG P&L','AVG RETURN','AVG HOLD'],exits.map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+money(x.metrics.averageTrade)+'</td><td>'+pct(x.metrics.averageReturn)+'</td><td>'+duration(x.metrics.averageHoldMs)+'</td></tr>';}),'No exit labels persisted')+'</div></div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY HOUR</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(times.hours,['HOUR','TRADES','NET P&L'])+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY DAY OF WEEK</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(times.weekdays,['DAY','TRADES','NET P&L'])+'</div></div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">TOKEN LEADERBOARD</div><div class="panel-subtitle">Most profitable tokens from recorded completed trades</div></div></div>'+table(['TOKEN','TRADES','WINS','LOSSES','WIN RATE','CAPITAL','NET P&L','AVG HOLD','BEST','WORST'],token.map(function(x){var rows=trades.filter(function(t){return t.token===x.label;}),m=x.metrics;return '<tr class="click-row" data-route="/transactions?token='+encodeURIComponent(x.label)+'"><td class="text-left">'+esc(x.label)+'</td><td>'+int(m.trades)+'</td><td>'+int(m.wins)+'</td><td>'+int(m.losses)+'</td><td>'+metric(m.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td>'+money(m.capitalDeployed)+'</td><td class="'+signClass(m.netPnl)+'">'+money(m.netPnl)+'</td><td>'+duration(m.averageHoldMs)+'</td><td>'+money(m.best)+'</td><td>'+money(m.worst)+'</td></tr>'; }),'No token history')+'</div>';
  }
  function byTime(trades) {
    var hourFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',hour:'2-digit',hourCycle:'h23'}),dayFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',weekday:'long'});
    var hours={},weekdays={};events(trades).forEach(function(e){var d=new Date(e.time),h=hourFmt.format(d)+':00',w=dayFmt.format(d);(hours[h]||(hours[h]=[])).push(e.trade);(weekdays[w]||(weekdays[w]=[])).push(e.trade);});
    return {hours:Object.keys(hours).sort().map(function(k){return {label:k,metrics:metrics(hours[k])};}),weekdays:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].filter(function(k){return weekdays[k];}).map(function(k){return {label:k,metrics:metrics(weekdays[k])};})};
  }

  function renderAnalytics() {
    var t=tradesForRange(),m=metrics(t), botMetric=state.compareMetric;
    var rows=comparisonSystems().map(function(s){var sm=metrics(s.trades.filter(function(x){return inRange(x,state.range);}));var value=botMetric==='NET P&L'?money(sm.netPnl):botMetric==='RETURN %'?pct(sm.returnPercent):botMetric==='WIN RATE'?metric(sm.winRate,function(x){return x.toFixed(1)+'%';}):botMetric==='TRADE COUNT'?int(sm.trades):metric(sm.profitFactor,function(x){return x===Infinity?'∞':x.toFixed(2);});return '<tr class="click-row" data-open-system="'+s.id+'"><td class="text-left">'+esc(s.label)+'</td><td>'+value+'</td><td>'+int(sm.trades)+'</td><td class="'+signClass(sm.netPnl)+'">'+money(sm.netPnl)+'</td></tr>';});
    $('view').innerHTML=pageHead('Analytics','Compare results and inspect why recorded trades won or lost.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">BOT PERFORMANCE COMPARISON</div><div class="panel-subtitle">Metric selector changes the comparison measure</div></div><div class="right segmented">'+['NET P&L','RETURN %','WIN RATE','PROFIT FACTOR','TRADE COUNT'].map(function(x){return '<button data-compare="'+x+'" class="'+(x===botMetric?'active':'')+'">'+x+'</button>';}).join('')+'</div></div>'+table(['BOT / STRATEGY','SELECTED METRIC','TRADES','NET P&L'],rows,'No completed trades')+'</div>'+comparisonBars()+'<div class="grid-2 section-gap"><div class="panel"><div class="panel-head"><div><div class="panel-title">ENTRY SIGNAL PERFORMANCE</div><div class="panel-subtitle">Which recorded entry categories returned money</div></div></div>'+table(['ENTRY','TRADES','WIN RATE','NET P&L','AVG RETURN'],byGroup(t,function(x){return x.entryReason;}).map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+pct(x.metrics.averageReturn)+'</td></tr>';}),'No entry labels persisted')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">EXIT REASONS</div><div class="panel-subtitle">P&L contribution by recorded exit</div></div></div>'+table(['EXIT','TRADES','WIN RATE','NET P&L','AVG HOLD'],exitGroups(t).map(function(x){return '<tr><td class="text-left">'+esc(x.label)+'</td><td>'+int(x.metrics.trades)+'</td><td>'+metric(x.metrics.winRate,function(v){return v.toFixed(1)+'%';})+'</td><td class="'+signClass(x.metrics.netPnl)+'">'+money(x.metrics.netPnl)+'</td><td>'+duration(x.metrics.averageHoldMs)+'</td></tr>';}),'No exit labels persisted')+'</div></div><div class="grid-2 section-gap"><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY HOUR</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(byTime(t).hours,['HOUR','TRADES','NET P&L'])+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">P&L BY DAY OF WEEK</div><div class="panel-subtitle">Puerto Rico time</div></div></div>'+groupTable(byTime(t).weekdays,['DAY','TRADES','NET P&L'])+'</div></div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">WIN / LOSS / BREAKEVEN CONTRIBUTION</div></div></div>'+splitContribution(t)+'</div>';
  }

  function comparisonBars() { var rows=comparisonSystems().map(function(s){var m=metrics(s.trades.filter(function(t){return inRange(t,state.range);})),v=state.compareMetric==='NET P&L'?m.netPnl:state.compareMetric==='RETURN %'?m.returnPercent:state.compareMetric==='WIN RATE'?m.winRate:state.compareMetric==='TRADE COUNT'?m.trades:m.profitFactor;return {label:s.label,value:v};}),finite=rows.map(function(x){return Math.abs(n(x.value)||0);}),max=Math.max(1,...finite);return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">BOT PERFORMANCE CHART</div><div class="panel-subtitle">'+esc(state.compareMetric)+' · selected time range</div></div></div><div class="metric-bar-list">'+rows.map(function(x){var v=n(x.value),width=x.value===Infinity?100:v===null?0:Number.isFinite(v)?Math.max(2,Math.abs(v)/max*100):100;return '<div class="metric-bar-row"><span>'+esc(x.label)+'</span><div class="metric-bar-track"><i class="'+signClass(v)+'" style="width:'+width+'%"></i></div><strong class="'+signClass(v)+'">'+(v===null?(x.value===Infinity?'∞':'NOT ENOUGH DATA'):state.compareMetric==='TRADE COUNT'?int(v):state.compareMetric==='RETURN %'||state.compareMetric==='WIN RATE'?pct(v):state.compareMetric==='PROFIT FACTOR'&&v===Infinity?'∞':money(v))+'</strong></div>';}).join('')+'</div></div>'; }
  function swarmSlots() { return state.swarm && Array.isArray(state.swarm.slots) ? state.swarm.slots : []; }
  function families() { var map={};swarmSlots().forEach(function(s){var id=s.genesisId||s.swarmId; if(id && /^G\d+$/.test(id))(map[id]||(map[id]=[])).push(s);});return Array.from(new Set(['G1','G2','G3','G4','G5'].concat(Object.keys(map)))).sort().map(function(id){return {id:id,slots:map[id]||[]};}); }
  function renderSwarm(path) {
    var bits=path.split('/').filter(Boolean), tab=(bits[1]||'overview').replace(/-/g,' ').toUpperCase();state.swarmTab=tab;
    var sw=state.swarm||{}, slots=swarmSlots(), familiesList=families();
    var tabs=['OVERVIEW','GENESIS','LIVE SWARMS','GENEALOGY','REPRODUCTION','PERFORMANCE','TRANSACTIONS'];
    var html='<div class="tab-row">'+tabs.map(function(x){return '<button data-route="/swarm/'+x.toLowerCase().replace(/ /g,'-')+'" class="'+(x===tab?'active':'')+'">'+x+'</button>';}).join('')+'</div>';
    if(tab==='OVERVIEW') html='<div class="kpi-grid">'+kpi('TOTAL SWARMS',int(sw.totalSwarms),'Tracked swarms')+kpi('ACTIVE SWARMS',sw.running?int(slots.length):'0',sw.running?'Running':'Stopped')+kpi('ATTACKING',int(slots.filter(function(s){return !!s.position;}).length),'Open positions')+kpi('GROWING',int(slots.filter(function(s){return s.growthStatus==='GROWING_TOWARD_NEXT_CHILD';}).length),'Working toward next child')+kpi('TOTAL SWARM EQUITY',money(sw.totalCapital),'Current capital')+kpi("TODAY'S SWARM P&L",money(todayPnl(realizedEventsFor({id:'swarm'}))),'Realized exits')+kpi('ALL-TIME SWARM P&L',money(sw.totalPnl),'Current equity less starting capital',signClass(sw.totalPnl))+kpi('POCKETED PROFIT',money(sw.pocketedProfit),'All time')+kpi('REINVESTED PROFIT',money(sw.reinvestedProfit),'All time')+kpi('CHILD CAPITAL',money(sw.reproductionAllocated),'All time')+kpi('TOTAL CHILDREN',int(sw.childrenCreated),'All generations')+kpi('MAX GENERATION',int(Math.max(0,...slots.map(function(s){return n(s.generation)||0;}))),'Observed descendants')+'</div><div class="section-title">GENESIS FAMILIES</div><div class="family-grid">'+familiesList.map(familyCard).join('')+'</div><div class="grid-2 section-gap"><div class="panel"><div class="panel-head"><div><div class="panel-title">SWARM MONEY FLOW</div><div class="panel-subtitle">Existing allocation methodology · observed ledger totals</div></div></div>'+flowPanel(sw)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">NEXT REPRODUCTION OPPORTUNITIES</div><div class="panel-subtitle">25% of pre-spawn capital remains protected</div></div></div>'+reproductionList(slots.slice(0,6))+'</div></div>';
    else if(tab==='GENESIS') { var selectedFamily=bits[2]&&familiesList.find(function(f){return f.id===bits[2];});if(selectedFamily){var fm=familyMetrics(selectedFamily.slots);html='<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">'+esc(selectedFamily.id)+' FAMILY</div><div class="panel-subtitle">Totals use recorded swarm genealogy and account fields.</div></div><span class="badge">PAPER</span></div><div class="kpi-grid">'+kpi('FAMILY EQUITY',money(fm.equity))+kpi('FAMILY P&L',money(fm.pnl),null,signClass(fm.pnl))+kpi('DESCENDANTS',int(fm.descendants))+kpi('TRADES',int(fm.trades))+kpi('WIN RATE',metric(fm.winRate,function(x){return x.toFixed(1)+'%';}))+kpi('MAX GENERATION',int(fm.maxGen))+'</div><div class="section-title">FAMILY SWARMS</div>'+swarmTable(selectedFamily.slots)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">FAMILY LINEAGE</div><div class="panel-subtitle">Select a recorded swarm to inspect its children and reproduction plan.</div></div></div>'+table(['SWARM','PARENT','GENERATION','LOCAL X','CAPITAL','REALIZED P&L','CHILDREN'],selectedFamily.slots.map(function(s){return '<tr class="click-row" data-route="/swarm/genealogy/'+encodeURIComponent(s.swarmId)+'"><td class="text-left">'+esc(s.swarmId)+'</td><td>'+esc(s.parentId||'ROOT')+'</td><td>'+int(s.generation)+'</td><td>'+money(s.localX)+'</td><td>'+money(s.capital)+'</td><td class="'+signClass(s.realizedProfit)+'">'+money(s.realizedProfit)+'</td><td>'+int((s.children||[]).length)+'</td></tr>'; }),'Family records are unavailable in the current feed.')+'</div></div>';}else html='<div class="family-grid">'+familiesList.map(familyCard).join('')+'</div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">GENESIS FAMILY COMPARISON</div><div class="panel-subtitle">Family totals are grouped by the stored genesisId.</div></div></div>'+familyTable(familiesList)+'</div>'; }
    else if(tab==='LIVE SWARMS') html=swarmTable(slots.filter(function(s){return s.position;}));
    else if(tab==='GENEALOGY') html=genealogyView(bits[2]||state.selectedNode);
    else if(tab==='REPRODUCTION') html=reproductionView(slots.find(function(s){return s.swarmId===(bits[2]||state.selectedNode);})||slots[0]);
    else if(tab==='PERFORMANCE') html=swarmPerformance(slots);
    else html=renderTransactions(swarmTransactions(),true);
    $('view').innerHTML=pageHead('Swarm','Every swarm is an independent root with its own reproduction plan. '+(sw.running?'RUNNING':'STOPPED'),'<span class="badge">'+esc(sw.mode||'PAPER')+'</span>')+html+(tab==='OVERVIEW'?swarmCostSimulationPanel():'');
  }
  function swarmTrades() { return swarmTransactions().filter(function(t){return t.type==='SELL';}).map(function(t){return normalizeTrade(t,{name:'Swarm',id:'swarm'},true);}); }
  function swarmTransactions() {
    var x=state.swarm&&Array.isArray(state.swarm.executions)?state.swarm.executions:[];
    return x.map(function(r){
      var type=String(r.type||'TRADE').toUpperCase(),saleValue=n(r.saleValue??r.amountReceived),pnl=n(r.pnl);
      var invested=n(r.amountInvested??r.invested??r.amount);
      if(type==='SELL'&&invested===null&&saleValue!==null&&pnl!==null)invested=saleValue-pnl;
      var returnPercent=n(r.pnlPercent??r.returnPercent);
      if(type==='SELL'&&returnPercent===null&&invested!==null&&invested>0&&pnl!==null)returnPercent=pnl/invested*100;
      return Object.assign({},r,{system:'Swarm · V3.1',systemId:'swarm',type:type,time:r.time||null,exitTime:r.exitTime||r.time||null,
        token:r.symbol||'-',pnl:pnl,invested:invested,amountInvested:invested,saleValue:saleValue,amountReceived:saleValue,
        returnPercent:returnPercent,exitReason:r.reason||'Not recorded',entryReason:r.entrySignal||'Not recorded'});
    });
  }
  function familyCard(f) { var m=familyMetrics(f.slots);return '<div class="family-card" data-route="/swarm/genesis/'+f.id+'"><h3>'+f.id+'</h3><strong class="'+signClass(m.pnl)+'">'+money(m.pnl)+'</strong><small>FAMILY EQUITY '+money(m.equity)+'</small><small>'+int(m.descendants)+' DESCENDANTS · '+int(m.trades)+' TRADES</small><small>MAX GEN '+int(m.maxGen)+' · WIN RATE '+metric(m.winRate,function(x){return x.toFixed(1)+'%';})+'</small></div>'; }
  function familyMetrics(slots) { var sum=function(key){var values=slots.map(function(x){return n(x[key]);}).filter(function(x){return x!==null;});return values.length?values.reduce(function(a,b){return a+b;},0):null;},pnl=sum('realizedProfit'),equity=sum('capital'),trades=sum('completedTrades'),wins=sum('winners'),gens=slots.map(function(x){return n(x.generation);}).filter(function(x){return x!==null;});return {pnl:pnl,equity:equity,descendants:slots.length?Math.max(0,slots.length-1):null,trades:trades,wins:wins,winRate:trades>0&&wins!==null?wins/trades*100:null,maxGen:gens.length?Math.max.apply(null,gens):null}; }
  function familyTable(fs) { return table(['GENESIS','FAMILY EQUITY','FAMILY P&L','RETURN','DESCENDANTS','TRADES','WIN RATE','MAX GEN'],fs.map(function(f){var m=familyMetrics(f.slots);return '<tr class="click-row" data-route="/swarm/genesis/'+f.id+'"><td class="text-left">'+f.id+'</td><td>'+money(m.equity)+'</td><td class="'+signClass(m.pnl)+'">'+money(m.pnl)+'</td><td>NOT ENOUGH DATA</td><td>'+int(m.descendants)+'</td><td>'+int(m.trades)+'</td><td>'+metric(m.winRate,function(x){return x.toFixed(1)+'%';})+'</td><td>'+int(m.maxGen)+'</td></tr>'; }),'No Genesis swarms found'); }
  function flowPanel(sw) { var f=sw.profitAllocation||{reinvest:50,pocket:25,reproduction:25};return '<div class="split-flow"><div class="split-item"><span>REINVEST · '+int(f.reinvest)+'%</span><strong>'+money(sw.reinvestedProfit)+'</strong></div><div class="split-item"><span>POCKET · '+int(f.pocket)+'%</span><strong>'+money(sw.pocketedProfit)+'</strong></div><div class="split-item"><span>CHILD FUND · '+int(f.reproduction)+'%</span><strong>'+money(sw.reproductionAllocated)+'</strong></div></div><div class="footer-note">Accounting reflects the existing Swarm records; this view does not change allocation behavior.</div>'; }
  function reproductionList(slots) { var rows=slots.map(function(s){var next=s.nextChild||{};var pass=!!(s.reproductionEligible||next.eligible);return '<tr class="click-row" data-route="/swarm/reproduction/'+encodeURIComponent(s.swarmId)+'"><td class="text-left">'+esc(s.swarmId)+'</td><td>'+money(s.localX)+'</td><td>'+int(next.multiplier)+'</td><td>'+money(next.cost)+'</td><td>'+money(s.capital)+'</td><td><span class="badge '+(pass?'':'amber')+'">'+(pass?'PASS':'GROWING')+'</span></td></tr>';});return table(['SWARM','LOCAL X','NEXT MULTIPLIER','REQUIRED CAPITAL','CURRENT CAPITAL','75% GATE'],rows,'No swarm records'); }
  function swarmTable(slots) { return '<div class="table-panel"><div class="table-head"><h2>LIVE SWARMS</h2><span class="sub">Current position and capital state</span></div>'+table(['SWARM','PARENT','GENESIS','GENERATION','LOCAL X','TOKEN','INVESTED','UNREALIZED P&L','STATUS'],slots.map(function(s){return '<tr class="click-row" data-route="/swarm/reproduction/'+encodeURIComponent(s.swarmId)+'"><td class="text-left">'+esc(s.swarmId)+'</td><td>'+esc(s.parentId||'ROOT')+'</td><td>'+esc(s.genesisId||'-')+'</td><td>'+int(s.generation)+'</td><td>'+money(s.localX)+'</td><td>'+esc(s.position&&s.position.symbol||'-')+'</td><td>'+money(s.position&&s.position.amountInvested)+'</td><td class="'+signClass(s.live&&s.live.pnl)+'">'+money(s.live&&s.live.pnl)+'</td><td>'+esc(s.growthStatus||'ACTIVE')+'</td></tr>'; }),'No open Swarm positions')+'</div>'; }
  function genealogyView(id) { var slots=swarmSlots(),node=slots.find(function(s){return s.swarmId===id;});if(!node)return '<div class="notice">This swarm is not present in the currently loaded state.</div>';state.selectedNode=id;var children=(node.children||[]).map(function(cid){return slots.find(function(s){return s.swarmId===cid;});}).filter(Boolean);var crumb=[];var cur=node;while(cur){crumb.unshift(cur.swarmId);cur=slots.find(function(s){return s.swarmId===cur.parentId;});}var rows=children.map(function(s){return '<div class="tree-node" data-route="/swarm/genealogy/'+encodeURIComponent(s.swarmId)+'"><span class="tree-toggle">›</span><b>'+esc(s.swarmId)+'</b><span class="muted">X '+money(s.localX)+'</span><span class="muted">GEN '+int(s.generation)+'</span><span class="muted" style="margin-left:auto">'+int((s.children||[]).length)+' CHILDREN</span></div>';});return '<div class="panel"><div class="panel-head"><div><div class="panel-title">GENEALOGY</div><div class="panel-subtitle">Loaded node: '+crumb.map(esc).join(' &gt; ')+'</div></div><a class="button small" href="/swarm/genesis/'+encodeURIComponent(node.genesisId||'G1')+'" data-route="/swarm/genesis">FAMILY ROOT</a></div><div class="tree-node selected"><span class="tree-toggle">⌄</span><b>'+esc(node.swarmId)+'</b><span class="muted">LOCAL X '+money(node.localX)+'</span><span class="muted">OWN PYRAMID · '+Math.max(0,25-(node.nextChildIndex||0))+' CHILD SLOTS LEFT</span></div><div class="tree-indent">'+(rows.length?rows.join(''):'<div class="empty"><strong>No recorded descendants yet</strong>Children load only when this node exists in saved lineage.</div>')+'</div></div>'; }
  function reproductionView(s) { if(!s)return '<div class="empty"><strong>No Swarm state available</strong>NOT ENOUGH DATA</div>';var next=s.nextChild||{},current=n(s.capital),cost=n(next.cost),after=current!==null&&cost!==null?current-cost:null,ret=current&&after!==null?after/current*100:null,gate=!!(s.reproductionEligible||next.eligible);return '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">REPRODUCTION INSPECTOR</div><div class="panel-subtitle">Selected swarm '+esc(s.swarmId)+'</div></div><span class="badge '+(gate?'':'amber')+'">'+(gate?'75% GATE PASS':'GROWING TOWARD NEXT CHILD')+'</span></div><div class="four-col">'+kpi('PARENT',esc(s.parentId||'ROOT'))+kpi('GENESIS',esc(s.genesisId||'-'))+kpi('GENERATION',int(s.generation))+kpi('LOCAL X',money(s.localX))+kpi('CURRENT CAPITAL',money(s.capital))+kpi('REALIZED P&L',money(s.realizedProfit),null,signClass(s.realizedProfit))+kpi('REINVESTED PROFIT',money(s.reinvestedProfit))+kpi('POCKETED PROFIT',money(s.pocketedProfit))+kpi('CHILD CAPITAL',money(s.reproductionBalance))+kpi('NEXT MULTIPLIER',int(next.multiplier))+kpi('REQUIRED CHILD CAPITAL',money(cost))+kpi('PRE-SPAWN CAPITAL',money(next.parentCapital||s.capital))+kpi('POST-SPAWN CAPITAL',money(after))+kpi('POST-SPAWN RETENTION',pct(ret))+'</div><div class="section-title">75% RETENTION GATE</div><div class="retention-bar"><i style="width:'+Math.max(0,Math.min(100,ret||0))+'%"></i></div><p class="footer-note">When the next child is not eligible, this swarm remains operational and continues trading. Current status is derived from the existing reproduction data.</p></div><div class="panel"><div class="panel-head"><div><div class="panel-title">NEXT CHILD SLOT</div><div class="panel-subtitle">This plan belongs to '+esc(s.swarmId)+'; the swarm is outside the plan.</div></div></div>'+reproductionList([s])+'</div></div>'; }
  function swarmPerformance(slots) { var byGen={},byX={},byMulti={};slots.forEach(function(s){var g='Generation '+(s.generation||0),x=(s.localX||0)+' local X',m=(s.formationMultiplier||1)+'X';(byGen[g]||(byGen[g]=[])).push(s);(byX[x]||(byX[x]=[])).push(s);(byMulti[m]||(byMulti[m]=[])).push(s);});var tableFor=function(map){return table(['GROUP','SWARMS','TRADES','REALIZED P&L','EQUITY'],Object.keys(map).map(function(k){var list=map[k],p=list.reduce(function(a,s){return a+(n(s.realizedProfit)||0);},0),e=list.reduce(function(a,s){return a+(n(s.capital)||0);},0),t=list.reduce(function(a,s){return a+(n(s.completedTrades)||0);},0);return '<tr><td class="text-left">'+esc(k)+'</td><td>'+int(list.length)+'</td><td>'+int(t)+'</td><td class="'+signClass(p)+'">'+money(p)+'</td><td>'+money(e)+'</td></tr>'; }),'No Swarm records');};return '<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY GENESIS</div></div></div>'+familyTable(families())+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY GENERATION</div></div></div>'+tableFor(byGen)+'</div></div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY LOCAL X</div></div></div>'+tableFor(byX)+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">PERFORMANCE BY FORMATION MULTIPLIER</div></div></div>'+tableFor(byMulti)+'</div></div>'+swarmTable(slots); }

  function transactionRow(t,index) {
    var rowId=t.positionId||t.id||index,type=String(t.type||'TRADE').toUpperCase();
    var closed=type==='SELL'||type==='CLOSED TRADE'||type==='CLOSED'||(!!t.exitTime&&type!=='BUY');
    var dex=closed?transactionDexScreenerLink(t):null;
    var dexLink=closed?'<a class="dex-link" data-dex-link href="'+esc(dex.href)+'" title="'+esc(dex.hint)+'" aria-label="'+esc(dex.label)+'" target="_blank" rel="noopener noreferrer">'+dex.label+'</a>':'';
    var token=esc(t.token||t.symbol||t.name||'-');
    var buy=type==='BUY',invested=t.invested??t.amountInvested??t.amount,received=t.saleValue??t.amountReceived,pnl=t.pnl,returnPercent=t.pnlPercent??t.returnPercent;
    return '<tr class="click-row" data-transaction="'+esc(rowId)+'" data-tx-index="'+index+'"><td>'+dateTime(t.time||t.exitTime||t.entryTime)+'</td><td class="text-left">'+esc(t.system||'-')+'</td><td class="text-left">'+esc(t.swarmId||'-')+'</td><td class="text-left"><strong>'+token+'</strong>'+(closed?'<div class="closed-dex-link">'+dexLink+'</div>':'')+'</td><td>'+esc(t.type||'TRADE')+'</td><td>'+money(invested)+'</td><td>'+(buy?'—':money(received))+'</td><td class="'+signClass(pnl)+'">'+(buy?'—':money(pnl))+'</td><td>'+(buy?'—':pct(returnPercent))+'</td><td class="text-left">'+esc(t.entryReason||'Not recorded')+'</td><td class="text-left">'+esc(t.exitReason||t.reason||'Not recorded')+'</td></tr>';
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
      '<div class="table-panel section-gap"><div class="table-head"><h2>TRANSACTION LEDGER</h2><span class="sub">'+int(list.length)+' rows · page '+state.page+' of '+pages+'</span><div class="table-tools"><button class="button small" data-export="csv">EXPORT CSV</button></div></div>'+table(['TIME','BOT / STRATEGY','SWARM','TOKEN','TYPE','INVESTED','RECEIVED','P&L','RETURN','ENTRY','EXIT'],rows,'No transactions found')+'<div class="pagination"><span>Showing '+(list.length?start+1:0)+'–'+Math.min(start+PAGE_SIZE,list.length)+' of '+list.length+'</span><button data-page="prev" '+(state.page<=1?'disabled':'')+'>PREVIOUS</button><button data-page="next" '+(state.page>=pages?'disabled':'')+'>NEXT</button></div></div>'+(list.some(function(t){return t.limitedHistory;})?'<div class="notice">At least one source only exposes recent trades. Earlier records are unavailable in its current read-only feed.</div>':'');
  }
  function streakMetrics(trades) { var rows=trades.filter(function(t){return n(t.pnl)!==null&&t.exitTime;}).slice().sort(function(a,b){return Date.parse(a.exitTime)-Date.parse(b.exitTime);}),wins=0,losses=0,maxWins=0,maxLosses=0;rows.forEach(function(t){if(t.pnl>0){wins++;losses=0;maxWins=Math.max(maxWins,wins);}else if(t.pnl<0){losses++;wins=0;maxLosses=Math.max(maxLosses,losses);}else{wins=0;losses=0;}});return {currentWins:rows.length&&rows[rows.length-1].pnl>0?wins:0,currentLosses:rows.length&&rows[rows.length-1].pnl<0?losses:0,maxWins:maxWins,maxLosses:maxLosses}; }
  function calendarMarkup(trades) { var month=state.calendarMonth;if(!month){var now=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Puerto_Rico',year:'numeric',month:'2-digit'}).format(new Date());month=now;state.calendarMonth=month;}var bits=month.split('-'),year=Number(bits[0]),mon=Number(bits[1]),first=new Date(Date.UTC(year,mon-1,1)),offset=(first.getUTCDay()+6)%7,count=new Date(Date.UTC(year,mon,0)).getUTCDate(),pnl={};daily(trades).forEach(function(x){pnl[x.date]=x.pnl;});var cells=Array.from({length:offset},function(){return '<div class="calendar-blank"></div>';});for(var day=1;day<=count;day++){var key=year+'-'+String(mon).padStart(2,'0')+'-'+String(day).padStart(2,'0'),v=pnl[key],klass=v===undefined?'':signClass(v);cells.push('<div class="calendar-day '+klass+'" '+(v===undefined?'':'data-day="'+key+'" title="Open transactions for '+key+'"')+'><span>'+day+'</span><strong>'+(v===undefined?'—':money(v))+'</strong></div>');}var prev=new Date(Date.UTC(year,mon-2,1)).toISOString().slice(0,7),next=new Date(Date.UTC(year,mon,1)).toISOString().slice(0,7);return '<div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">REALIZED P&L CALENDAR</div><div class="panel-subtitle">Recorded sale P&L · select a day to open its transactions</div></div><div class="calendar-nav"><button class="button small" data-calendar-month="'+prev+'">←</button><input type="month" class="input" data-calendar-month-select value="'+month+'"><button class="button small" data-calendar-month="'+next+'">→</button></div></div><div class="calendar-weekdays">'+['MON','TUE','WED','THU','FRI','SAT','SUN'].map(function(x){return '<span>'+x+'</span>';}).join('')+'</div><div class="calendar-grid">'+cells.join('')+'</div></div>'; }
  function renderReports() {
    var t=tradesForRange(),m=metrics(t),realizedPeriod=allRealizedEvents.filter(function(e){return inRange(e,state.range);}),realizedPnl=realizedTotal(realizedPeriod);
    var bots=comparisonSystems().map(function(s){return {name:s.label,value:realizedTotal(realizedEventsFor(s))};}).filter(function(x){return x.value!==null;}).sort(function(a,b){return b.value-a.value;});
    var tokens=byGroup(t,function(x){return x.token;}).filter(function(x){return x.metrics.netPnl!==null;}).sort(function(a,b){return b.metrics.netPnl-a.metrics.netPnl;});
    var swarms=swarmSlots().slice().sort(function(a,b){return (n(b.realizedProfit)||0)-(n(a.realizedProfit)||0);});
    var rankingRows=[];
    if(bots.length){rankingRows.push('<tr><td class="text-left">BEST BOT</td><td class="text-left">'+esc(bots[0].name)+'</td><td class="positive">'+money(bots[0].value)+'</td></tr>');rankingRows.push('<tr><td class="text-left">WORST BOT</td><td class="text-left">'+esc(bots[bots.length-1].name)+'</td><td class="negative">'+money(bots[bots.length-1].value)+'</td></tr>');}
    if(tokens.length){rankingRows.push('<tr><td class="text-left">BEST TOKEN</td><td class="text-left">'+esc(tokens[0].label)+'</td><td class="positive">'+money(tokens[0].metrics.netPnl)+'</td></tr>');rankingRows.push('<tr><td class="text-left">WORST TOKEN</td><td class="text-left">'+esc(tokens[tokens.length-1].label)+'</td><td class="negative">'+money(tokens[tokens.length-1].metrics.netPnl)+'</td></tr>');}
    if(swarms.length){rankingRows.push('<tr><td class="text-left">BEST SWARM</td><td class="text-left">'+esc(swarms[0].swarmId)+'</td><td class="positive">'+money(swarms[0].realizedProfit)+'</td></tr>');rankingRows.push('<tr><td class="text-left">WORST SWARM</td><td class="text-left">'+esc(swarms[swarms.length-1].swarmId)+'</td><td class="negative">'+money(swarms[swarms.length-1].realizedProfit)+'</td></tr>');}
    $('view').innerHTML=pageHead('Reports','Period summaries from actual saved records. No estimated history.',rangeBar(state.range,['1D','7D','30D','90D','ALL'],'range'))+'<div class="kpi-grid">'+kpi('STARTING EQUITY',money(sumKnown(comparisonSystems().map(function(s){return n(s.account.startingBalance)||null;}))))+kpi('ENDING EQUITY',money(sumKnown(comparisonSystems().map(function(s){return s.equity;}))))+kpi('NET P&L',money(realizedPnl),'Recorded sale events',signClass(realizedPnl))+kpi('CLOSED-TRADE RETURN',pct(m.returnPercent),null,signClass(m.returnPercent))+kpi('TRADES',int(m.trades))+kpi('WIN RATE',metric(m.winRate,function(x){return x.toFixed(1)+'%';}))+kpi('PROFIT FACTOR',metric(m.profitFactor,function(x){return x===Infinity?'∞':x.toFixed(2); }))+kpi('AVERAGE WIN',money(m.averageWin))+kpi('AVERAGE LOSS',money(m.averageLoss))+kpi('LARGEST WIN',money(m.best))+kpi('LARGEST LOSS',money(m.worst))+kpi('CURRENT WIN STREAK',int(streakMetrics(t).currentWins))+kpi('CURRENT LOSS STREAK',int(streakMetrics(t).currentLosses))+kpi('AVG CAPITAL AT RISK',function(){var vals=t.filter(function(x){return n(x.pnl)!==null;}).map(function(x){return n(x.invested);});return vals.length&&vals.every(function(x){return x!==null;})?money(vals.reduce(function(a,b){return a+b;},0)/vals.length):'NOT ENOUGH DATA';}())+'</div><div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">BEST / WORST SYSTEMS</div><div class="panel-subtitle">Bot, token, and individual Swarm results</div></div></div>'+table(['RANK','BOT / TOKEN / SWARM','NET P&L'],rankingRows,'Not enough history')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">DRAWDOWN</div><div class="panel-subtitle">Realized P&L proxy; historical equity snapshots are unavailable</div></div></div>' +realizedDrawdown(realizedPeriod)+'</div></div>'+calendarMarkup(allRealizedEvents);
  }
    function realizedDrawdown(trades) { var d=OneCoinAnalytics.drawdownFromRealizedPnl(trades);if(!d)return '<div class="empty"><strong>NOT ENOUGH DATA</strong>Historical equity snapshots were not persisted.</div>';return '<div class="two-col"><div class="mini-metric"><span>CURRENT REALIZED DRAWDOWN</span><strong>'+money(d.currentDrawdown)+'</strong></div><div class="mini-metric"><span>MAX REALIZED DRAWDOWN</span><strong>'+money(d.maxDrawdown)+'</strong></div></div><p class="footer-note">Drawdown basis: '+esc(d.basis)+'. It is a realized P&L proxy, not an equity curve.</p>'; }
    function renderSettings() {
    var sw=state.swarm||{};var rows=comparisonSystems().map(function(s){return '<tr><td class="text-left">'+esc(s.label)+'</td><td><span class="badge">PAPER</span></td><td>'+esc(s.running?'RUNNING':'STOPPED')+'</td><td>'+int(s.trades.length)+(s.historyLimited?' recent':'')+'</td></tr>';});
    $('view').innerHTML=pageHead('Settings','Data sources and dashboard refresh preferences.')+'<div class="grid-2"><div class="panel"><div class="panel-head"><div><div class="panel-title">CONNECTED SYSTEMS</div><div class="panel-subtitle">Source status from current read-only feeds</div></div></div>'+table(['SYSTEM','MODE','STATUS','KNOWN HISTORY'],rows,'No connected systems')+'</div><div class="panel"><div class="panel-head"><div><div class="panel-title">DATA QUALITY</div><div class="panel-subtitle">Known persistence limits</div></div></div><div class="notice">Fees are not recorded in current paper trade events.</div><div class="notice">Historical price candles and prior equity snapshots are not stored.</div><div class="notice">B3.1 Lab summary currently exposes its 15 most recent completed trades.</div><div class="notice">Swarm dashboard currently returns recent executions; the stored ledger is capped at 2,000 events.</div><label class="filter-row"><input type="checkbox" id="autoRefresh" checked> Auto-refresh read-only data every 30 seconds</label></div></div><div class="panel section-gap"><div class="panel-head"><div><div class="panel-title">REFRESH</div><div class="panel-subtitle">Refresh analytics only; this does not change bot behavior</div></div><button class="button primary" data-action="refresh">REFRESH NOW</button></div><div class="footer-note">Dashboard time display: America/Puerto_Rico. All sources currently identify as paper trading.</div></div>';
  }

  function render() {
    buildSystems(); var path=currentRoute();setActiveNav(path);
    $('navSwarmCount').textContent=state.swarm?String(state.swarm.totalSwarms||0):'—';
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

  function loadData() {
    return Promise.allSettled([request('/api/data'),request('/api/swarm'),request('/api/status')]).then(function(results){
      state.error=null;
      if(results[0].status==='fulfilled')state.api=results[0].value;else state.error='Bot history feed unavailable.';
      if(results[1].status==='fulfilled')state.swarm=results[1].value;else state.error=(state.error?state.error+' ':'')+'Swarm feed unavailable.';
      if(results[2].status==='fulfilled')state.status=results[2].value;else state.error=(state.error?state.error+' ':'')+'V3.1 status unavailable.';
      $('lastUpdated').textContent='Updated '+new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',hour:'2-digit',minute:'2-digit'}).format(new Date());
      render();
    });
  }

  function openTransaction(index) {
    var list=visibleTransactions,t=list[index];if(!t)return;
    var fields=[['Bot / strategy',t.system],['Strategy',t.strategy],['Mode',t.mode||'PAPER'],['Swarm ID',t.swarmId||'Not applicable'],['Parent',t.parentId||'Not recorded'],['Genesis',t.genesisId||'Not recorded'],['Generation',t.generation],['Token',t.token||t.symbol],['Entry time',dateTime(t.entryTime)],['Exit time',dateTime(t.exitTime||t.time)],['Hold duration',duration(t.holdMs)],['Capital invested',money(t.invested||t.amountInvested||t.amount)],['Entry price',priceValue(t.entryPrice||t.price)],['Exit price',priceValue(t.exitPrice||t.price)],['Amount received',money(t.saleValue||t.amountReceived)],['Estimated fees',t.estimatedFeesUsd==null?'NOT ENOUGH DATA':money(t.estimatedFeesUsd)],['Estimated slippage',t.estimatedSlippageUsd==null?'NOT ENOUGH DATA':money(t.estimatedSlippageUsd)],['Gross P&L',t.grossPnl==null&&t.pnlGross==null?'NOT ENOUGH DATA':money(t.grossPnl??t.pnlGross)],['Net P&L',money(t.netPnl??t.pnl)],['Return',pct(t.returnPercent??t.pnlPercent)],['Entry reason',t.entryReason||'Not recorded'],['Exit reason',t.exitReason||t.reason||'Not recorded']];
    var raw=t.sourceRecord||t;
    $('detailDrawer').innerHTML='<div class="drawer-top"><div><div class="eyebrow">TRANSACTION DETAIL</div><h2>'+esc(t.token||t.symbol||'Trade')+'</h2></div><button class="icon-button" data-action="close-drawer">×</button></div><div class="detail-grid">'+fields.map(function(x){return '<div class="detail-field"><span>'+esc(x[0])+'</span><strong>'+esc(x[1]===null||x[1]===undefined?'NOT ENOUGH DATA':x[1])+'</strong></div>';}).join('')+'</div><details class="raw-record"><summary>ALL SAVED TRANSACTION FIELDS</summary><pre>'+esc(JSON.stringify(raw,null,2))+'</pre></details><div class="footer-note">Transaction detail uses fields present in saved records. No missing values are estimated.</div>';
    $('drawerBackdrop').classList.remove('hidden');$('detailDrawer').classList.add('open');$('detailDrawer').setAttribute('aria-hidden','false');
  }
  function priceValue(value) { var x=n(value);return x===null?'NOT ENOUGH DATA':'$'+x.toFixed(8); }
    function closeDrawer() {$('drawerBackdrop').classList.add('hidden');$('detailDrawer').classList.remove('open');$('detailDrawer').setAttribute('aria-hidden','true');}
  function routeForSystem(id) { return id==='v31'?'/trading/v31':id==='candle'?'/trading/candle-breakout':id==='buy-test'?'/trading/buy-priority-test':id==='exit-test'?'/trading/buy-priority-exit-test':id==='swarm'?'/swarm':'/trading/b31-lab'; }

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
    if(event.target.closest('[data-dex-link]'))return;
    var routeEl=event.target.closest('[data-route]');if(routeEl){event.preventDefault();navigate(routeEl.getAttribute('data-route'));$('sidebar').classList.remove('open');return;}
    var range=event.target.closest('[data-range]');if(range){state.range=range.getAttribute('data-range');state.page=1;render();return;}
    var chart=event.target.closest('[data-chart]');if(chart){state.chartMetric=chart.getAttribute('data-chart');render();return;}
    var compare=event.target.closest('[data-compare]');if(compare){state.compareMetric=compare.getAttribute('data-compare');render();return;}
    var overlay=event.target.closest('[data-overlay]');if(overlay){state.chartOverlays=state.chartOverlays||{};var overlayId=overlay.getAttribute('data-overlay');state.chartOverlays[overlayId]=state.chartOverlays[overlayId]===false;render();return;}
    var open=event.target.closest('[data-open-system]');if(open){navigate(routeForSystem(open.getAttribute('data-open-system')));return;}
    var tx=event.target.closest('[data-tx-index]');if(tx){openTransaction(Number(tx.getAttribute('data-tx-index')));return;}
    var day=event.target.closest('[data-day]');if(day){state.selectedDay=day.getAttribute('data-day');state.systemFilter='ALL';state.outcomeFilter='ALL';navigate('/transactions?day='+encodeURIComponent(state.selectedDay));return;}
    var pg=event.target.closest('[data-page]');if(pg){state.page=Math.max(1,state.page+(pg.getAttribute('data-page')==='next'?1:-1));render();return;}
    var action=event.target.closest('[data-action]');if(action){var act=action.getAttribute('data-action');if(act==='close-drawer')closeDrawer();if(act==='refresh')loadData();return;}
    var control=event.target.closest('[data-control]');if(control){var verb=control.getAttribute('data-control');request('/api/'+verb,{method:'POST',headers:{'x-bot-control':'1'}}).then(loadData).catch(function(){state.error='Bot control request was rejected.';render();});return;}
    var exportButton=event.target.closest('[data-export]');if(exportButton){exportCsv();return;}
  });
  document.addEventListener('change',function(event){
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
  setInterval(function(){if(state.autoRefresh!==false)loadData();},30000);
})();
