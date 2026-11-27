/**
 * 煎和鍋貼｜線上訂單 → Google Sheet
 * ------------------------------------------------------------
 * 部署方式請看同資料夾的 README.md。
 *
 * 功能：
 *  - doPost：接收官網送出的訂單，驗證、以伺服器價格重新計算金額、
 *            產生訂單編號、寫入「訂單」與「訂單明細」、寄通知信
 *  - doGet ：健康檢查；或以 ?orderNo=...&phone=... 查詢訂單狀態
 *  - setup ：建立／整理工作表（標題、格式、狀態下拉選單、每日統計）
 *  - onOpen：試算表上方新增「🥟 煎和鍋貼」選單
 *  - onEdit：修改訂單狀態時自動記錄「狀態更新時間」
 */

/* ============================================================
 * 1. 設定（價格、門市需與官網 index.html 一致）
 * ============================================================ */
const CONFIG = {
  SHOP_NAME: '煎和鍋貼',
  TIMEZONE: 'Asia/Taipei',
  SHIPPING_FEE: 150,
  FREE_SHIPPING: 1500,
  MAX_QTY_PER_ITEM: 99,
  MAX_ITEMS: 30,
  RATE_LIMIT: { MAX_ORDERS: 5, WINDOW_SEC: 600 }, // 同一支手機 10 分鐘內最多 5 筆
  // 新訂單通知信收件人；留空則寄給部署此程式的帳號
  NOTIFY_EMAIL: '',
  SEND_NOTIFY_EMAIL: true
};

const PRODUCTS = {
  p1: { name: '招牌高麗菜鍋貼', price: 70,  cat: 'potsticker' },
  p2: { name: '韭菜鮮肉鍋貼',   price: 75,  cat: 'potsticker' },
  p3: { name: '麻辣爆汁鍋貼',   price: 85,  cat: 'potsticker' },
  p4: { name: '玉米鮮肉鍋貼',   price: 75,  cat: 'potsticker' },
  p5: { name: '鮮蝦鍋貼',       price: 110, cat: 'potsticker' },
  p6: { name: '起司牽絲鍋貼',   price: 90,  cat: 'potsticker' },
  d1: { name: '高麗菜豬肉水餃', price: 65,  cat: 'dumpling' },
  d2: { name: '韭黃鮮蝦水餃',   price: 110, cat: 'dumpling' },
  d3: { name: '紅油抄手',       price: 80,  cat: 'dumpling' },
  d4: { name: '酸白菜水餃',     price: 70,  cat: 'dumpling' },
  s1: { name: '酸辣湯',         price: 40,  cat: 'drink' },
  s2: { name: '玉米蛋花湯',     price: 35,  cat: 'drink' },
  s3: { name: '古早味豆漿',     price: 30,  cat: 'drink' },
  s4: { name: '冬瓜檸檬',       price: 35,  cat: 'drink' },
  c1: { name: '涼拌小黃瓜',     price: 40,  cat: 'side' },
  c2: { name: '皮蛋豆腐',       price: 45,  cat: 'side' },
  c3: { name: '招牌滷味拼盤',   price: 60,  cat: 'side' },
  c4: { name: '麻辣鴨血',       price: 50,  cat: 'side' },
  g1: { name: '招財鍋貼禮盒',   price: 680, cat: 'gift' },
  g2: { name: '闔家團圓綜合組', price: 980, cat: 'gift' },
  g3: { name: '節慶伴手雙享盒', price: 560, cat: 'gift' }
};

const STORES = {
  flagship: '旗艦店',
  xinyi: '信義店',
  banqiao: '板橋店'
};

const MODES = { dinein: '內用', takeout: '外帶', delivery: '宅配' };
const STATUSES = ['待處理', '製作中', '可取餐', '已出貨', '已完成', '已取消'];

const SHEET = {
  ORDERS: '訂單',
  ITEMS: '訂單明細',
  STATS: '每日統計'
};

