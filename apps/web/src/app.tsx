/**
 * app.tsx — каркас Mini App.
 *
 * Навигация — стек экранов в состоянии (контракт docs/ux/navigation.md):
 * вложенные экраны получают верхнюю панель «← Назад»/«🏠 На главную»;
 * после мутации возвращаемся на экран-источник — он перемонтируется
 * (рендерится только верхушка стека) и useData заново грузит данные.
 * flash — одноразовое сообщение после успешной мутации.
 */
import { useEffect, useState } from 'preact/hooks';
import { Check } from 'lucide-preact';
import type { Api } from './api';
import { flashCls, TopBar } from './ui';
import { HomeScreen } from './screens/home';
import { PlanScreen } from './screens/plan';
import { ExpenseScreen, SpentAddScreen, WeekScreen } from './screens/week';
import { IncomeScreen } from './screens/income';
import { CommitmentAddScreen, CommitmentScreen } from './screens/commitments';
import { ProfileScreen } from './screens/profile';
import { DebtAddScreen, DebtsScreen, DebtScreen } from './screens/debts';
import { LoanAddScreen, LoansScreen, LoanScreen } from './screens/loans';
import { FxScreen } from './screens/fx';
import { ReportScreen } from './screens/report';
import { CategoriesScreen } from './screens/categories';
import { InvestScreen } from './screens/invest';
import { InvestFormScreen } from './screens/invest-form';

export type Route =
  | { id: 'home' }
  | { id: 'plan' }
  | { id: 'week' }
  | { id: 'expense'; expenseId: number }
  | { id: 'spent-add' }
  | { id: 'income' }
  | { id: 'profile' }
  | { id: 'commitment'; commitmentId: number }
  | { id: 'commitment-add' }
  | { id: 'debts' }
  | { id: 'debt'; debtId: number }
  | { id: 'debt-add' }
  | { id: 'loans' }
  | { id: 'loan'; loanId: number }
  | { id: 'loan-add' }
  | { id: 'fx' }
  | { id: 'report' }
  | { id: 'categories' }
  | { id: 'invest' }
  | { id: 'invest-form'; holdingId?: number };

export interface Nav {
  push: (r: Route) => void;
  back: () => void;
  home: () => void;
  flash: (msg: string) => void;
}

export interface ScreenProps {
  api: Api;
  nav: Nav;
  /** фатальные 401/403 и не-онбординг → экран «Нет доступа» в main.tsx. */
  onFatal: () => void;
}

export function App({ api, name, onFatal }: { api: Api; name: string | null; onFatal: () => void }) {
  const [stack, setStack] = useState<Route[]>([{ id: 'home' }]);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const nav: Nav = {
    push: (r) => {
      setFlash(null); // старый flash не тащим на новый экран
      setStack((s) => [...s, r]);
    },
    // back/home flash НЕ трогаем: мутация ставит сообщение и сразу возвращает
    // на экран-источник — оно должно дожить до показа там.
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    home: () => setStack([{ id: 'home' }]),
    flash: setFlash,
  };

  // Нативная «Назад» Telegram дублирует TopBar на вложенных экранах;
  // без неё кнопка/свайп назад закрывали бы всё приложение.
  useEffect(() => {
    const bb = window.Telegram?.WebApp?.BackButton;
    if (!bb) return;
    if (stack.length > 1) {
      bb.onClick(nav.back);
      bb.show();
      return () => bb.offClick(nav.back);
    }
    bb.hide();
  }, [stack.length]);

  const top = stack[stack.length - 1]!;
  const props = { api, nav, onFatal };
  let screen;
  switch (top.id) {
    case 'plan':
      screen = <PlanScreen {...props} />;
      break;
    case 'week':
      screen = <WeekScreen {...props} />;
      break;
    case 'expense':
      screen = <ExpenseScreen {...props} expenseId={top.expenseId} />;
      break;
    case 'spent-add':
      screen = <SpentAddScreen {...props} />;
      break;
    case 'income':
      screen = <IncomeScreen {...props} />;
      break;
    case 'profile':
      screen = <ProfileScreen {...props} />;
      break;
    case 'commitment':
      screen = <CommitmentScreen {...props} commitmentId={top.commitmentId} />;
      break;
    case 'commitment-add':
      screen = <CommitmentAddScreen {...props} />;
      break;
    case 'debts':
      screen = <DebtsScreen {...props} />;
      break;
    case 'debt':
      screen = <DebtScreen {...props} debtId={top.debtId} />;
      break;
    case 'debt-add':
      screen = <DebtAddScreen {...props} />;
      break;
    case 'loans':
      screen = <LoansScreen {...props} />;
      break;
    case 'loan':
      screen = <LoanScreen {...props} loanId={top.loanId} />;
      break;
    case 'loan-add':
      screen = <LoanAddScreen {...props} />;
      break;
    case 'fx':
      screen = <FxScreen {...props} />;
      break;
    case 'report':
      screen = <ReportScreen {...props} />;
      break;
    case 'categories':
      screen = <CategoriesScreen {...props} />;
      break;
    case 'invest':
      screen = <InvestScreen {...props} />;
      break;
    case 'invest-form':
      screen = <InvestFormScreen {...props} {...(top.holdingId !== undefined ? { holdingId: top.holdingId } : {})} />;
      break;
    default:
      screen = <HomeScreen {...props} name={name} />;
  }

  return (
    <div class="mx-auto max-w-md px-4 pb-10 pt-5">
      {stack.length > 1 && <TopBar onBack={nav.back} onHome={nav.home} />}
      {flash !== null && (
        <div class={flashCls}>
          <Check size={16} strokeWidth={1.5} /> {flash}
        </div>
      )}
      {screen}
    </div>
  );
}
