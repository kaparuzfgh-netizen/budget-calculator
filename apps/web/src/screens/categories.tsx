/**
 * categories.tsx — управление категориями: активные, архивные (приглушённые),
 * добавление (emoji + имя), переименование, архив/разархив, удаление
 * (траты остаются без категории). Мутации → reload списка.
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { CategoriesList, Category } from '../api';
import type { ScreenProps } from '../app';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

function CatRow({
  api,
  cat,
  onDone,
  onFlash,
}: {
  api: ScreenProps['api'];
  cat: Category;
  onDone: (msg: string) => void;
  onFlash: (msg: string) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(cat.name);
  const [del, setDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone(msg);
    } catch (e) {
      onFlash(e instanceof ApiError ? e.message : 'Не удалось — проверьте соединение');
      setBusy(false);
    }
  };
  return (
    <li class={cat.archived ? 'off' : ''}>
      {edit ? (
        <div class="inline">
          <input value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button
            type="button"
            class="btn sm"
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(() => api.patch(`/api/tma/categories/${cat.id}`, { name: name.trim() }), 'Переименовано')
            }
          >
            ✓
          </button>
          <button type="button" class="btn sm" onClick={() => { setEdit(false); setName(cat.name); }}>
            ✕
          </button>
        </div>
      ) : (
        <div class="row">
          <span>
            {cat.emoji} {cat.name}
          </span>
          <span>
            <button type="button" class="rowbtn" title="Переименовать" onClick={() => setEdit(true)}>
              ✏️
            </button>
            <button
              type="button"
              class="rowbtn"
              title={cat.archived ? 'Вернуть' : 'В архив'}
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.patch(`/api/tma/categories/${cat.id}`, { archived: !cat.archived }),
                  cat.archived ? 'Категория возвращена' : 'В архиве',
                )
              }
            >
              {cat.archived ? '↩' : '📥'}
            </button>
            <button type="button" class="rowbtn" title="Удалить" disabled={busy} onClick={() => setDel(true)}>
              🗑
            </button>
          </span>
        </div>
      )}
      {del && (
        <div class="confirm">
          <p>Удалить «{cat.name}»? Траты останутся без категории.</p>
          <div class="inline">
            <button
              type="button"
              class="btn danger"
              disabled={busy}
              onClick={() => void run(() => api.del(`/api/tma/categories/${cat.id}`), 'Удалено')}
            >
              Да, удалить
            </button>
            <button type="button" class="btn ghost" onClick={() => setDel(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {err && <p class="err form-err">{err}</p>}
    </li>
  );
}

export function CategoriesScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<CategoriesList>('/api/tma/categories?all=1'), onFatal, []);
  const [emoji, setEmoji] = useState('📦');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const cats = q.data.categories;
  const active = cats.filter((x) => !x.archived);
  const archived = cats.filter((x) => x.archived);

  const add = async (ev: Event) => {
    ev.preventDefault();
    if (!name.trim()) {
      setErr('Введите название');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/categories', { name: name.trim(), emoji: emoji.trim() || '📦' });
      setName('');
      setEmoji('📦');
      nav.flash('Категория добавлена');
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось добавить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>🏷 Категории</h1>
      <div class="card">
        <form onSubmit={add}>
          <div class="inline">
            <Field label="Эмодзи">
              <input value={emoji} maxLength={4} onInput={(e) => setEmoji((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Название">
              <input value={name} maxLength={32} placeholder="например, Питомцы" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <FormError msg={err} />
          <button type="submit" class="btn" disabled={busy}>
            Добавить
          </button>
        </form>
      </div>

      <div class="card">
        {active.length ? (
          <ul class="plain">
            {active.map((x) => (
              <CatRow key={x.id} api={api} cat={x} onDone={(m) => { nav.flash(m); q.reload(); }} onFlash={nav.flash} />
            ))}
          </ul>
        ) : (
          <p class="muted">Нет активных категорий.</p>
        )}
      </div>
      {archived.length > 0 && (
        <>
          <h2>Архив</h2>
          <div class="card">
            <ul class="plain">
              {archived.map((x) => (
                <CatRow key={x.id} api={api} cat={x} onDone={(m) => { nav.flash(m); q.reload(); }} onFlash={nav.flash} />
              ))}
            </ul>
          </div>
        </>
      )}
      <p class="muted">При записи траты категория определяется по заметке («Авто») или выбирается чипом.</p>
    </>
  );
}
