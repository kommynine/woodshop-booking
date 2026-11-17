/**
 * 대전세종목공기술학원 예약 서버 (구글 Apps Script)
 * 이 파일 전체를 Apps Script 편집기의 Code.gs 에 붙여넣으세요.
 * 자동 생성 파일: core.js, server/sheets-adapter.js, server/slack.js 를 고친 뒤 build.sh 로 다시 만드세요.
 */
/*
 * 대전세종목공기술학원 예약 앱 — 공통 처리 로직
 * 이 파일 하나가 두 곳에서 똑같이 쓰여요.
 *   1) 구글 Apps Script 서버 (server/Code.gs 안에 그대로 들어감)
 *   2) 서버 연결 전 '체험 모드' (브라우저 안에서 실행)
 * db 는 rows/insert/update/remove/getConfig/setConfig 를 가진 저장소예요.
 */
var WoodshopCore = (function () {
  // 예약은 신청 즉시 확정(booked). 원장이 필요하면 '작업 완료'나 '취소'로 바꿔요.
  var STATUSES = ["booked", "done", "cancelled"];
  var STATUS_LABELS = { booked: "예약됨", done: "작업 완료", cancelled: "취소" };
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
  // 서버가 정해 준 알림 함수(Slack 등)를 부르되, 알림이 실패해도 예약 처리는 그대로 진행
  function notify(opt, event, b, db) {
    if (!opt || typeof opt.notify !== "function") return;
    try { opt.notify(event, b, db); } catch (e) { if (opt.log) opt.log("알림 실패: " + (e && e.message)); }
  }
  /* ── 변경 기록(감사 로그): 데이터가 바뀔 때마다 '누가 · 무엇을 · 전→후'를 서버에 알려요.
   *    서버(Slack 연결부)가 받아서 고명균 원장님께 개인 메시지로 보내요. 실패해도 처리에는 영향 없음. */
  var WD = ["일", "월", "화", "수", "목", "금", "토"];
  function md(d) { var p = String(d).split("-").map(Number); return p[1] + "/" + p[2] + "(" + WD[new Date(p[0], p[1] - 1, p[2]).getDay()] + ")"; }
  function bLine(b) { return b.name + "(" + b.last4 + ") · " + md(b.date) + " " + b.start + "~" + b.end + " · " + b.project; }
  function show(v) { v = v == null ? "" : String(v); return v ? "\"" + v + "\"" : "(비어 있음)"; }
  function diff(before, after, fields) {
    var out = [];
    fields.forEach(function (f) {
      var a = before[f[0]] == null ? "" : String(before[f[0]]), b = after[f[0]] == null ? "" : String(after[f[0]]);
      if (a !== b) out.push(f[1] + ": " + show(a) + " → " + show(b));
    });
    return out;
  }
  function audit(opt, title, lines) {
    if (!opt || typeof opt.audit !== "function") return;
    try {
      opt.audit({ title: title, lines: lines || [], actor: opt.actor || "알 수 없음", actorAdminId: opt.adminId || "", at: opt.now || "" });
    } catch (e) { if (opt.log) opt.log("변경 알림 실패: " + (e && e.message)); }
  }
  function findBooking(db, id) { return db.rows("bookings").filter(function (x) { return x.id === id; })[0]; }
  /** 원장의 상태 변경 (작업 완료 / 취소 / 되돌리기) */
  function decide(db, id, status, byName, opt) {
    if (STATUSES.indexOf(status) < 0) fail("상태 값이 올바르지 않아요.");
    var b = findBooking(db, str(id));
    if (!b) fail("예약을 찾을 수 없어요.");
    if (b.status === status) return { booking: b, changed: false };
    var before = b.status;
    var patch = { status: status, handledBy: byName || "" };
    db.update("bookings", b.id, patch);
    for (var k in patch) b[k] = patch[k];
    notify(opt, "status", b, db);
    audit(opt, "🔄 예약 상태 변경", [bLine(b), "상태: " + STATUS_LABELS[before] + " → " + STATUS_LABELS[status]]);
    return { booking: b, changed: true };
  }
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
      var newMember = !findMember(db, w.name, w.last4);
      if (newMember)
        db.insert("members", { id: newId(), name: w.name, last4: w.last4, phone: "", memo: "", createdAt: now });
      notify(opt, "new", b, db);
      opt.actor = "회원 본인 (" + w.name + "·" + w.last4 + ")";
      var bl = [bLine(b)];
      if (stage) bl.push("작업 단계: " + stage);
      if (tools.length) bl.push("사용 장비: " + tools.join(", "));
      if (newMember) bl.push("➕ 처음 예약한 회원이라 회원 목록에 자동 등록했어요.");
      audit(opt, "🆕 새 예약", bl);
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
      if (b.status !== "booked") fail("이미 '" + STATUS_LABELS[b.status] + "' 상태라 취소할 수 없어요.");
      db.update("bookings", b.id, { status: "cancelled" });
      b.status = "cancelled";
      notify(opt, "cancelled", b, db);
      opt.actor = "회원 본인 (" + w.name + "·" + w.last4 + ")";
      audit(opt, "🚫 회원이 예약 취소", [bLine(b)]);
      return { ok: true };
    },
  };

  var adminActions = {
    adminCheck: function () { return { ok: true }; },
    adminData: function (p, db) {
      return { bookings: db.rows("bookings").map(full), members: db.rows("members"), fees: db.rows("fees"), config: config(db) };
    },
    setStatus: function (p, db, opt) { decide(db, p.id, p.status, opt.adminName, opt); return { ok: true }; },
    setNote: function (p, db, opt) {
      var b = findBooking(db, str(p.id));
      if (!b) fail("예약을 찾을 수 없어요.");
      var note = str(p.note, 300);
      if (note === (b.ownerNote || "")) return { ok: true };
      db.update("bookings", b.id, { ownerNote: note, handledBy: opt.adminName });
      audit(opt, "📝 예약 메모 수정", [bLine(b), "메모: " + show(b.ownerNote) + " → " + show(note)]);
      return { ok: true };
    },
    deleteBooking: function (p, db, opt) {
      var b = findBooking(db, str(p.id));
      if (!b) return { ok: true };
      db.remove("bookings", b.id);
      audit(opt, "🗑️ 예약 삭제", [bLine(b), "삭제 전 상태: " + (STATUS_LABELS[b.status] || b.status)]);
      return { ok: true };
    },
    saveMember: function (p, db, opt) {
      var w = who(p);
      var v = { name: w.name, last4: w.last4, phone: str(p.phone, 20), memo: str(p.memo, 300) };
      var dup = findMember(db, w.name, w.last4);
      if (p.id) {
        if (dup && dup.id !== p.id) fail("같은 이름·뒷자리 회원이 이미 있어요.");
        var old = db.rows("members").filter(function (x) { return x.id === str(p.id); })[0] || {};
        db.update("members", str(p.id), v);
        var ch = diff(old, v, [["name", "이름"], ["last4", "휴대폰 뒷자리"], ["phone", "연락처"], ["memo", "기타(메모)"]]);
        if (ch.length) audit(opt, "✏️ 회원 정보 수정", [(old.name || v.name) + "(" + (old.last4 || v.last4) + ")"].concat(ch));
        return { id: str(p.id) };
      }
      if (dup) fail("같은 이름·뒷자리 회원이 이미 있어요.");
      v.id = newId(); v.createdAt = opt.now; db.insert("members", v);
      var ml = [v.name + "(" + v.last4 + ")"];
      if (v.phone) ml.push("연락처: " + v.phone);
      if (v.memo) ml.push("기타(메모): " + v.memo);
      audit(opt, "👤 회원 추가", ml);
      return { id: v.id };
    },
    // 회비 납부 기간 (한 회원에 여러 번 쌓여요)
    saveFee: function (p, db, opt) {
      var m = db.rows("members").filter(function (x) { return x.id === str(p.memberId); })[0];
      if (!m) fail("회원을 찾을 수 없어요.");
      var s = str(p.start), e = str(p.end);
      if (!isDate(s) || !isDate(e)) fail("회비기간 시작일과 종료일을 골라 주세요.");
      if (e < s) fail("종료일이 시작일보다 빨라요.");
      var v = { memberId: m.id, name: m.name, last4: m.last4, start: s, end: e, note: str(p.note, 100), by: opt.adminName || "" };
      if (p.id) {
        var oldF = db.rows("fees").filter(function (x) { return x.id === str(p.id); })[0] || {};
        db.update("fees", str(p.id), v);
        var fc = diff(oldF, v, [["start", "시작일"], ["end", "종료일"], ["note", "메모"]]);
        if (fc.length) audit(opt, "💳 회비기간 수정", [m.name + "(" + m.last4 + ")"].concat(fc));
        return { id: str(p.id) };
      }
      v.id = newId(); v.createdAt = opt.now; db.insert("fees", v);
      audit(opt, "💳 회비기간 추가", [m.name + "(" + m.last4 + ")", "기간: " + s + " ~ " + e + (v.note ? " · " + v.note : "")]);
      return { id: v.id };
    },
    deleteFee: function (p, db, opt) {
      var f = db.rows("fees").filter(function (x) { return x.id === str(p.id); })[0];
      if (!f) return { ok: true };
      db.remove("fees", f.id);
      audit(opt, "🗑️ 회비기간 삭제", [f.name + "(" + f.last4 + ")", "기간: " + f.start + " ~ " + f.end + (f.note ? " · " + f.note : "")]);
      return { ok: true };
    },
    deleteMember: function (p, db, opt) {
      var m = db.rows("members").filter(function (x) { return x.id === str(p.id); })[0];
      if (!m) return { ok: true };
      db.remove("members", m.id);
      audit(opt, "🗑️ 회원 삭제", [m.name + "(" + m.last4 + ")" + (m.memo ? " · 메모: " + m.memo : ""), "예약·회비 기록은 시트에 남아 있어요."]);
      return { ok: true };
    },
    saveConfig: function (p, db, opt) {
      var before = config(db);
      var cap = Math.max(1, Math.min(50, Number(p.capacity) || DEFAULT_CONFIG.capacity));
      var tools = (Array.isArray(p.tools) ? p.tools : splitTools(p.tools)).map(function (t) { return str(t, 30); }).filter(Boolean);
      var open = isTime(p.open) ? p.open : DEFAULT_CONFIG.open, close = isTime(p.close) ? p.close : DEFAULT_CONFIG.close;
      if (toMin(close) <= toMin(open)) fail("마감 시간이 시작 시간보다 늦어야 해요.");
      db.setConfig({ capacity: cap, tools: tools.join(", "), open: open, close: close });
      var after = config(db);
      var cc = diff({ capacity: before.capacity, hours: before.open + "~" + before.close, tools: before.tools.join(", ") },
        { capacity: after.capacity, hours: after.open + "~" + after.close, tools: after.tools.join(", ") },
        [["capacity", "같은 시간 최대 인원"], ["hours", "운영 시간"], ["tools", "장비 목록"]]);
      if (cc.length) audit(opt, "⚙️ 공방 설정 변경", cc);
      return after;
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
        opt.adminId = str(req.adminId);
        opt.actor = admin.name + " 원장";
        return { ok: true, data: adminActions[a](req, db, opt) };
      }
      return { ok: false, error: "알 수 없는 요청이에요." };
    } catch (e) {
      return { ok: false, error: e.userFacing ? e.message : "처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요." };
    }
  }

  return { handle: handle, decide: decide, DEFAULT_CONFIG: DEFAULT_CONFIG, STATUS_LABELS: STATUS_LABELS };
})();

