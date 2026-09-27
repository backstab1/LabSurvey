// Поле «Другое» у варианта ответа
import type { Option } from '../../../shared/types.ts';

/** Поле открытого значения варианта: текст, большое поле, число, дата или время */
export function OtherInput({ value, onChange, placeholder = 'Укажите ваш вариант', autoFocus, opt }: {
  value: string; onChange: (s: string) => void; placeholder?: string; autoFocus?: boolean; opt?: Option;
}) {
  const common = { className: 'input other-input', value, autoFocus, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  switch (opt?.otherType) {
    case 'number':
      return <input {...common} inputMode={opt.otherDecimals ? 'decimal' : 'numeric'} placeholder={opt.otherDecimals ? 'Число' : 'Целое число'} maxLength={30} />;
    case 'date': return <input {...common} type="date" />;
    case 'time': return <input {...common} type="time" />;
    default:
      return opt?.otherMultiline
        ? <textarea {...common} rows={3} placeholder={placeholder} maxLength={2000} />
        : <input {...common} placeholder={placeholder} maxLength={500} />;
  }
}
