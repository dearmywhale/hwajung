# 화정 찬양부 — 하늘 습관으로 무장하자

찬양부 팀 관리와 매일 실천 체크(**천국 한걸음**)를 위한 웹 사이트입니다.
여러 사람이 각자 휴대폰·PC에서 접속해도 계정·체크·사진이 한 곳에 저장되어 공유됩니다.

## 주요 기능

- **로그인**: 관리자가 만든 계정으로 이름 + 숫자 PIN(4~8자리) 로그인
- **천국 한걸음**: 기도 · 위클릭 · 3분말씀을 항목마다 사진 한 장으로 체크 (미리보기, 사진 교체, 체크 취소)
  - 한국 시간 기준 오늘 날짜만 수정 가능, 자정이 지나면 지난 날짜는 잠금
- **내 기록**: 월별 달력으로 나의 체크와 사진 보기
- **관리자 통계**: 주간/기간 조회, 팀별·찬양부 전체 항목별·전체 달성률, 팀 상세(날짜별 완료 인원, 성도별·항목별 체크표, 7일씩 넘겨보기), CSV 다운로드
  - 달성률은 해당 기간에 실제로 그 팀에 소속된 성도별 체크 기회 기준, 미래 날짜 제외
- **성도 관리**: 추가 · 수정 · 팀 배정/이동 · 비활성화 · PIN 재설정 · 영구 삭제(계정·기록·사진)
- **팀 관리**: 추가 · 수정 · 삭제 · 복구, 카드에서 소속 성도 확인, + 버튼으로 기존 성도 여러 명 추가 또는 새 성도 등록
- **사진 확인**: 성도별·날짜별·항목별 사진 목록, 기간 조회, 확대 보기

사진은 본인과 관리자만 열람할 수 있도록 서버에서 권한을 검사합니다. 일반 성도는 관리 메뉴와 관리자 API에 접근할 수 없습니다.

## Vercel에 배포하기

Vercel은 파일을 저장해 두지 못하므로, **데이터베이스(Neon)** 와 **사진 저장소(Cloudflare R2)** 를 연결해야 합니다.

### 1. 데이터베이스 (Neon)
Vercel 프로젝트 → **Storage** → **Create Database** → **Neon** 을 만들고 이 프로젝트에 연결합니다.
Production · Preview · Development 를 모두 체크하세요. (`DATABASE_URL` 이 자동으로 추가됩니다.)

### 2. 사진 저장소 (Cloudflare R2)
1. Cloudflare 대시보드 → **R2 Object Storage** → **Create bucket** (예: `hwajung-photos`). 공개 설정은 하지 않습니다(비공개 그대로).
2. R2 화면의 **Manage API tokens** → **Create API token** → 권한 **Object Read & Write**, 대상은 위 버킷으로 지정해 만듭니다.
   만들어지면 **Access Key ID** 와 **Secret Access Key** 가 한 번만 표시되니 복사해 둡니다.
3. R2 개요 화면의 **Account ID** 를 복사합니다.
4. Vercel 프로젝트 → **Settings → Environment Variables** 에 아래 4개를 추가합니다 (Production · Preview 모두).

| 이름 | 값 |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare 계정 ID |
| `R2_ACCESS_KEY_ID` | API 토큰의 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | API 토큰의 Secret Access Key |
| `R2_BUCKET` | 버킷 이름 (예: `hwajung-photos`) |

(EU 관할 버킷 등 다른 주소를 쓰는 경우 `R2_ENDPOINT` 로 주소를 직접 지정할 수 있습니다.)

### 3. 다시 배포하고 확인
**Deployments → ⋯ → Redeploy** 후 `사이트주소/api/health` 에서 `"photos":"Cloudflare R2"` 가 보이면 연결된 것입니다.
처음 접속해 **관리자 계정을 가장 먼저 만드세요.**

사진은 서버가 본인·관리자인지 확인한 뒤 R2에서 읽어 전달하므로 버킷을 공개할 필요가 없습니다.
예전에 Vercel Blob에 올린 사진은 `BLOB_READ_WRITE_TOKEN` 이 남아 있는 동안 계속 보이며, 새 사진은 R2에 저장됩니다.
사진은 휴대폰에서 줄여서 올리며, 한 장 최대 4MB입니다.

## 내 컴퓨터에서 실행하기

Node.js 20 이상이 필요합니다.

```bash
npm install
npm start          # http://localhost:3000
```

환경 변수가 없으면 내장 데이터베이스(PGlite)와 사진 폴더를 `DATA_DIR`(기본 `./data`)에 저장합니다.
`DATABASE_URL`, `R2_*` 을 지정하면 배포 환경과 같은 저장소를 사용합니다.

| 환경 변수 | 설명 |
| --- | --- |
| `DATABASE_URL` (또는 `POSTGRES_URL`) | Postgres 연결 주소 (Neon 등) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 사진 저장소 |
| `BLOB_READ_WRITE_TOKEN` | (예전) Vercel Blob 토큰 — R2 설정이 없을 때 사용 |
| `DATA_DIR` | 위 둘이 없을 때 데이터 저장 폴더 (기본 `./data`) |
| `ADMIN_NAME`, `ADMIN_PIN` | (선택) 첫 관리자 자동 생성 |
| `PORT` | 서버 포트 (기본 `3000`) |

`Dockerfile` 과 `render.yaml` 로 Render · Railway · Fly.io 같은 일반 서버에 배포할 수도 있습니다. 이때는 영구 디스크를 붙이거나 위 환경 변수를 지정하세요.

## 개발

```bash
npm test           # API 테스트 (내장 DB 사용, DATABASE_URL 을 주면 그 DB로 테스트)
```

- `src/application.js` — API 서버 (Express)
- `src/store.js` — 데이터베이스 · 사진 저장소 연결
- `src/db.js` — 스키마, 팀 소속 이력 관리
- `src/stats.js` — 달성률 계산, CSV
- `src/local.js` — 로컬 실행용 / `api/index.js` — Vercel 함수
- `public/` — 화면 (HTML · CSS · JavaScript, 빌드 과정 없음)
