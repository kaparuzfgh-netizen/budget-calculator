import type { ComponentChildren } from 'preact';
import { Bell, CalendarClock, Camera, Receipt, TrendingUp } from 'lucide-preact';
import type { SelectOption } from '../ui';
import { Info } from '../ui';

/** Переключатель-«тогл» в стиле iOS: PATCH по change, без submit-кнопки. */
export function Switch({
  icon,
  label,
  hint,
  checked,
  busy,
  onToggle,
}: {
  icon: ComponentChildren;
  label: ComponentChildren;
  hint?: string | undefined;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <span class="flex items-center gap-2.5 text-[15px] text-zinc-100">
        {icon}
        <span>
          {label}
          {hint ? <span class="mt-0.5 block text-xs text-zinc-400">{hint}</span> : null}
        </span>
      </span>
      <span class="relative inline-flex h-[27px] w-[46px] flex-none cursor-pointer items-center">
        <input
          type="checkbox"
          class="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          checked={checked}
          disabled={busy}
          onChange={() => onToggle()}
        />
        <span class="absolute inset-0 rounded-full bg-fill-3 transition peer-checked:bg-sky-500 peer-disabled:opacity-50" />
        <span class="absolute left-[3px] top-[3px] h-[21px] w-[21px] rounded-full bg-white transition peer-checked:translate-x-[19px]" />
      </span>
    </div>
  );
}

/** Ключи boolean-настроек профиля (PATCH /profile) — и напоминания, и фичи. */
export type ToggleKey = 'reminders_weekly' | 'reminders_payments' | 'reminders_digest' | 'fx_alerts_enabled' | 'vision_enabled';

export const REMINDERS: {
  key: ToggleKey;
  icon: typeof Bell;
  label: ComponentChildren;
  hint: string;
}[] = [
  { key: 'reminders_weekly', icon: CalendarClock, label: 'Еженедельный итог', hint: 'вс 20:00 — траты недели' },
  { key: 'reminders_payments', icon: Receipt, label: 'Платежи и сроки', hint: 'за 2 дня до срока, 10:00' },
  { key: 'reminders_digest', icon: CalendarClock, label: 'Дайджест месяца', hint: 'итоги в последний день месяца' },
  { key: 'fx_alerts_enabled', icon: TrendingUp, label: 'Алерты по курсам', hint: 'выгодные моменты для обмена' },
];

/** «⚡️ Возможности» — opt-in фичи (не напоминания), тот же PATCH-контракт. */
export const FEATURES: {
  key: ToggleKey;
  icon: typeof Bell;
  label: ComponentChildren;
  hint: string;
}[] = [
  {
    key: 'vision_enabled',
    icon: Camera,
    label: (
      <>
        Распознавание скриншотов
        <Info title="Распознавание скриншотов">
          <p>
            Включите — и можно прислать скриншот банковского приложения боту
            ИЛИ загрузить его здесь: кнопка «📷 Из скриншота» в форме траты.
            Строки операций распознаются списком — перед записью их можно
            проверить и поправить.
          </p>
          <p>
            Фото уходит в Google AI (резерв — Groq), хранится только результат.
            Лимит — 20 фото в день.
          </p>
        </Info>
      </>
    ),
    hint: 'фото банка — в боте или в форме траты',
  },
];

/** «Время напоминаний»: «По умолчанию» → null (легаси) + часы 0–23. */
export const REM_HOUR_OPTIONS: SelectOption[] = [
  { value: '', label: 'По умолчанию', hint: '10:00 · вс 20:00' },
  ...Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  })),
];
