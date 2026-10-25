'use strict';
// All dynamic text goes through textContent: token names/symbols come from the chain and must never be treated as HTML.
const I18N = {
  ar: {
    dir: 'rtl', title: 'بوت قنص عملات Solana', sub: 'اكتشاف وتحليل وتداول آلي — مفصول بين المحاكاة والتداول الحقيقي',
    modeObserve: 'وضع المراقبة: تحليل فقط، لا أوامر ولا صفقات', modePaper: 'وضع المحاكاة: صفقات افتراضية على بيانات حقيقية — لا تتحرك أموال حقيقية', modeLive: 'تداول حقيقي بأموال حقيقية',
    kill: 'إيقاف طارئ', killAll: 'إيقاف وإغلاق الكل', resume: 'استئناف', lang: 'English',
    capital: 'رأس المال', wallet: 'الرصيد المتاح', reserved: 'محجوز في صفقات (بالتكلفة)', unreal: 'ربح/خسارة غير محققة', real: 'محقق (الإجمالي)', realToday: 'محقق (اليوم UTC)', fees: 'رسوم مسجلة', trades: 'صفقات مغلقة', solusd: 'سعر SOL', unavailable: 'غير متاح',
    tabs: { wallet: 'المحفظة', positions: 'الصفقات', tokens: 'العملات المكتشفة', orders: 'الأوامر', withdrawals: 'السحوبات', errors: 'الأخطاء' },
    settings: 'الإعدادات', save: 'حفظ', saved: 'تم الحفظ', arm: 'تفعيل التداول الحقيقي', armPh: 'اكتب عبارة التأكيد', armBtn: 'تفعيل', disarm: 'إلغاء التفعيل', armed: 'مُفعَّل',
    feed: 'مصدر الاكتشاف', rpc: 'RPC', connected: 'متصل', disconnected: 'منقطع', lastMsg: 'آخر رسالة', halted: 'التداول متوقف', canTrade: 'جاهز لفتح صفقات', noConn: 'انقطع الاتصال بالخدمة الخلفية — البيانات المعروضة قد تكون قديمة',
    cols: { symbol: 'العملة', mode: 'النمط', state: 'الحالة', cost: 'التكلفة SOL', value: 'القيمة الحالية', pnl: 'الربح/الخسارة', peak: 'الذروة', held: 'المدة', exit: 'سبب الخروج', tx: 'المعاملات', act: '', time: 'الوقت', risk: 'المخاطرة', quality: 'الجودة', mcap: 'القيمة السوقية SOL', why: 'سبب القبول/الرفض', side: 'الاتجاه', route: 'المسار', sig: 'التوقيع', slip: 'الانزلاق %', delta: 'تغير SOL', fee: 'رسوم', err: 'خطأ', level: 'المستوى', src: 'المصدر', msg: 'الرسالة', amount: 'المبلغ SOL', dest: 'الوجهة', status: 'الحالة' },
    close: 'إغلاق', none: 'لا توجد بيانات بعد', confirmKill: 'سيتوقف فتح صفقات جديدة. هل أنت متأكد؟', confirmKillAll: 'سيتم إغلاق كل الصفقات المفتوحة وإيقاف الصفقات الجديدة. هل أنت متأكد؟', confirmClose: 'إغلاق هذه الصفقة الآن؟',
    token: 'أدخل رمز الدخول للوحة (DASHBOARD_TOKEN)', checks: 'الفحوصات', evidence: { confirmed: 'مؤكد', probabilistic: 'احتمالي', unavailable: 'غير متاح' },
    groups: { capital: 'رأس المال', exec: 'التنفيذ', entry: 'شروط الدخول', exit: 'شروط الخروج' },
    walletTitle: 'عنوان محفظة البوت', copyAddr: 'نسخ العنوان', copied: 'تم النسخ', walletBalanceLbl: 'رصيد SOL الحالي',
    noWallet: 'لا توجد محفظة حقيقية في هذا الوضع (مراقبة/محاكاة). فعّل MODE=live وأضف PRIVATE_KEY لعرض محفظة حقيقية.',
    depositTitle: 'الإيداع', depositHelp: 'أرسل SOL من أي محفظة خارجية (Phantom، Solflare، تبادل...) إلى العنوان أعلاه. لا حاجة لأي إعداد إضافي — بمجرد تأكيد المعاملة على الشبكة سيظهر الرصيد والإيداع هنا تلقائيًا خلال ثوانٍ. ابدأ بمبلغ صغير للتجربة أولًا.',
    depositHistory: 'آخر الإيداعات المكتشفة', noDeposits: 'لا توجد إيداعات حديثة ظاهرة',
    depConfirmed: 'مؤكدة', depProcessed: 'قيد المعالجة',
    withdrawTitle: 'سحب SOL إلى عنوان خارجي', destLabel: 'عنوان الوجهة', amountLabel: 'المبلغ (SOL)', maxBtn: 'الحد الأقصى', prepareBtn: 'حساب المبلغ والرسوم',
    quoteAmount: 'سيُرسل', quoteFee: 'رسوم الشبكة التقديرية', quoteRemaining: 'سيتبقى في المحفظة', confirmSendBtn: 'تأكيد الإرسال الآن', cancelBtn: 'إلغاء',
    withdrawConfirmDialog: (amt, dest) => `سيتم إرسال ${amt} SOL إلى ${dest} الآن. هذا الإجراء نهائي ولا يمكن التراجع عنه. متابعة؟`,
    needArmed: 'السحب يتطلب تفعيل التداول الحقيقي أولًا (نفس زر "تفعيل التداول الحقيقي" أعلاه) لأنه يحرّك أموالًا حقيقية.',
    withdrawSent: 'تم إرسال السحب', withdrawPending: 'السحب قيد التأكيد على الشبكة (لن يُعاد إرساله)',
  },
  en: {
    dir: 'ltr', title: 'Solana Sniper Bot', sub: 'Discovery, analysis and automated trading — simulation and live are kept strictly apart',
    modeObserve: 'OBSERVE mode: analysis only, no orders or trades', modePaper: 'PAPER mode: virtual trades on real data — no real money moves', modeLive: 'LIVE trading with real funds',
    kill: 'Emergency stop', killAll: 'Stop & close all', resume: 'Resume', lang: 'العربية',
    capital: 'Capital', wallet: 'Available balance', reserved: 'Locked in trades (at cost)', unreal: 'Unrealized PnL', real: 'Realized (total)', realToday: 'Realized (today, UTC)', fees: 'Recorded fees', trades: 'Closed trades', solusd: 'SOL price', unavailable: 'unavailable',
    tabs: { wallet: 'Wallet', positions: 'Positions', tokens: 'Discovered tokens', orders: 'Orders', withdrawals: 'Withdrawals', errors: 'Errors' },
    settings: 'Settings', save: 'Save', saved: 'Saved', arm: 'Arm live trading', armPh: 'Type the confirmation phrase', armBtn: 'Arm', disarm: 'Disarm', armed: 'ARMED',
    feed: 'Discovery feed', rpc: 'RPC', connected: 'connected', disconnected: 'disconnected', lastMsg: 'last message', halted: 'Trading halted', canTrade: 'Ready to open trades', noConn: 'Lost connection to the backend — displayed data may be stale',
    cols: { symbol: 'Token', mode: 'Mode', state: 'State', cost: 'Cost SOL', value: 'Value now', pnl: 'PnL', peak: 'Peak', held: 'Held', exit: 'Exit reason', tx: 'Transactions', act: '', time: 'Time', risk: 'Risk', quality: 'Quality', mcap: 'Mcap SOL', why: 'Why accepted/rejected', side: 'Side', route: 'Route', sig: 'Signature', slip: 'Slippage %', delta: 'SOL change', fee: 'Fee', err: 'Error', level: 'Level', src: 'Source', msg: 'Message', amount: 'Amount SOL', dest: 'Destination', status: 'Status' },
    close: 'Close', none: 'No data yet', confirmKill: 'New trades will stop. Continue?', confirmKillAll: 'All open positions will be closed and new trades stopped. Continue?', confirmClose: 'Close this position now?',
    token: 'Enter the dashboard token (DASHBOARD_TOKEN)', checks: 'Checks', evidence: { confirmed: 'confirmed', probabilistic: 'probabilistic', unavailable: 'unavailable' },
    groups: { capital: 'Capital', exec: 'Execution', entry: 'Entry rules', exit: 'Exit rules' },
    walletTitle: 'Bot wallet address', copyAddr: 'Copy address', copied: 'Copied', walletBalanceLbl: 'Current SOL balance',
    noWallet: 'No real wallet in this mode (observe/paper). Set MODE=live and PRIVATE_KEY to see a real wallet here.',
    depositTitle: 'Deposit', depositHelp: 'Send SOL from any external wallet (Phantom, Solflare, an exchange...) to the address above. No extra setup needed — once the transfer confirms on-chain, the balance and the deposit itself appear here automatically within seconds. Start with a small test amount first.',
    depositHistory: 'Recently detected deposits', noDeposits: 'No recent deposits to show',
    depConfirmed: 'confirmed', depProcessed: 'processing',
    withdrawTitle: 'Withdraw SOL to an external address', destLabel: 'Destination address', amountLabel: 'Amount (SOL)', maxBtn: 'Max', prepareBtn: 'Calculate amount & fee',
    quoteAmount: 'Will send', quoteFee: 'Estimated network fee', quoteRemaining: 'Will remain in wallet', confirmSendBtn: 'Confirm & send now', cancelBtn: 'Cancel',
    withdrawConfirmDialog: (amt, dest) => `${amt} SOL will be sent to ${dest} right now. This is final and cannot be undone. Continue?`,
    needArmed: 'Withdrawing requires arming live trading first (the same "Arm live trading" button above), since it moves real funds.',
    withdrawSent: 'Withdrawal sent', withdrawPending: 'Withdrawal pending network confirmation (will not be re-sent)',
  },
};
const SETTING_LABELS = {
  initialCapitalUsd: ['رأس المال الأولي $', 'Initial capital $'], tradeSizeUsd: ['حجم الصفقة $', 'Trade size $'], maxTradeUsd: ['أقصى صفقة $', 'Max per trade $'], maxOpenPositions: ['أقصى صفقات مفتوحة', 'Max open positions'], feeReserveSol: ['احتياطي رسوم SOL', 'Fee reserve SOL'], dailyLossLimitUsd: ['حد الخسارة اليومي $', 'Daily loss limit $'], totalLossLimitUsd: ['حد الخسارة الكلي $', 'Total loss limit $'], stopBalanceUsd: ['إيقاف عند رصيد $', 'Stop at equity $'], maxCostPctOfTrade: ['أقصى تكلفة متوقعة %', 'Max expected cost %'], maxOverheadPctOfTrade: ['أقصى نسبة رسوم ثابتة %', 'Max fixed-fee overhead %'],
  slippageBuyPct: ['انزلاق الشراء %', 'Buy slippage %'], slippageSellPct: ['انزلاق البيع %', 'Sell slippage %'], priorityFeeSol: ['رسوم الأولوية SOL', 'Priority fee SOL'], pumpFeeBps: ['رسوم المنحنى (نقطة أساس)', 'Curve fee (bps)'], portalFeePct: ['رسوم PumpPortal %', 'PumpPortal fee %'], maxSellAttempts: ['محاولات البيع', 'Sell attempts'], txConfirmTimeoutSec: ['مهلة التأكيد (ث)', 'Confirm timeout (s)'],
  minAgeSec: ['أدنى عمر (ث)', 'Min age (s)'], maxAgeSec: ['أقصى عمر (ث)', 'Max age (s)'], minMarketCapSol: ['أدنى قيمة سوقية SOL', 'Min mcap SOL'], maxMarketCapSol: ['أقصى قيمة سوقية SOL', 'Max mcap SOL'], maxTop10Pct: ['أقصى تركز أكبر 10 %', 'Max top-10 %'], maxTopHolderPct: ['أقصى حصة محفظة %', 'Max top holder %'], maxCreatorPct: ['أقصى حصة المنشئ %', 'Max creator %'], maxDevInitialBuyPct: ['أقصى شراء ابتدائي للمنشئ %', 'Max dev initial buy %'], minTxInWindow: ['أدنى معاملات/60ث', 'Min tx / 60s'], minGrowthPct: ['أدنى نمو سعر %', 'Min price growth %'], maxGrowthPct: ['أقصى نمو سعر %', 'Max price growth %'], maxRoundTripCostPct: ['أقصى تكلفة ذهاب وإياب %', 'Max round-trip cost %'], maxBuyImpactPct: ['أقصى أثر سعري للشراء %', 'Max buy impact %'], minQuality: ['أدنى درجة جودة', 'Min quality'], maxRisk: ['أقصى درجة مخاطرة', 'Max risk'],
  takeProfitPct: ['هدف الربح %', 'Take profit %'], stopLossPct: ['حد الخسارة %', 'Stop loss %'], hardStopPct: ['وقف فوري %', 'Hard stop %'], trailingActivatePct: ['تفعيل المتحرك عند %', 'Trailing starts at %'], trailingDropPct: ['تراجع المتحرك %', 'Trailing drop %'], confirmTicks: ['فحوص التأكيد', 'Confirm ticks'], maxHoldSec: ['أقصى مدة احتفاظ (ث)', 'Max hold (s)'], liquidityDropExitPct: ['خروج عند هبوط السيولة %', 'Exit on liquidity drop %'], creatorSellExitPct: ['خروج عند بيع المنشئ %', 'Exit on creator sell %'], monitorIntervalMs: ['فترة المراقبة (مل ث)', 'Monitor interval (ms)'],
};
const GROUPS = {
  capital: ['initialCapitalUsd', 'tradeSizeUsd', 'maxTradeUsd', 'maxOpenPositions', 'feeReserveSol', 'dailyLossLimitUsd', 'totalLossLimitUsd', 'stopBalanceUsd', 'maxCostPctOfTrade', 'maxOverheadPctOfTrade'],
  exec: ['slippageBuyPct', 'slippageSellPct', 'priorityFeeSol', 'pumpFeeBps', 'portalFeePct', 'maxSellAttempts', 'txConfirmTimeoutSec'],
  entry: ['minAgeSec', 'maxAgeSec', 'minMarketCapSol', 'maxMarketCapSol', 'maxTop10Pct', 'maxTopHolderPct', 'maxCreatorPct', 'maxDevInitialBuyPct', 'minTxInWindow', 'minGrowthPct', 'maxGrowthPct', 'maxRoundTripCostPct', 'maxBuyImpactPct', 'minQuality', 'maxRisk'],
  exit: ['takeProfitPct', 'stopLossPct', 'hardStopPct', 'trailingActivatePct', 'trailingDropPct', 'confirmTicks', 'maxHoldSec', 'liquidityDropExitPct', 'creatorSellExitPct', 'monitorIntervalMs'],
};
const ARM_PHRASE = 'I-UNDERSTAND-I-CAN-LOSE-ALL-FUNDS';

