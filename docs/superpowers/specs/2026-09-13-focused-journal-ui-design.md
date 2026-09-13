# Focused Journal UI Design

상태: 하이브리드 방향 승인 완료. 이 상세 명세는 사용자 검토 대기이며 앱 구현은 아직 시작하지 않았다.

## 목적과 범위

이 문서는 JobTracker의 첫 번째 UI 갱신을 위한 시각·상호작용 명세다. 방향은 다음의 승인된 하이브리드다.

- **B의 분위기:** 따뜻한 off-white 작업 표면과 deep green의 차분한 기록 도구 인상
- **A의 흐름:** 눈에 띄는 `Add application` 진입점, 작고 우선순위가 분명한 통계, 최근 지원 목록 중심의 Dashboard
- **C의 운영성:** Applications 목록 바로 위에 있는 검색·상태·근무 형태 필터

대상 화면은 Dashboard, 공통 AppShell, Applications, Application detail이다. Settings와 Connect는 공유 토큰 적용에 따른 시각적 호환성만 포함하며, 정보 구조와 기능은 재설계하지 않는다.

이 작업은 **UI 전용**이다. API, Prisma schema, 인증, 접근 제어, 추출·저장 요청, 중복 처리, 기존 검증을 바꾸지 않는다. `Manual` 입력은 현재처럼 `validationManualEntryEnabled`일 때에만 보이며 검증 목적이라는 성격도 유지한다.

## 제외 범위

- AI 기능, 일정/캘린더, 할 일, 리마인더, 새로운 분석 지표
- Kanban, drag and drop, 새 저장 상태나 새 필터·정렬 API
- Dashboard 필터 또는 Dashboard에서 실제로 존재하지 않는 검색 결과를 보여주는 UI
- Settings/Connect의 기능·카피·권한 동작 변경

## 정보 구조와 화면 흐름

### 공통 AppShell

데스크톱에서는 좌측 탐색과 콘텐츠 작업대의 2열 구조를 사용한다. 탐색은 로고 `JobTracker`와 `Dashboard`, `Applications`, `Settings`를 유지하되, 화면을 고정 폭으로 계속 점유하는 이전 sidebar가 아니라 스크롤 문서 안의 안정적인 좁은 rail로 만든다. 현재 위치는 deep green의 채워진 배경과 텍스트/아이콘 상태로 함께 표시한다.

콘텐츠 영역의 상단에는 페이지 제목과 필요한 경우 페이지별 보조 행동을 둔다. 전역 `UrlInputWrapper`는 모든 페이지의 무맥락 입력줄이 아니라 Dashboard의 기본 CTA 영역으로 이동한다. Applications와 detail에서 새 지원서를 추가해야 할 때는 같은 입력 컴포넌트를 여는 명시적 `Add application` 버튼/패널을 사용한다. 이는 URL, Paste Text, Manual의 현재 상태·요청·검증을 재사용할 뿐, 새 흐름을 만들지 않는다.

모바일에서는 sidebar를 고정하지 않는다. 메뉴 버튼으로 문서 흐름 안의 접힌 navigation을 펼친다. 버튼은 `aria-expanded`와 `aria-controls`를 가지며, 현재 페이지 표시·Esc로 닫기·닫을 때 trigger로 포커스 복귀를 제공한다. 비모달 구조이므로 focus trap은 사용하지 않는다. 콘텐츠는 한 열이다.

### Dashboard

Dashboard는 “오늘 새 공고를 기록하고, 진행 중인 지원을 확인한다”는 순서로 구성한다.

