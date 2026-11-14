/**
 * 대전세종목공기술학원 예약 서버 (구글 Apps Script)
 * 이 파일 전체를 Apps Script 편집기의 Code.gs 에 붙여넣으세요.
 * 자동 생성 파일: core.js 와 server/sheets-adapter.js 를 고친 뒤 build.sh 로 다시 만드세요.
 */
/*
 * 대전세종목공기술학원 예약 앱 — 공통 처리 로직
 * 이 파일 하나가 두 곳에서 똑같이 쓰여요.
 *   1) 구글 Apps Script 서버 (server/Code.gs 안에 그대로 들어감)
 *   2) 서버 연결 전 '체험 모드' (브라우저 안에서 실행)
 * db 는 rows/insert/update/remove/getConfig/setConfig 를 가진 저장소예요.
 */
var WoodshopCore = (function () {
  var STATUSES = ["booked", "confirmed", "done", "cancelled"];
  var DEFAULT_CONFIG = {
    capacity: 6,
    open: "09:00",
    close: "22:00",
    tools: "테이블쏘, 각도절단기, 밴드쏘, 수압대패, 자동대패, 트리머·라우터, 드릴프레스, 각끌기, 샌더, 도미노",
  };
  var STAGES = ["설계·도면", "재단", "가공·짜맞춤", "조립", "샌딩", "마감(오일·도장)", "기타"];

  function fail(msg) { var e = new Error(msg); e.userFacing = true; throw e; }
  function str(v, max) { v = v == null ? "" : String(v).trim(); return max ? v.slice(0, max) : v; }
  function toMin(t) { var p = String(t).split(":"); return Number(p[0]) * 60 + Number(p[1]); }
  function isTime(t) { return /^\d{2}:(00|30)$/.test(String(t)); }
  function isDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d)); }
  function splitTools(s) { return String(s || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function config(db) {
    var c = db.getConfig() || {};
    return {
      capacity: Number(c.capacity) || DEFAULT_CONFIG.capacity,
      open: isTime(c.open) ? c.open : DEFAULT_CONFIG.open,
      close: isTime(c.close) ? c.close : DEFAULT_CONFIG.close,
      tools: splitTools(c.tools || DEFAULT_CONFIG.tools),
      stages: STAGES,
    };
  }
  function active(b) { return b.status !== "cancelled"; }
  function overlaps(a, s, e) { return toMin(a.start) < toMin(e) && toMin(s) < toMin(a.end); }
  function peak(list, s, e) {
    var max = 0;
    for (var t = toMin(s); t < toMin(e); t += 30) {
      var n = list.filter(function (b) { return toMin(b.start) <= t && t < toMin(b.end); }).length;
      if (n > max) max = n;
    }
    return max;
  }
  function who(p) {
    var name = str(p.name, 20), last4 = str(p.last4);
    if (!name) fail("이름을 입력해 주세요.");
    if (!/^\d{4}$/.test(last4)) fail("휴대폰 번호 뒷자리 4자리를 숫자로 입력해 주세요.");
    return { name: name, last4: last4 };
  }
  function pub(b) { // 회원에게 보여줄 내용만
    return { id: b.id, date: b.date, start: b.start, end: b.end, project: b.project, stage: b.stage,
      tools: splitTools(b.tools), status: b.status, ownerNote: b.ownerNote };
  }
  function full(b) { var o = pub(b); o.name = b.name; o.last4 = b.last4; o.createdAt = b.createdAt; o.handledBy = b.handledBy || ""; return o; }
  function findMember(db, name, last4) {
    return db.rows("members").filter(function (m) { return m.name === name && m.last4 === last4; })[0];
  }

  var publicActions = {
    config: function (p, db) { return config(db); },

    // 날짜별 예약 시간만 (이름 없이) — 남은 자리 계산용
    slots: function (p, db) {
      if (!isDate(p.date)) fail("날짜 형식이 올바르지 않아요.");
      return db.rows("bookings").filter(function (b) { return b.date === p.date && active(b); })
        .map(function (b) { return { start: b.start, end: b.end }; });
    },

    book: function (p, db, opt) {
      var w = who(p), c = config(db);
      var date = str(p.date), s = str(p.start), e = str(p.end);
      if (!isDate(date)) fail("방문 날짜를 골라 주세요.");
      if (date < opt.today) fail("지난 날짜는 예약할 수 없어요.");
      if (!isTime(s) || !isTime(e)) fail("방문 시간을 30분 단위로 골라 주세요.");
      if (toMin(s) < toMin(c.open) || toMin(e) > toMin(c.close)) fail("운영 시간(" + c.open + "~" + c.close + ") 안에서 골라 주세요.");
      if (toMin(e) <= toMin(s)) fail("끝나는 시간이 시작 시간보다 늦어야 해요.");
      var project = str(p.project, 100);
      if (!project) fail("무슨 작업을 할 예정인지 적어 주세요.");
      var stage = STAGES.indexOf(str(p.stage)) >= 0 ? str(p.stage) : "";
      var tools = (Array.isArray(p.tools) ? p.tools : []).map(String).filter(function (t) { return c.tools.indexOf(t) >= 0; });

      var sameDay = db.rows("bookings").filter(function (b) { return b.date === date && active(b); });
      if (sameDay.some(function (b) { return b.name === w.name && b.last4 === w.last4 && overlaps(b, s, e); }))
        fail("같은 시간에 이미 예약이 있어요.");
      var n = peak(sameDay, s, e);
      if (n >= c.capacity) fail("그 시간에는 자리가 다 찼어요. 다른 시간을 골라 주세요.");

      var now = opt.now;
      var b = { id: newId(), name: w.name, last4: w.last4, date: date, start: s, end: e, project: project,
        stage: stage, tools: tools.join(", "), status: "booked", ownerNote: "", createdAt: now };
      db.insert("bookings", b);
      if (!findMember(db, w.name, w.last4))
        db.insert("members", { id: newId(), name: w.name, last4: w.last4, phone: "", memo: "", createdAt: now });
      return pub(b);
    },

    mine: function (p, db, opt) {
      var w = who(p);
      return db.rows("bookings")
        .filter(function (b) { return b.name === w.name && b.last4 === w.last4 && b.date >= opt.today; })
        .sort(byWhen).map(pub);
    },

    cancel: function (p, db, opt) {
      var w = who(p);
      var b = db.rows("bookings").filter(function (x) { return x.id === str(p.id); })[0];
      if (!b || b.name !== w.name || b.last4 !== w.last4) fail("예약을 찾을 수 없어요.");
      if (b.date < opt.today) fail("지난 예약은 취소할 수 없어요.");
      if (b.status === "done" || b.status === "cancelled") fail("이미 " + (b.status === "done" ? "완료된" : "취소된") + " 예약이에요.");
      db.update("bookings", b.id, { status: "cancelled" });
      return { ok: true };
    },
  };

  var adminActions = {
    adminCheck: function () { return { ok: true }; },
    adminData: function (p, db) {
      return { bookings: db.rows("bookings").map(full), members: db.rows("members"), config: config(db) };
    },
    setStatus: function (p, db, opt) {
      if (STATUSES.indexOf(p.status) < 0) fail("상태 값이 올바르지 않아요.");
      db.update("bookings", str(p.id), { status: p.status, handledBy: opt.adminName }); return { ok: true };
    },
    setNote: function (p, db, opt) { db.update("bookings", str(p.id), { ownerNote: str(p.note, 300), handledBy: opt.adminName }); return { ok: true }; },
    deleteBooking: function (p, db) { db.remove("bookings", str(p.id)); return { ok: true }; },
    saveMember: function (p, db, opt) {
      var w = who(p);
      var v = { name: w.name, last4: w.last4, phone: str(p.phone, 20), memo: str(p.memo, 300) };
      var dup = findMember(db, w.name, w.last4);
      if (p.id) {
        if (dup && dup.id !== p.id) fail("같은 이름·뒷자리 회원이 이미 있어요.");
        db.update("members", str(p.id), v);
        return { ok: true };
      }
      if (dup) fail("같은 이름·뒷자리 회원이 이미 있어요.");
      v.id = newId(); v.createdAt = opt.now; db.insert("members", v);
      return { ok: true };
    },
    deleteMember: function (p, db) { db.remove("members", str(p.id)); return { ok: true }; },
    saveConfig: function (p, db) {
      var cap = Math.max(1, Math.min(50, Number(p.capacity) || DEFAULT_CONFIG.capacity));
      var tools = (Array.isArray(p.tools) ? p.tools : splitTools(p.tools)).map(function (t) { return str(t, 30); }).filter(Boolean);
      var open = isTime(p.open) ? p.open : DEFAULT_CONFIG.open, close = isTime(p.close) ? p.close : DEFAULT_CONFIG.close;
      if (toMin(close) <= toMin(open)) fail("마감 시간이 시작 시간보다 늦어야 해요.");
      db.setConfig({ capacity: cap, tools: tools.join(", "), open: open, close: close });
      return config(db);
    },
  };

  function byWhen(a, b) { return (a.date + a.start).localeCompare(b.date + b.start); }

  /**
   * req = { action, ...params, adminId, pin }
   * opt = { admins: { 아이디: { name, pin } }, today:'YYYY-MM-DD', now:'YYYY-MM-DD HH:mm' }
   */
  function handle(req, db, opt) {
    try {
      req = req || {};
      var a = req.action;
      if (publicActions[a]) return { ok: true, data: publicActions[a](req, db, opt) };
      if (adminActions[a]) {
        var admin = (opt.admins || {})[str(req.adminId)];
        if (!admin || !admin.pin || String(req.pin || "") !== String(admin.pin))
          return { ok: false, error: "아이디 또는 비밀번호가 맞지 않아요.", badPin: true };
        if (a === "adminCheck") return { ok: true, data: { id: str(req.adminId), name: admin.name } };
        opt.adminName = admin.name;
        return { ok: true, data: adminActions[a](req, db, opt) };
      }
      return { ok: false, error: "알 수 없는 요청이에요." };
    } catch (e) {
      return { ok: false, error: e.userFacing ? e.message : "처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요." };
    }
  }

  return { handle: handle, DEFAULT_CONFIG: DEFAULT_CONFIG };
})();