let lang = localStorage.getItem('lang') || 'ar';
let tab = 'positions';
let state = null;
let online = true;
let settingsDirty = false;
const T = () => I18N[lang];
const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const num = (text, cls) => h('span', { class: 'num' + (cls ? ' ' + cls : '') }, text);

async function api(path, opts = {}) {
  let token = sessionStorage.getItem('token');
  if (!token) { token = prompt(T().token) || ''; sessionStorage.setItem('token', token); }
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-requested-with': 'sniper-ui' },
  });
  if (res.status === 401) { sessionStorage.removeItem('token'); throw new Error('unauthorized'); }
  const body = await res.json();
  if (!res.ok && !body.ok && body.error) throw Object.assign(new Error(body.error), { body });
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

const sol = (lamports, d = 4) => (lamports == null ? '—' : (lamports / 1e9).toFixed(d));
const usd = (lamports) => (lamports == null || !state?.solUsd ? '' : ` ($${((lamports / 1e9) * state.solUsd.price).toFixed(2)})`);
const signed = (lamports) => (lamports == null ? '—' : (lamports >= 0 ? '+' : '') + sol(lamports, 5));
const cls = (v) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + 's' : Math.round(s / 60) + 'm'; };
const time = (ms) => new Date(ms).toLocaleTimeString(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
const link = (sig) => sig ? h('a', { href: 'https://solscan.io/tx/' + encodeURIComponent(sig), target: '_blank', rel: 'noopener noreferrer' }, sig.slice(0, 6) + '…') : null;

function renderChrome() {
  const t = T();
  document.documentElement.lang = lang; document.documentElement.dir = t.dir;
  $('title').textContent = t.title; $('sub').textContent = t.sub;
  $('killBtn').textContent = t.kill; $('killAllBtn').textContent = t.killAll; $('resumeBtn').textContent = t.resume; $('langBtn').textContent = t.lang;
  const tabs = $('tabs'); tabs.replaceChildren();
  for (const k of Object.keys(t.tabs)) tabs.append(h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; renderChrome(); refreshTab(); } }, t.tabs[k]));
}

