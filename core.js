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
  function findBooking(db, id) { return db.rows("bookings").filter(function (x) { return x.id === id; })[0]; }
  /** 원장의 상태 변경 (작업 완료 / 취소 / 되돌리기) */
  function decide(db, id, status, byName, opt) {
    if (STATUSES.indexOf(status) < 0) fail("상태 값이 올바르지 않아요.");
    var b = findBooking(db, str(id));
    if (!b) fail("예약을 찾을 수 없어요.");
    if (b.status === status) return { booking: b, changed: false };
    var patch = { status: status, handledBy: byName || "" };
    db.update("bookings", b.id, patch);
    for (var k in patch) b[k] = patch[k];
    notify(opt, "status", b, db);
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
      if (!findMember(db, w.name, w.last4))
        db.insert("members", { id: newId(), name: w.name, last4: w.last4, phone: "", memo: "", createdAt: now });
      notify(opt, "new", b, db);
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
      return { ok: true };
    },
  };

  var adminActions = {
    adminCheck: function () { return { ok: true }; },
    adminData: function (p, db) {
      return { bookings: db.rows("bookings").map(full), members: db.rows("members"), fees: db.rows("fees"), config: config(db) };
    },
    setStatus: function (p, db, opt) { decide(db, p.id, p.status, opt.adminName, opt); return { ok: true }; },
    setNote: function (p, db, opt) { db.update("bookings", str(p.id), { ownerNote: str(p.note, 300), handledBy: opt.adminName }); return { ok: true }; },
    deleteBooking: function (p, db) { db.remove("bookings", str(p.id)); return { ok: true }; },
    saveMember: function (p, db, opt) {
      var w = who(p);
      var v = { name: w.name, last4: w.last4, phone: str(p.phone, 20), memo: str(p.memo, 300) };
      var dup = findMember(db, w.name, w.last4);
      if (p.id) {
        if (dup && dup.id !== p.id) fail("같은 이름·뒷자리 회원이 이미 있어요.");
        db.update("members", str(p.id), v);
        return { id: str(p.id) };
      }
      if (dup) fail("같은 이름·뒷자리 회원이 이미 있어요.");
      v.id = newId(); v.createdAt = opt.now; db.insert("members", v);
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
      if (p.id) { db.update("fees", str(p.id), v); return { id: str(p.id) }; }
      v.id = newId(); v.createdAt = opt.now; db.insert("fees", v);
      return { id: v.id };
    },
    deleteFee: function (p, db) { db.remove("fees", str(p.id)); return { ok: true }; },
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

  return { handle: handle, decide: decide, DEFAULT_CONFIG: DEFAULT_CONFIG, STATUS_LABELS: STATUS_LABELS };
})();
