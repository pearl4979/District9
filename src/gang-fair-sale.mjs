import {formatUnits} from 'ethers';
import {check} from './market-utils.mjs';

export function fairSaleSnapshot(state,{totalShares,tokensPerShare,effectiveExitFeeBps,quoteDecimals=18,sourceBlock,updatedAt}={}) {
  check(totalShares===10000n&&tokensPerShare===50000n*10n**18n,'Fair 总份额或每份分配已变化，需要重新核验');
  check(typeof state.sold==='bigint'&&state.sold>=0n&&state.sold<=totalShares,'Fair 有效认购份数无效');
  check(typeof state.sharePrice==='bigint'&&state.sharePrice>0n&&state.sharePrice<2n**128n,'Fair 每份价格无效');
  check(typeof state.capShares==='bigint'&&state.capShares>0n&&state.capShares<=totalShares,'Fair 钱包认购上限无效');
  check(typeof effectiveExitFeeBps==='bigint'&&effectiveExitFeeBps>=0n&&effectiveExitFeeBps<=10000n,'Fair 当前退出费未核验');
  return {
    verified:true,status:state.launched?'launched':state.sold===totalShares?'filled':'minting',
    soldShares:String(state.sold),totalShares:String(totalShares),remainingShares:String(totalShares-state.sold),walletCapShares:String(state.capShares),
    progress:Number(state.sold*10000n/totalShares)/100,tokensPerShare:formatUnits(tokensPerShare,18),
    sharePriceRaw:String(state.sharePrice),sharePrice:formatUnits(state.sharePrice,quoteDecimals),
    subscribedPrincipal:formatUnits(state.sold*state.sharePrice,quoteDecimals),targetPrincipal:formatUnits(totalShares*state.sharePrice,quoteDecimals),
    mintFeeBps:Number(state.mintFeeBps),exitFeeBps:Number(effectiveExitFeeBps),configuredExitFeeBps:Number(state.exitFeeBps),sourceBlock,updatedAt,
  };
}

export function fairPositionPrincipal(shares,sharePrice,quoteDecimals=18) {
  check(typeof shares==='bigint'&&shares>=0n&&shares<=10000n&&typeof sharePrice==='bigint'&&sharePrice>0n,'Fair 认购本金未核验');
  return {fairPrincipalRaw:String(shares*sharePrice),fairPrincipal:formatUnits(shares*sharePrice,quoteDecimals)};
}
