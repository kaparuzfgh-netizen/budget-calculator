import type { SelectOption } from '../ui';

/**
 * Часовой пояс: полный список IANA (Intl.supportedValuesOf) с поиском.
 * Первой закреплена текущая зона («Текущая: X»), затем избранные, дальше —
 * весь список. Если API нет (старый WebView) — статичный fallback ~50 зон.
 * Русские имена городов ищутся через hint (SelectOption) — «москва» →
 * Europe/Moscow и т.п. Храним значение = IANA-строку (проверяет сервер).
 */
const TZ_FAVORITES = ['Europe/Moscow', 'Asia/Bishkek', 'Europe/Minsk', 'Asia/Almaty', 'UTC'] as const;
/** Алиасы городов → IANA: ищутся по подстроке (см. SelectOption.hint). */
const TZ_ALIASES: Record<string, string> = {
  'Europe/Moscow': 'москва питер санкт-петербург',
  'Europe/Samara': 'самара',
  'Asia/Bishkek': 'бишкек',
  'Europe/Minsk': 'минск',
  'Asia/Almaty': 'алматы',
  'Europe/Kyiv': 'киев',
  'Europe/Kiev': 'киев',
  'Europe/Berlin': 'берлин',
  'Europe/London': 'лондон',
  'America/New_York': 'нью-йорк',
  'Asia/Dubai': 'дубай',
  'Europe/Istanbul': 'стамбул',
};
/** Статичный список ~50 ходовых зон — fallback без Intl.supportedValuesOf. */
const TZ_FALLBACK: readonly string[] = [
  'UTC',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Vienna', 'Europe/Zurich',
  'Europe/Warsaw', 'Europe/Prague', 'Europe/Stockholm', 'Europe/Helsinki',
  'Europe/Athens', 'Europe/Bucharest', 'Europe/Istanbul', 'Europe/Kyiv',
  'Europe/Minsk', 'Europe/Moscow', 'Europe/Samara',
  'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk',
  'Asia/Irkutsk', 'Asia/Vladivostok', 'Asia/Kamchatka',
  'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku', 'Asia/Tashkent',
  'Asia/Almaty', 'Asia/Bishkek', 'Asia/Dubai', 'Asia/Karachi',
  'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
  'America/Anchorage', 'America/Los_Angeles', 'America/Chicago',
  'America/New_York', 'America/Mexico_City', 'America/Sao_Paulo',
  'Africa/Cairo', 'Africa/Johannesburg',
];

/** Все IANA-зоны из рантайма; без supportedValuesOf — TZ_FALLBACK. */
function allTimezones(): string[] {
  try {
    const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const list = fn?.call(Intl, 'timeZone');
    if (list?.length) return list;
  } catch {
    // старый WebView — ниже вернём fallback
  }
  return [...TZ_FALLBACK];
}

/** Опции селекта: «Текущая: X», избранные, полный список (без дублей). */
export function tzOptions(current: string): SelectOption[] {
  const all = allTimezones();
  const opt = (z: string, label = z): SelectOption => ({
    value: z,
    label,
    ...(TZ_ALIASES[z] ? { hint: TZ_ALIASES[z] } : {}),
  });
  const head = new Set<string>([current]);
  const favs = TZ_FAVORITES.filter((z) => z !== current && all.includes(z));
  for (const z of favs) head.add(z);
  return [
    opt(current, `Текущая: ${current}`),
    ...favs.map((z) => opt(z)),
    ...all.filter((z) => !head.has(z)).map((z) => opt(z)),
  ];
}
