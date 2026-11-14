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
