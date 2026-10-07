# OmniRoute: комплексное улучшение доставки ответов, качества маршрутов и панели

**Статус:** план, не разрешение считать улучшения выполненными. В этом ходе выполнено только чтение исходников и сохранение этого документа. Код, настройки, работающий runtime и данные не менялись.

## Goal

Сделать `https://api.mafsolin.space` быстрее и предсказуемее для API-клиента, пользователя Playground и администратора, сохранив выбранную модель, уровень reasoning, контекст и корректность ответов.

## Current context / assumptions

### Где что находится

| Объект | Точный путь / адрес |
|---|---|
| SSH с Windows | `ssh -o BatchMode=yes -o ConnectTimeout=8 vps-sh` |
| Git-репозиторий на VPS | `/opt/omniroute-staging/source` |
| HEAD при подготовке плана | `8bb49dd83` — `chore: stop tracking local *.bak-* patch backups` |
| Работающий runtime, НЕ каталог для разработки | `/opt/omniroute-staging/runtime-c511facdf` |
| Работающий entrypoint | `/opt/omniroute-staging/runtime-c511facdf/server-ws.mjs` |
| Продовая SQLite | `/opt/omniroute-staging/data/storage.sqlite` |
| Продовый loopback | `http://127.0.0.1:20128` |
| systemd | `omniroute.service` |
| nginx site | `/etc/nginx/sites-enabled/api.mafsolin.space` |
| nginx performance include | `/etc/nginx/conf.d/omniroute-ui-performance.conf` |
| Статика | `/var/www/omniroute-ui-static/current` |
| Диагностика | `/var/lib/omniroute-maintenance/` |
| Предыдущий откат к состоянию ДО оптимизаций | `/opt/omniroute-staging/backups/perf-20261007-150216/rollback.py` |
| Рекомендации по сборке | `/opt/omniroute-staging/BUILD-SAFELY.md` |
| Новый независимый checkout для этой работы | `/opt/omniroute-quality-speed-20261007` |
| Рабочие данные тестов | `/opt/omniroute-quality-speed-data` — никогда не DATA_DIR прода |
| Локальные предыдущие отчёты | `C:/Users/artem/AppData/Local/hermes/cache/scratch/omniroute-performance-report.md`, `omniroute-model-stability-report.md`, `omniroute-model-benchmark.json`, `omniroute-model-audit.json` |

План хранится в активном локальном workspace, сейчас `C:/Users/artem`. Это НЕ локальный checkout OmniRoute. Все относительные пути исходников ниже отсчитываются от нового checkout `/opt/omniroute-quality-speed-20261007`, если явно не указан другой корень.

На VPS проверены Node `v22.23.1` и npm `10.9.8`. Проект использует Next.js App Router, React, TypeScript, `better-sqlite3`, Node native test runner, Vitest/jsdom и Playwright. Требование проекта к Node: `>=22.22.2 <23 || >=24.0.0 <27`.

### Полные пути для сокращённых имён в задачах

| Короткое имя | Точный repo-relative path |
|---|---|
| `ChatTab.tsx` | `src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab.tsx` |
| `CompareTab.tsx` | `src/app/(dashboard)/dashboard/playground/components/tabs/CompareTab.tsx` |
| `useStreamMetrics.ts` | `src/app/(dashboard)/dashboard/playground/hooks/useStreamMetrics.ts` |
| `ProviderMetrics.tsx` | `src/app/(dashboard)/dashboard/playground/components/ProviderMetrics.tsx` |
| `chatTabEndpointRequest.ts` | `src/app/(dashboard)/dashboard/playground/components/tabs/chatTabEndpointRequest.ts` |
| `providers/page.tsx` | `src/app/(dashboard)/dashboard/providers/page.tsx` |
| `providers/providerPageUtils.ts` | `src/app/(dashboard)/dashboard/providers/providerPageUtils.ts` |
| `providers/loading.tsx` | `src/app/(dashboard)/dashboard/providers/loading.tsx` |
| `providers/error.tsx` | `src/app/(dashboard)/dashboard/providers/error.tsx` |
| `usageHistory.ts` | `src/lib/usage/usageHistory.ts` |
| `usageHistory/helpers.ts` | `src/lib/usage/usageHistory/helpers.ts` |
| `usageStats.ts` | `src/lib/usage/usageStats.ts` |
| `catalog.ts` | `src/app/api/v1/models/catalog.ts` |
| `catalogCache.ts` | `src/app/api/v1/models/catalogCache.ts` |
| `catalogProviderMaps.ts` | `src/app/api/v1/models/catalogProviderMaps.ts` |

Скобки в путях обязательно заключать в кавычки в shell/git commands.

### Что уже улучшено — не потерять

В исходном checkout есть НЕЗАКОММИЧЕННЫЕ изменения:

- `src/lib/db/settings/pricing.ts`: кэш и индексы цен.
- `src/lib/db/cleanup.ts`: bounded maintenance.
- `src/lib/usage/usageStats.ts`: read-only SQL worker вместо тяжёлых SELECT в основном потоке.
- `src/app/api/v1/models/catalogProviderMaps.ts`: memoization префиксов.
- Новый `src/lib/usage/usage-stats-reader.cjs`.
- Новые `tests/unit/omni-pricing-cache.test.ts`, `omni-cleanup-bounded.test.mjs`, `omni-compiled-pricing.test.mjs`, `omni-pricing-index.test.mjs`, `omni-pricing-missing.test.mjs`, `omni-worker-read.test.mjs`, `omni-prefix-memo.test.mjs`.

Прод также содержит runtime-only изменения и вспомогательные entrypoint-файлы. Простой rebuild из HEAD может вернуть старые зависания или потерять защитные wrappers. Старый `rollback.py --apply` возвращает состояние ДО оптимизаций, поэтому он не является подходящим откатом для нового релиза.

### Известные результаты, не SLA

В предыдущем суточном снимке было 900 записей, включая диагностику и отдельные попытки маршрутизации:

- OpenCode Go / `deepseek-flash`: 643/662 записанных успехов, 13 timeout, также upstream 400/500 и отключения клиентов.
- Antigravity / `gemini-3.8-flash-tiered`: 178/188 успехов; встречались `empty_content`, `malformed_translated_response`, upstream 500.
- Gemini 3.7 High и Claude Sonnet 4.6 имели маленькие преимущественно диагностические выборки; 100% на них не доказывает надёжность.
- В коротких пробах до первого текста: DeepSeek ~7 с, Gemini 3.8 ~23 с, Gemini 3.7 High ~13,7 с, Claude ~4,6 с. Это одиночные пробы с VPS через публичный адрес, не усреднённые результаты с ПК.
- При `max_tokens=768` DeepSeek выдал reasoning и `finish_reason=length`, но не ответ. При 4096 ответ появился. Нельзя лечить это отключением thinking или автоматически повышать явно указанный клиентом лимит.
- Холодный каталог после прежних правок всё ещё около 13 с. Высокий CPU steal VPS остаётся внешним ограничением.
- Groq упирался в Cloudflare; Codex app-server не был настроен. Не объявлять их исправленными без отдельной реальной генерации.
- Предыдущий расширенный typecheck не был закрыт. Новый релиз блокируется до выяснения диагностики затронутых файлов.

### Конкретные дефекты, найденные чтением кода

1. `src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab.tsx`, блок `reader.read()` / `chunk.split("\n")`: отсутствует накопление незавершённой SSE-строки. JSON, разрезанный TCP/HTTP-пакетом, игнорируется; ответ может терять текст и usage.
2. Там же `onFirstChunk()` вызывается на первом сетевом пакете, до разбора содержимого. Heartbeat/role/reasoning могут выглядеть как быстрый первый текст.
3. Там же после `streamMetrics.finish(usageData)` берётся `streamMetrics.metrics` из предыдущего React render. Финальная метрика может остаться устаревшей.
4. `CompareTab.tsx` дублирует metrics tracker, считает chunk как токен и использует отдельный сборщик запроса. Reasoning-параметры из Chat не гарантированно совпадают с Compare.
5. `chatTabEndpointRequest.ts` обрабатывает все non-chat endpoints как `query`/`url`. Responses API требует `input`, не `query`; отдельная проверка обязательна.
6. `providers/providerPageUtils.ts::loadProviderPageData()` ждёт пять источников через один `Promise.all`, включая необязательные expiration и OpenRouter enrichment. Все ограничены 20 с, но optional API всё равно задерживают первый полезный экран.
7. `src/shared/utils/fetchTimeout.ts` снимает таймер после получения headers; JSON body читается уже вне deadline. Не менять этот общий helper без отдельного теста: им пользуются другие пути.
8. `src/lib/usage/usageHistory.ts::getModelLatencyStats()` всё ещё делает синхронный SQL SELECT. Worker уже есть для другой статистики; не создавать второй конкурирующий механизм.
9. `open-sse/utils/streamTiming.ts` измеряет первый generated output, включая reasoning/tool arguments, и иногда fallback к первому SSE. Старое поле `ttft_ms` не равно строго задержке первого пользовательского текста.
10. `usageHistory/helpers.ts` считает TPS из `tokens_output/(latency_ms-ttft_ms)`. Семантика reasoning в разных upstream различается. Старые строки нельзя «исправить» догадкой.

**Это гипотезы, подтверждённые структурой кода, а не новые воспроизведённые баги браузера. Каждый code fix ниже начинается с RED на соответствующем сценарии. Если RED не воспроизводится, сначала уточнить наблюдение и не менять код наугад.**

## Architecture / proposed approach

Использовать существующие Next/React страницы, SSE pipeline, SQL worker и механизмы account fallback; не добавлять новый gateway, БД, Redis, внешнюю аналитику или параллельную админку. Сначала исправить доставку и достоверность клиентских метрик, затем снять baseline по трём ролям и исправить подтверждённые узкие места, сохраняя reasoning и маршруты. Релиз собрать в отдельный immutable runtime, проверить на staging и переключить только после тестов и готового отката к текущему оптимизированному runtime.

## Непереговорные правила

- Не менять модель/effort/thinking/max_tokens/system prompt/temperature/контекст молча ради скорости.
- Для фиксированной модели fallback разрешён только на проверенный эквивалентный маршрут к той же модели и compatible capabilities. `free-stack` с разными моделями не выдавать за стабильный quality route и не переписывать без согласования.
- Не включать semantic cache, агрессивную compression, hedged запросы или mid-stream continuation глобально. Это меняет семантику/стоимость или может повторить tool calls.
- После первого выданного текста или tool-call нельзя незаметно повторять весь запрос. На обрыве сохранить частичный ответ и показать ошибку.
- HTTP 200, полный ответ, корректный tool handoff и качественный результат — разные показатели.
- Не считать chunks токенами; отсутствие provider usage обозначать «нет данных». Не смешивать reasoning-token numerator с text-only denominator.
- Дизайн не переделывать: существующая тема, spacing и компоненты. Добавлять только нужные loading/error/partial/metric состояния.
- Никаких `git reset --hard`, blanket `git add .`, удаления runtime, копирования голой живой SQLite, полного VACUUM в serving thread или отключения авторизации.
- Browser login в прод — только vault UI; пароль/ключи не писать в план, файлы, команды, HAR или chat. Production credentials не передавать сторонним сервисам.
- Изменения SQL использовать только параметризованно. Auth-scoped каталоги/статистику не кэшировать в общий nginx cache.
- Тестовые изменения providers/settings/API keys — только в staging. Production readback после любого разрешённого изменения обязателен.

