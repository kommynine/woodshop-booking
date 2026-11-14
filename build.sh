#!/bin/sh
# core.js + server/sheets-adapter.js 를 합쳐 구글 Apps Script 에 붙여넣을 server/Code.gs 를 만들어요.
cd "$(dirname "$0")"
{
  echo "/**"
  echo " * 대전세종목공기술학원 예약 서버 (구글 Apps Script)"
  echo " * 이 파일 전체를 Apps Script 편집기의 Code.gs 에 붙여넣으세요."
  echo " * 자동 생성 파일: core.js 와 server/sheets-adapter.js 를 고친 뒤 build.sh 로 다시 만드세요."
  echo " */"
  cat core.js
  echo
  cat server/sheets-adapter.js
} > server/Code.gs
echo "server/Code.gs 생성 완료"
