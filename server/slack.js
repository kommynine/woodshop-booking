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