## Команды и общий цикл

Все команды в последующих задачах — для будущего исполнителя, **в этом plan turn не запускать**. Shell на VPS — bash. Рабочее время каждой задачи 2–5 минут; ожидание установки/сборки/soak вынесено отдельно и может занять дольше.

После создания checkout установить один раз:

```bash
cd /opt/omniroute-quality-speed-20261007
export DISABLE_SQLITE_AUTO_BACKUP=true
export DATA_DIR=/opt/omniroute-quality-speed-data
export NEXT_TELEMETRY_DISABLED=1
export TMPDIR=/opt/omniroute-quality-speed-data/tmp
UT=(node --max-old-space-size=1536 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit --test-concurrency=1)
UI=(node node_modules/vitest/vitest.mjs run \
  --config vitest.omni.config.ts --maxWorkers=1)
```

Для каждой code-задачи:

1. Написать ровно следующий behavior test, без production fix.
2. Выполнить точную команду теста. **RED — assertion о потерянном тексте/неправильной метрике/зависании, а не SyntaxError, отсутствующий package или ошибка импорта.**
3. Внести минимальный fix из указанного блока, не решать соседние проблемы.
4. Повторить тот же тест: exit 0, `fail 0` / Vitest PASS. Запустить указанные соседние regression tests.
5. `git diff --check`; затем `git add` только перечисленные файлы и `git commit -m '<указанное сообщение>'`.

Если проверка уже зелёная: записать это как characterization, не ломать код искусственно. Если дальнейшая новая функция нужна, сначала добавить RED на реально недостающем поведении. Полные блоки кода ниже — целевое содержимое для соответствующего завершённого tracer bullet, а не разрешение реализовать все блоки до тестов.

## Step-by-step tasks

### Этап A — безопасный рабочий контур и baseline

#### A1. Зафиксировать текущее состояние, 3 мин

**Файлы:** прочитать `/opt/omniroute-staging/BUILD-SAFELY.md`, текущие source/runtime paths; будущий артефакт `docs/ops/quality-speed-baseline.md` в новом checkout.

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 vps-sh \
  'git -C /opt/omniroute-staging/source status --short; \
   systemctl show omniroute -p WorkingDirectory -p ExecStart -p ActiveState -p MainPID -p NRestarts; \
   node --version; npm --version; free -m; df -h /opt'
```

Ожидание: `ActiveState=active`, прод всё ещё на текущем runtime; вывод git сопоставлен со списком выше. Новые чужие изменения не включать автоматически. Результат не обязан численно совпадать со старой памятью/рестартами.

#### A2. Отдельный checkout с сохранением предыдущих правок, 5 мин

**Пути:** `/opt/omniroute-quality-speed-20261007`, перечисленные выше 12 изменённых/новых файлов.

На VPS, только после проверки, что целевой каталог ещё не существует:

```bash
test ! -e /opt/omniroute-quality-speed-20261007
git clone --no-hardlinks /opt/omniroute-staging/source /opt/omniroute-quality-speed-20261007
git -C /opt/omniroute-quality-speed-20261007 switch -c perf/quality-speed-20261007
git -C /opt/omniroute-staging/source diff --binary -- \
  src/lib/db/settings/pricing.ts src/lib/db/cleanup.ts \
  src/lib/usage/usageStats.ts src/app/api/v1/models/catalogProviderMaps.ts \
  | git -C /opt/omniroute-quality-speed-20261007 apply
```

Копировать восемь untracked файлов через file tools или Python `shutil.copy2`, **без** `.env`, data/, истории сообщений и ключей:

```python
from pathlib import Path
from shutil import copy2
src = Path('/opt/omniroute-staging/source')
dst = Path('/opt/omniroute-quality-speed-20261007')
paths = [
    'src/lib/usage/usage-stats-reader.cjs',
    'tests/unit/omni-pricing-cache.test.ts',
    'tests/unit/omni-cleanup-bounded.test.mjs',
    'tests/unit/omni-compiled-pricing.test.mjs',
    'tests/unit/omni-pricing-index.test.mjs',
    'tests/unit/omni-pricing-missing.test.mjs',
    'tests/unit/omni-worker-read.test.mjs',
    'tests/unit/omni-prefix-memo.test.mjs',
]
for rel in paths:
    target = dst / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    copy2(src / rel, target)
print('prior performance files copied')
```

`git diff --check` в новом checkout; commit только этих файлов: `chore: preserve deployed performance fixes as baseline`. Никакого commit в исходном checkout в этой задаче.

#### A3. Зависимости и baseline tests, 3 мин активной работы

```bash
cd /opt/omniroute-quality-speed-20261007
mkdir -p /opt/omniroute-quality-speed-data/tmp
npm ci
```

После экспорта команд из общего раздела:

```bash
"${UT[@]}" tests/unit/omni-pricing-cache.test.ts \
  tests/unit/omni-cleanup-bounded.test.mjs \
  tests/unit/omni-worker-read.test.mjs \
  tests/unit/playground-stream-metrics.test.ts \
  tests/unit/fetch-timeout.test.ts \
  tests/unit/latency-stats-ttft-6875.test.ts
```

Ожидание: exit 0, `fail 0`; **если исходный тест уже красный — сохранить точную диагностику и закрыть её отдельным минимальным fix до новых features**. `omni-prefix-memo`/compiled tests сейчас содержат hardcoded старый runtime: это deploy-contract tests, не доказательство portable source build. Не удалять их; в G1 разделить source/runtime проверки и убрать hardcode.

#### A4. Контур UI tests, 3 мин

**Новый файл:** `vitest.omni.config.ts`. Это scoped runner, а не замена общего Vitest:

```ts
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/unit/ui/omni-*.test.tsx'],
    exclude: [],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
```

Некоторые исходные UI tests исключены в `vitest.config.ts` как известные failures; зелёный общий runner их не проверяет. Для новых regression tests использовать уникальные `omni-*` имена. Затем добавить первый RED B1, а не пустой зелёный suite.

#### A5. Baseline глазами пользователя, 5 мин на один проход

**Артефакты будущего исполнения:** `docs/ops/quality-speed-baseline.md`, screenshots/HAR в test-results вне git; отдельный `docs/ops/quality-speed-issues.md`.

На ПК в автоматизированном Chromium или Brave проверить **после входа через vault**:

| Роль | Путь | Точное действие и проверка |
|---|---|---|
| Внешний API-клиент | `/v1/models`, `/v1/chat/completions`, `/v1/responses` | список → фиксированный model → streaming и nonstreaming; настоящие terminal events и полезный текст/tool call |
| Пользователь Playground | `/dashboard/playground` | короткий русский запрос → отмена → новый запрос; длинный ответ; вкладка Compare с одинаковыми параметрами |
| Админ | `/dashboard/providers` | карточки появляются, поиск модели, открыть аккаунт; ошибки не выглядят как «провайдеров нет» |
| Админ | `/dashboard/analytics`, `/dashboard/logs`, `/dashboard/settings/resilience` | открыть, перейти назад, сменить фильтр, посмотреть объяснение ошибки; не сохранять production settings |
| Анонимный посетитель | `/login`, `/api/settings` | login не содержит секретов, management API без авторизации отвергает чтение |

На каждом шаге: console/pageerror, HTTP waterfall, время до **полезного элемента**, не просто `body`, screenshot с воспроизведением. Снимать обычную и медленную сеть, холодный/тёплый tab, ширины 1280 и 390. При недоступном браузере пометить BLOCKED, а не подменять UI-результат curl.

### Этап B — ответ не теряется, метрики не врут

#### B1. RED: пакетная граница не должна уничтожать текст, 5 мин

**Новый файл:** `tests/unit/ui/omni-chat-delivery.test.tsx`. Полный тест ниже. Network mock необходим для детерминированной границы пакета; parser/metrics/ChatTab не mock-ать.

```tsx
// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatTab from '../../../src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab';
import { DEFAULT_PARAMS } from '../../../src/app/(dashboard)/dashboard/playground/components/ParamSliders';
import type { ConfigState } from '../../../src/app/(dashboard)/dashboard/playground/components/StudioConfigPane';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    (key === 'send' ? 'Send' : key === 'stop' ? 'Stop' : key),
}));

const enc = new TextEncoder();
const event = (j: unknown) => `data: ${JSON.stringify(j)}\r\n\r\n`;
const config: ConfigState = {
  endpoint: 'chat.completions',
  baseUrl: '',
  model: 'test/delivery',
  systemPrompt: 'Keep the user instructions.',
  params: { ...DEFAULT_PARAMS },
  reasoning: { show: false, effortOptions: [] },
};
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function installStream(payload: string, fragmentSize: number) {
  const bytes = enc.encode(payload);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += fragmentSize) {
        controller.enqueue(bytes.slice(i, i + fragmentSize));
      }
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })));
}

async function send() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'synthetic check' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

