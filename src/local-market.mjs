import {createMarketClient} from './market-client.mjs';

// Shared discovery must not construct a second chain scanner. Quotes and
// execution are still verified by this machine's separate trading provider.
export function createLocalMarket({baseUrl,createDiscovery,createClient=createMarketClient}) {
  if(!baseUrl)return createDiscovery();
  const client=createClient({baseUrl,allowHttps:true}),snapshot=client.snapshot;
  return {...client,snapshot(){
    const value=snapshot();
    return{...value,tokens:value.tokens.map(t=>t.platformId==='gang'&&t.tradable===true&&!t.sourceUnavailable&&typeof t.reason==='string'?{...t,reason:t.reason.replace('需逐笔预览，真实交易保持关闭。','下单时后台报价、模拟与风控。')}:t)};
  }};
}
