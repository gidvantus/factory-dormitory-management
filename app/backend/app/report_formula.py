"""Безопасный расчёт формул: арифметика и ссылки [Название строки] за тот же день."""

import ast
import json
import re
from collections.abc import Callable
from decimal import Decimal


class FormulaError(ValueError):
    pass


def compile_formula(formula: str) -> tuple[ast.Expression, set[str]]:
    if not formula.startswith("=") or len(formula) > 1000:
        raise FormulaError("Формула должна начинаться с = и быть не длиннее 1000 символов")
    source = re.sub(
        r"\[([^\[\]]+)\]",
        lambda match: f"ref({json.dumps(match.group(1), ensure_ascii=False)})",
        formula[1:],
    )
    try:
        tree = ast.parse(source, mode="eval")
    except (SyntaxError, RecursionError) as exc:
        raise FormulaError("Проверьте синтаксис формулы") from exc
    references: set[str] = set()

    def check(node: ast.AST) -> None:
        if isinstance(node, ast.Expression):
            check(node.body)
        elif isinstance(node, ast.BinOp) and isinstance(
            node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)
        ):
            check(node.left)
            check(node.right)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            check(node.operand)
        elif isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "ref"
            and len(node.args) == 1
            and not node.keywords
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            references.add(node.args[0].value)
        else:
            raise FormulaError("Можно использовать только числа, +, −, ×, ÷, скобки и [строки]")

    check(tree)
    return tree, references


def calculate_formula(tree: ast.Expression, resolve: Callable[[str], Decimal]) -> Decimal:
    def calculate(node: ast.AST) -> Decimal:
        if isinstance(node, ast.Expression):
            return calculate(node.body)
        if isinstance(node, ast.Constant):
            return Decimal(str(node.value))
        if isinstance(node, ast.Call):
            argument = node.args[0]
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                return resolve(argument.value)
            raise FormulaError("Недопустимая ссылка на строку")
        if isinstance(node, ast.UnaryOp):
            value = calculate(node.operand)
            return -value if isinstance(node.op, ast.USub) else value
        if isinstance(node, ast.BinOp):
            left, right = calculate(node.left), calculate(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                if right == 0:
                    raise FormulaError("Деление на ноль")
                return left / right
        raise FormulaError("Недопустимая формула")

    return calculate(tree)


def format_number(value: Decimal) -> str:
    if not value.is_finite() or abs(value) > Decimal("1000000000000000"):
        raise FormulaError("Результат вне допустимого диапазона")
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text