describe('ChatTab delivery', () => {
  it('preserves UTF-8 text across arbitrary network boundaries', async () => {
    installStream(
      ': keepalive\r\n\r\n' +
      event({ choices: [{ delta: { role: 'assistant' } }] }) +
      event({ choices: [{ delta: { content: 'Ответ 🌿' } }] }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3,
          completion_tokens_details: { reasoning_tokens: 0 } } }) +
      'data: [DONE]\r\n\r\n', 1);
    render(<ChatTab configState={config} />);
    await send();
    await waitFor(() => expect(screen.getByText('Ответ 🌿')).toBeTruthy());
  });
});
```

```bash
"${UI[@]}" tests/unit/ui/omni-chat-delivery.test.tsx
```

Ожидаемый RED: `Ответ 🌿` не найден. Если упал fixture/translation/provider import, починить только harness и повторить до assertion failure.

#### B2. GREEN: единый bounded SSE decoder, 5 мин

**Новый файл:** `src/lib/playground/sseDecoder.ts` — полный код в Appendix 1. Импортировать его в `ChatTab.tsx`; заменить `chunk.split` на накопительный decode. Пока не менять метрики, лимиты и request builder.

Точная форма замены reading-loop: создать `const decoder = new SseDecoder()` перед loop; внутри `for (const frame of decoder.push(value))` пропускать пустые/comment frames, `[DONE]`, затем `JSON.parse(frame.data)` и выполнять существующий выбор `delta.content` и `usage`. На EOF вызвать `decoder.finish()`; обработка payload должна быть одной локальной функцией, не продублированной для finish.

Повторить B1 → PASS. Затем отдельными 2–3-минутными тестами в `tests/unit/playground-sse-decoder.test.ts`: CRLF, LF, multiline data, несколько событий в пакете, UTF-8 split, frame limit. Использовать полный test block Appendix 1. Если тест раскрывает новое поведение, RED до его минимального дополнения.

Commit: `fix(playground): preserve fragmented SSE events`.

#### B3. RED/GREEN: terminal error нельзя превращать в пустой успех, 5 мин

**Файлы:** `tests/unit/ui/omni-chat-delivery.test.tsx`, `src/lib/playground/consumeChatStream.ts` (новый, Appendix 2), `ChatTab.tsx`.

Добавить в B1 файл следующий тест:

```tsx
it('shows an in-stream error and keeps text already received', async () => {
  installStream(
    event({ choices: [{ delta: { content: 'Частичный ответ' } }] }) +
    event({ error: { message: 'synthetic upstream failure', code: 'upstream_error' } }) +
    'data: [DONE]\r\n\r\n', 11);
  render(<ChatTab configState={config} />);
  await send();
  await waitFor(() => expect(screen.getByText('Частичный ответ')).toBeTruthy());
  await waitFor(() => expect(screen.getByText(/synthetic upstream failure/)).toBeTruthy());
});
```

RED должен отсутствием ошибки, не fixture failure. После RED добавить `consumeChatStream` и заменить SSE-loop вызовом из Appendix 2; current `catch` показывает error, но не удаляет накопленный текст. EOF без `[DONE]`/валидного terminal — ошибка `stream_truncated`, не «done». Отдельно проверить legitimate `length`, content filter и tool-call: они не должны запускать повторный запрос или подменять ответ.

Команды: B1 suite + `"${UT[@]}" tests/unit/playground-sse-decoder.test.ts`. Commit: `fix(playground): preserve partial output and expose stream failures`.

#### B4. RED/GREEN: первый текст отдельно от первого события, 4 мин

**Файлы:** новый `tests/unit/playground-delivery-metrics.test.ts`, новый `src/lib/playground/deliveryMetrics.ts` (Appendix 3), `src/shared/schemas/playground.ts`, `useStreamMetrics.ts`, `ChatTab.tsx`.

В этом commit добавить optional schema fields из B5, необходимые для типизации tracker, но новый TPS UI пока не включать. Тесты и реализацию Appendix 3 добавлять по одному tracer bullet: сначала event/text timing, затем финальный callback; token semantics и sustained-delivery tests — в B5. Полный Appendix 3 — целевой конец этих двух задач, не приказ пропустить RED.

В existing UI test добавить capture `onMetricsUpdate`; сеть fixture отдаёт heartbeat и reasoning, затем content. На RED проверить, что callback получает **финальный** non-null totalMs и known completion count. Затем использовать tracker Appendix 3, стартующий ДО `fetch`; callback получает объект, возвращённый `tracker.finish`, а не предыдущий React state.

Добавить метод `apply(metrics: StreamMetrics): void` в `UseStreamMetrics` и его возвращаемый объект:

```ts
function apply(next: StreamMetrics): void {
  setMetrics(next);
}
```

Старые `start/onFirstChunk/onChunk/finish` сохранить для совместимости на первом commit. В Chat путь завершения:

```ts
const snapshot = tracker.finish(result.usage);
streamMetrics.apply(snapshot);
setMessages(prev => {
  const next = [...prev];
  const idx = appendIndex !== undefined ? appendIndex : next.length - 1;
  next[idx] = { ...next[idx], metrics: snapshot };
  return next;
});
onMetricsUpdate?.(snapshot);
```

Тесты метрик Appendix 3 сначала направить на текущую семантику `computeMetrics`/callback, наблюдать неправильное поведение, затем подключить новый tracker. Не менять значения cost/billable-token accounting в рамках этого fix.

Commit: `fix(playground): report final first-text timing without stale state`.

#### B5. RED/GREEN: TPS неизвестен, если неизвестны токены ответа, 4 мин

**Файлы:** `src/shared/schemas/playground.ts`, `deliveryMetrics.ts`, `ProviderMetrics.tsx`, `tests/unit/playground-delivery-metrics.test.ts`.

К `StreamMetricsSchema` **аддитивно** добавить optional поля, чтобы старые consumers не сломались:

```ts
firstEventMs: z.number().nonnegative().nullable().optional(),
firstTextMs: z.number().nonnegative().nullable().optional(),
visibleTokens: z.number().int().nonnegative().nullable().optional(),
reasoningTokens: z.number().int().nonnegative().nullable().optional(),
visibleTps: z.number().nonnegative().nullable().optional(),
outputTps: z.number().nonnegative().nullable().optional(),
tpsKind: z.enum(['unknown', 'burst', 'delivery']).optional(),
```

`ttftMs` в новом клиентском пути = первый непустой `delta.content`; `tps` оставить backward-compatible e2e reported-output rate, но UI не называть его decode TPS. В `ProviderMetrics.tsx` использовать следующие выражения вместо старых TTFT/TPS span:

```tsx
<span title={t('firstTextTitle')}>TTFT {formatMs(metrics.firstTextMs ?? metrics.ttftMs)}</span>
<span title={t('deliveryTpsTitle')}>
  · {metrics.tpsKind === 'delivery'
    ? formatTps(metrics.visibleTps ?? null)
    : metrics.tpsKind === 'burst' ? t('burstDelivery') : t('tpsUnavailable')}
