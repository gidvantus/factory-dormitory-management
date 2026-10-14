import styles from './TariffPrice.module.css';

/** Разделяем готовую подпись сервера на сумму и пояснение, не пересчитывая цену. */
export function TariffPrice({
  label,
  className = '',
  testId,
}: {
  label: string;
  className?: string;
  testId?: string;
}): JSX.Element {
  const parts = /^(.+?\s(?:₽|\$|€|[A-Z]{3}))(\s+.+)$/.exec(label);
  return (
    <p className={`${styles.price} ${className}`} data-testid={testId}>
      <strong>{parts ? parts[1] : label}</strong>
      {parts && <span>{parts[2]}</span>}
    </p>
  );
}
