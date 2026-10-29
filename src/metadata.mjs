import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

const API = 'https://four.meme/meme-api/v1/private/token/get/v2';
// These exact hosts were observed in the official API and TokenCreated URI.
// No caller-supplied host allowlist: on-chain strings are still untrusted input.
const HOSTS = new Set(['four.meme', 'static.four.meme', 'ipfs.io', 'gang.fun', 'cdn.gang.fun', 'flap.mypinata.cloud', 'validation.alphapulsehq.top','pbs.twimg.com']);
const JSON_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function createPublicResolver({ systemLookup = lookup, queryDns = queryPublicDns } = {}) {
  return async (hostname, { signal = AbortSignal.timeout(6000) } = {}) => {
    if (!HOSTS.has(hostname)) throw new Error('DNS host is not allowed');
    let answers;
    try { answers = await systemLookup(hostname, { all: true, family: 4, verbatim: true }); }
    catch { /* Authenticated public DNS also handles a local resolver outage. */ }
    if (Array.isArray(answers) && answers.length && answers.every(answer => publicIpv4(answer.address))) return answers;
    if (signal?.aborted) throw signal.reason;
    const data = await queryDns(hostname, { signal });
    answers = Array.isArray(data?.Answer) ? data.Answer.filter(answer => answer.type === 1).map(answer => ({ address: answer.data, family: 4 })) : [];
    if (data?.Status !== 0 || !answers.length || answers.some(answer => !publicIpv4(answer.address))) throw new Error('Unsafe public DNS answer');
    return answers;
  };
}

function tokenAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error('Invalid token address');
  return value.toLowerCase();
}

function safeUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Unsupported metadata URL');
  let value = input;
  if (value.startsWith('ipfs://')) {
    const path = value.slice(7).replace(/^ipfs\//, '');
    const [cid] = path.split('/');
    if (!CID.test(cid) || /(?:^|\/)\.\.(?:\/|$)/.test(path)) throw new Error('Invalid IPFS path');
    value = `https://ipfs.io/ipfs/${path}`;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname)) throw new Error('Metadata URL host is not allowed');
  if (['ipfs.io', 'flap.mypinata.cloud'].includes(url.hostname) && (!url.pathname.startsWith('/ipfs/') || !CID.test(url.pathname.split('/')[2] ?? ''))) throw new Error('Invalid IPFS gateway path');
  url.hash = '';
  return url.href;
}

// Use only public IPv4 addresses. All fixed hosts have A records; refusing
// IPv6 entirely also closes mapped, 6to4, Teredo and link-local edge cases.
function publicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function pinnedFetch(resolveHost) {
  return async (input, { signal, headers }) => {
    const url = new URL(safeUrl(input));
    const answers = await resolveHost(url.hostname, { all: true, family: 4, verbatim: true, signal });
    if (!Array.isArray(answers) || !answers.length || answers.some(answer => !publicIpv4(answer.address))) throw new Error('Unsafe DNS address');
    if (signal.aborted) throw signal.reason;
    return requestPinned(url, answers[0].address, { signal, headers });
  };
}

function requestPinned(url, address, { signal, headers }) {
  if (!publicIpv4(address)) throw new Error('Unsafe DNS address');
  const pinned = { address, family: 4 };
  return new Promise((resolve, reject) => {
    // TLS authenticates the original hostname. The socket uses this checked
    // address and cannot perform a second DNS lookup (DNS rebinding).
    const req = request(url, {
      method: 'GET', agent: false, signal, servername: url.hostname,
      headers: { ...headers, 'accept-encoding': 'identity' },
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    }, response => resolve({ status: response.statusCode, headers: new Headers(response.headers), body: response }));
    req.on('error', reject);
    req.end();
  });
}

async function queryPublicDns(hostname, { signal }) {
  // A local proxy may synthesize 198.18/15 DNS answers. Never allow those
  // socket targets: ask one fixed HTTPS resolver at one fixed public IP.
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname); url.searchParams.set('type', 'A');
  const response = await requestPinned(url, '1.1.1.1', { signal, headers: { accept: 'application/dns-json' } });
  if (response.status !== 200) { disposeBody(response.body); throw new Error('Public DNS is unavailable'); }
  return JSON.parse((await readBounded(response, 16 * 1024, signal)).toString('utf8'));
}

function disposeBody(body) {
  if (typeof body?.destroy === 'function') body.destroy();
  else if (typeof body?.cancel === 'function' && !body.locked) void body.cancel().catch(() => {});
}