/* ───────────── 아래부터는 구글 시트 연결 부분 ───────────── */

// 시트 탭 이름과 열 제목 (열 순서는 바꿔도 되지만 제목 글자는 바꾸지 마세요)
var TABLES_ = {
  bookings: { sheet: "예약", cols: [
    ["id", "예약번호"], ["date", "날짜"], ["start", "시작"], ["end", "종료"], ["name", "이름"], ["last4", "휴대폰 뒷자리"],
    ["project", "작업 내용"], ["stage", "작업 단계"], ["tools", "사용 장비"], ["status", "상태"], ["ownerNote", "원장 메모"], ["handledBy", "처리한 원장"], ["createdAt", "신청 시각"], ["slackRef", "슬랙 메시지"],
  ] },
  members: { sheet: "회원", cols: [
    ["id", "회원번호"], ["name", "이름"], ["last4", "휴대폰 뒷자리"], ["phone", "연락처"], ["memo", "메모"], ["createdAt", "등록일"],
  ] },
  fees: { sheet: "회비", cols: [
    ["id", "기록번호"], ["memberId", "회원번호"], ["name", "이름"], ["last4", "휴대폰 뒷자리"],
    ["start", "회비 시작일"], ["end", "회비 종료일"], ["note", "메모"], ["by", "기록한 원장"], ["createdAt", "기록 시각"],
  ] },
};
var STATUS_LABEL_ = WoodshopCore.STATUS_LABELS; // 예약됨 / 작업 완료 / 취소
// 이전 버전에서 쓰던 이름도 알아듣기
var LEGACY_STATUS_ = { "준비 확인": "booked", "승인 대기": "booked", "승인됨": "booked", "거절": "cancelled",
  confirmed: "booked", rejected: "cancelled" };
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
    if (LEGACY_STATUS_[v]) return LEGACY_STATUS_[v];
    if (WoodshopCore.STATUS_LABELS[v]) return v; // 영어 코드로 적혀 있어도 인정
    return "booked";
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
    notify: slackNotify_,
    audit: slackAudit_,
    log: function (m) { Logger.log(m); },
    today: Utilities.formatDate(now, "Asia/Seoul", "yyyy-MM-dd"),
    now: Utilities.formatDate(now, "Asia/Seoul", "yyyy-MM-dd HH:mm"),
  };
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  // 이전 버전의 Slack 승인 버튼이 눌린 경우: 이제 승인 절차가 없으니 조용히 무시
  if (e && e.parameter && e.parameter.payload) return HtmlService.createHtmlOutput("");
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
  sheetFor_("bookings"); sheetFor_("members"); sheetFor_("fees"); configSheet_();
  var a = admins_(), missing = ADMIN_USERS_.filter(function (u) { return !a[u[0]].pin; });
  Logger.log(missing.length
    ? "시트는 준비됐어요. 이제 '프로젝트 설정 > 스크립트 속성'에 다음 비밀번호를 추가해 주세요: " +
      missing.map(function (u) { return "PW_" + u[0] + " (" + u[1] + ")"; }).join(", ")
    : "준비 완료! 원장 " + ADMIN_USERS_.length + "명의 비밀번호가 모두 설정되어 있어요.");
  var s = slackConf_();
  Logger.log(!s.token ? "Slack 은 아직 연결 전이에요. (SLACK_BOT_TOKEN)"
    : "Slack 봇 토큰이 있어요. 채널 " + (s.channel ? "켜짐" : "꺼짐") + ", 고명균 원장님 개인 알림 " + (s.dmUser ? "켜짐" : "꺼짐") +
      ". testSlack 을 실행해 시험 메시지를 보내 보세요.");
}