const ORDER_HEADERS = [
  '訂單編號', '下單時間', '狀態', '取餐方式', '姓名', '手機', '門市', '預計時間',
  '宅配地址', '備註', '品項摘要', '件數', '商品小計', '運費', '應付總額',
  '狀態更新時間', '來源頁面'
];
const ITEM_HEADERS = ['訂單編號', '下單時間', '商品代碼', '品名', '單價', '數量', '小計'];
const COL = Object.fromEntries(ORDER_HEADERS.map((h, i) => [h, i + 1]));

/* ============================================================
 * 2. Web App 入口
 * ============================================================ */
function doPost(e) {
  try {
    const body = parseBody_(e);

    // 機器人陷阱：真人看不到這個欄位，有填值就直接當成功丟棄
    if (body.website) return json_({ ok: true, orderNo: 'JH-IGNORED' });

    const order = validate_(body);
    checkRateLimit_(order.phone);

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let saved;
    try {
      saved = saveOrder_(order);
    } finally {
      lock.releaseLock();
    }

    if (CONFIG.SEND_NOTIFY_EMAIL) {
      try { notifyShop_(saved); } catch (err) { console.warn('通知信寄送失敗', err); }
    }

    return json_({
      ok: true,
      orderNo: saved.orderNo,
      createdAt: saved.createdAtText,
      subtotal: saved.subtotal,
      shipping: saved.shipping,
      total: saved.total,
      items: saved.items.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price }))
    });
  } catch (err) {
    const isUser = err && err.userMessage;
    if (!isUser) console.error(err);
    return json_({ ok: false, error: isUser ? err.userMessage : '系統忙碌中，請稍後再試或來電訂購。' });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.orderNo) return json_({ ok: true, service: CONFIG.SHOP_NAME + ' 訂單 API', time: now_().text });

  // 查詢訂單狀態：需同時提供訂單編號與手機，避免他人亂查
  const phone = normPhone_(p.phone || '');
  const sh = sheet_(SHEET.ORDERS);
  const last = sh.getLastRow();
  if (last < 2) return json_({ ok: false, error: '查無此訂單' });
  const rows = sh.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  const row = rows.find(r => String(r[COL['訂單編號'] - 1]) === String(p.orderNo) &&
                             normPhone_(String(r[COL['手機'] - 1])) === phone);
  if (!row) return json_({ ok: false, error: '查無此訂單' });
  return json_({
    ok: true,
    orderNo: row[COL['訂單編號'] - 1],
    status: row[COL['狀態'] - 1],
    mode: row[COL['取餐方式'] - 1],
    total: row[COL['應付總額'] - 1]
  });
}

/* ============================================================
 * 3. 驗證與計算
 * ============================================================ */
function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw userError_('沒有收到訂單資料');
  if (e.postData.contents.length > 20000) throw userError_('訂單資料過大');
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw userError_('訂單資料格式錯誤');
  }
}

