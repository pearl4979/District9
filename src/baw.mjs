import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CHAIN = '56';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UINT256_MAX = (1n << 256n) - 1n;
const TIMEOUT_MS = 60_000;
const bundledBinary = fileURLToPath(new URL('../node_modules/.bin/baw', import.meta.url));

function fail(message, code = 'BAW_INVALID_RESPONSE', extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

// 文档曾返回 Unix 秒；CLI 1.11.0 把 Developer Mode 到期时间转为 ISO 字符串。
export function expiryMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) return expiryMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function errorDetails(error) {
  return {
    message: error.message,
    code: error.code,
    name: error.name,
    ...(error.data !== undefined && { data: error.data }),
    ...(error.cliError !== undefined && { cliError: error.cliError }),
    ...(error.stdout !== undefined && { stdout: error.stdout }),
    ...(error.raw !== undefined && { raw: error.raw }),
  };
}

function validateTransaction(tx) {
  if (!object(tx) || !ADDRESS.test(tx.from ?? '') || !ADDRESS.test(tx.to ?? '')) {
    throw fail('Transaction from and to must be full EVM addresses', 'BAW_INVALID_INPUT');
  }
  if (typeof tx.value !== 'string' || !/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(tx.value) || tx.value.length > 80) {
    throw fail('Transaction value must be a non-negative integer string in wei', 'BAW_INVALID_INPUT');
  }
  if (BigInt(tx.value) > UINT256_MAX) {
    throw fail('Transaction value exceeds uint256', 'BAW_INVALID_INPUT');
  }
  if (typeof tx.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data) || tx.data.length > 262146) {
    throw fail('Transaction data must be byte-aligned 0x-prefixed calldata', 'BAW_INVALID_INPUT');
  }
}

function walletAddress(data) {
  if (!object(data) || !Array.isArray(data.addresses)) throw fail('Malformed baw wallet address response');
  const entry = data.addresses.find(item => object(item) && String(item.binanceChainId) === CHAIN);
  if (!entry) return null;
  if (typeof entry.address !== 'string' || !ADDRESS.test(entry.address)) throw fail('Malformed BSC wallet address');
  return entry.address;
}

function nativeBalance(data) {
  if (!Array.isArray(data)) throw fail('Malformed baw wallet balance response');
  const native = data.find(item => object(item) && String(item.binanceChainId) === CHAIN && typeof item.address === 'string' && /^0x[eE]{40}$/.test(item.address));
  // CLI 会隐藏低于 $0.01 的余额。缺失条目只能视为未知，不能当作 0。
  if (!native) return null;
  if (typeof native.balance !== 'string' || !DECIMAL.test(native.balance)) throw fail('Malformed native BNB balance');
  return native.balance;
}

function walletQuota(data) {
  if (!object(data) || !['quotaUsed', 'quotaLeft', 'dailyLimit'].every(key => typeof data[key] === 'number' && Number.isFinite(data[key])) || typeof data.date !== 'string') {
    throw fail('Malformed baw wallet quota response');
  }
  const { quotaUsed, quotaLeft, dailyLimit, date } = data;
  return { quotaUsed, quotaLeft, dailyLimit, date };
}

function developerMode(data) {
  if (!object(data) || !Object.hasOwn(data, 'devMode') || (data.devMode !== null && !object(data.devMode))) {
    throw fail('Malformed baw Developer Mode response');
  }
  if (data.devMode === null) return null;
  return {
    ...data.devMode,
    ...(Object.hasOwn(data, 'developerModeQuotaUsed') && { quotaUsed: data.developerModeQuotaUsed }),
    ...(Object.hasOwn(data, 'developerModeQuotaDate') && { quotaDate: data.developerModeQuotaDate }),
  };
}

/**
 * run(binary, args, options) returns { stdout, stderr, code? } or rejects with
 * an execFile-style error containing stdout/stderr. All CLI calls use argv,
 * shell:false, bounded output, and a timeout. This adapter never reads session files.
 */