function renderState() {
  const t = T(); const s = state;
  const bar = $('modeBar');
  bar.className = 'modebar ' + (s.mode === 'live' ? 'live' : s.mode === 'paper' ? 'paper' : '');
  bar.textContent = s.mode === 'live' ? t.modeLive + (s.liveArmed ? ' — ' + t.armed : '') : s.mode === 'paper' ? t.modePaper : t.modeObserve;

  const chips = $('chips'); chips.replaceChildren();
  const chip = (label, val, kind) => chips.append(h('span', { class: 'chip ' + (kind || '') }, label + ': ', h('b', {}, val)));
  if (s.feed) chip(t.feed, s.feed.connected ? t.connected : t.disconnected, s.feed.connected ? 'ok' : 'bad');
  if (s.feed && s.feed.lastMessageAt) chip(t.lastMsg, dur(s.now - s.feed.lastMessageAt), '');
  if (s.rpc) chip(t.rpc, s.rpc.lastError && s.rpc.lastErrorAt > s.rpc.lastOkAt ? s.rpc.lastError.slice(0, 30) : 'OK', s.rpc.lastErrorAt > s.rpc.lastOkAt ? 'warn' : 'ok');
  chip(t.solusd, s.solUsd ? '$' + s.solUsd.price.toFixed(2) : t.unavailable, s.solUsd ? '' : 'bad');
  chip(s.canTrade.ok ? t.canTrade : t.halted, s.canTrade.ok ? '✓' : (s.canTrade.reason || '').slice(0, 60), s.canTrade.ok ? 'ok' : 'bad');

  const al = $('alert');
  const msgs = [];
  if (!online) msgs.push(t.noConn);
  if (s.hardHalt) msgs.push(s.hardHalt);
  al.hidden = msgs.length === 0; al.textContent = msgs.join(' | ');

  const c = s.capital;
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  $('capital').replaceChildren(
    h('h2', {}, t.capital),
    h('dl', { class: 'kv' },
      row(t.wallet, c.walletLamports == null ? h('span', { class: 'warn' }, t.unavailable + (c.walletNote ? ' — ' + c.walletNote : '')) : num('◎ ' + sol(c.walletLamports) + usd(c.walletLamports))),
      row(t.reserved, num('◎ ' + sol(c.reservedLamports) + usd(c.reservedLamports))),
      row(t.unreal, num(signed(c.unrealizedLamports) + usd(c.unrealizedLamports), cls(c.unrealizedLamports))),
      row(t.real, num(signed(c.realizedTotalLamports) + usd(c.realizedTotalLamports), cls(c.realizedTotalLamports))),
      row(t.realToday, num(signed(c.realizedTodayLamports), cls(c.realizedTodayLamports))),
      row(t.fees, num('◎ ' + sol(c.feesLamports, 5))),
      row(t.trades, num(c.wins + ' / ' + c.closedTrades)),
    ),
    s.mode === 'live' ? armPanel(s) : null,
  );
  if (!settingsDirty) renderSettings();
}

