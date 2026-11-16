/* ───────────── Slack 알림 (알림만, 승인 절차 없음) ─────────────
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 아래 두 값을 넣으면 켜져요. 비어 있으면 Slack 없이 그대로 동작해요.
 *   SLACK_BOT_TOKEN   xoxb- 로 시작하는 봇 토큰
 *   SLACK_CHANNEL_ID  알림을 받을 채널 ID (C 로 시작)
 * 새 예약이 들어오면 채널에 알림이 가고, 회원이 취소하면 그 알림 아래에 취소 소식이 붙어요.
 */
var SITE_URL_ = "https://kommynine.github.io/woodshop-booking/";
var DAYS_KO_ = ["일", "월", "화", "수", "목", "금", "토"];

function slackConf_() {
  var p = PropertiesService.getScriptProperties();
  return { token: p.getProperty("SLACK_BOT_TOKEN"), channel: p.getProperty("SLACK_CHANNEL_ID") };
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
  if (!c.token || !c.channel) return; // Slack 설정 전이면 조용히 넘어감
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

/** Apps Script 편집기에서 실행: Slack 연결이 되는지 시험 메시지를 보내요. */
function testSlack() {
  var c = slackConf_(), miss = [];
  if (!c.token) miss.push("SLACK_BOT_TOKEN");
  if (!c.channel) miss.push("SLACK_CHANNEL_ID");
  if (miss.length) { Logger.log("스크립트 속성이 비어 있어요: " + miss.join(", ")); return; }
  slackApi_("chat.postMessage", { channel: c.channel,
    text: "🪚 대전세종목공기술학원 예약 알림이 연결됐어요! 이제 새 방문 예약이 들어오면 이 채널로 알려 드릴게요." });
  Logger.log("시험 메시지를 보냈어요. Slack 채널을 확인해 주세요.");
}
