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