</span>
```

Добавить keys в namespace `playground` в `src/i18n/messages/en.json` и `src/i18n/messages/ru.json` (русский файл подтверждён чтением; не создавать вторую локаль):

```json
{
  "firstTextTitle": "Time from request dispatch to the first visible text, excluding heartbeats and reasoning",
  "deliveryTpsTitle": "Visible token delivery rate; not upstream inference speed",
  "burstDelivery": "burst delivery",
  "tpsUnavailable": "TPS unavailable"
}
```

Русский перевод: «От отправки запроса до первого текста; без heartbeat и рассуждений», «Скорость доставки токенов ответа, не вычислений upstream», «пакетная выдача», «TPS: нет данных».

RED fixtures: reasoning usage absent → `visibleTokens/visibleTps=null`; completion 3000 / reasoning 2800 → 200 visible tokens; <3 с или <8 content events → burst label, не стабильный TPS. Не выдавать chunks/characters за токены.

```bash
"${UT[@]}" tests/unit/playground-delivery-metrics.test.ts tests/unit/playground-stream-metrics.test.ts
"${UI[@]}" tests/unit/ui/omni-chat-delivery.test.tsx
```

Commit: `fix(metrics): distinguish reported output, reasoning and visible delivery`.

#### B6. RED/GREEN: Compare использует те же parsing/metrics и параметры, 5 мин

**Файлы:** `CompareTab.tsx`, новый `src/lib/playground/chatRequest.ts`, новый `tests/unit/playground-chat-request.test.ts`, новый `tests/unit/ui/omni-compare-delivery.test.tsx`.

Extract **существующую** Chat body construction в shared builder Appendix 4. RED: при выбранном effort/high, seed, stop, JSON mode и system prompt captured POST Compare должен содержать те же поля, что Chat. Не mock-ать builder.

Удалить локальный `ColumnMetricsTracker`, подключить `DeliveryTracker` + `consumeChatStream`. One tracker/AbortController на колонку; сохранять существующий RAF batching и лимит 4. Fetch в same-origin mode через `/api/v1/chat/completions`, как Chat, чтобы management auth работала одинаково. Внешний baseUrl не снабжать admin cookie или чужими credentials: при нестандартном origin оставить существующий внешний режим, потребовать явную API-auth конфигурацию, не изобретать ключ из admin password.

Reasoning spec должен соответствовать модели колонки: получить capabilities из уже загруженного каталога, вызвать `resolveReasoningControls` из `components/reasoningControlUtils.ts`. Если каталог ещё недоступен или spec неизвестен, показать «параметры этой модели ещё не подтверждены» и не запускать misleading сравнение. Не переносить spec одной модели на другие вслепую.

После RED: общая pure request test PASS; UI обеих колонок получает полный UTF-8 текст, финальные counts; отмена первой не останавливает вторую. Commit: `refactor(playground): share delivery and request semantics across chat and compare`.

#### B7. RED/GREEN: Responses — input, а не query, 4 мин

**Файлы:** `chatTabEndpointRequest.ts`, `ChatTab.tsx`, новый `tests/unit/playground-responses-request.test.ts`, UI `omni-chat-delivery.test.tsx`.

Полный путь request helper: `src/app/(dashboard)/dashboard/playground/components/tabs/chatTabEndpointRequest.ts`. В Chat условие ветки разделить на `const isResponses = configState.endpoint === 'responses'` и `const isStreamingConversation = isChatCompletionsEndpoint(configState.endpoint) || isResponses`. Существующий non-chat JSON path выполнять только при `!isStreamingConversation`; fetch body выбрать `isResponses ? buildResponsesRequestBody(...) : buildPlaygroundChatRequest(...)`. Иначе новый правильный body останется в неправильной nonstreaming ветке. Path оставлять `resolveChatTabRequestPath(configState.endpoint)`.

Сначала fixture с `config.endpoint='responses'`: captured request должен содержать `input` и **не** `query`. Current code отправляет query → RED.

Добавить pure builder:

```ts
export function buildResponsesRequestBody(
  messages: Array<{ role: string; content: string }>,
  model: string,
  params: { max_tokens: number; temperature: number },
  reasoning: { effort?: string; thinking?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, input: messages, stream: true };
  if (params.max_tokens > 0) body.max_output_tokens = params.max_tokens;
  if (params.temperature !== 1) body.temperature = params.temperature;
  if (reasoning.effort) body.reasoning = { effort: reasoning.effort };
  return body;
}
```

На Responses пути использовать уже включённые system/user messages и этот builder; parsing — `response.output_text.delta`/`response.completed` в Appendix 2. Search/web.fetch оставить прежними. Не пытаться этим builder обслужить audio/images/embeddings и не передавать unsupported thinking boolean в Responses.

Проверить complete, failed, incomplete(length), tool-call JSON и usage-only completed. Commit: `fix(playground): use native Responses request and stream shapes`.

### Этап C — админ видит данные быстро и понимает отказ

#### C1. RED/GREEN: critical providers не ждут optional enrichment, 5 мин

**Файлы:** `providers/providerPageUtils.ts`, новый `tests/unit/provider-page-first-paint.test.ts`, новый `src/shared/utils/fetchJsonWithDeadline.ts` (Appendix 5).

RED: current `loadProviderPageData` при never-resolving OpenRouter stats не даёт critical result. В тесте инжектировать fetch: providers/nodes/settings отвечают сразу, optional promise висит; core должен вернуть connections, не дожидаясь optional. Отдельный RED: headers есть, `json()` завис → deadline всё равно завершает запрос.

Разделить внутри существующего модуля на `loadProviderCore` и `loadProviderEnrichment` (Appendix 5). Не удалять `loadProviderPageData` до перехода всех callers; оставить совместимость как композицию обоих loaders для старых consumers, но первая загрузка страницы использует core.

Ожидание: core 3 endpoint results, optional не вызваны; deadline test возвращает `FetchJsonDeadlineError`, а не висит. Commit: `perf(providers): decouple first paint from optional enrichment`.

#### C2. RED/GREEN: progressive loading и честная ошибка вместо пустых данных, 5 мин

**Файлы:** `providers/page.tsx`, новый `tests/unit/ui/omni-provider-first-paint.test.tsx`, existing `providers/loading.tsx`, `providers/error.tsx`.

Refresh после импорта — тот же core loader: `providers/page.tsx` currently имеет `onImported={async () => setConnections((await loadProviderPageData()).connections)}`. Заменить на `loadProviderCore`; иначе первый экран ускорится, а обновление после импорта всё ещё будет ждать optional sources. Не запускать production import ради теста.

После RED UI test с delayed `/api/providers/openrouter-stats` список карточек должен быть виден до ответа enrichment.

В initial effect сохранить ранее полученные connections при refresh error; разделить:

1. Core loading → core data → `setLoading(false)`.
2. Независимый background `loadProviderEnrichment` → expiration/popularity; их ошибки — nonblocking warning.
3. `AbortController`/cancelled guard на unmount; поздние ответы не меняют другую страницу.
4. Если `/api/providers` failed/401 — visible error с Retry/reauth, не состояние «не настроено ни одного провайдера».
5. Если settings/blockedProviders недоступны — читать карточки можно, state-changing action buttons disabled до успешного чтения policy. Не считать unknown policy разрешением.

Hook skeleton — применять к текущим setter именам из page, не переписывать 2006 строк:

```tsx
useEffect(() => {
  const controller = new AbortController();
  let disposed = false;
  const load = async () => {
    try {
      const data = await loadProviderCore(fetch, 5000, controller.signal);
      if (disposed) return;
      setConnections(data.connections);
      setProviderNodes(data.providerNodes);
      setCcCompatibleProviderEnabled(data.ccCompatibleProviderEnabled);
      setBlockedProviders(data.blockedProviders);
      setCodexGlobalServiceMode(getCodexGlobalServiceMode(data.settings));
      setCoreError(null);
      setPolicyReady(true);
    } catch (error) {
      if (!disposed) {
        setCoreError(error instanceof Error ? error.message : 'Provider data unavailable');
        setPolicyReady(false);
      }
    } finally {
      if (!disposed) setLoading(false);
    }
  };
  void load();
  void loadProviderEnrichment(fetch, 10000, controller.signal).then(data => {
    if (disposed) return;
    if (data.expirations) setExpirations(data.expirations);
    setOpenRouterProviderStats(data.openRouterProviderStats);
  }).catch(() => {});
  return () => { disposed = true; controller.abort(); };
}, []);
```

Добавить state `coreError:string|null`, `policyReady:boolean`, локализованные Retry/error над существующим списком. `setBlockedProviders` должен получать default только после успешного settings API. State-changing handlers в дополнение к disabled также guard `if (!policyReady) return`.

Commit: `fix(providers): render core data progressively and surface unavailable policy`.

#### C3. RED/GREEN: статистика задержек не блокирует Node, 5 мин

**Файлы:** новый `src/lib/usage/usageStatsReader.ts`, новый `src/lib/usage/usage-stats-reader.d.cts`, `usageHistory.ts`, `usageStats.ts`, новый `tests/unit/latency-stats-worker.test.ts`.

Повторно использовать текущий CJS worker. Не менять SQL semantics и не добавлять синхронный fallback при ошибке worker.

`usage-stats-reader.d.cts`:

```ts
export interface UsageStatsReader {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}
export function createUsageStatsReader(file: string): UsageStatsReader;
```

`usageStatsReader.ts`:

```ts
import { SQLITE_FILE } from '../db/core';
import { createUsageStatsReader, type UsageStatsReader } from './usage-stats-reader.cjs';
let instance: UsageStatsReader | null = null;
export function getUsageStatsReader(): UsageStatsReader {
  if (!SQLITE_FILE) throw new Error('Usage statistics require a SQLite file');
  instance ??= createUsageStatsReader(SQLITE_FILE);
  return instance;
}
export async function closeUsageStatsReaderForTest(): Promise<void> {
  const current = instance;
  instance = null;
  await current?.close();
}
```

В `usageStats.ts` заменить только локальный construction на `getUsageStatsReader` и использовать тот же singleton. В `usageHistory.ts::getModelLatencyStats` заменить `db.prepare(sql).all(queryParams)` на:

```ts
const rows = await getUsageStatsReader().all<LatencyRow>(`
  SELECT provider, model, success, latency_ms, ttft_ms, tokens_output
  FROM usage_history
  WHERE ${conditions.join(' AND ')}
  ORDER BY timestamp DESC
  LIMIT @maxRows
`, [queryParams]);
```

`conditions` уже состоит из фиксированных SQL snippets; user strings остаются params. Не убирать `getDbInstance` из файла: он нужен остальным функциям.

RED test: наполнить **изолированную** SQLite синтетическими строками, одновременно запустить latency stats и `setTimeout(...,0)`; таймер должен успеть до завершения тяжёлой выборки. Также точно сопоставить result с нынешним `getModelLatencyStats`, проверить provider/model scope и 401 на API. Если порог времени недетерминированный, использовать large fixture + bounded timeout и мерить event order, не assertion на 1 мс.

```bash
"${UT[@]}" tests/unit/latency-stats-worker.test.ts \
  tests/unit/latency-stats-ttft-6875.test.ts \
  tests/unit/model-latency-stats-route.test.ts tests/unit/omni-worker-read.test.mjs
```

Commit: `perf(usage): share SQL worker for latency statistics`.

#### C4. RED/GREEN: админские метрики обозначают legacy semantics, 4 мин

**Файлы:** `src/app/api/usage/model-latency-stats/route.ts`, `tests/unit/model-latency-stats-route.test.ts`, UI consumer, который реально использует `avgTokensPerSecond` (найти по exact symbol до редактирования), `src/lib/usage/usageHistory/helpers.ts`.

Аддитивно вернуть в route JSON:

```ts
measurement: {
  ttft: 'legacy-first-generated-output-or-first-event',
  throughput: 'reported-output-over-post-legacy-ttft',
  includesReasoning: 'provider-dependent',
  historicalRowsReinterpreted: false,
},
```

RED на присутствие metadata; existing entries shape остаётся прежним. UI legacy table показывает tooltip «включая reasoning / историческая методика», samples denominator, окно, p50/p95, а не безоговорочное «скорость модели». Не мигрировать SQLite ради tooltip и не использовать эти поля для нового quality scoring до validation.

Commit: `fix(analytics): expose legacy timing semantics and sample context`.

### Этап D — качество не покупается отключением reasoning

#### D1. Contract tests upstream transformations, 5 мин

**Файлы:** existing `tests/unit/stream-readiness-policy.test.ts`, `empty-response-hardening.test.ts`, `stream-early-eof-breaker.test.ts`, `combo-terminal-status-policy-10501.test.ts`, `stream-claude-delta-contract.test.ts`, `responses-transformer-tool-call-reasoning-collision.test.ts`, `tests/integration/combo-matrix/ordered.test.ts`.

```bash
"${UT[@]}" tests/unit/stream-readiness-policy.test.ts \
  tests/unit/empty-response-hardening.test.ts \
  tests/unit/stream-early-eof-breaker.test.ts \
  tests/unit/combo-terminal-status-policy-10501.test.ts \
  tests/unit/stream-claude-delta-contract.test.ts \
  tests/unit/responses-transformer-tool-call-reasoning-collision.test.ts \
  tests/integration/combo-matrix/ordered.test.ts
```

Ожидание: exit 0, `fail 0`. Это regression gate; не называть мокнутые upstream доказательством доступности живых провайдеров.

Если живой Gemini malformed-response воспроизводится: сохранить **санитизированный** минимальный raw fixture в `tests/fixtures/omni/gemini-malformed-sse.txt`; RED тест в `tests/unit/omni-gemini-translation.test.ts` должен проходить настоящую translator ветку `open-sse/utils/stream.ts` и соответствующие `open-sse/translator/` adapters. Только после конкретного stack/формата подготовить маленькое дополнение к этому плану с exact patch. Не править 3000-строчный stream.ts по предположению и не превращать provider error в выдуманный ответ.

#### D2. Read-only проверка pools, quotas и retry scopes, 4 мин

**Артефакт:** `docs/ops/model-routing-audit.md`; кодовые seams: `open-sse/services/accountFallback.ts`, `errorClassifier.ts`, `streamRecovery.ts`, `src/lib/resilience/settings.ts`, `open-sse/handlers/chatCore/upstreamTimeouts.ts`.

Проверить существующую семантику, не менять всё сразу:

- healthy eligible accounts, actual canonical model + effort aliases;
- при 429 учитываются настоящий Retry-After/quota reset, нет многократного hammering запрещённого endpoint;
- клиентский abort не ухудшает score провайдера;
- 400/context overflow не повторяются бессмысленно на тех же данных;
- timeout до headers, idle между generated chunks и общий deadline различаются;
- thinking model не abort-ится watchdog из-за отсутствия видимого текста при продолжающемся reasoning;
- terminal/protocol error до выдачи можно повторить только в пределах общего бюджета; после output — не replay;
- `autoDisableBannedScope=all` не превращает один inconclusive model/region отказ в отключение всего account pool.

```bash
"${UT[@]}" tests/unit/persist-429-cooldown-account-fallback.test.ts \
  tests/unit/self-inflicted-upstream-timeout.test.ts \
  tests/unit/provider-health-inconclusive-probes.test.ts \
  tests/unit/account-fallback-cf1010-no-retry-8775.test.ts \
  tests/unit/stream-throughput-watchdog-recovery.test.ts \
  tests/unit/chatcore-upstream-timeouts.test.ts
