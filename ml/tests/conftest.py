from fortytwo_ml.engine.dominoes import index_of


def deal_with(hands: dict[int, list[tuple[int, int]]]) -> list[int]:
    """A deal order giving each listed seat those dominoes first; everything else fills in ascending."""
    fixed = {seat: [index_of(*pips) for pips in dominoes] for seat, dominoes in hands.items()}
    used = {d for ds in fixed.values() for d in ds}
    rest = iter(d for d in range(28) if d not in used)
    order: list[int] = []
    for seat in range(4):
        ds = fixed.get(seat, [])
        order.extend(ds + [next(rest) for _ in range(7 - len(ds))])
    return order