/* ───────────── Slack 알림 ─────────────
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 값을 넣으면 켜져요. 비어 있는 것은 조용히 건너뛰어요.
 *   SLACK_BOT_TOKEN       xoxb- 로 시작하는 봇 토큰 (필수)
 *   SLACK_CHANNEL_ID      (선택) 채널 ID (C…) — 새 예약·취소를 두 원장님이 함께 보는 채널
 *   SLACK_DM_USER         고명균 원장님의 Slack 멤버 ID (U…) — 모든 데이터 변동을 개인 메시지로 받음
 *   SLACK_DM_SKIP_EMAIL   (선택) 고명균 원장님의 구글 이메일 — 본인이 시트를 직접 고친 것은 알리지 않음
 * 고명균 원장님(kommy9)이 원장 메뉴에서 직접 바꾼 내용은 본인에게 알리지 않아요.
 */
var DM_SKIP_ADMIN_ = "kommy9";
var SITE_URL_ = "https://kommynine.github.io/woodshop-booking/";
var DAYS_KO_ = ["일", "월", "화", "수", "목", "금", "토"];

function slackConf_() {
  var p = PropertiesService.getScriptProperties();
  return { token: p.getProperty("SLACK_BOT_TOKEN"), channel: p.getProperty("SLACK_CHANNEL_ID"),
    dmUser: p.getProperty("SLACK_DM_USER"), skipEmail: String(p.getProperty("SLACK_DM_SKIP_EMAIL") || "").trim().toLowerCase() };
}