```

При уже зелёном контракте reuse; новый retry engine не писать. При RED — сформировать named defect, точный failure и отдельный 2–5-минутный fix+commit, без пакета «заодно поменять все таймауты». Настройку timeout менять только если trace доказывает локальный self-inflicted cap, а не нагрузку upstream.

#### D3. Реальные модельные проверки, 5 мин подготовки + ограниченный прогон

**Исходный рабочий скрипт:** `C:/Users/artem/AppData/Local/hermes/cache/scratch/omni-model-bench.py` (существует, уже исполнялся). **Целевой файл в repo:** `scripts/ops/model-quality-probe.py`.

Перенести этот скрипт через file tools; его ключевой synthetic prompt и strict JSON проверки сохранить. Перед новым прогоном исправить методику:

- использовать bounded SSE decoder; сохранять failures до итогового assert;
- вынести в args `--base-url`, `--model`, `--max-output`, `--report`; не читать ключ из произвольной user home;
- ключ получать только на VPS из существующего read-only SQLite API-key item; никогда не выводить значение;
- max output для thinking tests 4096; явно заданный лимит настоящих клиентов не менять;
- по одному model на прогон сначала; concurrency=1 baseline, затем отдельный concurrency=4;
- первая event/reasoning/text, последние text, terminal marker, usage provenance, actual route id — раздельно;
- модели: `opencode-go/deepseek-flash`, `antigravity/gemini-3.7-flash-high`, `antigravity/gemini-3.8-flash-tiered`, `antigravity/claude-sonnet-4-6`;
- visibility TPS = null, когда reasoning usage unknown; short burst отдельно, никогда «7000 TPS модели»;
- диагностические запросы отделять от пользовательской статистики по выделенному test API key id после разрешения создать такой ключ. Не ставить header/metadata, поддержку которых gateway не подтвердил.

Сначала написать stdlib unittest на saved synthetic SSE, включая known DeepSeek reasoning-only limit, then RED → code → GREEN. `python3 -m unittest discover -s tests/ops -p 'test_model_quality_probe.py' -v` должен иметь exit 0 и `OK` без вызовов живых моделей.

В живом тесте выполнить те же объективные случаи с каждой моделью:

1. Strict JSON + duplicates sort + исправленные факты (исходный prompt).
2. Длинный синтетический контекст: owner/deadline/negation ближе к началу и в конце; не реальные переписки.
3. Один tool call со schema и корректный ответ после заранее заданного dummy tool result, только для advertised supportsTools. Реальные tools не выполнять.
4. Ошибка в коротком коде: попросить JSON с исправленной функцией и ожидаемыми edge outputs; returned code автоматически не выполнять без sandbox.

Подготовка каждого fixture — отдельная 2–5-минутная задача в `tests/fixtures/omni/quality/`; validation отвечает конкретными assertions, не subjective «мне нравится ответ». У unsupported capability — явный SKIP с причиной, не FAIL и не исчезновение результата.

Без установленного лимита расходов — не запускать платные маршруты. Стартовый live budget: до 16 коротких и 4 длинных запросов, concurrency не более 4; остановка при quota/429 storm, росте ошибок прода или достижении бюджета. Повторные серии и 24h мониторинг отдельно согласовать. Сохранить всё в `docs/ops/model-quality-results.json`/`.md`, включая failed runs.

#### D4. Выбор безопасных production routes, 3 мин

**Артефакт:** `docs/ops/model-route-proposal.md`, реальные config-targets после approved выбора — combos из `/api/combos` и connections из `/api/providers/[id]`.

Решение по каждой модели: основной маршрут, проверенный резерв к той же canonical model, сохранённый effort, подтверждённые tools/context, quota, observed failure rate и выборка. Если реального резерва нет — так и написать, не заполнять placeholder выдуманным account.

Не удалять `free-stack`. Предлагать отдельно стабильный explicit-model route; изменение групп, приоритетов аккаунтов, платных tier, autoDisable policy или расходных лимитов согласовать перед применением. Сделать через management API, backup точного JSON, затем readback целевого id, не прямой UPDATE SQLite.

### Этап E — холодный каталог и сеть без утечки семантики

#### E1. Разделить latency CPU/SQL/auth/сеть, 4 мин

**Файлы:** `src/app/api/v1/models/catalog.ts`, `catalogCache.ts`, `catalogProviderMaps.ts`, existing `modelMetadataRegistry.ts`, `/var/lib/omniroute-maintenance/catalog.cpuprofile`.

Сравнить cold/warm public, loopback и concurrent health, для одинакового key и scope. Чужой cold cache не очищать production restart ради измерения: использовать staging restart. Проверить поколения кэша и auth: revoke/hide должны отражаться на следующем read, а stale может использоваться только без изменения прав.

```bash
"${UT[@]}" tests/unit/v1-models-catalog-generation-race.test.ts \
  tests/unit/model-catalog-cache-swr-8728.test.ts \
  tests/unit/catalog-cache-auth-fingerprint.test.ts \
  tests/unit/instrumentation-warm-catalog-cache.test.ts
```

Ожидание: all pass. `.cpuprofile` старый и ДО последней memoization, его нельзя выдавать за актуальный профиль. Новый profile — staging inspector только `127.0.0.1`, закрыть после снятия; никаких публичных inspector ports.

#### E2. Оптимизировать только новый измеренный hot path, 5 мин на fix

**Пути scope:** `catalog.ts`, `catalogProviderMaps.ts`, `src/lib/modelMetadataRegistry.ts`, `src/lib/modelCapabilityResolutionSnapshot.ts`.

Разрешённые минимальные действия после profile: одна immutable snapshot per build, заранее индексированная metadata, повторное использование существующих per-build maps; либо дополнительный cooperative yield в доказанном long CPU-loop. Запрещены общий auth-blind snapshot, удаление metadata/capabilities ради времени, фиктивный placeholder catalog и бессрочное stale.

Для каждого найденного duplicate scan: RED counter/identity/invalidated-generation test, exact patch, PASS, commit. Если новый профиль не обнаружит такого повтора, не переписывать каталог в worker наугад: это отдельное изменение архитектуры со snapshot/auth contracts и дополнительным планом.

Цель первого прохода — concurrent health не замирает, warm catalog быстро отвечает и cold улучшается относительно baseline. Cold ≤3 с — целевой бюджет, не обещанный достижимый факт; при высокой CPU steal недостижение честно фиксируется.

#### E3. Verify nginx SSE + static, 4 мин

**Файлы:** `/etc/nginx/sites-enabled/api.mafsolin.space`, `/etc/nginx/conf.d/omniroute-ui-performance.conf`, future repo snapshot `deploy/omni/nginx-ui-performance.conf`.

Сейчас `proxy_buffering off` есть для `/v1/chat/completions`/`responses`, но browser management aliases `/api/v1/...` проходят general location. Проверить actual SSE headers на обоих путях: application header `X-Accel-Buffering: no` может уже решать вопрос. Если streaming artifact показывает buffering, сначала staging RED на равенство chunk timing public vs loopback, затем минимальная nginx конфигурация для alias путей.

Не менять regex location precedence вслепую и не обходить rate limits. Не снимать текущие `limit_req/limit_conn` глобально; условия перегрузки должны приводить к понятному 429, не 502 и не падению панели.

Для streaming location после доказанного RED добавить:

```nginx
proxy_buffering off;
proxy_cache off;
gzip off;
```

Остальные заголовки Host/X-Forwarded/Upgrade, существующие `/v1/alpha/search` и `/max-sonar/*` сохранить. `nginx -t` → syntax ok/test successful; reload только при deploy stage и readback. Статика остаётся immutable hashed + gzip/HTTP2; authenticated API не попадает в public cache.

### Этап F — пользовательские и админские сценарии до деплоя

#### F1. Automated browser contract, 5 мин на сценарий

**Файлы:** `tests/e2e/omni-user-delivery.spec.ts`, `tests/e2e/omni-admin-speed.spec.ts`; reuse `tests/e2e/helpers/dashboardAuth.ts` и `mockUpstreamServer.ts` только на staging. Не вызывать авто-onboarding helper на прод: он умеет менять состояние.

В отдельных tracer bullets проверять:

- Chat fragmented UTF-8, error midstream, cancellation, restart next request; partial сохраняется.
- Responses correct input, completed/failed/incomplete, no query-body.
- Compare two columns, равные request params, independent abort, no duplicate completion.
- Providers ready при зависшем enrichment, failures не показывают false empty list, settings policy unavailable блокирует mutation.
- Staging admin create test API key → reload/list id → revoke → 401; readback exact key id, секрет не логировать.
- Staging edit provider priority → reload/read exact id → restore → readback. Reauth и rollback UI понятны.
- 390px/1280px: нет горизонтального overflow, controls accessible, keyboard focus виден.

Playwright normal config имеет default server start до 15 мин и часть ignore patterns. Для этого набора пользоваться новым config без server auto-build — Appendix 6. Браузеры установить только в implementation turn. Никогда не принимать `--list` за выполненные tests.

```bash
node node_modules/@playwright/test/cli.js test \
  --config playwright.omni.config.ts --project chromium --workers=1 --retries=0
```

Ожидание: все выбранные сценарии passed, 0 unexpected failures/skips; screenshot/trace для failures. Продовый browser read-only audit A5 повторяется после деплоя, но production mutations не выполняются тестовыми fixtures.

#### F2. Параллельность и деградация, 5 мин подготовки + прогон

**Артефакт:** `docs/ops/quality-speed-load.json`. **Контур:** staging + deterministic mock upstream.

По отдельности concurrency 1, 4, 8; fake upstream delays/429/500/early EOF. Health делать одновременно, не после завершения серии. Проверять:

- отказ gateway ограничен/понятен, Retry-After читается;
- reasoning/headers heartbeat не искажают firstText;
- не растут unbounded pending/worker queues;
- connection slots освобождаются после abort/EOF;
- request text/tool args не дублируются;
- providers/settings доступно во время slow generation;
- имитация upstream failure не переписывает user model;
- client disconnect в отдельно отмеченном классе, не как «плохое качество».

На prod максимум согласованных 4 настоящих параллельных запроса. Stress 8+ и chaos исключительно staging. Не «улучшать» результат удалением неудачных запросов.

### Этап G — сборка, выкладка, откат

#### G1. Закрыть portability и typecheck перед build, 5 мин

**Файлы:** `tests/unit/omni-prefix-memo.test.mjs`, `omni-compiled-pricing.test.mjs`, `tsconfig.omni-quality-speed.json` (новый).

Hardcoded runtime tests разделить на portable source tests и **явные** deployment tests с обязательным `OMNI_RUNTIME_DIR`. Source root = repository root через `import.meta.url`/cwd, не `/opt/omniroute-staging/source`. При отсутствии candidate runtime deploy-test должен отмечаться как skipped deployment check, а release gate блокируется до реального запуска G3; не маскировать skip как coverage.

Сначала RED на loading source из independent checkout, затем исправить paths без изменений test assertions.

Сохранить полный baseline tsc stdout. Новый scoped config:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "incremental": false },
  "include": [
    "src/lib/playground/*.ts",
    "src/shared/schemas/playground.ts",
    "src/shared/utils/fetchJsonWithDeadline.ts",
    "src/lib/usage/usageStatsReader.ts",
    "src/lib/usage/usage-stats-reader.d.cts",
    "src/lib/usage/usageHistory.ts",
    "src/lib/usage/usageStats.ts",
    "src/app/api/usage/model-latency-stats/route.ts",
    "src/app/api/v1/models/catalogProviderMaps.ts",
    "src/app/(dashboard)/dashboard/playground/**/*.tsx",
    "src/app/(dashboard)/dashboard/playground/hooks/*.ts",
    "src/app/(dashboard)/dashboard/providers/providerPageUtils.ts",
    "src/app/(dashboard)/dashboard/providers/page.tsx"
  ],
  "exclude": ["node_modules", ".build", "dist"]
}
```

```bash
node --max-old-space-size=1536 node_modules/typescript/bin/tsc \
  --pretty false -p tsconfig.omni-quality-speed.json