function armPanel(s) {
  const t = T();
  if (s.liveArmed) return h('div', { class: 'arm' }, h('span', { class: 'tag loss' }, t.armed), h('button', { class: 'ghost', onclick: async () => { await post('/api/disarm'); poll(); } }, t.disarm));
  const inp = h('input', { placeholder: t.armPh, 'aria-label': t.arm, dir: 'ltr' });
  return h('div', { class: 'arm' }, h('strong', {}, t.arm), h('small', { class: 'muted num' }, ARM_PHRASE), inp,
    h('button', { class: 'danger', onclick: async () => { try { await post('/api/arm', { phrase: inp.value.trim() }); poll(); } catch (e) { alert(e.message); } } }, t.armBtn));
}

function renderSettings() {
  const t = T(); const st = state.settings; const box = $('settings');
  const form = h('div', { class: 'settings' });
  const inputs = {};
  for (const [g, keys] of Object.entries(GROUPS)) {
    const fs = h('fieldset', {}, h('legend', {}, t.groups[g]));
    for (const k of keys) {
      const inp = h('input', { type: 'number', step: 'any', value: st[k], id: 's_' + k, oninput: () => { settingsDirty = true; } });
      inputs[k] = inp;
      fs.append(h('label', {}, SETTING_LABELS[k][lang === 'ar' ? 0 : 1], inp));
    }
    form.append(fs);
  }
  const msg = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { onclick: async () => {
    const patch = {}; for (const [k, i] of Object.entries(inputs)) patch[k] = Number(i.value);
    try { await post('/api/settings', patch); settingsDirty = false; msg.textContent = t.saved; poll(); } catch (e) { msg.textContent = e.message; msg.className = 'loss'; }
  } }, t.save);
  box.replaceChildren(h('h2', {}, t.settings), form, h('div', { class: 'btns' }, save, msg));
}