/* ───────────── 아래부터는 구글 시트 연결 부분 ───────────── */

// 시트 탭 이름과 열 제목 (열 순서는 바꿔도 되지만 제목 글자는 바꾸지 마세요)
var TABLES_ = {
  bookings: { sheet: "예약", cols: [
    ["id", "예약번호"], ["date", "날짜"], ["start", "시작"], ["end", "종료"], ["name", "이름"], ["last4", "휴대폰 뒷자리"],
    ["project", "작업 내용"], ["stage", "작업 단계"], ["tools", "사용 장비"], ["status", "상태"], ["ownerNote", "원장 메모"], ["handledBy", "처리한 원장"], ["createdAt", "신청 시각"],
  ] },
  members: { sheet: "회원", cols: [
    ["id", "회원번호"], ["name", "이름"], ["last4", "휴대폰 뒷자리"], ["phone", "연락처"], ["memo", "메모"], ["createdAt", "등록일"],
  ] },
};
var STATUS_LABEL_ = { booked: "예약됨", confirmed: "준비 확인", done: "작업 완료", cancelled: "취소" };
var CONFIG_SHEET_ = "설정";
var CONFIG_KEYS_ = [["capacity", "같은 시간 최대 인원"], ["open", "운영 시작"], ["close", "운영 종료"], ["tools", "장비 목록(쉼표로 구분)"]];