```

Ожидание: exit 0. Старые unrelated transitive ошибки не скрывать cast-any: либо исправить минимально с тестом, либо явный documented blocker. Изменённые файлы не могут иметь неизвестный failing typecheck.

#### G2. Воспроизводимый release manifest и build, 5 мин активного труда

**Пути:** `docs/ops/quality-speed-release.md`, `scripts/build/assembleStandalone.mjs`, `/opt/omniroute-quality-speed-20261007/.build/next/standalone`.

Сначала сохранить diff всех runtime-only wrappers относительно соответствующего source: `server-ws.mjs` ↔ `scripts/dev/standalone-server-ws.mjs`, `peer-stamp.mjs` ↔ `scripts/dev/peer-stamp.mjs`, `main-server-timeouts.mjs`, `http-method-guard.cjs`, `head-response-guard.cjs`, worker loader. Каждую нужную ранее deployed правку перенести в source с тестом. Не брать старые compiled chunks в новую сборку.

`BUILD-SAFELY.md` советует старый `dist`, но текущий inspected `npm run build` собирает `.build/next/standalone`. Проверить именно существующий output, `server-ws.mjs`, `.build/next/static`, native modules и workers; exit 0 build script недостаточен, сборщик ловит некоторые assembly failures как nonfatal.

Предпочтительно build на отдельном совместимом Linux builder. Если только VPS — сначала подтвердить memory headroom и отсутствие конкурирующей сборки. Никакого automatic роста RAM/покупки VPS.

Проверенный ограниченный вариант для отдельного checkout:

```bash
UNIT=omniroute-quality-build-$(date +%Y%m%d-%H%M%S)
systemd-run --unit="$UNIT" \
  --property=MemoryMax=13G --property=MemoryHigh=12G --property=MemorySwapMax=0 \
  --property=WorkingDirectory=/opt/omniroute-quality-speed-20261007 \
  --setenv=HOME=/root --setenv=NODE_ENV=production \
  --setenv=OMNIROUTE_USE_TURBOPACK=0 --setenv=CIRCLE_NODE_TOTAL=2 \
  --setenv=OMNIROUTE_BUILD_MEMORY_MB=6144 \
  --setenv=NODE_OPTIONS=--max-old-space-size=6144 \
  --setenv=NEXT_TELEMETRY_DISABLED=1 \
  /usr/bin/npm run build
systemctl show "$UNIT" -p ActiveState -p SubState -p Result -p MemoryPeak -p ExecMainStatus
```

Ожидание после фактического конца: `ExecMainStatus=0`, Result success и существуют все artifacts. Не принимать старое Result=success у живого unit за завершение. Исторически сборка ~23 мин; ждать tracked completion, не запускать повторную поверх первой.

#### G3. Candidate runtime + packaging smoke, 5 мин

**Новый путь:** `/opt/omniroute-staging/runtime-quality-<полный verified git short SHA>`. SHA получать `git rev-parse --short HEAD`, не угадывать.

Скопировать **новый standalone bundle** туда offline; старый runtime не менять. Проверить deploy contracts с `OMNI_RUNTIME_DIR` и worker colocating. Candidate запускать отдельно на 20138 с тестовой БД, background workers/cron отключить существующим документированным flag, не подключать prod data.

```bash
RELEASE_SHA=$(git -C /opt/omniroute-quality-speed-20261007 rev-parse --short=12 HEAD)
CANDIDATE="/opt/omniroute-staging/runtime-quality-$RELEASE_SHA"
test -n "$RELEASE_SHA" && test -d "$CANDIDATE"
node --check "$CANDIDATE/server-ws.mjs"
node --check "$CANDIDATE/usage-stats-reader.cjs"
OMNI_RUNTIME_DIR="$CANDIDATE" \
  "${UT[@]}" tests/unit/omni-compiled-pricing.test.mjs tests/unit/omni-prefix-memo.test.mjs
```

`<SHA>` в командах заменить реальным значением переменной, не буквальной строкой. Ожидание: exit 0; worker реально исполняет read-only query, новый runtime tests проверяют **его**, а не старый `c511facdf`.

#### G4. Свежий откат и database safety, 4 мин

**Backup:** `/opt/omniroute-staging/backups/quality-<timestamp>/`.

Перед командами с release paths получать идентификаторы один раз, не подставлять placeholder буквально:

```bash
RELEASE_SHA=$(git -C /opt/omniroute-quality-speed-20261007 rev-parse --short=12 HEAD)
CANDIDATE="/opt/omniroute-staging/runtime-quality-$RELEASE_SHA"
BACKUP="/opt/omniroute-staging/backups/quality-$(date +%Y%m%d-%H%M%S)"
test -n "$RELEASE_SHA" && test -d "$CANDIDATE"
```

Сохранить точные systemd unit/drop-ins, nginx configs, static symlink target, verified old runtime path и route JSON settings. Живую SQLite бэкапить только штатным SQLite backup API/операторской процедурой, не `cp storage.sqlite` без WAL. Снимок будет тяжёлым и не нужен для каждого code commit; нужен перед потенциальными schema/config updates.

Сначала dry-run rollback: он возвращает **текущий оптимизированный** runtime/settings/static, НЕ старый perf rollback. Не рестартовать прод ради демонстрации отката. На staging реально переключить candidate → прежний test runtime → candidate и повторить smoke.

Schema migration в первом проходе не планируется. Если появится необходимость, остановиться и описать reversible/forward-compatible migration отдельно.

#### G5. Static staging и один approved switch, 5 мин

Сначала сделать новый immutable static release directory, включающий новые hash-файлы **и предыдущие hash-файлы для открытых вкладок**. Проверить отсутствие same-name/different-bytes коллизий, `.gz` и main CSS/JS 200. Нельзя просто сменить current на каталог только с новыми hashes: старые вкладки начнут получать 404.

После approval окна переключить `WorkingDirectory`/`ExecStart` новым systemd drop-in, обновить static symlink атомарно, `nginx -t`, один daemon-reload/restart/reload. Другие drop-ins (`90-nonblocking-integrity.conf`, timeout/resource guards) сохранить.

Readback: systemctl actual ExecStart/WorkingDirectory, nginx effective configuration, public health, новый build SHA, current static target. Не заявлять success только по успешному write/restart.

#### G6. Проверка снаружи и небольшой soak, 5 мин подготовки

Повторить A5 с ПК, live API качество D3 в пределах бюджета, staging failures F2 и production health одновременно с generation. Первый короткий production soak — 15 мин без continuous paid probes; 24h наблюдение предложить отдельно.

Rollback trigger: потеря текста/tool args, auth leakage, 500 новых endpoints, стабильно ухудшенный latency относительно matched baseline, рост upstream storm, OOM/PSI admission stuck, статические 404. Upstream rate limit не лечить бесконечными restart.

**Итог:** `docs/ops/quality-speed-results.md`: что поменялось, before/after одной методики, все denominators, TPS provenance, sample size, unresolved upstream/hosting issues, branch/commits/candidate SHA, rollback id и реальные browser screenshots. Нельзя заканчивать только списком файлов.

## Tests / validation: acceptance criteria

### Детерминированные release blockers

- SSE UTF-8/CRLF/multiline/frame limits: payload не теряется при каждом tested split; error/EOF не объявляется успешным completion.
- Thinking-only `length` не маскируется полезным ответом и не вызывает hidden budget raise; tool-call terminal не классифицируется как empty error.
- Chat и Compare на одинаковой модели отправляют одинаковые system/effort/limits; Responses отправляет правильный input.
- Final callback содержит актуальные timings/counts; heartbeat не равен первому тексту; unknown count даёт null TPS.
- Abort прекращает upstream/consumer и освобождает слоты; повторный запрос работает; частичный ответ остаётся.
- UI critical data не ждут optional enrichment; failed providers/settings видны как ошибка, не false empty или разрешение mutation.
- SQL stats не блокируют основной event loop; результат scope/параметры совпадают с прежним; worker errors не fallback в синхронный SELECT.
- Auth/cached catalog generations не смешиваются; revocation/visibility edits действуют на следующем read.
- Все touched tests реально обнаружены runner-ом; skips известных excluded files не считать PASS.
- Targeted typecheck, build artifact/native worker smoke, staging E2E и readback deployment проходят.

### Performance targets, которые измерить, а не обещать

| Сторона | Целевой бюджет первого прохода | Методика |
|---|---|---|
| ПК → login / critical provider UI | полезный экран ≤3 с на обычной сети, optional не блокирует | browser navigation → видимые controls, 5 повторов cold/warm |
| Node concurrent health | loopback p95 <500 мс при 4 slow streams; public overhead отдельно | health во время generation, не после |
| Warm model catalog | public p95 ≤1 с | один scope/key, cache hit подтверждён |
| Cold catalog | цель ≤3 с, иначе минимум доказанное улучшение и нет event-loop freeze | staging cold + auth/capability parity |
| Модельный transport | gateway-added задержка не хуже baseline; устранены подтверждённые local failures | matched model/effort/prompt/payload, latency distribution и failure denominator |
| TPS | reported/visible/reasoning и burst раздельно; steady only на достаточном тексте | ≥3 с текстового интервала и ≥8 content events для delivery label; не inference guarantee |
| Качество | ни одного protocol/input/identity regression; objective fixtures не хуже baseline | system/reasoning/tools/context parity + fixed tasks |

Порог 3 с/8 событий — правило отображения, не научное доказательство постоянного upstream TPS. Для p95 маленькую sample size указывать рядом. 100% на нескольких probes не превращать в SLA.

## Risks, tradeoffs, open questions

1. **CPU steal/диск VPS:** код не создаёт дополнительное процессорное время. Если matched loopback CPU measurements показывают это основным ограничением, предложить миграцию/другой тариф отдельно, без покупки и перезапуска сервера в этом плане.
2. **Upstream и квоты:** Groq/Cloudflare, Codex bridge, истёкшие accounts и платёжные 402 нельзя исправить CSS/worker-ом; каждый требует отдельного подтверждённого решения.
3. **Quality:** gateway может сохранить/восстановить качество доставки, но не превратить одну модель в более умную. Новые fallback модели, paid tiers и compression — отдельный выбор пользователя.
4. **Сборка:** standalone output layout расходится со старой документацией, wrappers могут быть только в runtime. Релиз запрещён без packaging inventory и тестов.
5. **Старые метрики:** `ttft_ms/tokens_output` имеют mixed semantics. Не переписывать историю и не делать автоматические выводы о TPS из недостаточных данных.
6. **Backpressure/буферы:** новый client parser ограничен по frame/output; большие законные tool args могут потребовать поднять лимит отдельно с test, не убрать ограничение полностью.
7. **Дополнительный code scope:** если обнаружатся P0 auth/security/данные, исправлять раньше performance; новый точный mini-plan обязателен для ещё не исследованного bug.
8. **Что требует решения перед действием:** платный test budget, production config/routing changes, deploy downtime window, перенос VPS и длительное наблюдение. Для draft/исследования вопросов нет — можно выполнять staged deterministic этапы после команды на исполнение.

## Appendix 1 — целевой bounded SSE decoder и tests

`src/lib/playground/sseDecoder.ts`:

```ts
export interface SseFrame { event: string; data: string }
export class SseDecoder {
  private decoder = new TextDecoder();
  private buffer = '';
  private event = 'message';
  private data: string[] = [];
  private dataChars = 0;
  constructor(private readonly limit = 1_048_576) {}