let withdrawQuote = null; // { draft, amountSol, feeSol, remainingSol } while a prepared withdrawal awaits confirmation

function walletSection() {
  const t = T(); const s = state;
  if (!s.walletAddress) return h('div', { class: 'empty' }, t.noWallet);
  const addrBox = h('code', { class: 'addr num' }, s.walletAddress);
  const copyBtn = h('button', { class: 'ghost', onclick: () => { navigator.clipboard?.writeText(s.walletAddress); copyBtn.textContent = t.copied; setTimeout(() => (copyBtn.textContent = t.copyAddr), 1500); } }, t.copyAddr);
  return h('div', { class: 'wallet-head' },
    h('h2', {}, t.walletTitle), h('div', { class: 'addr-row' }, addrBox, copyBtn),
    h('dl', { class: 'kv' }, h('dt', {}, t.walletBalanceLbl), h('dd', {}, s.capital.walletLamports == null ? t.unavailable : num('◎ ' + sol(s.capital.walletLamports) + usd(s.capital.walletLamports)))),
  );
}

function withdrawSection(wallet) {
  const t = T(); const s = state;
  if (!s.walletAddress) return null;
  if (!s.liveArmed) return h('div', { class: 'panel-note warn' }, h('h2', {}, t.withdrawTitle), h('p', {}, t.needArmed));
  if (withdrawQuote) {
    const q = withdrawQuote;
    return h('div', {}, h('h2', {}, t.withdrawTitle),
      h('dl', { class: 'kv' },
        h('dt', {}, t.quoteAmount), h('dd', {}, num('◎ ' + q.amountSol.toFixed(6))),
        h('dt', {}, t.quoteFee), h('dd', {}, num('◎ ' + q.feeSol.toFixed(6))),
        h('dt', {}, t.quoteRemaining), h('dd', {}, num('◎ ' + q.remainingSol.toFixed(6))),
      ),
      h('div', { class: 'btns' },
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm(t.withdrawConfirmDialog(q.amountSol.toFixed(6), q.destination))) return;
          try {
            const r = await post('/api/withdraw/confirm', { id: q.draft.id });
            alert(r.status === 'confirmed' ? t.withdrawSent + ': ' + r.signature : t.withdrawPending + ': ' + r.signature);
          } catch (e) { alert(e.message); }
          withdrawQuote = null; refreshTab();
        } }, t.confirmSendBtn),
        h('button', { class: 'ghost', onclick: () => { withdrawQuote = null; refreshTab(); } }, t.cancelBtn),
      ),
    );
  }
  const destInp = h('input', { placeholder: t.destLabel, dir: 'ltr' });
  const amtInp = h('input', { type: 'number', step: 'any', placeholder: t.amountLabel, dir: 'ltr' });
  const msg = h('span', { class: 'muted', role: 'status' });
  const doPrepare = async (amount) => {
    try {
      const r = await post('/api/withdraw/prepare', { destination: destInp.value.trim(), amount });
      if (!r.ok) { msg.textContent = r.error; msg.className = 'loss'; return; }
      withdrawQuote = { ...r, destination: destInp.value.trim() };
      refreshTab();
    } catch (e) { msg.textContent = e.message; msg.className = 'loss'; }
  };
  return h('div', {}, h('h2', {}, t.withdrawTitle),
    h('div', { class: 'wform' }, destInp, amtInp,
      h('div', { class: 'btns' },
        h('button', { onclick: () => doPrepare(Number(amtInp.value)) }, t.prepareBtn),
        h('button', { class: 'ghost', onclick: () => doPrepare('max') }, t.maxBtn),
      ),
      msg,
    ),
  );
}

