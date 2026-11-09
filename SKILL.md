---
name: npay-harvester
description: >-
  네이버페이 포인트 모음 링크(뽐뿌, 클리앙, daissue 등)를 입력받아
  Ego Lite AI 브라우저 환경에서 유형별(3초 체류, 미션 클릭, 모바일 에뮬레이션 등)로
  적립 작업을 자동 수행하고 수령 결과를 리포트하는 스킬입니다.
---

# 네이버페이 포인트 자동 수령기 (NPay Harvester)

사용자가 커뮤니티(뽐뿌, 클리앙, 딜바다 등)나 메신저에서 공유된 네이버페이 포인트 적립 링크 모음(텍스트 또는 URL 목록)을 제공했을 때, **Ego Lite 브라우저의 격리된 Task Space와 로그인 세션을 활용**하여 포인트 수령 작업을 자동으로 완수합니다.

---

## 1. 활성화 조건 (Triggers)
- 사용자가 "네페 링크 적립해줘", "네이버페이 모음 글 올려둘 테니 받아줘"라고 요청할 때
- `campaign2.naver.com`, `ofw.adison.co`, `mycar.naver.com`, `insurance.pay.naver.com`, `home.pay.naver.com`, `daissue.app/link-opener` 등이 포함된 링크 목록을 공유했을 때

---

## 2. 작업 절차 (Workflow)

### Step 1: 링크 파싱 및 목표 기대치 산출
1. **뽐뿌 재테크포럼 자동 탐색 및 크롤링**:
   - 뽐뿌 목록 페이지 접속 후 `a[href*="view.php?id=money"]` 또는 `tr.baseList` 기반으로 당일 날짜(예: `11/9` 또는 `11월 9일`) 및 `네페`/`네이버페이` 포함 글을 타깃팅합니다. (구형 `tr.list0, tr.list1` 셀렉터는 변경되었으므로 금지)
   - 타깃 게시글 진입 후 본문(`.board-contents`, `#body`)에서 링크 및 본문 텍스트를 추출합니다.
2. 사용자 입력 텍스트 또는 뽐뿌 게시글 제목에서 **목표 기대 금액**을 추출합니다:
   - 제목 패턴: `11/1일자 네이버페이 134원(114원) + 랜덤포인트 모음`
   - 정규식: `/(?:네페|네이버페이)\s*(\d+)원(?:\s*\(\s*(\d+)원\s*\))?/i`
   - `maxTarget` = 134원 (연금/조건부 포함 전체 금액)
   - `baseTarget` = 114원 (괄호 안의 기본 확정 금액, 괄호가 없을 시 주 금액)
   - 1차 목표 기대치(`targetExpected`) = `baseTarget` (기본 확정치 기준)
3. 본문에서 모든 URL을 정규식으로 추출합니다.
4. 뽐뿌 리다이렉트 링크(`s.ppomppu.co.kr/?...target=<base64>`)가 포함된 경우 `target` 파라미터를 base64 디코딩하여 원본 목적지 URL을 복원합니다.
5. 중복 링크를 제거합니다.

### Step 2: Ego Lite 브라우저 세션 시작
1. 격리된 Task Space를 생성하고 페이지 크래시 방지용 `getPage()` 및 인증서 오류 무시 설정을 적용합니다:
   ```javascript
   const task = await taskSpace("npay-harvest");
   let currentPage = task.page("p1");
   try { await currentPage.cdp("Security.setIgnoreCertificateErrors", { ignore: true }); } catch (e) {}

   async function getPage() {
     try {
       await currentPage.evaluate(() => 1);
       return currentPage;
     } catch (e) {
       const pages = task.pages();
       currentPage = (pages && pages.length > 0) ? pages[0] : await task.newPage();
       try { await currentPage.cdp("Security.setIgnoreCertificateErrors", { ignore: true }); } catch (eIgnore) {}
       return currentPage;
     }
   }
   ```
2. 작업 전 네이버페이 포인트 잔액(`https://point.pay.naver.com/pointshistory/list`)을 먼저 확인하여 시작 포인트를 기록합니다.

### Step 3: 미션 유형별 정밀 수령 (1차 Pass)

#### 1. 캠페인 클릭 적립 (`campaign2.naver.com`)
- 페이지 로드 후 `포인트 받기` 또는 `적립하기` 버튼 클릭
- 리다이렉트된 브랜드 스토어에서 **최소 4.5초 체류**