// 원장 메뉴를 쓸 수 있는 사람 (아이디, 이름).
// 비밀번호는 코드에 적지 않고 '프로젝트 설정 > 스크립트 속성'에 PW_아이디 이름으로 저장해요.
var ADMIN_USERS_ = [
  ["kommy9", "고명균"],
  ["wood77", "이문회"],
];

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetFor_(table) {
  var t = TABLES_[table], sh = ss_().getSheetByName(t.sheet);
  if (!sh) {
    sh = ss_().insertSheet(t.sheet);
    sh.getRange(1, 1, sh.getMaxRows(), t.cols.length).setNumberFormat("@");
    sh.getRange(1, 1, 1, t.cols.length).setValues([t.cols.map(function (c) { return c[1]; })])
      .setFontWeight("bold").setBackground("#f1e3d3");
    sh.setFrozenRows(1);
  }
  return sh;
}

function colIndex_(table, header, sh) {
  var idx = {};
  TABLES_[table].cols.forEach(function (c) {
    var i = header.indexOf(c[1]);
    if (i < 0) { // 새로 생긴 열은 오른쪽 끝에 자동으로 추가
      i = header.length; header.push(c[1]);
      sh.getRange(1, i + 1).setNumberFormat("@").setValue(c[1]).setFontWeight("bold").setBackground("#f1e3d3");
    }
    idx[c[0]] = i;
  });
  return idx;
}

// 수식으로 해석되지 않도록 사용자 입력을 글자로 고정
function safe_(v) { v = v == null ? "" : String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; }

function toSheetVal_(table, key, v) {
  if (table === "bookings" && key === "status") return STATUS_LABEL_[v] || v;
  return safe_(v);
}
function fromSheetVal_(table, key, v) {
  if (table === "bookings" && key === "status") {
    for (var k in STATUS_LABEL_) if (STATUS_LABEL_[k] === v) return k;
    return v || "booked";
  }
  return v;
}

