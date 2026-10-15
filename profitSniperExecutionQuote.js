const axios = require("axios");
const CONFIG = require("./profitSniperConfig");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Quotes only: no taker, wallet, signing or /execute endpoint.
function createExecutionVerifier({httpGet=(...args)=>axios.get(...args),clock=Date.now}={}) {
  async function quote(inputMint,outputMint,amount,signal) {
    if(signal?.aborted)throw new Error("ABORTED");
    const at=clock();
    const headers=process.env.JUPITER_API_KEY ? {"x-api-key":process.env.JUPITER_API_KEY} : {};
    const response=await httpGet("https://api.jup.ag/swap/v2/order",{
      params:{inputMint,outputMint,amount},headers,timeout:8000,signal});
    const data=response.data;
    if(signal?.aborted)throw new Error("ABORTED");
    if(clock()-at>15000)throw new Error("STALE_EXECUTION_QUOTE");
    if(data?.errorCode || data?.error || data?.inputMint!==inputMint || data?.outputMint!==outputMint ||
        String(data.inAmount)!==amount || !/^\d+$/.test(String(data.outAmount)) ||
        BigInt(data.outAmount)<=0n || !Array.isArray(data.routePlan) || !data.routePlan.length)
      throw new Error("SELL_ROUTE_OR_BUY_QUOTE_UNVERIFIED");
    return {data,at};
  }
  return async function verifyExecution(coin,{amountUsd,signal}={}) {
    const raw=Math.floor(Number(amountUsd)*1e6);
    if(!Number.isSafeInteger(raw) || raw<=0 || !coin?.tokenAddress || coin.tokenAddress===USDC)
      return {allowed:false,reason:"INVALID_EXECUTION_QUOTE_SIZE"};
    try {
      const buy=await quote(USDC,coin.tokenAddress,String(raw),signal);
      const sell=await quote(coin.tokenAddress,USDC,String(buy.data.outAmount),signal);
      if(clock()-buy.at>15000)throw new Error("STALE_ROUND_TRIP_QUOTE");
      const returned=Number(sell.data.outAmount)/1e6;
      if(!Number.isFinite(returned))throw new Error("INVALID_SELL_QUOTE");
      const estimatedNetworkFeesUsd=0.02;
      const lossPercent=(Number(amountUsd)-returned+estimatedNetworkFeesUsd)/Number(amountUsd)*100+
        CONFIG.ROUND_TRIP_SLIPPAGE_BUFFER_PERCENT;
      const result = {allowed:lossPercent<=CONFIG.MAX_ROUND_TRIP_LOSS_PERCENT,provider:"Jupiter quote only",amountUsd:Number(amountUsd),
        quotedSellValueUsd:returned,estimatedNetworkFeesUsd,
        slippageBufferPercent:CONFIG.ROUND_TRIP_SLIPPAGE_BUFFER_PERCENT,
        lossPercent,checkedAt:new Date(clock()).toISOString(),
        buyRouter:buy.data.router,sellRouter:sell.data.router,
        maximumLossPercent:CONFIG.MAX_ROUND_TRIP_LOSS_PERCENT};
      return result.allowed ? result : {...result,reason:"ROUND_TRIP_COST_TOO_HIGH"};
    } catch(error) {
      return {allowed:false,reason:"EXECUTION_DATA_PENDING: "+(error.response?.status ?
        "HTTP "+error.response.status : error.message)};
    }
  };
}
module.exports={createExecutionVerifier,USDC};