function slackApi_(method, body) {
  var c = slackConf_();
  var res = UrlFetchApp.fetch("https://slack.com/api/" + method, {
    method: "post", contentType: "application/json; charset=utf-8",
    headers: { Authorization: "Bearer " + c.token },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  var j = JSON.parse(res.getContentText() || "{}");
  if (!j.ok) throw new Error("Slack " + method + " 실패: " + j.error);
  return j;
}

function prettyDate_(d) {
  var p = String(d).split("-").map(Number), dt = new Date(p[0], p[1] - 1, p[2]);
  return p[1] + "/" + p[2] + "(" + DAYS_KO_[dt.getDay()] + ")";
}
function esc_(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** 예약 하나를 Slack 메시지 모양으로 */
function slackBlocks_(b) {
  var L = WoodshopCore.STATUS_LABELS;
  var head = { booked: "🪚 새 방문 예약", done: "🏁 작업 완료", cancelled: "🚫 취소된 예약" }[b.status] || "🪚 방문 예약";
  var lines = [
    "*" + head + "*",
    "*" + esc_(b.name) + "* (휴대폰 뒷자리 " + esc_(b.last4) + ")",
    "📅 " + prettyDate_(b.date) + "  " + b.start + "~" + b.end,
    "🔨 " + esc_(b.project) + (b.stage ? "  ·  " + esc_(b.stage) : ""),
  ];
  if (b.tools) lines.push("🧰 " + esc_(b.tools));
  if (b.ownerNote) lines.push("📝 " + esc_(b.ownerNote));
  var by = b.status === "cancelled" && !b.handledBy ? "회원 본인" : (b.handledBy ? b.handledBy + " 원장" : "");
  var blocks = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn",
      text: "상태: *" + (L[b.status] || b.status) + "*" + (b.status !== "booked" && by ? "  ·  " + esc_(by) : "") +
        "  ·  신청 " + esc_(b.createdAt) + "  ·  <" + SITE_URL_ + "|예약 화면 열기>" }] },
  ];
  return { blocks: blocks, text: head + " - " + b.name + " " + prettyDate_(b.date) + " " + b.start + "~" + b.end + " " + b.project };
}

