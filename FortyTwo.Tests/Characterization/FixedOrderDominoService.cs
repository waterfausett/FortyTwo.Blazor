using System.Collections.Generic;
using System.Linq;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Services;

namespace FortyTwo.Tests.Characterization
{
    // Ignores `shuffle` entirely — returns the 28 dominoes in exactly the
    // order the scenario specifies, so Deal() (which always requests
    // shuffle: true) produces deterministic hands. Position.First gets
    // order[0..6], Second gets order[7..13], Third order[14..20], Fourth order[21..27].
    public class FixedOrderDominoService : IDominoService
    {
        private readonly List<(int Top, int Bottom)> _order;

        public FixedOrderDominoService(List<(int Top, int Bottom)> order)
        {
            _order = order;
        }

        public List<Domino> InitDominos(DominoType type, bool shuffle = true)
            => _order.Select(d => new Domino(d.Top, d.Bottom)).ToList();
    }
}
