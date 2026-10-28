/**
 * categories.ts — пресеты и автоматчинг категорий расходов. Чистые функции.
 * matchCategory: токенизация заметки → (a) свои категории по имени →
 * (b) алиасы пресетов; первый совпавший токен побеждает; если это первый
 * токен — он вырезается из заметки («500 кафе с коллегами» → кафе, «с коллегами»).
 */

export interface Preset {
  key: string;
  name: string;
  emoji: string;
  aliases: string[];
}

/** Порядок = sort в БД. */
export const PRESETS: Preset[] = [
  { key: 'food', name: 'Продукты', emoji: '🛒', aliases: ['продукт', 'еда', 'магазин', 'супермаркет', 'гипермаркет', 'globus', 'глобус', 'народн', 'фрукт', 'овощ'] },
  { key: 'cafe', name: 'Кафе и рестораны', emoji: '🍽', aliases: ['кафе', 'ресторан', 'кофе', 'обед', 'ужин', 'завтрак', 'бар', 'доставк', 'пицц', 'шаурм', 'фастфуд'] },
  { key: 'transport', name: 'Транспорт', emoji: '🚕', aliases: ['такси', 'яндекс', 'автобус', 'маршрут', 'метро', 'бензин', 'топлив', 'заправк', 'парковк', 'транспорт', 'проезд'] },
  { key: 'home', name: 'Дом', emoji: '🏠', aliases: ['дом', 'аренд', 'квартир', 'коммунал', 'жкх', 'свет', 'газ', 'вода', 'ремонт', 'хозтовар'] },
  { key: 'health', name: 'Здоровье', emoji: '💊', aliases: ['аптек', 'врач', 'здоров', 'лекарств', 'клиник', 'анализ', 'стомат'] },
  { key: 'fun', name: 'Развлечения', emoji: '🎉', aliases: ['кино', 'развлеч', 'игр', 'концерт', 'театр', 'хобби', 'отдых'] },
  { key: 'clothes', name: 'Одежда', emoji: '👕', aliases: ['одежд', 'обув', 'кроссов', 'куртк'] },
  { key: 'comms', name: 'Связь и подписки', emoji: '📱', aliases: ['связь', 'интернет', 'телефон', 'мобильн', 'подписк', 'netflix', 'spotify', 'youtube'] },
  { key: 'gifts', name: 'Подарки', emoji: '🎁', aliases: ['подар', 'цвет'] },
  { key: 'other', name: 'Прочее', emoji: '📦', aliases: ['прочее'] },
];

export interface MatchCat {
  id: number;
  name: string;
  preset_key: string | null;
  archived: number;
}

const ALIAS = new Map(PRESETS.map((p) => [p.key, p.aliases]));
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Токены заметки (≥3 символов) сканируются по порядку:
 *  a) свои категории (preset_key IS NULL): name.toLowerCase().startsWith(token)
 *     или token.startsWith(первое слово имени, len ≥ 3);
 *  b) пресет-алиасы по preset_key: token.startsWith(stem).
 * Первый подошедший токен побеждает; если он первый — вырезается из заметки.
 */
export function matchCategory(
  note: string | null,
  cats: MatchCat[],
): { categoryId: number | null; note: string | null } {
  if (!note) return { categoryId: null, note };
  const tokens = note.toLowerCase().match(TOKEN_RE) ?? [];
  const active = cats.filter((c) => !c.archived);
  const customs = active.filter((c) => c.preset_key === null);
  const presets = active.filter((c) => c.preset_key !== null);
  let hitIdx = -1;
  let hitId: number | null = null;
  outer: for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length < 3) continue;
    for (const c of customs) {
      const nm = c.name.toLowerCase();
      const first = nm.split(/\s+/)[0]!;
      if (nm.startsWith(t) || (first.length >= 3 && t.startsWith(first))) {
        hitIdx = i;
        hitId = c.id;
        break outer;
      }
    }
    for (const c of presets) {
      const stems = ALIAS.get(c.preset_key!) ?? [];
      if (stems.some((s) => t.startsWith(s))) {
        hitIdx = i;
        hitId = c.id;
        break outer;
      }
    }
  }
  if (hitId === null) return { categoryId: null, note };
  let rest = note;
  if (hitIdx === 0) {
    // вырезать первый токен из исходной строки (без g-флага — только первый матч)
    rest = note.replace(new RegExp(TOKEN_RE.source, 'u'), '').replace(/^\s*[\s,.;:!\-–—]*\s*/, '').trim();
    if (!rest) return { categoryId: hitId, note: null };
  }
  return { categoryId: hitId, note: rest.trim() || null };
}