#### 2. 마이카 '포인트 쉽게 받기' 배너 5종 (`mycar.naver.com`)
> [!IMPORTANT]
> `clkMission` 링크(`ica.pay.naver.com/...`)는 단순 `page.goto`로 이동하면 리퍼러 소실 및 외부 사이트 이탈로 인해 `클릭 ?원` 상태가 유지되고 적립이 누락됩니다.
- **표준 실행 절차**:
  1. `https://mycar.naver.com/?from=push1` 접속 후 `포인트 쉽게 받기` 섹션으로 스크롤
  2. 페이지 내 `a[href*="clkMission"]` 엘리먼트 5개를 추출
  3. 각 링크 엘리먼트의 `target = '_self'`를 지정하고 **페이지 내에서 `.click()` 호출**
  4. 랜딩 페이지 이동 후 **최소 5.5초 체류**
  5. 다시 `mycar.naver.com`으로 복귀하여 다음 배너를 순차 클릭
  6. 5개 배너 순회 완료 후 마이카 페이지를 재조회하여 **`2원 받기완료`**로 갱신되었는지 검증

```javascript
// 마이카 5종 정밀 수령 모범 로직
for (let i = 0; i < bannerList.length; i++) {
  const currentUrl = await page.evaluate(() => window.location.href);
  if (!currentUrl.includes("mycar.naver.com")) {
    await page.goto("https://mycar.naver.com/?from=push1", { timeout: 20000 });
    await sleep(2500);
  }
  await page.evaluate((targetHref) => {
    const link = Array.from(document.querySelectorAll('a[href*="clkMission"]')).find(a => a.href === targetHref);
    if (link) {
      link.target = '_self';
      link.scrollIntoView({ behavior: 'smooth', block: 'center' });
      link.click();
    }
  }, bannerList[i].href);
  await sleep(5500);
}
```

#### 3. 보험 방문 랜덤 포인트 (`insurance.pay.naver.com`)
> [!IMPORTANT]
> `/point` 페이지의 당일 3개 방문 미션(`insu_v3_benefits_clk`)은 단순 URL 이동 시 판정 지연으로 미적립(`?원`)될 수 있습니다.
- **표준 실행 절차**:
  1. `https://insurance.pay.naver.com/point` 접속
  2. 배너 엘리먼트 3개를 직접 클릭하여 방문
  3. 보험사 랜딩 페이지에서 **최소 6초 체류**
  4. `/point`로 복귀하여 `오늘 총 X원 받았어요` 및 3개 배너의 완료 상태 확인

#### 4. Npay 모바일 홈 '여기 누르면 3원' (`home.pay.naver.com`)
> [!IMPORTANT]
> 네이버페이 모바일 메인의 '여기 누르면 3원'은 화면 하단 **'포인트뽑기' (`point-draw`) 컴포넌트**의 클릭 적립 카드입니다.
> 이는 내부적으로 `campaign2.naver.com/npay/v2/click-point/?eventId=cr_pointdraw_...` 또는 `pointdraw_...` 이벤트로 매핑됩니다.
- **표준 실행 절차**:
  1. `CDP`로 Android Chrome UA + Viewport(412x915) + `setTouchEmulationEnabled` 활성화
  2. `https://home.pay.naver.com/?from=pay_main` (또는 `?from=main_pay_icon`) 접속 후 방해 팝업(`레이어 닫기` 등) 제거
  3. **페이지 데이터 기반 정밀 추출 (최우선)**:
     - 페이지 내 `<script>` 태그의 `self.__next_f` 데이터에서 `cr_pointdraw_...` 및 `pointdraw_...` 정규식 추출
     - 추출된 이벤트 URL들(`campaign2.naver.com/npay/v2/click-point/?eventId=...`)을 순차 방문하여 수령 (캠페인당 1회, 1~3원)
  4. **DOM 버튼 클릭 백업**:
     - `document.querySelectorAll('[class*="point-draw"] [class*="button"]')` 또는 `point-draw_image-button` 엘리먼트가 보일 경우 직접 `.click()` 수행

```javascript
// Npay 모바일 홈 3원 / 포인트뽑기 자동 추출 & 수령 로직
const pointdrawUrls = await page.evaluate(() => {
  const scripts = Array.from(document.querySelectorAll('script')).map(s => s.innerText);
  const urls = new Set();
  const regex = /https%3A%2F%2Fcampaign2\.naver\.com%2Fnpay%2Fv2%2Fclick-point%2F%3FeventId%3D[a-zA-Z0-9_-]+/g;
  scripts.forEach(s => {
    let m;
    while ((m = regex.exec(s)) !== null) urls.add(decodeURIComponent(m[0]));
  });
  return Array.from(urls);
});

for (const url of pointdrawUrls) {
  await page.goto(url, { timeout: 15000 });
  await sleep(2500);
}
```

