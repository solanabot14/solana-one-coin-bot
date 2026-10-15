const test=require("node:test"),assert=require("node:assert/strict");
const {createExecutionVerifier,USDC}=require("../profitSniperExecutionQuote");
const coin={tokenAddress:"test-mint"};
function setup({sellAmount="19900000",malformed=false,fail=false}={}) {
  const calls=[];
  const verify=createExecutionVerifier({httpGet:async(url,options)=>{
    calls.push({url,...options});
    if(fail)throw new Error("missing route");
    const p=options.params;
    return {data:{inputMint:p.inputMint,outputMint:malformed?"wrong":p.outputMint,inAmount:p.amount,
      outAmount:p.inputMint===USDC?"500000000":sellAmount,routePlan:[{swapInfo:{ammKey:"pool"}}],router:"metis"}};
  }});
  return {verify,calls};
}
test("quotes buy and sell for the actual compounded size without a wallet or execution",async()=>{
  const {verify,calls}=setup();const result=await verify(coin,{amountUsd:20});
  assert.equal(result.allowed,true);assert.equal(calls.length,2);
  assert.equal(calls[0].params.amount,"20000000");
  assert.equal(calls[1].params.amount,"500000000");
  assert.equal(calls[1].params.outputMint,USDC);
  assert.equal(calls[0].params.taker,undefined);
  assert.ok(result.lossPercent>1);
  assert.ok(calls.every(call=>call.url.endsWith("/order")));
});
test("large round-trip loss is rejected even with positive liquidity and routes",async()=>{
  const result=await setup({sellAmount:"18000000"}).verify(coin,{amountUsd:20});
  assert.equal(result.allowed,false);assert.equal(result.reason,"ROUND_TRIP_COST_TOO_HIGH");
});
test("missing routes, mismatched mints and invalid sizes never authorize paper entry",async()=>{
  assert.equal((await setup({fail:true}).verify(coin,{amountUsd:20})).allowed,false);
  assert.equal((await setup({malformed:true}).verify(coin,{amountUsd:20})).allowed,false);
  assert.equal((await setup().verify(coin,{amountUsd:0})).allowed,false);
});
test("aborted quote requests never authorize entry",async()=>{
  const controller=new AbortController();controller.abort();const {verify,calls}=setup();
  assert.equal((await verify(coin,{amountUsd:20,signal:controller.signal})).allowed,false);
  assert.equal(calls.length,0);
});


test("ordinary 2.6% quoted costs pass with a separate 1% reserve; excessive costs still fail",async()=>{
  const result=await setup({sellAmount:'19500000'}).verify(coin,{amountUsd:20});
  assert.equal(result.allowed,true);
  assert.ok(Math.abs(result.quotedCostPercent-2.6)<1e-9);
  assert.ok(Math.abs(result.lossPercent-3.6)<1e-9);
  assert.equal(result.slippageBufferPercent,1);
  assert.equal(result.maximumLossPercent,4);
  assert.equal((await setup({sellAmount:'19300000'}).verify(coin,{amountUsd:20})).allowed,false);
});
test("route fees are disclosed without charging them a second time",async()=>{
  const verify=createExecutionVerifier({httpGet:async(url,{params:p})=>({data:{inputMint:p.inputMint,outputMint:p.outputMint,
    inAmount:p.amount,outAmount:p.inputMint===USDC?'500000000':'19500000',feeBps:10,
    routePlan:[{swapInfo:{ammKey:'pool'}}]}})});
  const result=await verify(coin,{amountUsd:20});
  assert.equal(result.buyFeeBps,10);assert.equal(result.sellFeeBps,10);
  assert.ok(Math.abs(result.quotedCostPercent-2.6)<1e-9);
});

test('execution quotes still fail after 15 seconds despite the wider market-cache window',async()=>{
  let time=100000;
  const verify=createExecutionVerifier({clock:()=>time,httpGet:async(url,{params:p})=>{
    time+=15001;
    return {data:{inputMint:p.inputMint,outputMint:p.outputMint,inAmount:p.amount,
      outAmount:'100',routePlan:[{swapInfo:{ammKey:'pool'}}]}};
  }});
  const result=await verify(coin,{amountUsd:20});
  assert.equal(result.allowed,false);assert.match(result.reason,/STALE_EXECUTION_QUOTE/);
});
