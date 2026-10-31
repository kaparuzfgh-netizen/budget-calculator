/**
 * categories.tsx — управление категориями: активные, архивные (приглушённые),
 * добавление (emoji + имя), переименование, архив/разархив, удаление
 * (траты остаются без категории). Мутации → reload списка.
 */
import { useState } from 'preact/hooks';
import { Archive, ArchiveRestore, Check, Pencil, Tags, Trash2, X } from 'lucide-preact';
import { ApiError } from '../api';
import type { CategoriesList, Category } from '../api';
import type { ScreenProps } from '../app';
import {
  cardCls,
  confirmCls,
  ErrorView,
  errorView,
  Field,
  FormError,
  h1Cls,
  headCls,
  inputCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowBtnCls,
  rowCls,
  smBtnCls,
  smDangerFillBtnCls,
  smGhostBtnCls,
  useData,
} from '../ui';

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
    <li class={`px-4 py-3${cat.archived ? ' opacity-50' : ''}`}>
      {edit ? (
        <div class="flex items-center gap-2">
          <input
            class="w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-950 px-2.5 py-1.5 text-[15px] text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/60"
            value={name}
            maxLength={32}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            class={smBtnCls}
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(() => api.patch(`/api/tma/categories/${cat.id}`, { name: name.trim() }), 'Переименовано')
            }
          >
            <Check size={14} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            class={rowBtnCls}
            onClick={() => {
              setEdit(false);
              setName(cat.name);
            }}
          >
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>
      ) : (
        <div class={rowCls}>
          <span>
            {cat.emoji} {cat.name}
          </span>
          <span class="flex items-center gap-0.5">
            <button type="button" class={rowBtnCls} title="Переименовать" onClick={() => setEdit(true)}>
              <Pencil size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              class={rowBtnCls}
              title={cat.archived ? 'Вернуть' : 'В архив'}
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.patch(`/api/tma/categories/${cat.id}`, { archived: !cat.archived }),
                  cat.archived ? 'Категория возвращена' : 'В архиве',
                )
              }
            >
              {cat.archived ? <ArchiveRestore size={15} strokeWidth={1.5} /> : <Archive size={15} strokeWidth={1.5} />}
            </button>
            <button
              type="button"
              class={`${rowBtnCls} hover:text-red-400`}
              title="Удалить"
              disabled={busy}
              onClick={() => setDel(true)}
            >
              <Trash2 size={15} strokeWidth={1.5} />
            </button>
          </span>
        </div>
      )}
      {del && (
        <div class={confirmCls}>
          <p class="text-sm">Удалить «{cat.name}»? Траты останутся без категории.</p>
          <div class="mt-2 flex gap-2">
            <button
              type="button"
              class={smDangerFillBtnCls}
              disabled={busy}
              onClick={() => void run(() => api.del(`/api/tma/categories/${cat.id}`), 'Удалено')}
            >
              Да, удалить
            </button>
            <button type="button" class={smGhostBtnCls} onClick={() => setDel(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {err && <p class="mt-2 text-sm text-red-400">{err}</p>}
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
      <h1 class={h1Cls}>
        <Tags size={20} strokeWidth={1.5} class="text-sky-400" /> Категории
      </h1>
      <div class={cardCls}>
        <form onSubmit={add}>
          <div class="flex gap-3">
            <Field label="Эмодзи">
              <input
                class={inputCls}
                value={emoji}
                maxLength={4}
                onInput={(e) => setEmoji((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Название">
              <input
                class={inputCls}
                value={name}
                maxLength={32}
                placeholder="например, Питомцы"
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            Добавить
          </button>
        </form>
      </div>

      <div class={`${listCardCls} mt-4`}>
        {active.length ? (
          <ul class="divide-y divide-white/5">
            {active.map((x) => (
              <CatRow key={x.id} api={api} cat={x} onDone={(m) => { nav.flash(m); q.reload(); }} onFlash={nav.flash} />
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Нет активных категорий.</p>
        )}
      </div>
      {archived.length > 0 && (
        <>
          <h2 class={`${headCls} mt-6`}>
            <Archive size={16} strokeWidth={1.5} /> Архив
          </h2>
          <div class={`${listCardCls} mt-2`}>
            <ul class="divide-y divide-white/5">
              {archived.map((x) => (
                <CatRow key={x.id} api={api} cat={x} onDone={(m) => { nav.flash(m); q.reload(); }} onFlash={nav.flash} />
              ))}
            </ul>
          </div>
        </>
      )}
      <p class={`${mutedCls} mt-3`}>При записи траты категория определяется по заметке («Авто») или выбирается чипом.</p>
    </>
  );
}