1. 페이지 제목 `Dashboard` 아래에 눈에 띄는 **Add application** card를 둔다. 기본 모드는 `URL`; `Paste Text`와 조건부 `Manual`은 탭/세그먼트 컨트롤로 제공한다. 기존 placeholder와 영문 버튼 카피(`+ Add`, `Extract`, `Save Application`) 및 추출 후 확인 절차를 유지한다.
2. 추출 결과가 있으면 같은 card 안에서 Job Title/Company 확인과 Save/Cancel을 보여 준다. 경고, 추출 중, 저장 중, 오류, 이미 존재하는 지원서 notice는 기존 의미와 카피를 보존한다.
3. 6개 기존 metric(`Total Applied`, `Interviewing`, `Offers`, `Rejected`, `This Week`, `This Month`)은 모두 유지한다. `Interviewing`과 `Offers`는 먼저 보이는 active pipeline 요약에, 나머지 4개는 더 조밀한 보조 통계 그룹에 배치한다. 값과 레이블을 함께 보여 주며 색만으로 뜻을 전달하지 않는다.
4. 기존 status breakdown은 넓은 단계형 요약으로 바꾼다. `Applied`, `Interview`, `Offer`, `Rejected` 각각에 텍스트 레이블, 건수, 구별되는 semantic badge를 제공한다. 이는 시각적 summary이며 클릭 가능한 칸반이나 filter control이 아니다.
5. `Recent Applications`는 Dashboard의 주 목록이다. 각 행은 job title, company, applied date, semantic status badge를 유지한다. 기존 데이터가 없을 때에는 URL을 붙여 첫 지원서를 추가하라는 빈 상태를 CTA card와 연결해 보여 준다.

Dashboard의 data source는 계속 `/api/stats` 하나다. Dashboard는 검색·필터·가짜 정렬 UI를 추가하지 않는다.

### Applications

Applications는 빠르게 찾고 상태를 갱신하는 목록 화면이다. 제목 아래에 list-adjacent filter bar를 배치한다.

- `Search by title or company...`, `All Statuses`, `All Types`는 현재 query semantics와 `/api/applications` 호출을 그대로 사용한다.
- 데스크톱에서는 검색 입력이 먼저 오고 두 select가 같은 행에 둔다. 결과 테이블 바로 위/아래에 붙어 목록의 범위를 명확히 한다.
- status는 native select를 유지할 수 있으나 현재 값은 semantic label과 충분한 대비를 가져야 한다. 행의 클릭 영역과 상태 변경 control은 시각적으로 구분하고, control 이벤트가 행 상세 이동을 일으키지 않는 현재 동작을 보존한다.
- 넓은 화면에서는 Job Title, Company, Status, Date Applied, Location, Type의 6열을 유지한다. Job title/company가 식별 우선순위를 가진다.
- 모바일에서는 table의 6열을 억지로 축소하지 않는다. 각 application을 카드형 행으로 바꿔 title/company, status, applied date를 먼저 보이고 location/type을 보조 metadata로 배치한다. 검색·두 필터는 세로로 stack한다.

`No applications found. Paste a job URL above to add your first one.`의 빈 상태는 현재 조건을 유지하되, Applications에 나타나는 `Add application` CTA와 연결된 카피로 조정할 수 있다.

### Application detail

상세 화면은 제목/회사와 status control을 첫 시야에 둔다. Date Applied, Location, Salary Range, Job Type은 별도의 compact metadata group으로 정렬하고, Job Description, Keyword Match Analysis, Notes, Source URL은 읽기·편집 구역을 분리한다.

- status 옵션과 PATCH 저장 형식은 현재 네 상태(`Applied`, `Interview`, `Offer`, `Rejected`)를 그대로 사용한다.
- Keyword Match Analysis의 임계값, matched/missing keyword, resume 부재 안내, 접기/펼치기 동작은 그대로다. 색 외에도 `Matched`, `Missing`, 백분율 텍스트를 유지한다.
- `Save Changes`, 저장 중 `Saving...`, 성공 `Saved`, 오류, delete confirmation 및 delete 요청은 현재 semantics를 보존한다.
- 작은 화면에서는 모든 detail group을 한 열로 배치하고, Save Changes를 콘텐츠 끝과 화면 내 명확한 위치에 둔다. 삭제는 시각적으로 destructive action으로 분리한다.

## 시각 토큰과 컴포넌트 원칙

### 핵심 토큰

| 역할 | 값 | 사용 |
| --- | --- | --- |
| canvas | `#f6f5ef` | 앱 배경과 넓은 작업 표면 |
| ink / primary action | `#24483e` | 제목, active navigation, primary CTA, focus 계열 |
| surface | `#ffffff` | 카드, filter bar, form field의 배경 |
| border | `#d9ddd5` | 카드/입력 분리. 텍스트 대비를 대체하지 않음 |
| primary text | `#23352e` | 본문과 입력값 |
| secondary text | `#526259` | 보조 metadata와 placeholder |
| destructive | `#a12c32` | 오류, 삭제, `Rejected` 보조 표현 |