/** core.js 가 예약이 생기거나 바뀔 때 불러요. */
function slackNotify_(event, b, db) {
  var c = slackConf_();
  if (!c.token || !c.channel) return; // 채널 설정 전이면 조용히 넘어감 (개인 메시지는 따로 감)
  var msg = slackBlocks_(b);
  var ref = String(b.slackRef || "").split("|"); // "채널|ts"
  if (ref.length === 2 && ref[1]) {
    slackApi_("chat.update", { channel: ref[0], ts: ref[1], blocks: msg.blocks, text: msg.text });
    if (event === "cancelled") // 회원 취소는 원장님이 알아차리도록 새 알림으로도
      slackApi_("chat.postMessage", { channel: ref[0], thread_ts: ref[1], reply_broadcast: true,
        text: "🚫 " + b.name + " 님이 " + prettyDate_(b.date) + " " + b.start + "~" + b.end + " 예약을 취소했어요." });
    return;
  }
  if (event !== "new") return; // Slack 연결 전에 들어온 예약은 새로 올리지 않음
  var j = slackApi_("chat.postMessage", { channel: c.channel, blocks: msg.blocks, text: msg.text });
  db.update("bookings", b.id, { slackRef: j.channel + "|" + j.ts });
}

/* ───────────── 고명균 원장님 개인 메시지: 모든 데이터 변동 ───────────── */

function dmSend_(title, lines, actor, at) {
  var c = slackConf_();
  if (!c.token || !c.dmUser) return;
  var text = "*" + title + "*\n" + lines.map(function (l) { return "• " + esc_(l); }).join("\n") +
    "\n_누가: " + esc_(actor) + (at ? "  ·  " + esc_(at) : "") + "_";
  slackApi_("chat.postMessage", { channel: c.dmUser, text: text, unfurl_links: false });
}

/** core.js 가 데이터가 바뀔 때마다 불러요 (앱에서 바꾼 것). */
function slackAudit_(entry) {
  if (entry.actorAdminId === DM_SKIP_ADMIN_) return; // 고명균 원장님 본인이 바꾼 건 알리지 않음
  dmSend_(entry.title, entry.lines, entry.actor, entry.at);
}

