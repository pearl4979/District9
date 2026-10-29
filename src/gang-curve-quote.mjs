import {check} from './market-utils.mjs';
const VIRTUAL=1066666666666666666666666667n,ceil=(a,b)=>(a+b-1n)/b;
export function gangBuyQuote(c,gross,room){
 check(gross>0n&&c.virtualQuote>0n&&c.realQuote<c.gradAmt&&c.sold<VIRTUAL,'曲线预算或储备无效');
 check(room===null||room>0n,'已达到每钱包持仓上限');
 const invariant=c.virtualQuote*VIRTUAL,q=c.virtualQuote+c.realQuote,t=VIRTUAL-c.sold;
 let spent=gross,fee=gross/100n,net=gross-fee;
 const resize=required=>{spent=ceil(required*10000n,9900n);if(spent>gross)spent=gross;fee=spent/100n;net=spent-fee;};
 const remaining=c.gradAmt-c.realQuote;
 if(net>remaining){resize(remaining);if(net>remaining)net=remaining;}
 let output=t-ceil(invariant,q+net);
 if(room!==null&&output>room){output=room;resize(ceil(invariant,t-output)-q);}
 check(output>0n&&output<=1_000_000_000n*10n**18n,'购买输出无效');
 return{output,spent,fee,refund:gross-spent};
}
export function gangSellQuote(c,input){
 check(input>0n&&input<=c.sold&&c.sold<VIRTUAL&&c.virtualQuote>0n,'卖出数量或曲线份额无效');
 const gross=c.virtualQuote+c.realQuote-ceil(c.virtualQuote*VIRTUAL,VIRTUAL-c.sold+input);
 check(gross>0n&&gross<=c.realQuote,'曲线可支付储备不足');
 const fee=gross/100n;return{output:gross-fee,gross,fee};
}
