/**
 * main.tsx — точка входа Mini App (веха G: экраны на Preact).
 *
 * Флоу: Telegram.WebApp.initData → POST /api/tma/auth → JWT в памяти
 * (не в localStorage) → <App/> со стеком экранов. Тема — из themeParams.
 * Сохранены экраны: «откройте через бота», «нет доступа» (401/403),
 * сетевая ошибка + кнопка «Повторить».
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, createApi } from './api';
import type { Api, AuthResponse } from './api';
import { App } from './app';
import { applyTheme } from './tg';
import { ErrorView, Loading } from './ui';

const wa = window.Telegram?.WebApp;
const rootEl = document.getElementById('app')!;

/** initData → JWT; 401/403 → ApiError('forbidden'). */
async function authenticate(initData: string): Promise<{ token: string; name: string | null }> {
  const res = await fetch('/api/tma/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(res.status, 'forbidden', 'Нет доступа');
  }
  if (!res.ok) throw new ApiError(res.status, 'error', `Сервер ответил ${res.status}`);
  const data = (await res.json()) as AuthResponse;
  if (!data.ok || !data.token) {
    throw new ApiError(500, 'error', 'Неожиданный ответ сервера при входе');
  }
  return { token: data.token, name: data.user?.name ?? null };
}

type Boot =
  | { kind: 'loading' }
  | { kind: 'ready'; api: Api; name: string | null }
  | { kind: 'access' }
  | { kind: 'net' };

function Root() {
  const [st, setSt] = useState<Boot>({ kind: 'loading' });

  const boot = async () => {
    setSt({ kind: 'loading' });
    let token: string;
    let name: string | null;
    try {
      const a = await authenticate(wa!.initData);
      token = a.token;
      name = a.name;
    } catch (e) {
      setSt({
        kind: e instanceof ApiError && (e.status === 401 || e.status === 403) ? 'access' : 'net',
      });
      return;
    }
    // токен — в замыкании, только память; reauth обновляет его же
    const api = createApi({
      getToken: () => token,
      reauth: async () => {
        token = (await authenticate(wa!.initData)).token;
        return token;
      },
    });
    setSt({ kind: 'ready', api, name });
  };

  useEffect(() => {
    void boot();
  }, []);

  switch (st.kind) {
    case 'loading':
      return <Loading />;
    case 'access':
      return (
        <ErrorView
          title="Нет доступа"
          text="Бот не узнал вас или настройка не завершена. Завершите /start в боте и попробуйте снова."
          onRetry={() => void boot()}
        />
      );
    case 'net':
      return (
        <ErrorView
          title="Сеть недоступна"
          text="Не удалось связаться с сервером. Проверьте соединение."
          onRetry={() => void boot()}
        />
      );
    default:
      return <App api={st.api} name={st.name} onFatal={() => setSt({ kind: 'access' })} />;
  }
}

// ── вход ──
if (!wa) {
  render(
    <ErrorView
      title="Не из Telegram"
      text="Это приложение открывается из бота — нажмите «📱 Приложение» в меню (/menu)."
    />,
    rootEl,
  );
} else {
  applyTheme(wa);
  if (!wa.initData) {
    render(
      <ErrorView
        title="Не из Telegram"
        text="initData пуст — откройте приложение кнопкой «📱 Приложение» в меню бота."
      />,
      rootEl,
    );
  } else {
    render(<Root />, rootEl);
  }
}
