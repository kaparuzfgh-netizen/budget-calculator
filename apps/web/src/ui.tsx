/**
 * ui.tsx — общие кирпичики экранов: верхняя навигация «← Назад»/«🏠»,
 * состояния загрузки/ошибки, хук useData (загрузка с retry и реакцией
 * на 401/403 через onAuthFail), подписанные поля форм.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { isAuthError } from './api';

/** Верхняя панель вложенных экранов (показывается при глубине ≥ 1). */
export function TopBar({ onBack, onHome }: { onBack: () => void; onHome: () => void }) {
  return (
    <div class="topbar">
      <button type="button" class="navbtn" onClick={onBack}>
        ← Назад
      </button>
      <button type="button" class="navbtn" onClick={onHome}>
        🏠 На главную
      </button>
    </div>
  );
}

export function Loading() {
  return (
    <div class="center">
      <p class="muted">Загружаю…</p>
    </div>
  );
}

export function ErrorView({
  title,
  text,
  onRetry,
}: {
  title: string;
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div class="center">
      <div>
        <h1>{title}</h1>
        <p class="muted">{text}</p>
        {onRetry && (
          <button type="button" class="retry" onClick={onRetry}>
            Повторить
          </button>
        )}
      </div>
    </div>
  );
}

/** Заголовок и текст экрана ошибки загрузки: сеть — TypeError от fetch. */
export function errorView(e: unknown): { title: string; text: string } {
  if (e instanceof TypeError)
    return { title: 'Сеть недоступна', text: 'Не удалось связаться с сервером. Проверьте соединение.' };
  if (e instanceof Error) return { title: 'Ошибка сервера', text: e.message };
  return { title: 'Ошибка', text: 'Что-то пошло не так.' };
}

export interface LoadState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Загрузка данных экрана. Рефетч — reload() или смена deps.
 * 401/403 (в т.ч. после неудачного reauth) → onAuthFail → экран «Нет доступа».
 */
export function useData<T>(
  fn: () => Promise<T>,
  onAuthFail: () => void,
  deps: readonly unknown[] = [],
): LoadState<T> {
  const [tick, setTick] = useState(0);
  const [st, setSt] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => {
        if (live) setSt({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (live) setSt({ data: undefined, error, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [tick, ...deps]);
  useEffect(() => {
    if (isAuthError(st.error)) onAuthFail();
  }, [st.error]);
  return { data: st.data, error: st.error, loading: st.loading, reload: () => setTick((t) => t + 1) };
}

/** Условный переход на фатальный экран (например, профиль без онбординга). */
export function useFatalOn(cond: boolean, onFatal: () => void): void {
  useEffect(() => {
    if (cond) onFatal();
  }, [cond, onFatal]);
}

export function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
    </label>
  );
}

export function FormError({ msg }: { msg: string | null }) {
  return msg ? <p class="err form-err">{msg}</p> : null;
}