async function readBounded(response, limit, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    disposeBody(response.body);
    throw new Error('Metadata response is too large');
  }
  if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
    disposeBody(response.body);
    throw new Error('Compressed metadata response is unsupported');
  }
  const chunks = [];
  let size = 0;
  // Cancel the reader itself on timeout, including after response headers.
  const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null;
  const cancel = () => reader ? void reader.cancel().catch(() => {}) : disposeBody(response.body);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (!response.body) throw new Error('Empty metadata response');
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Metadata response is too large');
        chunks.push(Buffer.from(value));
      }
    } else {
      for await (const chunk of response.body) {
        if (signal.aborted) throw signal.reason;
        size += chunk.length;
        if (size > limit) throw new Error('Metadata response is too large');
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}

async function timed(work, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Metadata request timed out');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]); }
  finally { clearTimeout(timer); }
}

function imageType(body) {
  if (body.length >= 33 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && body.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (body.length >= 12 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9) return 'image/jpeg';
  if (body.length >= 14 && ['GIF87a', 'GIF89a'].includes(body.toString('ascii', 0, 6)) && body[body.length - 1] === 0x3b) return 'image/gif';
  if (body.length >= 20 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(body.toString('ascii', 12, 16)) && body.readUInt32LE(4) + 8 === body.length) return 'image/webp';
  throw new Error('Unsupported or invalid image format');
}

function boundedText(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : undefined; }

function sourceUri(value, platform) {
  if (platform !== 'flap' || typeof value !== 'string') return value;
  const path = value.startsWith('ipfs://') ? value.slice(7).replace(/^ipfs\//, '') : CID.test(value) ? value : null;
  return path === null ? value : `https://flap.mypinata.cloud/ipfs/${path}`;
}

/**
 * Routes must authorize token membership before using this service. Metadata
 * never establishes template membership or modifies the monitored token list.
 * fetchImpl/resolveHost are trusted application dependencies, never user input.
 */
export function createMetadataService({
  lookupToken, fetchImpl, resolveHost = createPublicResolver(), now = Date.now,
  ttlMs = 15 * 60 * 1000, negativeTtlMs = 60 * 1000, timeoutMs = 6000,
  maxEntries = 32,
} = {}) {
  for (const value of [ttlMs, negativeTtlMs, timeoutMs, maxEntries]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid metadata service limits');
  }
  maxEntries = Math.min(128, Math.floor(maxEntries));
  const fetcher = fetchImpl ?? pinnedFetch(resolveHost);
  const metadataCache = new Map(), imageCache = new Map();
  const metadataPending = new Map(), imagePending = new Map();

  async function fetchBody(input, limit, accept) {
    return timed(async signal => {
      let url = safeUrl(input);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetcher(url, { method: 'GET', redirect: 'manual', signal, headers: { accept } });
        if (signal.aborted) { disposeBody(response.body); throw signal.reason; }
        if (REDIRECTS.has(response.status)) {
          disposeBody(response.body);
          const location = response.headers.get('location');
          if (redirects === 3 || !location) throw new Error('Metadata redirect limit exceeded');
          url = safeUrl(new URL(location, url).href);
          continue;
        }
        if (response.status !== 200) { disposeBody(response.body); throw new Error(`Metadata HTTP ${response.status}`); }
        return readBounded(response, limit, signal);
      }
      throw new Error('Metadata redirect limit exceeded');
    }, timeoutMs);
  }

  async function fetchJson(url) {
    const object = JSON.parse((await fetchBody(url, JSON_LIMIT, 'application/json')).toString('utf8'));
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Invalid metadata JSON');
    return object;
  }

  function metadataResult(data, source, platform) {
    const imageUrl = safeUrl(sourceUri(data.image, platform));
    return {
      imageUrl, source, updatedAt: new Date(now()).toISOString(),
      ...(boundedText(data.name, 200) !== undefined ? { name: boundedText(data.name, 200) } : {}),
      ...(boundedText(data.description ?? data.descr, 2000) !== undefined ? { description: boundedText(data.description ?? data.descr, 2000) } : {}),
    };
  }

  function unavailable(error) {
    return { imageUrl: null, source: 'unavailable', updatedAt: new Date(now()).toISOString(), error: boundedText(error?.message ?? 'Metadata is unavailable', 180) };
  }

  async function loadMetadata(token, suppliedState) {
    let tokenState = suppliedState;
    if (!tokenState && lookupToken) {
      try { tokenState = await timed(signal => lookupToken(token, { signal }), timeoutMs); }
      catch { /* Exact-address official API remains available if RPC is slow. */ }
    }
    if (tokenState?.verified === true && String(tokenState.address).toLowerCase() === token && ['gang', 'four'].includes(tokenState.platformId) && (tokenState.sourceImageUrl || tokenState.sourceImageFallbackUrl)) {
      const images=[];
      for(const input of [tokenState.sourceImageUrl,tokenState.sourceImageFallbackUrl]){
        try{const url=safeUrl(input);if(!images.includes(url))images.push(url);}catch{/* An unsafe optional image never replaces a safe official one. */}
      }
      if(!images.length)return unavailable(new Error('Unsupported official image URL'));
      return{...metadataResult({image:images[0]},`${tokenState.platformId}-indexer`),...(images[1]?{fallbackImageUrl:images[1]}:{})};
    }
    if (tokenState?.verified === true && String(tokenState.address).toLowerCase() === token && tokenState.tokenMetaUri) {
      try { return metadataResult(await fetchJson(sourceUri(tokenState.tokenMetaUri, tokenState.platformId)), 'tokenMetaUri', tokenState.platformId); }
      catch { /* Missing/unavailable on-chain metadata falls back by exact CA. */ }
    }
    if (tokenState?.platformId && tokenState.platformId !== 'four') return unavailable(new Error('此平台没有可读取的图片元数据'));
    try {
      const result = await fetchJson(`${API}?address=${token}`);
      if (String(result.code) !== '0' || !result.data || typeof result.data !== 'object' || String(result.data.address).toLowerCase() !== token) throw new Error('No matching metadata for token address');
      return metadataResult(result.data, 'four.meme-api');
    } catch (error) { return unavailable(error); }
  }

  async function cached(cache, pending, token, work, successful) {
    const existing = cache.get(token);
    if (existing && existing.expires > now()) {
      cache.delete(token); cache.set(token, existing);
      return existing.value;
    }
    cache.delete(token);
    if (pending.has(token)) return pending.get(token);
    // Bound both completed and in-flight entries so request storms cannot
    // consume unbounded sockets or retain unlimited image buffers.
    if (pending.size >= maxEntries) return null;
    const promise = Promise.resolve().then(work).then(value => {
      cache.set(token, { value, expires: now() + (successful(value) ? ttlMs : negativeTtlMs) });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(token));
    pending.set(token, promise);
    return promise;
  }

  function sourceCacheKey(token,state){
    if(state?.verified!==true||String(state.address).toLowerCase()!==token)return token;
    // A new verified logo must not inherit the negative cache of missing/old
    // metadata. Limit key material; image buffers and pending work stay bounded.
    return `${token}:${JSON.stringify([state.platformId,state.sourceImageUrl,state.sourceImageFallbackUrl,state.tokenMetaUri].map(value=>typeof value==='string'?value.slice(0,2049):null))}`;
  }

  async function getMetadata(token, tokenState) {
    token = tokenAddress(token);
    return await cached(metadataCache, metadataPending, sourceCacheKey(token,tokenState), () => loadMetadata(token, tokenState), value => Boolean(value?.imageUrl)) ?? unavailable(new Error('Metadata service is busy'));
  }

  async function getImage(token, tokenState) {
    token = tokenAddress(token);
    return cached(imageCache, imagePending, sourceCacheKey(token,tokenState), async () => {
      const metadata = await getMetadata(token, tokenState);
      if (!metadata.imageUrl) return null;
      for(const url of [metadata.imageUrl,metadata.fallbackImageUrl].filter(Boolean)){
        try {
          const body = await fetchBody(url, IMAGE_LIMIT, 'image/png,image/jpeg,image/webp,image/gif');
          const contentType = imageType(body);
          return { body, contentType, cacheControl: `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}` };
        } catch { /* A missing/invalid thumbnail may still have its official original. */ }
      }
      return null;
    }, value => value !== null);
  }

  return { getMetadata, getImage };
}

// Only a server-verified X profile may supply this URL; callers cannot proxy a
// supplied arbitrary image address. Reuse DNS pinning and media validation.
export function createSocialImageReader({fetchImpl,resolveHost=createPublicResolver(),now=Date.now}={}){
 const fetcher=fetchImpl??pinnedFetch(resolveHost),cache=new Map(),pending=new Map();
 return{async get(input){
  let u;try{u=new URL(input);if(u.protocol!=='https:'||u.hostname!=='pbs.twimg.com'||u.port||u.username||u.password||u.search||u.hash||!/^\/profile_images\/[A-Za-z0-9_\/-]+\.(?:jpg|jpeg|png|webp)$/.test(u.pathname))return null;}catch{return null;}
  const url=u.href,old=cache.get(url);if(old&&old.until>now())return old.value;if(pending.has(url))return pending.get(url);if(pending.size>=4)return null;
  const task=timed(async signal=>{const response=await fetcher(url,{method:'GET',redirect:'error',signal,headers:{accept:'image/png,image/jpeg,image/webp'}});if(response.status!==200){disposeBody(response.body);throw Error('X avatar unavailable');}const body=await readBounded(response,IMAGE_LIMIT,signal);return{body,contentType:imageType(body)};},6000).catch(()=>null).then(value=>{cache.delete(url);cache.set(url,{value,until:now()+(value?300000:60000)});while(cache.size>16)cache.delete(cache.keys().next().value);return value;}).finally(()=>pending.delete(url));pending.set(url,task);return task;
 }};
}