#### 5. 쇼핑라이브 (Pincrux)
- **On-Air Live 방송**: 온에어 리스트 방송 클릭 후 **최소 11.5초 체류** (+건당 5원)
- **Coming Soon 방송 예고**: `라이브 더 보기` 확장 클릭 후 모든 예고 카드 순환 방문 (건당 3.5초 체류, +건당 1원)

#### 6. 결제홈 15초 스크롤 (`new-m.pay.naver.com`)
> [!IMPORTANT]
> 결제홈(`https://new-m.pay.naver.com/historybenefit/home`) 미션은 **실제 연속 스크롤 이벤트가 지속적으로 유입되어야만 15초 카운트다운 타이머가 감소**합니다.
> 단일 `page.evaluate()` 장시간 루프는 브라우저 Evaluation 타임아웃(15초)을 유발하므로, **Node.js 레벨에서 200~250ms 간격으로 상하 스크롤을 트리거**해야 합니다.
- **표준 실행 절차**:
  1. 모바일 에뮬레이션(412x915) 상태로 `https://new-m.pay.naver.com/historybenefit/home` 접속
  2. 초기 스크롤(`window.scrollBy(0, 500)`)로 하단 플로팅 배너 `[class*="FloatingRewardBanner_article"]` 마운트 유도
  3. **연속 스크롤 루프**: Node.js 루프(약 18~20초) 동안 250ms 주기로 `window.scrollBy(0, delta)`를 상하 반전하며 실행
  4. 타이머 텍스트(`00:15초 남았어요` -> `00:00초` / `10원 받았어요!` / `포인트 받기`) 감시
  5. 카운트다운 완료 시 `FloatingRewardBanner_article` 클릭하여 10원 적립 확정
  6. **추가 5원 (Round 2)**: 배너가 `또 받고 싶다면?` 또는 `추가 포인트` 상태로 변경되면 배너를 클릭하고 2차 스크롤 루프를 수행하여 추가 적립

```javascript
// 결제홈 15초 연속 스크롤 수령 표준 로직
let direction = 1;
let totalElapsedMs = 0;
const intervalMs = 250;
const maxDurationMs = 25000;

while (totalElapsedMs < maxDurationMs) {
  await page.evaluate((dir) => {
    const delta = dir * (80 + Math.floor(Math.random() * 40));
    window.scrollBy(0, delta);
    if (window.scrollY > 2500) window.scrollBy(0, -400);
    else if (window.scrollY < 300) window.scrollBy(0, 400);
  }, direction);

  const bannerText = await page.evaluate(() => {
    const el = document.querySelector('[class*="FloatingRewardBanner_article"]');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  });

  if (bannerText && (bannerText.includes("00:00") || bannerText.includes("받았어요") || bannerText.includes("포인트 받기"))) {
    // 카운트다운 완료
    await page.evaluate(() => {
      const el = document.querySelector('[class*="FloatingRewardBanner_article"]');
      if (el) el.click();
    });
    break;
  }

  await sleep(intervalMs);
  totalElapsedMs += intervalMs;
  if (Math.floor(totalElapsedMs / 2000) % 2 === 0) direction = 1; else direction = -1;
}
```

#### 7. 기타 미션 (연금 혜택 및 Adison 광고)
- **연금 혜택 (`pensionmission`)**: 미래에셋/삼성자산운용 배너 클릭 (+20원, 7일 주기)
- **Adison 제휴 광고 (`ofw.adison.co`)**: URL 직접 방문 후 3.5초 체류

---

### Step 4: 갭 분석(Gap Analysis) 및 2차 전수 재조사 (Retry Audit Loop)

1차 수령 후 중간 잔액을 확인하여 목표 금액과의 갭을 계산합니다:
```javascript
const netEarned = midPoints - startPoints;
const gap = targetExpected - netEarned;
```

#### 갭 발생 기준 및 대응 프로토콜:
* **정상 완료 (`gap < 5원`)**:
  - 목표치에 충분히 도달한 것으로 판단하고 곧바로 최종 정산 및 디스코드 성공 리포트를 발송합니다.
* **부족액 발생 (`gap >= 5원`)**:
  - 목표 기대치 대비 5원 이상 부족할 경우 **즉시 디스코드 1차 경보 알림을 전송**하고 **2차 전수 재조사 및 누락 미션 재수령 루프**를 실행합니다.

---