deep green을 status의 유일한 표현에 재사용하지 않는다. status는 badge의 **영문 텍스트**와 색을 함께 쓴다: `Applied`, `Interview`, `Offer`, `Rejected`. `Interview`와 `Offer`는 특히 색맹 환경에서도 레이블과 아이콘/테두리 차이로 구분한다.

Cards는 가벼운 border와 제한된 반경을 사용하며 그림자는 절제한다. 큰 marketing-style hero, 과한 gradient, 장식용 그래프는 사용하지 않는다. 페이지 제목에는 B 시안의 기록 도구 인상을 살리는 serif stack(`Georgia, 'Times New Roman', serif`)을 제한적으로 사용한다. 본문·입력·테이블은 기존 sans 기반을 유지하며, job title > company > metadata 순으로 분명한 계층을 둔다. 외부 폰트 요청이나 신규 폰트 패키지는 추가하지 않는다. 앱의 사용자 노출 카피는 영어를 유지한다.

정적 시안은 배치·색상 비교를 위해 일부 표 열과 데이터 행을 축약한다. 실제 구현은 위에서 명시한 6개 목록 필드와 모든 기존 데이터 접근을 유지한다.

### 기존 컴포넌트 재사용 경계

| 기존 단위 | UI 역할 |
| --- | --- |
| `AppShell`, `Sidebar` | desktop rail과 mobile navigation으로 반응형 shell 전환 |
| `UrlInputWrapper`, `UrlInput` | Add application card/panel의 URL, Paste Text, 조건부 Manual 및 confirmation 상태 재사용 |
| `StatCard`, `StatusBadge` | compact metric과 semantic status 표현의 토큰화된 공통 단위 |
| `ApplicationTable` | desktop table + mobile card presentation. 데이터 필드와 click/status-change contract 유지 |
| `ApplicationDetail` | detail section hierarchy와 save/delete feedback의 시각적 재배치 |
| `globals.css` | 앱 전역 color/type/focus token 적용 |

## 반응형·접근성 요구사항

- 768px 이하에서 navigation은 fixed sidebar가 아니며, filters는 stack되고 Applications는 cards로 전환한다. Dashboard grid와 detail metadata도 한 열 또는 읽기 쉬운 2열 이하로 줄인다.
- 최소 interactive target은 desktop과 mobile 모두 44 × 44 CSS px이다. 정보 밀도는 작은 조작 영역이 아니라 여백과 비상호작용 metadata의 배치로 조절한다.
- URL/Paste Text/Manual 전환은 실제 button/tab 역할, 선택 상태, 키보드 조작과 명확한 visible focus indicator를 제공한다. 모든 input/select/button/link은 focus-visible 상태가 canvas와 surface 양쪽에서 인지되어야 한다.
- 일반 텍스트와 핵심 UI의 contrast는 WCAG 2.2 AA(일반 텍스트 4.5:1)를 충족한다. placeholder/보조 metadata도 읽기 가능한 대비를 목표로 하며, color-only 상태 표현은 금지한다.
- 기존 `role="alert"`, `role="status"`, `aria-busy`, label association을 유지·보완한다. 추출/저장 성공·오류는 screen reader가 인지할 수 있어야 한다. Add application은 비모달 inline panel로 열고, 닫기 전에 진행 중 입력을 암묵적으로 삭제하지 않는다. 모바일 탐색도 비모달이며 Esc와 원래 trigger로의 focus return을 제공한다.
- 표 헤더/행은 semantic table을 desktop에서 유지한다. 모바일 card는 동등한 정보를 읽는 순서로 노출한다.

## 상태 명세