  push(bytes: Uint8Array): SseFrame[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain(false);
  }

  finish(): SseFrame[] {
    this.buffer += this.decoder.decode();
    const frames = this.drain(true);
    if (this.buffer.length > 0 || this.data.length > 0) {
      throw new Error('stream_truncated: incomplete SSE frame');
    }
    return frames;
  }

  private drain(final: boolean): SseFrame[] {
    const out: SseFrame[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      if (!final && match[0] === '\r' && match.index + 1 === this.buffer.length) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line.length + this.dataChars > this.limit) throw new Error('SSE frame limit exceeded');
      if (line === '') {
        if (this.data.length > 0) out.push({ event: this.event, data: this.data.join('\n') });
        this.event = 'message'; this.data = []; this.dataChars = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') { this.data.push(value); this.dataChars += value.length + 1; }
        else if (field === 'event') this.event = value;
      }
    }
    if (this.buffer.length + this.dataChars > this.limit) throw new Error('SSE frame limit exceeded');
    return out;
  }
}
```

`tests/unit/playground-sse-decoder.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SseDecoder } from '../../src/lib/playground/sseDecoder.ts';
const encode = new TextEncoder();

test('every byte split preserves UTF-8 and CRLF events', () => {
  const source = ': heartbeat\r\n\r\nevent: reply\r\ndata: {"text":"Ответ 🌿"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = encode.encode(source);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new SseDecoder();
    const frames = [...decoder.push(bytes.slice(0, split)), ...decoder.push(bytes.slice(split)), ...decoder.finish()];
    assert.deepEqual(frames, [
      { event: 'reply', data: '{"text":"Ответ 🌿"}' },
      { event: 'message', data: '[DONE]' },
    ]);
  }
});
test('multiline data is joined and comments ignored', () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push(encode.encode('data: {\ndata: "ok":true}\n: comment\n\n')),
    [{ event: 'message', data: '{\n"ok":true}' }]);
});
test('unterminated frame is not silently accepted', () => {
  const decoder = new SseDecoder();
  decoder.push(encode.encode('data: {"ok":true}'));
  assert.throws(() => decoder.finish(), /stream_truncated/);
});
test('oversized unfinished frame is bounded', () => {
  const decoder = new SseDecoder(32);
  assert.throws(() => decoder.push(encode.encode('data: ' + 'x'.repeat(33))), /limit exceeded/);
});
```

## Appendix 2 — общий consumer (Chat + Responses)

`src/lib/playground/consumeChatStream.ts`:

```ts
import { SseDecoder } from './sseDecoder';
export type Usage = Record<string, unknown>;
export interface DeliveryCallbacks {
  onEvent?(): void;
  onFrame?(event: string, payload: Record<string, unknown>): void;
  onText?(text: string): void;
  onReasoning?(text: string): void;
}
export interface ChatStreamResult {
  usage?: Usage;
  finishReason: string | null;
  hasTools: boolean;
  hasText: boolean;
  hasReasoning: boolean;
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>, callbacks: DeliveryCallbacks = {},
): Promise<ChatStreamResult> {
  const reader = body.getReader();
  const decoder = new SseDecoder();
  const result: ChatStreamResult = {
    finishReason: null, hasTools: false, hasText: false, hasReasoning: false,
  };
  let terminal = false;
  let transportDone = false;
  let outputChars = 0;
  const text = (value: unknown, reasoning = false) => {
    if (typeof value !== 'string' || value.length === 0) return;
    outputChars += value.length;
    if (outputChars > 8_388_608) throw new Error('stream output limit exceeded');
    if (reasoning) { result.hasReasoning = true; callbacks.onReasoning?.(value); }
    else { result.hasText = true; callbacks.onText?.(value); }
  };
  const consume = (data: string) => {
    if (data.trim() === '[DONE]') { terminal = true; transportDone = true; return; }
    const parsed = record(JSON.parse(data));
    callbacks.onEvent?.();
    callbacks.onFrame?.(String(parsed.type ?? 'message'), parsed);
    if (parsed.error || parsed.type === 'error' || parsed.type === 'response.failed') {
      const error = record(parsed.error || record(parsed.response).error);
      throw new Error(String(error.message || parsed.message || 'upstream stream failed'));
    }
    if (parsed.usage && typeof parsed.usage === 'object') result.usage = record(parsed.usage);
    if (Array.isArray(parsed.choices)) {
      const choice = record(parsed.choices[0]);
      const delta = record(choice.delta);
      text(delta.content);
      text(delta.reasoning_content ?? delta.reasoning, true);
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) result.hasTools = true;
      if (delta.function_call && typeof delta.function_call === 'object') result.hasTools = true;
      if (typeof choice.finish_reason === 'string') {
        result.finishReason = choice.finish_reason;
        terminal = true;
      }
    }
    if (parsed.type === 'response.output_text.delta') text(parsed.delta);
    if (parsed.type === 'response.reasoning_summary_text.delta') text(parsed.delta, true);
    if (parsed.type === 'response.function_call_arguments.delta') result.hasTools = true;
    if (parsed.type === 'response.completed' || parsed.type === 'response.incomplete') {
      const response = record(parsed.response);
      if (response.usage) result.usage = record(response.usage);
      if (Array.isArray(response.output)) {
        result.hasTools ||= response.output.some(item => record(item).type === 'function_call');
      }
      if (parsed.type === 'response.incomplete') {
        const reason = String(record(response.incomplete_details).reason ?? 'unknown');
        if (reason === 'max_output_tokens') result.finishReason = 'length';
        else if (reason === 'content_filter') result.finishReason = 'content_filter';
        else throw new Error(`response_incomplete: ${reason}`);
      } else result.finishReason = 'stop';
      terminal = true;
      transportDone = true;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of decoder.push(value)) consume(frame.data);
      if (transportDone) { await reader.cancel().catch(() => {}); break; }
    }
    if (!transportDone) for (const frame of decoder.finish()) consume(frame.data);
    if (!terminal) throw new Error('stream_truncated: terminal event missing');
    if (!result.hasText && !result.hasTools && !result.hasReasoning && result.finishReason === 'stop') {
      throw new Error('empty_content: provider completed without output');
    }
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
```

Client integration block вместо старого loop в `ChatTab.tsx`:

```ts
if (!res.body) throw new Error('Response body is unavailable');
let assistantResponse = '';
const result = await consumeChatStream(res.body, {
  onEvent: () => tracker.event(),
  onReasoning: () => tracker.reasoning(),
  onText: delta => {
    tracker.text();
    assistantResponse += delta;
    setMessages(prev => {
      const next = [...prev];
      const idx = appendIndex !== undefined ? appendIndex : next.length - 1;
      next[idx] = { ...next[idx], content: assistantResponse };
      return next;
    });
  },
});
```

`tracker` создать до fetch, не в этом блоке. B3 сначала подключает consumer без tracker callbacks; callbacks включаются после RED B4. Reasoning-only length: UI warning «Лимит израсходован до ответа; увеличьте его явно»; legitimate tool result показать как structured tool handoff, не выдумывать текст. Для tools viewer сохранить полные raw events через existing inspector, не исполнять tools в consumer.

В hook consumer callback `onFrame` передавать событие существующему response inspector и накопителю tool calls. Tool-call arguments должны сохраняться по `index`/`id`, а не только boolean `hasTools`; complete fixture и аргументы проверяются отдельно. Пока такого сохранения нет, release blocked для tools, даже если текстовые тесты зелёные. На cancel/ошибке сохранить partial text; не вызывать новую генерацию автоматически.

## Appendix 3 — воспроизводимые delivery metrics

`src/lib/playground/deliveryMetrics.ts`:

```ts
import type { StreamMetrics } from '@/shared/schemas/playground';
import type { Usage } from './consumeChatStream';
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

export class DeliveryTracker {
  private start: number;
  private firstEvent: number | null = null;
  private firstText: number | null = null;
  private lastText: number | null = null;
  private textEvents = 0;
  private reasoningObserved = false;
  private nonTextOutput = false;
  constructor(private readonly now: () => number = () => performance.now()) {
    this.start = now();
  }
  event() { this.firstEvent ??= this.now(); }
  reasoning() { this.event(); this.reasoningObserved = true; }
  tool() { this.event(); this.nonTextOutput = true; }
  text() {
    const at = this.now();
    this.firstEvent ??= at; this.firstText ??= at; this.lastText = at;
    this.textEvents += 1;
  }
  finish(usage: Usage = {}): StreamMetrics {
    const totalMs = Math.max(0, this.now() - this.start);
    const tokensIn = count(usage.prompt_tokens ?? usage.input_tokens) ?? 0;
    const reported = count(usage.completion_tokens ?? usage.output_tokens);
    const details = obj(usage.completion_tokens_details ?? usage.output_tokens_details);
    const reasoningTokens = count(details.reasoning_tokens ?? usage.reasoning_tokens);
    const inconsistentZero = this.reasoningObserved && reasoningTokens === 0;
    const visibleTokens = reported !== null && reasoningTokens !== null && !inconsistentZero && !this.nonTextOutput && reported >= reasoningTokens
      ? reported - reasoningTokens : null;
    const span = this.firstText !== null && this.lastText !== null ? this.lastText - this.firstText : 0;
    const known = visibleTokens !== null && visibleTokens > 0 && span > 0;
    const sustained = known && span >= 3000 && this.textEvents >= 8;
    return {
      ttftMs: this.firstText === null ? null : this.firstText - this.start,
      totalMs, tokensIn, tokensOut: reported ?? 0,
      tps: reported !== null && totalMs > 0 ? reported / (totalMs / 1000) : null,
      costUsd: null,
      firstEventMs: this.firstEvent === null ? null : this.firstEvent - this.start,
      firstTextMs: this.firstText === null ? null : this.firstText - this.start,
      visibleTokens, reasoningTokens,
      visibleTps: sustained ? visibleTokens! / (span / 1000) : null,
      outputTps: reported !== null && totalMs > 0 ? reported / (totalMs / 1000) : null,
      tpsKind: sustained ? 'delivery' : known ? 'burst' : 'unknown',
    };
  }
}
```

`costUsd=null` здесь означает «этот tracker стоимость не считает», не нулевую стоимость. Сохранить существующий cost calculation через `computeMetrics`/pricing и передать результат в snapshot отдельно, без изменения billing и без замены неизвестных tokens выдуманным count.

Существующий `src/lib/usage/tokenAccounting.ts` уже имеет `getReasoningTokensOrNull` и `getObservedReasoning`; не создать третью расходящуюся трактовку reasoning. Для common normalized Chat использовать эту nullable семантику. Для Responses сначала RED на `output_tokens_details.reasoning_tokens`, затем аддитивно расширить existing helper поддержкой этого контейнера и использовать его в tracker. Billing helpers и формулы не менять; output-minus-reasoning допустимо только там, где upstream/translator contract подтверждает, что completion включает reasoning. Если есть tool args/nontext output или observed reasoning при metered 0, видимый text TPS остаётся null.

`tests/unit/playground-delivery-metrics.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryTracker } from '../../src/lib/playground/deliveryMetrics.ts';

