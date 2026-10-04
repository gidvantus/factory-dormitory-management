import { Login } from '../pages/Login';
import { Register } from '../pages/Register';
import { Modal } from './Modal';

export type AuthMode = 'login' | 'register';

const TITLES: Record<AuthMode, string> = {
  login: 'Вход в личный кабинет',
  register: 'Регистрация',
};

interface AuthDialogProps {
  mode: AuthMode;
  onClose: () => void;
}

/** Формы входа и регистрации показываются в модальном окне, а не отдельной страницей. */
export function AuthDialog({ mode, onClose }: AuthDialogProps): JSX.Element {
  return (
    <Modal title={TITLES[mode]} testId="auth-modal" onClose={onClose}>
      {mode === 'login' ? <Login /> : <Register />}
    </Modal>
  );
}