| 상태 | UI 처리 | 기존 동작 |
| --- | --- | --- |
| Dashboard/Applications loading | 기존 텍스트 loading indicator를 유지하고 `aria-busy` 제공 | 기존 fetch와 최신 요청만 반영하는 동작 유지 |
| Dashboard/Applications error | 인라인 alert와 현재 입력·필터 유지. 새 retry API/제어는 추가하지 않음 | 기존 오류 문구 의미 유지 |
| URL/Text extracting | 입력과 primary action disabled, `Extracting...` | `/api/extract` 요청 유지 |
| extracted confirmation | title/company 편집, warning, Save/Cancel | 추출값 확인 후 POST하는 흐름 유지 |
| saving | 중복 submit 방지, `Saving...` | POST/PATCH 요청 및 기존 validation 유지 |
| created/existing | `Application saved.` 또는 existing notice의 status feedback | 중복 지원서의 saved details 보존 |
| empty | dashboard/list에서 첫 URL 추가 CTA 안내 | 기존 empty 조건 유지 |
| detail delete | destructive 확인 UI와 deleting feedback | DELETE 후 `/applications` 이동 유지 |

## 구현 시 API·데이터 불변 조건

- Dashboard: `/api/stats`와 기존 6개 numeric fields, `recentApplications`만 사용한다.
- Applications: `/api/applications`와 현존하는 `search`, `status`, `jobType` query만 사용한다. 새 query parameter, client-only dashboard filter, pagination, sort는 추가하지 않는다.
- 생성: `/api/extract`, `/api/applications`의 body/response와 URL/text/manual validation을 변경하지 않는다. Manual feature gate를 우회하지 않는다.
- 상세: `/api/applications/[id]` PATCH/DELETE, `/api/settings?includeResume=true` 및 기존 keyword match 계산을 그대로 사용한다.
- session/auth/proxy/route protection/server env/database migrations에는 이 디자인 작업의 변경이 없다.

## 검증 및 수용 기준

### 시각·반응형

- [ ] 1440px에서 deep green navigation, off-white canvas, Dashboard Add application card, compact 6 metrics, status summary, Recent Applications의 읽는 순서가 명확하다.
- [ ] 1024px에서 Applications filter bar와 6열 desktop table이 겹치거나 잘리지 않는다.
- [ ] 768px 이하에서 fixed sidebar가 없고, navigation은 keyboard로 열고 닫을 수 있으며 filters는 세로 stack, application은 카드형으로 표시된다.
- [ ] 375px에서 Dashboard add card, extracted confirmation, detail save/delete 영역이 가로 스크롤 없이 사용 가능하다.

### 기능 보존

- [ ] URL/Paste Text/조건부 Manual, extraction, warning, confirmation, validation, created/existing feedback이 기존과 동일한 API 요청·결과를 낸다.
- [ ] Dashboard는 여섯 metric과 네 status를 모두 표시하고 새 데이터/필터를 암시하지 않는다.
- [ ] Applications의 search/status/job type filters가 기존 query 결과를 표시하고 status 변경 뒤 최신 결과를 반영한다.
- [ ] detail의 모든 기존 필드, keyword analysis, save, delete confirmation과 navigation이 보존된다.

### 접근성

- [ ] keyboard만으로 navigation, Add application mode, filters, status 변경, Save/Delete 흐름을 완료할 수 있다.
- [ ] focus-visible, label, alert/status announcement, busy state가 모든 새/수정 UI에서 확인된다.
- [ ] status를 색 없이 읽어도 이해할 수 있고, primary/secondary/destructive 상태의 contrast가 AA 기준을 만족한다.

## 위험과 완화

| 위험 | 완화 |
| --- | --- |
| 새 파이프라인 시각이 drag/drop 또는 kanban 기능을 기대하게 함 | summary를 비상호작용 card로 표기하고, 새로운 열/드롭 영역을 만들지 않는다. |
| off-white 전환에서 연한 metadata/placeholder가 흐려짐 | 토큰별 contrast를 실제 렌더에서 측정하고, 보조 텍스트도 읽는 데 필요한 대비를 확보한다. |
| table-to-card 전환이 정보나 조작을 숨김 | 카드에 6개 현재 필드를 우선순위 순서로 모두 노출하고, status control과 detail navigation을 각각 명확히 둔다. |
| global input 이동이 기존 흐름을 혼란스럽게 함 | Dashboard에는 상시 card, Applications/detail에는 같은 component를 연 명시적 Add application entry로 제공하여 기능 접근성을 잃지 않는다. |