test('event and reasoning do not count as first visible text', () => {
  let now = 0;
  const tracker = new DeliveryTracker(() => now);
  now = 10; tracker.event();
  now = 100; tracker.reasoning();
  now = 5000; tracker.text();
  now = 6000;
  const result = tracker.finish({ completion_tokens: 3000,
    completion_tokens_details: { reasoning_tokens: 2800 } });
  assert.equal(result.firstEventMs, 10);
  assert.equal(result.firstTextMs, 5000);
  assert.equal(result.ttftMs, 5000);
  assert.equal(result.visibleTokens, 200);
  assert.equal(result.visibleTps, null);
});
test('unknown reasoning count is not a precise visible TPS', () => {
  let now = 0;
  const tracker = new DeliveryTracker(() => now);
  for (let i = 1; i <= 10; i++) { now = i * 500; tracker.text(); }
  now = 6000;
  const result = tracker.finish({ completion_tokens: 900 });
  assert.equal(result.visibleTokens, null);
  assert.equal(result.visibleTps, null);
  assert.equal(result.tpsKind, 'unknown');
});
test('visible delivery uses matching text interval and excludes reasoning', () => {
  let now = 0;
  const tracker = new DeliveryTracker(() => now);
  for (let i = 1; i <= 9; i++) { now = 1000 + (i - 1) * 500; tracker.text(); }
  now = 5500;
  const result = tracker.finish({ completion_tokens: 500,
    completion_tokens_details: { reasoning_tokens: 300 } });
  assert.equal(result.visibleTps, 50);
  assert.equal(result.tpsKind, 'delivery');
});
test('observed reasoning with reported zero is not exact visible token accounting', () => {
  let now = 0;
  const tracker = new DeliveryTracker(() => now);
  now = 50; tracker.reasoning();
  for (let i = 1; i <= 9; i++) { now = 1000 + (i - 1) * 500; tracker.text(); }
  now = 5500;
  const result = tracker.finish({ completion_tokens: 500,
    completion_tokens_details: { reasoning_tokens: 0 } });
  assert.equal(result.visibleTokens, null);
  assert.equal(result.visibleTps, null);
});
```

## Appendix 4 — request DRY без уменьшения reasoning

`src/lib/playground/chatRequest.ts`:

```ts
import type { ConfigState } from '@/app/(dashboard)/dashboard/playground/components/StudioConfigPane';
import { buildReasoningRequestFields, type ReasoningControlSpec } from
  '@/app/(dashboard)/dashboard/playground/components/reasoningControlUtils';
export interface ChatInput { role: string; content: string }
export function buildPlaygroundChatRequest(
  config: ConfigState, messages: ChatInput[], model = config.model,
  spec: ReasoningControlSpec = config.reasoning ?? { show: false, effortOptions: [] },
): Record<string, unknown> {
  const input = messages.filter(item => item.role !== 'system');
  const body: Record<string, unknown> = {
    model, stream: true, stream_options: { include_usage: true },
    messages: [
      ...(config.systemPrompt.trim() ? [{ role: 'system', content: config.systemPrompt }] : []),
      ...input.map(({ role, content }) => ({ role, content })),
    ],
  };
  const p = config.params;
  if (p.temperature !== 1) body.temperature = p.temperature;
  if (p.max_tokens > 0) body.max_tokens = p.max_tokens;
  if (p.top_p !== 1) body.top_p = p.top_p;
  if (p.presence_penalty !== 0) body.presence_penalty = p.presence_penalty;
  if (p.frequency_penalty !== 0) body.frequency_penalty = p.frequency_penalty;
  if (p.seed !== null) body.seed = p.seed;
  if (p.stop.trim()) body.stop = p.stop;
  if (p.jsonMode) body.response_format = { type: 'json_object' };
  Object.assign(body, buildReasoningRequestFields({ effort: p.effort, thinking: p.thinking }, spec));
  return body;
}
```

Лимит по умолчанию остаётся существующим пользовательским значением 1024; пользователь его видит, а request получает его явно. Для модели, где этого мало для thinking, показать предупреждение и предложить 4096 **по нажатию пользователя**, не менять API-запросы произвольно.

Pure test fixture в `tests/unit/playground-chat-request.test.ts` должен сравнить body обоих callers, проверить same model/high/system/seed/stop, explicit max_tokens и immutable input. Test `spec` unknown при explicit effort: Compare UI блокирует запуск, а не quietly strips effort.

## Appendix 5 — body-inclusive deadline и split provider loaders

`src/shared/utils/fetchJsonWithDeadline.ts`:

```ts
export class FetchJsonDeadlineError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`JSON request deadline exceeded after ${timeoutMs}ms`);
    this.name = 'FetchJsonDeadlineError';
  }
}
export async function fetchJsonWithDeadline<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<T> {
  const { timeoutMs = 5000, fetchFn = fetch, signal, ...init } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = signal?.reason ?? new DOMException('Aborted', 'AbortError');
    controller.abort(error); rejectAbort?.(error);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new FetchJsonDeadlineError(timeoutMs);
      controller.abort(error); reject(error);
    }, timeoutMs);
  });
  const request = (async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} loading provider data`);
    return await response.json() as T;
  })();
  try { return await Promise.race([request, deadline, cancelled]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
```

В existing `providers/providerPageUtils.ts`, сохранив existing types/imports, добавить import helper и functions:

```ts
export async function loadProviderCore(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<Pick<ProviderPageData,
  'connections' | 'providerNodes' | 'ccCompatibleProviderEnabled' | 'blockedProviders' | 'settings'>> {
  const read = (url: string) => fetchJsonWithDeadline<Record<string, any>>(url, {
    fetchFn: fetchImpl, timeoutMs, signal, cache: 'no-store',
  });
  const [connections, nodes, settings] = await Promise.all([
    read('/api/providers'), read('/api/provider-nodes'), read('/api/settings'),
  ]);
  if (!Array.isArray(connections.connections) || !Array.isArray(nodes.nodes)) {
    throw new Error('Invalid provider data payload');
  }
  return {
    connections: connections.connections,
    providerNodes: nodes.nodes,
    ccCompatibleProviderEnabled: nodes.ccCompatibleProviderEnabled === true,
    blockedProviders: Array.isArray(settings.blockedProviders) ? settings.blockedProviders : [],
    settings,
  };
}

export async function loadProviderEnrichment(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<Pick<ProviderPageData, 'expirations' | 'openRouterProviderStats'>> {
  const read = (url: string) => fetchJsonWithDeadline<Record<string, any>>(url, {
    fetchFn: fetchImpl, timeoutMs, signal, cache: 'no-store',
  }).catch(() => null);
  const [expirations, stats] = await Promise.all([
    read('/api/providers/expiration'), read('/api/providers/openrouter-stats'),
  ]);
  return {
    expirations,
    openRouterProviderStats: Array.isArray(stats?.data) ? stats.data : [],
  };
}
```

`any` здесь соответствует текущему `ProviderPageData` интерфейсу. При refactor заменить payload types на существующие конкретные types там, где они доступны; не выдумывать новый provider schema. Shape check сначала baseline, затем дополнительные RED на 401/malformed/late abort.

`tests/unit/provider-page-first-paint.test.ts` — минимальный behavior test:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProviderCore } from
  '../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts';
import { fetchJsonWithDeadline, FetchJsonDeadlineError } from
  '../../src/shared/utils/fetchJsonWithDeadline.ts';

test('core provider load never requests optional enrichment', async () => {
  const urls: string[] = [];
  const fake = async (url: string | URL | Request) => {
    urls.push(String(url));
    const payload = String(url) === '/api/providers' ? { connections: [{ id: 'test' }] }
      : String(url) === '/api/provider-nodes' ? { nodes: [] }
      : { blockedProviders: [] };
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  };
  const core = await loadProviderCore(fake as typeof fetch, 100);
  assert.equal(core.connections[0].id, 'test');
  assert.deepEqual(urls.sort(), ['/api/provider-nodes', '/api/providers', '/api/settings'].sort());
});
test('JSON body is included in the deadline even if fetch ignores abort', async () => {
  const fake = async () => ({ ok: true, json: () => new Promise(() => {}) });
  await assert.rejects(
    fetchJsonWithDeadline('/synthetic', { timeoutMs: 20, fetchFn: fake as unknown as typeof fetch }),
    FetchJsonDeadlineError,
  );
});
```

Для честного RED core test сначала направить на нынешний loader и проверить факт запроса/ожидания optional; новый экспорт не должен падать просто отсутствующим import. Затем extract новый loader и сохранить этот test как regression. Deadline RED сначала воспроизвести на существующем `fetchWithTimeout` + `response.json()` с outer test deadline, затем внедрить body-inclusive helper.

## Appendix 6 — scoped Playwright без автосборки и production mutation

`playwright.omni.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['omni-user-delivery.spec.ts', 'omni-admin-speed.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: [['list'], ['html', { outputFolder: 'test-results/omni-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:20138',
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

Порт 20138 — отдельный тестовый server с isolated DATA_DIR. Не переопределять baseURL на прод и не переносить staging login helper/авто-onboarding на production. Проверить readiness отдельно: `/healthz` HTTP 200 и корректный test DB identity до первого E2E.

## Completion / handoff

После исполнения каждого этапа обновлять `docs/ops/quality-speed-results.md`, но финальный результат — работающий проверенный релиз и реальные before/after данные, не этот план. Исполнитель обязан перечислить незакрытые blockers; «все модели стабильны/качество улучшено» разрешено только для конкретно проверенных сценариев с указанной методикой, не для всего каталога.