async function refreshTab() {
  const t = T(); const body = $('tabBody');
  try {
    if (tab === 'wallet') {
      const w = state.walletAddress ? await api('/api/wallet') : { deposits: [] };
      const deposits = w.deposits || [];
      body.replaceChildren(
        walletSection(),
        state.walletAddress ? h('div', { class: 'section' },
          h('h2', {}, t.depositTitle), h('p', { class: 'muted' }, t.depositHelp),
          h('h3', {}, t.depositHistory),
          deposits.length ? table(['time', 'amount', 'sig'], deposits.map((d) => [d.blockTime ? time(d.blockTime * 1000) : '—', num('◎ ' + d.amountSol.toFixed(6)), link(d.signature)])) : h('div', { class: 'empty' }, t.noDeposits),
        ) : null,
        state.walletAddress ? h('div', { class: 'section' }, withdrawSection(w)) : null,
      );
    } else if (tab === 'withdrawals') {
      const rows = await api('/api/withdrawals?limit=50');
      body.replaceChildren(rows.length ? table(['time', 'dest', 'amount', 'fee', 'status', 'sig'], rows.map((wd) => [
        time(wd.requested_at), (wd.destination || '').slice(0, 10) + '…', num(sol(wd.amount_lamports, 6)), num(sol(wd.fee_lamports, 6)),
        h('span', { class: wd.status === 'confirmed' ? 'gain' : wd.status === 'failed' || wd.status === 'expired' ? 'loss' : 'warn' }, wd.status), link(wd.signature),
      ])) : h('div', { class: 'empty' }, t.none));
    } else if (tab === 'positions') {
      const rows = await api('/api/positions?limit=100');
      body.replaceChildren(rows.length ? table(['symbol', 'mode', 'state', 'cost', 'value', 'pnl', 'peak', 'held', 'exit', 'tx', 'act'], rows.map((p) => {
        const basis = p.cost_lamports - p.rent_lamports;
        const closed = p.state === 'closed';
        const pnlL = closed ? p.proceeds_lamports - p.cost_lamports : (p.last_value_lamports ? p.last_value_lamports - basis : null);
        const pct = closed ? (p.cost_lamports ? (pnlL / p.cost_lamports) * 100 : 0) : p.last_pnl_pct;
        return [p.symbol, h('span', { class: 'tag' }, p.mode === 'paper' ? (lang === 'ar' ? 'محاكاة' : 'paper') : (lang === 'ar' ? 'حقيقي' : 'live')), p.state + (p.note ? ' ⚠' : ''), num(sol(p.cost_lamports)),
          closed ? num(sol(p.proceeds_lamports)) : num(p.last_value_lamports ? sol(p.last_value_lamports) : '—'), num((pnlL == null ? '—' : signed(pnlL) + ' (' + pct.toFixed(1) + '%)'), cls(pnlL)), num(p.peak_pnl_pct.toFixed(1) + '%'),
          dur((p.closed_at || Date.now()) - p.opened_at), p.exit_reason || '', h('span', {}, link(p.buy_sig), ' ', link(p.sell_sig)),
          ['open', 'closing', 'stuck'].includes(p.state) ? h('button', { class: 'ghost', onclick: async () => { if (confirm(t.confirmClose)) { await post('/api/close', { id: p.id }); poll(); } } }, t.close) : ''];
      })) : h('div', { class: 'empty' }, t.none));
    } else if (tab === 'tokens') {
      const rows = await api('/api/tokens?limit=150');
      body.replaceChildren(rows.length ? table(['time', 'symbol', 'state', 'risk', 'quality', 'mcap', 'why'], rows.map((r) => [
        time(r.discovered_at), r.symbol || r.mint.slice(0, 6), r.state, num(r.risk_score == null ? '—' : r.risk_score), num(r.quality_score == null ? '—' : r.quality_score), num(r.market_cap_sol == null ? '—' : r.market_cap_sol.toFixed(1)),
        h('div', { class: 'reasons' }, (r.reasons || []).slice(0, 2).map((x) => h('div', {}, x)),
          r.checks && r.checks.length ? h('details', {}, h('summary', {}, t.checks), h('div', { class: 'check' }, r.checks.flatMap((c) => [h('span', { class: c.status === 'pass' ? 'gain' : c.status === 'fail' ? 'loss' : 'warn' }, c.status + ' · ' + t.evidence[c.evidence]), h('span', {}, c.id + ' — ' + c.detail)]))) : null)]
      )) : h('div', { class: 'empty' }, t.none));
    } else if (tab === 'orders') {
      const rows = await api('/api/orders?limit=100');
      body.replaceChildren(rows.length ? table(['time', 'side', 'route', 'state', 'slip', 'delta', 'fee', 'sig', 'err'], rows.map((o) => [time(o.created_at), o.side, o.route + (o.mode === 'paper' ? ' (paper)' : ''), o.state, num(o.slippage_pct), num(o.sol_delta_lamports == null ? '—' : signed(o.sol_delta_lamports)), num(o.fee_lamports == null ? '—' : sol(o.fee_lamports, 6)), link(o.signature), o.error || ''])) : h('div', { class: 'empty' }, t.none));
    } else {
      const rows = await api('/api/errors?limit=100');
      body.replaceChildren(rows.length ? table(['time', 'level', 'src', 'msg'], rows.map((e) => [time(e.ts), h('span', { class: e.level === 'critical' || e.level === 'error' ? 'loss' : 'warn' }, e.level), e.source, e.message])) : h('div', { class: 'empty' }, t.none));
    }
  } catch (e) { if (e.message !== 'unauthorized') online = false; }
}

function table(cols, rows) {
  const t = T();
  return h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, t.cols[c])))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { class: c && c.className && c.className.includes('reasons') ? 'reasons' : '' }, c))))));
}

async function poll() {
  try { state = await api('/api/state'); online = true; renderState(); }
  catch (e) { if (e.message !== 'unauthorized') online = false; if (state) renderState(); }
  await refreshTab();
}

$('langBtn').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; localStorage.setItem('lang', lang); settingsDirty = false; renderChrome(); if (state) renderState(); refreshTab(); });
$('killBtn').addEventListener('click', async () => { if (confirm(T().confirmKill)) { await post('/api/kill', { closeAll: false }); poll(); } });
$('killAllBtn').addEventListener('click', async () => { if (confirm(T().confirmKillAll)) { await post('/api/kill', { closeAll: true }); poll(); } });
$('resumeBtn').addEventListener('click', async () => { try { await post('/api/resume'); } catch (e) { alert(e.message); } poll(); });

renderChrome();
poll();
setInterval(poll, 2000);
