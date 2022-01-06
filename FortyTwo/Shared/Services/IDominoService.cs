using FortyTwo.Shared.Models;
using System.Collections.Generic;

namespace FortyTwo.Shared.Services
{
    public interface IDominoService
    {
        List<Domino> InitDominos(DominoType type, bool shuffle = true);
    }
}
