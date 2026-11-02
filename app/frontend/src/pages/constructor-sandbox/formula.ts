/** Арифметика report_formula.py: без eval, с тем же набором операций. */
export function calculate(
  expression: string,
  resolve: (name: string) => number,
  syntaxOnly = false,
): number {
  if (!expression.startsWith('=') || expression.length > 1000)
    throw new Error('Формула должна начинаться с = и быть не длиннее 1000 символов');
  const source = expression.slice(1);
  let at = 0;
  const space = (): void => {
    while (/\s/.test(source[at] ?? '') && at < source.length) at++;
  };
  function atom(): number {
    space();
    const char = source[at];
    if (char === '+' || char === '-') {
      at++;
      const value = atom();
      return char === '-' ? -value : value;
    }
    if (char === '(') {
      at++;
      const value = sum();
      space();
      if (source[at++] !== ')') throw new Error('Проверьте скобки в формуле');
      return value;
    }
    if (char === '[') {
      const end = source.indexOf(']', ++at);
      if (end < 0 || end === at) throw new Error('Проверьте ссылку на строку');
      const name = source.slice(at, end);
      if (name.includes('[')) throw new Error('Проверьте ссылку на строку');
      at = end + 1;
      return resolve(name);
    }
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
    if (!match) throw new Error('Можно использовать только числа, +, −, ×, ÷, скобки и [строки]');
    at += match[0].length;
    return Number(match[0]);
  }
  function product(): number {
    let value = atom();
    space();
    while (source[at] === '*' || source[at] === '/') {
      const op = source[at++];
      const right = atom();
      if (op === '/' && right === 0 && !syntaxOnly) throw new Error('Деление на ноль');
      value = syntaxOnly ? 1 : op === '*' ? value * right : value / right;
      space();
    }
    return value;
  }
  function sum(): number {
    let value = product();
    space();
    while (source[at] === '+' || source[at] === '-') {
      const op = source[at++];
      const right = product();
      value = op === '+' ? value + right : value - right;
      space();
    }
    return value;
  }
  const value = sum();
  space();
  if (at !== source.length) throw new Error('Проверьте синтаксис формулы');
  if (!syntaxOnly && (!Number.isFinite(value) || Math.abs(value) > 1e15))
    throw new Error('Результат вне допустимого диапазона');
  return value;
}

export function references(expression: string): string[] {
  return [...expression.matchAll(/\[([^[\]]+)\]/g)].map((match) => match[1]);
}