function makeDb_() {
  var cache = {};
  function load(table) {
    if (cache[table]) return cache[table];
    var sh = sheetFor_(table), values = sh.getDataRange().getDisplayValues();
    var idx = colIndex_(table, values[0], sh), rows = [];
    for (var r = 1; r < values.length; r++) {
      if (!values[r][idx.id]) continue;
      var o = { _row: r + 1 };
      for (var k in idx) o[k] = fromSheetVal_(table, k, values[r][idx[k]]);
      rows.push(o);
    }
    cache[table] = { sh: sh, idx: idx, rows: rows, width: Math.max(values[0].length, TABLES_[table].cols.length) };
    return cache[table];
  }
  function strip(o) { var c = {}; for (var k in o) if (k !== "_row") c[k] = o[k]; return c; }

  return {
    rows: function (table) { return load(table).rows.map(strip); },
    insert: function (table, obj) {
      var t = load(table), line = [];
      for (var i = 0; i < t.width; i++) line.push("");
      for (var k in t.idx) line[t.idx[k]] = toSheetVal_(table, k, obj[k]);
      var row = t.sh.getLastRow() + 1;
      if (t.sh.getMaxColumns() < t.width) t.sh.insertColumnsAfter(t.sh.getMaxColumns(), t.width - t.sh.getMaxColumns());
      t.sh.getRange(row, 1, 1, t.width).setNumberFormat("@").setValues([line]);
      delete cache[table];
    },
    update: function (table, id, patch) {
      var t = load(table), hit = t.rows.filter(function (r) { return r.id === id; })[0];
      if (!hit) throw new Error("not found");
      for (var k in patch) if (k in t.idx) t.sh.getRange(hit._row, t.idx[k] + 1).setValue(toSheetVal_(table, k, patch[k]));
      delete cache[table];
    },
    remove: function (table, id) {
      var t = load(table), hit = t.rows.filter(function (r) { return r.id === id; })[0];
      if (hit) t.sh.deleteRow(hit._row);
      delete cache[table];
    },
    getConfig: function () {
      var sh = configSheet_(), values = sh.getDataRange().getDisplayValues(), c = {};
      CONFIG_KEYS_.forEach(function (kv) {
        for (var r = 1; r < values.length; r++) if (values[r][0] === kv[1]) c[kv[0]] = values[r][1];
      });
      return c;
    },
    setConfig: function (c) {
      var sh = configSheet_();
      sh.getRange(2, 1, CONFIG_KEYS_.length, 2).setNumberFormat("@")
        .setValues(CONFIG_KEYS_.map(function (kv) { return [kv[1], safe_(c[kv[0]])]; }));
    },
  };
}

function configSheet_() {
  var sh = ss_().getSheetByName(CONFIG_SHEET_);
  if (!sh) {
    sh = ss_().insertSheet(CONFIG_SHEET_);
    var d = WoodshopCore.DEFAULT_CONFIG;
    sh.getRange(1, 1, CONFIG_KEYS_.length + 1, 2).setNumberFormat("@").setValues(
      [["항목", "값"]].concat(CONFIG_KEYS_.map(function (kv) { return [kv[1], String(d[kv[0]])]; })));
    sh.getRange(1, 1, 1, 2).setFontWeight("bold").setBackground("#f1e3d3");
    sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 600);
  }
  return sh;
}

function admins_() {
  var props = PropertiesService.getScriptProperties(), out = {};
  ADMIN_USERS_.forEach(function (u) { out[u[0]] = { name: u[1], pin: props.getProperty("PW_" + u[0]) }; });
  return out;
}

function options_() {
  var now = new Date();
  return {
    admins: admins_(),
    today: Utilities.formatDate(now, "Asia/Seoul", "yyyy-MM-dd"),
    now: Utilities.formatDate(now, "Asia/Seoul", "yyyy-MM-dd HH:mm"),
  };
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  var req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "요청 형식이 올바르지 않아요." }); }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: "요청이 몰려 있어요. 잠시 후 다시 시도해 주세요." });
  try {
    var res = WoodshopCore.handle(req, makeDb_(), options_());
    if (res.badPin) Utilities.sleep(1500); // 비밀번호 무작위 대입을 느리게
    return json_(res);
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json_({ ok: true, message: "대전세종목공기술학원 예약 서버가 작동 중이에요." });
}

/** 처음 한 번 실행: 시트 탭(예약·회원·설정)을 만들고 권한을 승인받아요. */
function setup() {
  sheetFor_("bookings"); sheetFor_("members"); configSheet_();
  var a = admins_(), missing = ADMIN_USERS_.filter(function (u) { return !a[u[0]].pin; });
  Logger.log(missing.length
    ? "시트는 준비됐어요. 이제 '프로젝트 설정 > 스크립트 속성'에 다음 비밀번호를 추가해 주세요: " +
      missing.map(function (u) { return "PW_" + u[0] + " (" + u[1] + ")"; }).join(", ")
    : "준비 완료! 원장 " + ADMIN_USERS_.length + "명의 비밀번호가 모두 설정되어 있어요.");
}