function nowKo_() { return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm"); }
function editorEmail_(e) {
  try { return (e && e.user && e.user.getEmail && e.user.getEmail()) || ""; } catch (err) { return ""; }
}

/** 시트를 사람이 직접 고쳤을 때 (설치형 '수정 시' 트리거). 앱이 고친 것은 트리거가 울리지 않아요. */
function sheetEditWatcher(e) {
  if (!e || !e.range) return;
  var email = editorEmail_(e), c = slackConf_();
  if (email && c.skipEmail && email.toLowerCase() === c.skipEmail) return;
  var sh = e.range.getSheet(), r = e.range.getRow(), col = e.range.getColumn();
  var header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0];
  var lines = [];
  var multi = e.range.getNumRows() > 1 || e.range.getNumColumns() > 1;
  var nameCol = header.indexOf("이름") + 1, rowName = "";
  if (nameCol > 0 && r > 1) rowName = sh.getRange(r, nameCol).getDisplayValue();
  if (r === 1) lines.push("⚠️ 첫 줄(제목 줄)이 바뀌었어요. 앱이 칸을 못 찾을 수 있으니 원래대로 돌려 주세요.");
  if (multi) {
    lines.push("'" + sh.getName() + "' 탭 " + e.range.getA1Notation() + " 여러 칸을 한꺼번에 고쳤어요." + (rowName ? " (" + rowName + " 줄 포함)" : ""));
  } else {
    var colName = header[col - 1] || (col + "번째 칸");
    lines.push("'" + sh.getName() + "' 탭 " + r + "번째 줄" + (rowName ? " (" + rowName + ")" : "") + " · " + colName);
    var oldV = e.oldValue == null ? "" : String(e.oldValue), newV = e.value == null ? e.range.getDisplayValue() : String(e.value);
    lines.push(show_(oldV) + " → " + show_(newV));
  }
  dmSend_("✏️ 구글 시트 직접 수정", lines, email ? "시트 편집자 " + email : "시트 편집자 (계정 확인 불가)", nowKo_());
}
function show_(v) { return v ? "\"" + v + "\"" : "(비어 있음)"; }

/** 줄·칸·탭을 넣거나 지웠을 때 (설치형 '변경 시' 트리거) */
function sheetChangeWatcher(e) {
  var kinds = { INSERT_ROW: "줄 추가", REMOVE_ROW: "줄 삭제", INSERT_COLUMN: "칸(열) 추가", REMOVE_COLUMN: "칸(열) 삭제",
    INSERT_GRID: "탭 추가", REMOVE_GRID: "탭 삭제" };
  if (!e || !kinds[e.changeType]) return;
  var email = editorEmail_(e), c = slackConf_();
  if (email && c.skipEmail && email.toLowerCase() === c.skipEmail) return;
  var tab = "";
  try { tab = e.source.getActiveSheet().getName(); } catch (err) {}
  var lines = [(tab ? "'" + tab + "' 탭에서 " : "") + kinds[e.changeType] + "가 있었어요."];
  if (e.changeType === "REMOVE_ROW") lines.push("지워진 내용은 시트의 '파일 → 버전 기록'에서 볼 수 있어요.");
  if (e.changeType === "REMOVE_COLUMN" || e.changeType === "REMOVE_GRID") lines.push("⚠️ 앱이 쓰는 칸이나 탭이 지워졌다면 예약이 안 될 수 있어요.");
  dmSend_("🧱 구글 시트 구조 변경", lines, email ? "시트 편집자 " + email : "시트 편집자 (계정 확인 불가)", nowKo_());
}

/** Apps Script 편집기에서 한 번 실행: 시트 직접 수정 알림(트리거 2개)을 켜요. 여러 번 실행해도 중복되지 않아요. */
function installSheetAlerts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === "sheetEditWatcher" || f === "sheetChangeWatcher") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sheetEditWatcher").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("sheetChangeWatcher").forSpreadsheet(ss).onChange().create();
  Logger.log("시트 직접 수정 알림을 켰어요. 이제 '" + ss.getName() + "' 시트를 고치면 고명균 원장님께 알림이 가요.");
}

/** Apps Script 편집기에서 실행: Slack 연결 시험 */
function testSlack() {
  var c = slackConf_();
  if (!c.token) { Logger.log("스크립트 속성 SLACK_BOT_TOKEN 이 비어 있어요."); return; }
  var done = [];
  if (c.dmUser) {
    dmSend_("🪚 개인 알림 연결 완료", ["앞으로 예약·회원·회비·설정의 추가·수정·삭제와 시트 직접 수정을 여기로 알려 드릴게요.",
      "고명균 원장님(kommy9)이 직접 바꾼 내용은 알리지 않아요."], "예약 서버", nowKo_());
    done.push("고명균 원장님 개인 메시지");
  }
  if (c.channel) {
    slackApi_("chat.postMessage", { channel: c.channel,
      text: "🪚 대전세종목공기술학원 예약 알림이 연결됐어요! 새 방문 예약과 취소를 이 채널로 알려 드릴게요." });
    done.push("채널");
  }
  Logger.log(done.length ? "시험 메시지를 보냈어요: " + done.join(", ") : "SLACK_DM_USER 와 SLACK_CHANNEL_ID 가 모두 비어 있어요.");
}