### Step 5: 결과 정산 및 리소스 정리
1. 최종 `https://point.pay.naver.com/pointshistory/list`로 이동하여 **당일 적립 내역**과 **최종 잔액**을 조회합니다.
2. 반드시 `await task.finish({ keep: [] })`를 호출하여 백그라운드 브라우저를 정리합니다.
3. 사용자에게 최종 결과를 보고할 때 **반드시 아래 3단계 구조로 상세 항목별 처리 결과와 미적립 원인을 명확히 포함**합니다:
   - **(1) 적립 정산 요약**: 작업 전 잔액, 작업 후 잔액, 순수 적립 금액 (+N원)
   - **(2) 정상 수령 항목**: 오늘 실시간으로 적립된 내역과 포인트 금액
   - **(3) 미적립 항목 및 사유 분석**: 수령되지 않은 항목 각각에 대해 아래 사유를 명시:
     * **선착순 조기 마감**: 오픈 시간(예: 08시 등) 선착순 한도 소진으로 메인 페이지 등으로 리다이렉트된 경우 (예: 제주항공 등)
     * **중복 적립 불가 / 이전 수령**: 이전 일자 또는 당일 이미 적립 이력이 있어 지급되지 않는 경우 (예: 플리마켓, 우리은행, 르무통 등)
     * **리셋 주기 미도래**: 7일 주기 등 리셋 기간이 아직 지나지 않은 경우 (예: 연금 혜택 등)
     * **계정 타깃 미노출**: 계정별 조건/타깃팅에 따라 적립 배너/버튼이 노출되지 않는 경우 (예: 모바일 홈 3원 등)
     * **당일 미션 미진행**: 퀴즈 없음 등 당일 진행되지 않는 미션인 경우
     * **제휴사 정산 딜레이/조기 마감**: 핀크럭스 쇼핑라이브 예고 등 외부 토큰 한도 마감 또는 정산 지연인 경우
4. 디스코드 알림 발송 시 **아래 [4. 디스코드 알림 표준 포맷]**에 따라 시인성 높은 카드형 Embed로 포맷팅하여 전달합니다.

---

## 3. 핵심 규칙 (Rules)
- **Windows 실행 안전성**: 모든 Node.js 스크립트는 임시 `.mjs` 파일로 작성 후 `cmd /c "ego-browser nodejs < <경로>"` 형태로 실행합니다.
- **DOM 직접 클릭 원칙**: 마이카(`clkMission`), 보험(`insu_v3`), 모바일 홈 3원은 단순 `goto` 금지, 반드시 DOM 상에서 엘리먼트를 클릭하고 충분한 체류 시간(4.5~6초)을 부여합니다.
- **모바일 팝업 사전 제거**: 모바일 웹 미션 진입 시 화면을 덮는 팝업 레이어를 반드시 먼저 닫아 클릭 차단을 방지합니다.
- **체류 시간 보장**: 캠페인(4.5초), 마이카(5.5초), 보험(6초), 모바일3원(4.5초), 라이브On-Air(11.5초), Coming Soon(3.5초).
- **5원 이상 갭 발생 시 자동 재조사**: 제목 기준치 대비 5원 이상 부족 시 2차 전수 재조사 및 디스코드 경보 발송을 강제합니다.
- **리소스 정리 필수**: 스크립트 종료 시 예외가 발생하더라도 `task.finish({ keep: [] })`가 실행되도록 보장합니다.
- **DOM 텍스트 덤프 금지**: 웹페이지 내의 무관한 본문(주문내역, 일반 숫자, 메뉴 등)을 그대로 메시지에 복사하지 말고, 수령 완료 여부 및 카테고리별 건수/금액만 정제하여 출력합니다.

---

## 4. 디스코드 알림 표준 포맷 (Discord Embed Format)

디스코드 웹훅 발송 또는 결과 보고 시 다음 카드형 규격을 반드시 준수합니다.

```json
{
  "embeds": [
    {
      "title": "💚 네이버페이 포인트 수령 완료",
      "url": "https://point.pay.naver.com/pointshistory/list",
      "color": 247642,
      "fields": [
        {
          "name": "💰 적립 결과",
          "value": "**+{earned}원** (목표 {target}원 대비 {rate}%)\n잔액: `{startPoints}원` ➔ **`{endPoints}원`**",
          "inline": false
        },
        {
          "name": "📋 수령 요약",
          "value": "• 쇼핑라이브: {liveCount}건\n• 클릭 배너: {bannerCount}건 (+{bannerWon}원)\n• 연금/마이카/보험: {partnerCount}건\n• 결제홈 스크롤: 1건 완료 (+15원)",
          "inline": false
        },
        {
          "name": "⚠️ 미적립 & 추가 대기",
          "value": "• **결제홈 클릭**: 15원 배너 수동 확인 필요\n• **오후 2시 오픈**: 브랜드뽑기 4종 (GS25, 컬리 등)\n• **미제공**: 모바일 홈 (타깃 없음), 퀴즈 (미진행)",
          "inline": false
        }
      ],
      "footer": {
        "text": "NPay Harvester"
      },
      "timestamp": "2026-10-28T10:20:00.000Z"
    }
  ]
}
```