export function createBaw({ binary = process.env.BAW_BIN || (existsSync(bundledBinary) ? bundledBinary : 'baw'), run = execFileAsync, now = Date.now, env } = {}) {
  if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary) || typeof run !== 'function') {
    throw fail('Invalid baw executable or runner', 'BAW_INVALID_INPUT');
  }

  const childEnv = env === undefined ? undefined : { ...env };
  // Internal, single-use proof; JSON supplied through HTTP cannot mint one.
  const contexts = new WeakMap();
  function consumeContext(context) {
    const proof=context&&contexts.get(context);
    if(context)contexts.delete(context);
    return proof&&context.address===proof.address&&now()>=proof.checkedAt&&now()-proof.checkedAt<5000&&proof.expiry>now()?proof:null;
  }

  async function command(args, { timeout = TIMEOUT_MS, signal } = {}) {
    let result;
    let executionError;
    try {
      result = await run(binary, [...args, '--json'], {
        shell: false,
        encoding: 'utf8',
        ...(childEnv ? { env: { ...childEnv } } : {}),
        timeout,
        ...(signal ? { signal } : {}),
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      executionError = error;
      // 超时/进程中断不能仅凭一段 success 输出宣告成功。
      if (error.killed || error.signal || error.code === 'ETIMEDOUT' || error.code === 'ENOENT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
    const exitCode = result?.code ?? result?.exitCode ?? 0;
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw fail('baw returned malformed JSON', 'BAW_MALFORMED_JSON', { stdout, stderr, exitCode, cause: executionError });
    }
    if (!object(envelope) || typeof envelope.success !== 'boolean') {
      throw fail('baw returned an invalid response envelope', 'BAW_INVALID_RESPONSE', { stdout, stderr, raw: envelope });
    }
    if (!envelope.success) {
      if (!object(envelope.error) || typeof envelope.error.message !== 'string') {
        throw fail('baw returned a malformed error response', 'BAW_INVALID_RESPONSE', { stdout, stderr, raw: envelope });
      }
      const upstream = envelope.error;
      throw fail(upstream.message, upstream.code, {
        name: typeof upstream.name === 'string' ? upstream.name : 'BawError',
        data: upstream.data,
        cliError: upstream,
        stdout,
        stderr,
        raw: envelope,
        exitCode,
      });
    }
    if (executionError || exitCode !== 0) {
      throw fail('baw exited unsuccessfully despite a success response', 'BAW_PROCESS_FAILED', { stdout, stderr, raw: envelope, exitCode, cause: executionError });
    }
    if (!Object.hasOwn(envelope, 'data')) {
      throw fail('baw response is missing data', 'BAW_INVALID_RESPONSE', { stdout, stderr, raw: envelope });
    }
    return envelope.data;
  }

  async function status() {
    const data = await command(['wallet', 'status']);
    if (!object(data) || !['UNCONNECTED', 'CREATING', 'CONNECTED'].includes(data.status)) throw fail('Malformed baw wallet status response');
    return data;
  }

  async function wallet() {
    const state = { available: true, status: null, address: null, balance: null, quota: null, devMode: null, raw: {} };
    let connection;
    try {
      connection = await status();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ...state, available: false, error: error.message, errors: { status: errorDetails(error) } };
    }
    state.status = connection.status;
    state.raw.status = connection;
    if (connection.status !== 'CONNECTED') return state;
    const queries = [
      ['address', 'address', ['wallet', 'address'], walletAddress],
      ['balance', 'balance', ['wallet', 'balance', '--binanceChainId', CHAIN], nativeBalance],
      ['quota', 'quota', ['wallet', 'left-quota'], walletQuota],
      ['devMode', 'settings', ['wallet', 'settings'], developerMode],
    ];
    const results = await Promise.allSettled(queries.map(async ([, , args, normalize]) => {
      const raw = await command(args);
      return { raw, value: normalize(raw) };
    }));
    const errors = {};
    for (let index = 0; index < results.length; index++) {
      const [field, rawField] = queries[index];
      const result = results[index];
      if (result.status === 'fulfilled') {
        state[field] = result.value.value;
        state.raw[rawField] = result.value.raw;
      } else {
        errors[field] = errorDetails(result.reason);
      }
    }
    if (Object.keys(errors).length) {
      state.errors = errors;
      state.error = Object.values(errors).map(error => error.message).join('; ');
    }
    return state;
  }

  // 每次操作重新读取必要身份和权限；展示余额/额度不进入交易关键路径。
  async function executionContext() {
    // CLI settings already queries login/query. A fresh server session expiry
    // avoids starting a third CLI just to repeat that same authentication read.
    const reads=await Promise.allSettled([command(['wallet','address']),command(['wallet','settings'])]);
    for(const read of reads)if(read.status==='rejected')throw read.reason;
    const addressData=reads[0].value,settingsData=reads[1].value;
    const sessionExpiry=expiryMs(settingsData?.sessionExpireTime);
    if(sessionExpiry!==null&&sessionExpiry<=now())throw fail('Agentic Wallet session expired','BAW_SESSION_EXPIRED');
    const connection=sessionExpiry!==null?{status:'CONNECTED',source:'wallet-settings-session',expiresAt:sessionExpiry}:await status();
    if (connection.status !== 'CONNECTED') throw fail('Agentic Wallet is not connected', 'BAW_NOT_CONNECTED');
    const address = walletAddress(addressData);
    if (!address) throw fail('Agentic Wallet has no BSC account address', 'BAW_ACCOUNT_MISMATCH');
    const devMode = developerMode(settingsData);
    if (devMode?.enabled !== true) throw fail('Developer Mode must be enabled in the Binance App', 'BAW_DEV_MODE_DISABLED');
    const expiry = expiryMs(devMode.expiresAt);
    if (expiry === null || expiry <= now()) throw fail('Developer Mode expiry is missing, invalid or expired', 'BAW_DEV_MODE_EXPIRED');
    if (devMode.balanceExceeded === true) throw fail('Developer Mode wallet balance exceeds its configured limit', 'BAW_DEV_MODE_BALANCE_EXCEEDED');
    const context = { available: true, status: connection.status, address, devMode, ...(sessionExpiry!==null?{sessionExpiresAt:sessionExpiry}:{}), raw: { status: connection, address: addressData, settings: settingsData } };
    contexts.set(context, { address, expiry:Math.min(expiry,sessionExpiry??Infinity), checkedAt:now() });
    return context;
  }

  async function preview(transaction, { context } = {}) {
    validateTransaction(transaction);
    const proof = consumeContext(context);
    // Only the current preparation's fresh identity can be reused. Execution
    // independently calls executionContext; display wallet caches never qualify.
    const reusable = Boolean(proof);
    const wallet = reusable ? { address: proof.address } : await executionContext();
    if (!reusable) contexts.delete(wallet);
    const address = wallet.address;
    if (!address || address.toLowerCase() !== transaction.from.toLowerCase()) {
      throw fail('Transaction from does not match the current Agentic Wallet BSC address', 'BAW_ACCOUNT_MISMATCH');
    }
    const data = await command([
      'contract-call', 'preview', '--binanceChainId', CHAIN,
      '--from', transaction.from, '--to', transaction.to,
      '--value', transaction.value, '--inputData', transaction.data,
    ]);
    const previewExpiry = object(data) ? expiryMs(data.expiresAt) : null;
    if (!object(data) || !validRequestId(data.requestId) || previewExpiry === null || previewExpiry <= now()) {
      throw fail('baw preview is missing a usable requestId or has invalid/expired expiry', 'BAW_INVALID_PREVIEW', { data });
    }
    return data;
  }

  async function execute(requestId) {
    if (!validRequestId(requestId)) throw fail('Invalid preview requestId', 'BAW_INVALID_INPUT');
    // 调用者负责一次性确认、预览绑定与过期检查；这里不添加 --yes 或自动确认逻辑。
    return command(['contract-call', 'execute', '--requestId', requestId]);
  }

  function marketArgs(input) {
    if (!object(input) || !ADDRESS.test(input.walletAddress ?? '') || !ADDRESS.test(input.fromToken ?? '') || !ADDRESS.test(input.toToken ?? '') || input.fromToken.toLowerCase() === input.toToken.toLowerCase() || typeof input.amount !== 'string' || input.amount.length > 80 || !DECIMAL.test(input.amount) || !/[1-9]/.test(input.amount) || !Number.isInteger(input.slippageBps) || input.slippageBps < 10 || input.slippageBps > 5000) throw fail('Invalid market order input', 'BAW_INVALID_INPUT');
    return ['--binanceChainId', CHAIN, '--fromToken', input.fromToken, '--toToken', input.toToken, '--fromTokenQty', input.amount, '--slippage', String(input.slippageBps / 100)];
  }
  async function marketQuote(input) {
    const data = await command(['market-order', 'quote', ...marketArgs(input)]);
    if (!object(data) || !DECIMAL.test(data.fromCoinAmount ?? '') || !DECIMAL.test(data.toCoinAmount ?? '') || !/[1-9]/.test(data.toCoinAmount)) throw fail('Malformed market quote');
    return data;
  }
  async function marketSwap(input, { beforeSubmit = () => {}, context } = {}) {
    let args;
    try{args=marketArgs(input);const proof=consumeContext(context);const wallet=proof?{address:proof.address}:await executionContext();if(!proof)contexts.delete(wallet);if(wallet.address.toLowerCase()!==input.walletAddress.toLowerCase())throw fail('Market order wallet does not match current wallet','BAW_ACCOUNT_MISMATCH');beforeSubmit();}
    catch(error){error.submissionAttempted=false;throw error;}
    // A timeout may already represent a submitted order. Never retry here.
    const data = await command(['market-order', 'swap', ...args, '--mev', 'true', '--gasLevel', 'MEDIUM']);
    if (!object(data) || !validRequestId(data.orderId)) throw fail('Market submission missing orderId', 'BAW_INVALID_RESPONSE', { data });
    return data;
  }
  async function marketOrder(orderId, { walletAddress: expected } = {}) {
    if (!validRequestId(orderId)) throw fail('Invalid market order ID', 'BAW_INVALID_INPUT');
    if(expected!==undefined){if(!ADDRESS.test(expected))throw fail('Invalid expected wallet','BAW_INVALID_INPUT');const actual=walletAddress(await command(['wallet','address']));if(actual?.toLowerCase()!==expected.toLowerCase())throw fail('Market lookup wallet mismatch','BAW_ACCOUNT_MISMATCH');}
    const data = await command(['market-order', 'list', '--orderId', orderId, '--binanceChainId', CHAIN]);
    if (!object(data) || !Array.isArray(data.list) || data.list.length > 1 || data.list.some(row => !object(row) || String(row.orderId) !== orderId || String(row.chain) !== CHAIN || !['PENDING', 'FINISHED', 'FAILED'].includes(row.status))) throw fail('Malformed market order lookup');
    return data.list[0] ?? null;
  }

  async function txLock() {
    const data = await command(['wallet', 'tx-lock', '--binanceChainId', CHAIN]);
    if (!object(data) || !['LOCKED', 'UNLOCKED'].includes(data.status)) throw fail('Malformed baw transaction lock response');
    return data;
  }

  async function authStart() {
    const data = await command(['auth', 'signin']);
    if (data?.status === 'ALREADY_CONNECTED') return data;
    let url;
    try { url = new URL(data?.urlForWeb); } catch { throw fail('登录响应缺少有效链接'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com'))) throw fail('登录响应不是 Binance 官方 HTTPS 链接');
    if (!validRequestId(data.qrCodeId) || typeof data.pairingCode !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(data.pairingCode) || (expiryMs(data.expireAt) ?? 0) <= Date.now()) throw fail('登录响应缺少有效配对码或已过期');
    // 保留原始 URL、配对码和 expireAt，不重组查询串。
    return data;
  }

  async function authVerify(qrCodeId, { signal } = {}) {
    if (!validRequestId(qrCodeId)) throw fail('Invalid QR code ID', 'BAW_INVALID_INPUT');
    const data = await command(['auth', 'verify', '--qrCodeId', qrCodeId], { timeout: 330_000, signal });
    if (data?.status !== 'SUCCESS') throw fail('钱包登录验证未成功');
    return data;
  }

  return { wallet, executionContext, status, preview, execute, marketQuote, marketSwap, marketOrder, txLock, authStart, authVerify };
}
