import cat from '../../assets/cat.svg';
import dog from '../../assets/dog.svg';
import dormHouse from '../../assets/dorm-house.svg';

interface CtaSectionProps {
  /** Регистрация — главное действие блока. */
  onRegister: () => void;
  /** Вход для тех, кто уже завёл аккаунт. */
  onLogin: () => void;
}

/**
 * Финальный призыв: вместо формы-заглушки из прототипа здесь настоящая
 * регистрация — она открывается в том же окне, что и по кнопке в шапке.
 */
export function CtaSection({ onRegister, onLogin }: CtaSectionProps): JSX.Element {
  return (
    <section className="section" id="demo">
      <div className="container">
        <div className="cta-band reveal">
          <div>
            <p className="eyebrow">Демо и доступ</p>
            <h2>Заведите рабочий аккаунт и посмотрите Домового изнутри</h2>
            <p>
              Регистрация занимает минуту: нужны только рабочая почта и ФИО. Пароль придумает сервер
              и покажет его один раз — сохраните его, повторно он не отображается.
            </p>

            <div className="cta-actions">
              <button
                className="btn btn--ink"
                type="button"
                data-testid="cta-register"
                onClick={onRegister}
              >
                Зарегистрироваться
              </button>
              <button
                className="btn btn--outline"
                type="button"
                data-testid="cta-login"
                onClick={onLogin}
              >
                Войти
              </button>
            </div>

            <p className="note">
              Демо-стенд: данные вымышленные, форма регистрации создаёт реального пользователя в
              этом сервисе.
            </p>
          </div>

          <div className="cta-band__art">
            <img className="art-house" src={dormHouse} alt="" width="420" height="460" />
            <img className="art-cat" src={cat} alt="" width="200" height="200" />
            <img className="art-dog" src={dog} alt="" width="200" height="200" />
          </div>
        </div>
      </div>
    </section>
  );
}