function validate_(b) {
  const name = clean_(b.name, 30);
  const phone = normPhone_(b.phone || '');
  const mode = String(b.mode || '');
  const note = clean_(b.note, 200);

  if (!name) throw userError_('請填寫姓名');
  if (!/^09\d{8}$/.test(phone)) throw userError_('請輸入 09 開頭的 10 碼手機號碼');
  if (!MODES[mode]) throw userError_('請選擇取餐方式');

  let store = '', time = '', address = '';
  if (mode === 'delivery') {
    address = clean_(b.address, 120);
    if (address.length < 8) throw userError_('請填寫完整宅配地址');
  } else {
    if (!STORES[b.store]) throw userError_('請選擇取餐門市');
    store = STORES[b.store];
    time = clean_(b.time, 30);
    if (!time) throw userError_('請選擇預計時間');
  }

  if (!Array.isArray(b.items) || !b.items.length) throw userError_('購物車是空的');
  if (b.items.length > CONFIG.MAX_ITEMS) throw userError_('品項過多，請分次下單');

  // 合併同品項，並一律使用伺服器端價格
  const merged = {};
  b.items.forEach(it => {
    const id = String(it && it.id || '');
    const qty = Math.floor(Number(it && it.qty));
    if (!PRODUCTS[id]) throw userError_('購物車中有已下架的商品，請重新整理頁面');
    if (!(qty >= 1 && qty <= CONFIG.MAX_QTY_PER_ITEM)) throw userError_('商品數量需介於 1 到 ' + CONFIG.MAX_QTY_PER_ITEM);
    merged[id] = (merged[id] || 0) + qty;
  });
  const items = Object.keys(merged).map(id => {
    const p = PRODUCTS[id];
    const qty = Math.min(merged[id], CONFIG.MAX_QTY_PER_ITEM);
    return { id: id, name: p.name, price: p.price, qty: qty, amount: p.price * qty };
  });

  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const shipping = mode === 'delivery' && subtotal < CONFIG.FREE_SHIPPING ? CONFIG.SHIPPING_FEE : 0;

  return {
    name: name, phone: phone, mode: mode, store: store, time: time, address: address, note: note,
    items: items, subtotal: subtotal, shipping: shipping, total: subtotal + shipping,
    clientTotal: Number(b.clientTotal) || null,
    page: clean_(b.page, 200)
  };
}

function checkRateLimit_(phone) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + phone;
  const n = Number(cache.get(key) || 0);
  if (n >= CONFIG.RATE_LIMIT.MAX_ORDERS) throw userError_('短時間內下單次數過多，請稍後再試或直接來電');
  cache.put(key, String(n + 1), CONFIG.RATE_LIMIT.WINDOW_SEC);
}

/* ============================================================
 * 4. 寫入試算表
 * ============================================================ */
function saveOrder_(o) {
  const t = now_();
  const orderNo = nextOrderNo_(t);
  const summary = o.items.map(i => i.name + '×' + i.qty).join('、');
  const count = o.items.reduce((s, i) => s + i.qty, 0);

  const orders = sheet_(SHEET.ORDERS);
  orders.appendRow([
    orderNo, t.date, '待處理', MODES[o.mode], safe_(o.name), "'" + o.phone, o.store, safe_(o.time),
    safe_(o.address), safe_(o.note), safe_(summary), count, o.subtotal, o.shipping, o.total,
    t.date, safe_(o.page)
  ]);

  const items = sheet_(SHEET.ITEMS);
  const rows = o.items.map(i => [orderNo, t.date, i.id, i.name, i.price, i.qty, i.amount]);
  items.getRange(items.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);

  return Object.assign({}, o, { orderNo: orderNo, createdAt: t.date, createdAtText: t.text, summary: summary, count: count });
}

// 訂單編號：JH + 年月日 + 當日流水號，例如 JH261127-007
function nextOrderNo_(t) {
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(t.date, CONFIG.TIMEZONE, 'yyMMdd');
  const key = 'seq_' + day;
  const seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return 'JH' + day + '-' + String(seq).padStart(3, '0');
}

/* ============================================================
 * 5. 通知信
 * ============================================================ */
function notifyShop_(o) {
  const to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  if (!to) return;
  const where = o.mode === 'delivery' ? '宅配地址：' + o.address : '門市：' + o.store + '　時間：' + o.time;
  const lines = o.items.map(i => '・' + i.name + ' × ' + i.qty + '　NT$' + i.amount);
  const body = [
    '新訂單 ' + o.orderNo + '（' + MODES[o.mode] + '）',
    '',
    '姓名：' + o.name + '　手機：' + o.phone,
    where,
    o.note ? '備註：' + o.note : '',
    '',
    lines.join('\n'),
    '',
    '商品小計 NT$' + o.subtotal + '　運費 NT$' + o.shipping,
    '應付總額 NT$' + o.total,
    '',
    '試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  ].filter(function (l, i, a) { return l !== '' || a[i - 1] !== ''; }).join('\n');
  MailApp.sendEmail({
    to: to,
    subject: '【' + CONFIG.SHOP_NAME + '】新訂單 ' + o.orderNo + '｜' + MODES[o.mode] + '｜NT$' + o.total,
    body: body
  });
}

/* ============================================================
 * 6. 試算表工具：選單、初始化、狀態時間、今日報表
 * ============================================================ */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🥟 煎和鍋貼')
    .addItem('初始化／整理工作表', 'setup')
    .addItem('寄送今日營收報表給我', 'sendTodayReport')
    .addSeparator()
    .addItem('測試：建立一筆範例訂單', 'createSampleOrder')
    .addToUi();
}

function onEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== SHEET.ORDERS || r.getRow() < 2) return;
  if (r.getColumn() <= COL['狀態'] && r.getLastColumn() >= COL['狀態']) {
    r.getSheet().getRange(r.getRow(), COL['狀態更新時間'], r.getNumRows(), 1).setValue(new Date());
  }
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  // 訂單
  const o = ensureSheet_(ss, SHEET.ORDERS, ORDER_HEADERS);
  o.setFrozenRows(1); o.setFrozenColumns(1);
  const widths = [130, 150, 80, 80, 90, 110, 80, 110, 240, 200, 260, 60, 90, 70, 100, 150, 160];
  widths.forEach((w, i) => o.setColumnWidth(i + 1, w));
  const maxRows = o.getMaxRows();
  o.getRange(2, COL['下單時間'], maxRows - 1, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  o.getRange(2, COL['狀態更新時間'], maxRows - 1, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  o.getRange(2, COL['商品小計'], maxRows - 1, 3).setNumberFormat('"NT$"#,##0');
  o.getRange(2, COL['手機'], maxRows - 1, 1).setNumberFormat('@');
  o.getRange(2, COL['品項摘要'], maxRows - 1, 1).setWrap(true);

  // 狀態下拉選單與顏色
  const statusRange = o.getRange(2, COL['狀態'], maxRows - 1, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  const colors = { '待處理': ['#fde2cc', '#9a3c08'], '製作中': ['#fff1c2', '#7a5a00'], '可取餐': ['#d6f0d8', '#1d6b2c'],
                   '已出貨': ['#d7e7f7', '#1f4f82'], '已完成': ['#e6e0d8', '#4e3020'], '已取消': ['#eeeeee', '#888888'] };
  const rules = STATUSES.map(s => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(s).setBackground(colors[s][0]).setFontColor(colors[s][1]).setRanges([statusRange]).build());
  o.setConditionalFormatRules(rules);

  // 訂單明細
  const it = ensureSheet_(ss, SHEET.ITEMS, ITEM_HEADERS);
  it.setFrozenRows(1);
  [130, 150, 80, 160, 80, 60, 90].forEach((w, i) => it.setColumnWidth(i + 1, w));
  it.getRange(2, 2, it.getMaxRows() - 1, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  it.getRange(2, 5, it.getMaxRows() - 1, 1).setNumberFormat('"NT$"#,##0');
  it.getRange(2, 7, it.getMaxRows() - 1, 1).setNumberFormat('"NT$"#,##0');

  // 每日統計（公式自動更新，排除已取消）
  const st = ss.getSheetByName(SHEET.STATS) || ss.insertSheet(SHEET.STATS);
  st.clear();
  st.getRange('A1').setFormula(
    "=QUERY({訂單!B2:B, 訂單!C2:C, 訂單!O2:O}," +
    "\"select toDate(Col1), count(Col1), sum(Col3) where Col1 is not null and Col2 <> '已取消' " +
    "group by toDate(Col1) order by toDate(Col1) desc label toDate(Col1) '日期', count(Col1) '訂單數', sum(Col3) '營收'\", 0)");
  st.getRange('E1').setValue('熱銷品項（不含已取消）');
  st.getRange('E2').setFormula(
    "=IFERROR(QUERY({訂單明細!A2:A, 訂單明細!D2:D, 訂單明細!F2:F, 訂單明細!G2:G}," +
    "\"select Col2, sum(Col3), sum(Col4) where Col1 is not null group by Col2 order by sum(Col3) desc label Col2 '品名', sum(Col3) '數量', sum(Col4) '金額'\", 0), \"尚無資料\")");
  st.getRange('A:A').setNumberFormat('yyyy/mm/dd');
  st.getRange('C:C').setNumberFormat('"NT$"#,##0');
  st.getRange('G:G').setNumberFormat('"NT$"#,##0');
  st.getRange('A1:C1').setFontWeight('bold').setBackground('#3b2418').setFontColor('#fdfaf5');
  st.getRange('E1').setFontWeight('bold');
  st.setColumnWidths(1, 3, 110); st.setColumnWidth(6, 160);

  // 移除預設的空白工作表
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  ss.setActiveSheet(o);

  try { SpreadsheetApp.getUi().alert('✅ 工作表已建立完成！接下來請依 README 部署成網頁應用程式。'); } catch (e) { /* 從編輯器執行時沒有 UI */ }
}

function ensureSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#3b2418').setFontColor('#fdfaf5').setVerticalAlignment('middle');
  sh.setRowHeight(1, 32);
  return sh;
}

function sendTodayReport() {
  const t = now_();
  const today = Utilities.formatDate(t.date, CONFIG.TIMEZONE, 'yyyy/MM/dd');
  const sh = sheet_(SHEET.ORDERS);
  const last = sh.getLastRow();
  const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues()
    .filter(r => r[0] && Utilities.formatDate(new Date(r[COL['下單時間'] - 1]), CONFIG.TIMEZONE, 'yyyy/MM/dd') === today);
  const valid = rows.filter(r => r[COL['狀態'] - 1] !== '已取消');
  const revenue = valid.reduce((s, r) => s + Number(r[COL['應付總額'] - 1] || 0), 0);
  const byMode = {};
  valid.forEach(r => { const m = r[COL['取餐方式'] - 1]; byMode[m] = (byMode[m] || 0) + 1; });
  const pending = rows.filter(r => r[COL['狀態'] - 1] === '待處理').length;

  const body = [
    today + ' 營收報表',
    '',
    '有效訂單：' + valid.length + ' 筆（已取消 ' + (rows.length - valid.length) + ' 筆）',
    '營收：NT$' + revenue.toLocaleString(),
    '取餐方式：' + (Object.keys(byMode).map(k => k + ' ' + byMode[k] + ' 筆').join('、') || '—'),
    '尚待處理：' + pending + ' 筆',
    '',
    '試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  ].join('\n');
  const to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: '【' + CONFIG.SHOP_NAME + '】' + today + ' 營收報表｜NT$' + revenue.toLocaleString(), body: body });
  try { SpreadsheetApp.getUi().alert('已寄出今日報表到 ' + to); } catch (e) { /* 由排程觸發時沒有 UI */ }
}

// 不經過網站，直接模擬一筆訂單，方便確認寫入是否正常
function createSampleOrder() {
  const res = doPost({ postData: { contents: JSON.stringify({
    name: '測試客人', phone: '0912345678', mode: 'takeout', store: 'flagship', time: '18:30',
    note: '這是測試訂單，可直接刪除', items: [{ id: 'p1', qty: 2 }, { id: 's1', qty: 1 }], page: '試算表測試'
  }) } });
  const data = JSON.parse(res.getContent());
  try { SpreadsheetApp.getUi().alert(data.ok ? '✅ 已建立測試訂單 ' + data.orderNo : '❌ ' + data.error); } catch (e) { console.log(data); }
}

/* ============================================================
 * 7. 小工具
 * ============================================================ */
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表「' + name + '」，請先執行 setup');
  return sh;
}

function now_() {
  const d = new Date();
  return { date: d, text: Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm') };
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 防止試算表公式注入：以 = + - @ 開頭的文字前面加上單引號
function safe_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// 只保留數字（也會去掉存入試算表時加的單引號）
function normPhone_(v) {
  return String(v).replace(/\D/g, '');
}

function userError_(msg) {
  const e = new Error(msg);
  e.userMessage = msg;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
