import { manifest } from './protocol.mjs';
import { check, getJson, mapLimited } from './market-utils.mjs';

// 官网模板页使用的公开搜索接口。接口只提供候选 CA，归属仍由 Core/Registry 判断。
const searchOfficial = async () => getJson('https://four.meme/meme-api/v1/public/token/search', {
  method: 'POST', body: JSON.stringify({ pageIndex: 1, pageSize: 84, templateId: Number(manifest.templateId), type: 'NEW', sort: 'DESC' }),
});

export function createFourMarketSource({ protocol, search = searchOfficial } = {}) {
  return {
    async load({ onProgress } = {}) {
      await protocol.initialize();
      const [response, tip] = await Promise.all([search(), protocol.provider.getBlockNumber()]);
      check(response.code === 0 && Array.isArray(response.data), 'Four.meme 索引不可用，不能视为空市场');
      const head = tip - manifest.confirmations;
      const candidates = [...new Map(response.data.filter(r => /^0x[0-9a-f]{40}$/i.test(r.tokenAddress)).map(r => [r.tokenAddress.toLowerCase(), r])).values()];
      let unavailable = 0;
      const partial = [];
      const tokens = (await mapLimited(candidates, 3, async row => {
        try {
          const state = await protocol.getTokenState(row.tokenAddress, { blockTag: head });
          check(state.verified && state.createBlock <= head, '创建尚未达到确认数');
          const created = Number(row.createDate);
          const image = typeof row.img === 'string' && row.img.startsWith('/market/') ? `https://static.four.meme${row.img}` : row.img;
          const token = { ...state, platformId: 'four', positionKind: 'token', priceUnit: 'BNB', quoteSymbol: 'BNB', quoteDecimals: 18,
            volume: typeof row.volume === 'string' && /^\d+(?:\.\d+)?$/.test(row.volume) ? row.volume : null, volumeLabel: '累计 · BNB · Four 索引',
            sourceImageUrl: image || null, createdAt: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null,
            officialUrl: `https://four.meme/token/${state.address}`, sourceBlock: head };
          partial.push(token); onProgress?.(partial, `正在核验 Four.meme：${partial.length}/${candidates.length} 个候选`); return token;
        } catch { unavailable++; return null; }
      })).filter(Boolean);
      check(tokens.length || !candidates.length, 'Four.meme 候选链上核验全部失败');
      return { tokens, status: unavailable ? 'degraded' : 'live', lastBlock: head, unavailable, truncated: candidates.length >= 84, message: `已核验 ${tokens.length} 个最近市场 · 区块 ${head} · ${manifest.confirmations} 个确认${unavailable ? ` · ${unavailable} 个尚未通过核验` : ''}` };
    },
  };
}
