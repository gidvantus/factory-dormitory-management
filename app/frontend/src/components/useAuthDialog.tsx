import { useState } from 'react';

import { AuthDialog } from './AuthDialog';
import type { AuthMode } from './AuthDialog';

/**
 * Окно входа и регистрации на публичных страницах.
 *
 * Главная открывает формы по адресам `/login` и `/register` и умеет их
 * переживать перезагрузку, поэтому она сама разбирает путь и этот хук не
 * использует. Остальным публичным экранам — прайсу и документу — адрес не нужен:
 * форма открывается окном прямо на странице, чтобы не уводить человека туда,
 * откуда он пришёл. Состояние окна и разметку держит один хук, чтобы шапка на
 * страницах вела себя одинаково.
 */
export function useAuthDialog(): {
  openLogin: () => void;
  openRegister: () => void;
  dialogElement: JSX.Element | null;
} {
  const [dialog, setDialog] = useState<AuthMode | null>(null);

  const dialogElement = dialog ? (
    <AuthDialog mode={dialog} onClose={() => setDialog(null)} />
  ) : null;

  return {
    openLogin: () => setDialog('login'),
    openRegister: () => setDialog('register'),
    dialogElement,
  };
}
